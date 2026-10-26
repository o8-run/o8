# macOS idle scheduling and repaint verification

The native app shell used a 20 ms timer even when nothing changed. Session sockets
also woke on 100 ms read timeouts. GPUI 0.2.2 gated its refresh driver on the
AppKit occlusion flag, which could prevent a hidden window from repainting.

The replacement keeps one maintenance timer and coalesces socket arrivals into
event wakes. Unchanged reconciliation results do not invalidate the view. Each
macOS window stops its display link after 100 ms without a draw. Invalidation,
input, resize, next-frame work and visibility transitions restart it immediately.
Display changes recreate the link. Queued work holds a weak reference and checks
window closure before touching the renderer.

## Test matrix

| Boundary | Assertion | Receipt |
| --- | --- | --- |
| Release shell, production-route fixture and live socket | 60 seconds without input, package idle wakeup and CPU counter deltas | `before.json`, `after.json` |
| Native refresh driver, GPUI test support disabled | Initial frame and changed generation while hidden | `repaint-red.json`, `repaint-green.json` |
| Native AppKit window | Fully transparent, not active, hide/order/unhide, occlusion, screen change and minimize/restore occlusion notifications | `repaint-green.json` |
| Idle refresh driver | No per-refresh checks after the 100 ms grace period | `macos_frame_clock.rs`, `repaint-green.json` |
| Resuming a paused driver | Input, data, resize and next-frame work paint within one display frame, with renderer submission | `repaint-green.json` |
| Closing a window | Pending refresh cannot retain or access the closed renderer | `repaint-green.json` |
| Application pump | Event wake is immediate, maintenance deadline survives event bursts | `wake::tests` |

## Measurements

Both runs used a release binary, the same saved session and the same disposable
production-route host, with 15 seconds to settle and a 60 second sample.

| Counter | Before | After |
| --- | ---: | ---: |
| Interrupt wakeups per second | 41.2977 | 0.9832 |
| Package-idle wakeups per second | 0 | 0 |
| CPU, percent of one logical CPU | 0.7198 | 0.1765 |
| Session subscriptions, including fixture reconnect | 0 | 2 |

The baseline's hidden-window freeze prevented session attachment. The repaired
shell attached and painted that session. These are the same launch configuration,
with the preexisting freeze explicitly retained in the baseline. The zero
package-idle counts do not establish an energy comparison; interrupt wakeups
provide the stricter bound on periodic app work in these runs.

The native probe creates windows with `show: false` and `focus: false`. Before
ordering any window it sets alpha to zero and ignores mouse events. It checks
that its application never becomes active. Input is sent through GPUI's window
dispatcher, with no OS input. Minimize/restore uses explicit occlusion
notifications to avoid Dock animation or a visible thumbnail.

Submission times come from a bounded diagnostic-only Metal counter, incremented
after committing the command buffer. The probe queries the first submission
after each data update, and requires a new submission for that generation. Resize
can submit a resized scene synchronously inside AppKit before returning; its
resize frame is timed from the first delivered bounds event, observed through
GPUI’s normal bounds observer; the subsequent data frame is timed from its own
update. Both must fit one display frame. Native AppKit call duration is retained
separately: it includes work before the bounds event reaches the application.
The resize event took 9.24 ms to submit a frame; data updates took at most 7.62 ms.
The cross-display native transition itself took 25.54 ms and is not represented
as a one-frame move. All 12 native stages passed, with zero idle frame callbacks
in each post-grace-period observation.

The measurement script uses `proc_pid_rusage(RUSAGE_INFO_V2)` cumulative
`ri_interrupt_wkups`, `ri_pkg_idle_wkups`, `ri_user_time` and `ri_system_time`, with
a 15 second settling period followed by 60 seconds of no app activity. CPU is
the delta in nanoseconds divided by wall time, as a percentage of one logical
CPU. Interrupt-level wakeups include timer wakeups even when other work keeps
the package awake. Package-idle wakeups are reported separately: a zero package
counter alone cannot prove the polling stopped. The script refuses a result
unless the repaired shell attached its session socket. The unmodified baseline
uses `--allow-frozen`: its hidden first-frame freeze can prevent the later render
that creates the session view and attaches the socket. That condition is recorded
as `frozenBeforeSessionAttach`, alongside the subscription count. Both runs use
the same saved state and fixture host. Raw receipts omit credentials, ports,
process IDs and fixture paths.

## Validation and remaining limits

- Release application and native diagnostic builds passed on macOS 26.6. The
  stock driver failed hidden-data repaint; the patched driver passed all 12 stages.
- Both event-pump tests and all four frame-clock policy tests passed.
- Application Clippy passed with existing warnings, and explicit GPUI Clippy
  passed. The license audit reported zero GPL/AGPL dependencies.
- TypeScript checking passed. The complete hermetic web suite had 9,057 passed,
  one failed and five skipped tests. The account-identity provider test failed
  again in isolation (three passed, one failed). No TypeScript was changed.
- The full native suite had 128 passed, six failed and three ignored tests. The
  Activity ordering failure is tracked in [#4717](https://github.com/o8-run/o8/issues/4717).
  A linked-context fixture test passed on retry; repository-draft paint and worker
  transcript timeout failures repeated. The saved-history test also requires an
  `o8d` binary which was absent. The vendor relocation failure introduced by this
  patch is corrected; its isolated scratch-build regression passed through all
  three compile checks (registered, removed and missing adapter).

Measurements cover the native app shell with the selected saved session. They
do not establish idle behavior for a connected terminal or the standalone
conversation launch mode, which retain their existing polling loops. Physical
minimization was not exercised; its occlusion notifications were simulated.
The remaining full-suite failures prevent a claim of complete acceptance.

## Reproduction

Run from the repository root on macOS, with `CARGO_TARGET_DIR` set to a disposable
directory inside the worktree:

```sh
cargo build --release --locked --manifest-path native/o8-next/Cargo.toml --bin o8-next
python3 scripts/next/macos-idle.py "$CARGO_TARGET_DIR/release/o8-next" /absolute/path/idle.json
cargo build --release --locked --manifest-path native/o8-next/Cargo.toml --features macos-diagnostics --bin o8-next-macos-check
"$CARGO_TARGET_DIR/release/o8-next-macos-check" /absolute/path/repaint.json
cargo test --locked --manifest-path native/o8-next/Cargo.toml
```

Build the native probe separately. Cargo's test feature graph enables GPUI test
support and replaces the native refresh driver; the probe explicitly refuses
that configuration.

## Source and license boundary

The vendored framework is the published Apache-2.0 `gpui` 0.2.2 crate, including
its original license. Local scheduling changes were written in this repository.
No application source or GPL/AGPL patch code was imported.

Background reading: [upstream occlusion diagnosis](https://github.com/zed-industries/zed/issues/63217),
[AppKit occlusion state](https://developer.apple.com/documentation/appkit/nswindow/occlusionstate-swift.struct),
and [stopping a display link](https://developer.apple.com/documentation/corevideo/cvdisplaylinkstop(_:)).
These describe the mechanism; the retained native runs establish behavior here.
