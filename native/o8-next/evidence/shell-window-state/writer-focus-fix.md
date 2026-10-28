# Window-state writer: pending-close focus correction

Reviewed source: `f714a1eb9`. Main comparison: `e33ee782b`.
Merged implementation and verification source: `fcce7d388`.

## Mechanic and integration

The original asynchronous close completion compared only current bounds. A Tab
press after the first close snapshot could reach the live composer while the
writer was held, yet close would remove the window after persisting the old
composer-focus flag.

Main's feature-based shell lifecycle wins the merge conflict. The writer,
closing flag, error reporting, bounds subscription, and close callback now live
in `shell_features/window_state.rs`, with the coalescing queue and worker in
`window_state/writer.rs`. `Shell::persist` is a forwarding bridge; no writer or
closing field is added to the shared shell state list. The queue still holds one
in-flight save and one replaceable pending snapshot. Serialization for the actual
save and filesystem work run on that worker, outside the input callback.

Before submitting a close, capture current bounds and registered surface state.
After its flush acknowledgement, capture them again and compare every serialized
field against the snapshot submitted for that close. A newer snapshot is flushed
before window removal if focus, bounds, selections, tabs, or other persisted state
changed. Save errors retain the window and allow retry.

## Regression and timing

`window_state_pending_close_recaptures_composer_focus` uses the production window
factory, a real route fixture, the real write boundary, and the actual platform
close callback. Hold the writer, request close, press Tab, verify live composer
focus and window survival, release the writer, then read the closed window's file.

Red on `f714a1eb9` plus the new regression:

```text
close must save the composer focus reached after its first snapshot
test result: FAILED. 0 passed; 1 failed; 0 ignored
```

Green after migration/correction: **1 passed / 0 failed / 0 ignored**.

| Probe | Reviewed head | Repaired head |
| --- | ---: | ---: |
| Existing held-writer resize/draw/palette-input sequence | 572 ms | 645 ms |
| Tab input while close is pending | 34.744 ms | 42.867 ms |

These are single debug measurements on a shared host, including CPU scene work;
no production latency or speedup claim is made. The same held-input event sequence
was used before and after. Both held-writer probes report `forced=false` and one
attempted in-flight write; the coalescing and final-bounds assertions pass.

The original PR's published receipt used an earlier main baseline
`5ab8acb4a8330b2b6cfe9887ed62d56f93443560`: its watchdog released the synchronous
writer after 30 seconds, with timed input 2.846 seconds, `forced=true`, and seven
attempted writes. Its original repaired result was 751 ms, `forced=false`, and one
write. Those older measurements are recorded in the [original PR receipt](https://github.com/o8-run/o8/pull/4959);
they were not rerun here and are distinct from this correction's before/after
measurements above.

## Existing test contracts

All existing main test source files, including embedded tests in `fake.rs` and
sidebar `measurement.rs`, are restored exactly. The test-file diff contains only
new feature-owned `window_state/tests.rs`; no main assertion, keystroke, or input
sequence changed.

Asynchronous close requires test-driver lifecycle support. `simulate_close` now
drives actual asynchronous window removal outside the native callback, while
`simulate_close_request` retains the prior immediate platform-decision operation.
The held/error probes use the raw request and continue to verify pending window
lifetime and live input. Shared fixture drawing settles already-enqueued writes
after painting, outside input callbacks; explicit held-writer injection skips
that settling. This replaces the branch's edits to main test bodies and does not
perform disk writes on the native input thread.

## Validation

Node 22, declared npm 11.21.1, locked Cargo dependencies, debug information and
incremental compilation disabled, nice priority 10 and four Cargo jobs. Focused
native groups and the single full native sweep use four test threads. The HTTP
fixture daemon is a debug `experimental-http` build.

| Run | Passed | Failed | Ignored |
| --- | ---: | ---: | ---: |
| State persistence filter | 3 | 0 | 0 |
| Window-state feature probes | 3 | 0 | 0 |
| Existing window tests | 8 | 0 | 0 |
| Shell tests | 17 | 0 | 3 |
| Full head, once, including integration targets | 332 | 1 | 8 |
| Full-sweep failure isolated on head | 0 | 1 | 0 |
| Same failure isolated on main | 0 | 1 | 0 |

`cargo check --locked --all-targets` and `npm run typecheck:fast`: pass.

The only full-sweep failure was
`shell::sidebar::tests::sidebar_worker_archive_real_path`. It fails alone on both
head and main (0/1/0 each) with the same notice:
`Select a workspace before changing this session.` The window-state regression,
error/retry probe, and existing restart/focus tests passed in the full sweep.
Production PTY probes also passed in this sweep. The full suite is not green;
no assertion, input, ignore, byte count, or time bound was changed to accommodate
the archive failure. Main was used for isolated failure comparison, not another
full sweep. The npm startup error below was also reproduced on main.

The npm unit gate could not start collecting tests: Vitest raised
`TypeError: code.charCodeAt is not a function`. No cache/configuration workaround
was applied. Local verify:ci was not run in addition to the requested single full
native sweep; hosted CI remains necessary.

## Shared boundary

Shell-shared files changed: `shell.rs`, `shell_features.rs`, `shell_state.rs`,
`shell_test_support.rs`, and `docs/shell/modules.md`. Test-only GPUI helpers also
changed. The pull request has the required `shell-work` label.
