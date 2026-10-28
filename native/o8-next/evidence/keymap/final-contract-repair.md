# Final focus-aware shortcut contract repair

Reviewed head: `f8ba332ec`. Merged comparison main: `88096a00c`.
Repaired source: `f5a24724e`.

## Mechanic and repair

- The tab-cycle predicate excluded `TextInput`, so Ctrl+Tab did not leave the
  composer. Its focused binding now admits text input while continuing to
  exclude terminals, modals and overlays. Ctrl+Shift+Tab retains main's forward
  cycle rather than introducing a reverse-cycle meaning.
- Settings was tagged as an overlay, which excluded its close action. The
  capture compatibility path also swallowed that chord after its former raw
  handler was removed. Eligible Control+W reaches the focused Settings action;
  a narrow shell-root context handles the same close when the shell has focus.
- Retain main's Control-only close semantics, including Control+Shift+W.
  Command+W keeps Settings open. Focused fields and terminals keep their keys.
  The shell root gains only the Settings close action, not unrelated Settings
  search or cancellation bindings.

## Existing main tests restored

- `shell_palette_switch_restart_and_server_down`: restore the original comment,
  remove the added Commands-click sequence, and restore the restart input to
  exactly `ctrl-tab`, without a preceding `tab`.
- `shell_pull_requests_opens_from_palette`: restore the original diagnostic and
  shell-focus setup and remove the branch's extra reopen/close sequence.

Both complete test files now match main byte-for-byte. New tests appended to
`shell_tests.rs` by this branch were moved into the branch's own
`keymap_review_tests.rs`. The only other changed files that already exist on
main, `projects_review_tests.rs` and `terminal_tests.rs`, retain main's complete
text unchanged and append only this branch's new tests. The requested test diff
was audited again after the repair.

The accepted release-only benchmark and its ignore annotation are unchanged.
No main assertions, inputs, timing limits or ignore annotations were changed.

## Verification

Node 22, locked npm dependencies with npm 11.21.1, locked Cargo, debug builds
only, `CARGO_PROFILE_DEV_DEBUG=0`, `CARGO_INCREMENTAL=0`, `nice -n 10`, `-j 4`.
The persisted HTTP fixture daemon was built in debug with `experimental-http`.
Full suites use four test threads; isolated reruns use one.

Before repair, the two new contract reproductions reported **0 passed, 2 failed**:

```text
main's Ctrl+Tab cycles directly from the focused composer
left: Session("thoughts-long"); right: Grid
main's Ctrl+W closes non-editing Settings
```

After repair, both reproductions passed. The registered binding matrix passed
all **6,592 dispatch cases**, including text, terminal, list and empty focus.

Focused groups passed during repair; the final full head suite below repeats
all these cases. Counts are passed/failed/ignored:

| Group | Head |
| --- | --- |
| Shortcuts | 15/0/0 |
| Keymap | 20/0/1 |
| Palette | 26/0/1 |
| Settings | 14/0/0 |
| Shell | 17/0/3 |

Full locked native suite, including the native binary and all six integration
targets, once per revision with `--test-threads=4`:

| Revision | Passed | Failed | Ignored |
| --- | ---: | ---: | ---: |
| Main `88096a00c` | 317 | 3 | 8 |
| Head `f5a24724e` | 340 | 1 | 9 |

All 328 main test cases remain present among head's 350 cases. Every existing
main ignore state is unchanged. The sole added ignore is the accepted
`review_palette_release_cpu_frame_budget` benchmark.

Every full-run failure was rerun alone and compared on both revisions:

| Test | Full main | Full head | Isolated main | Isolated head |
| --- | --- | --- | --- | --- |
| `shell::sidebar::tests::sidebar_worker_archive_real_path` | fail | fail | 0/1/0 | 0/1/0 |
| `terminal::tests::production_pty_flood_waits_for_delayed_tail` | fail | pass | 1/0/0 | 0/1/0, then 1/0/0 |
| `terminal::tests::production_pty_to_gpui_terminal` | fail | pass | 1/0/0 | 1/0/0 |

Worker archive fails with the same workspace-selection notice on main and head:
`Select a workspace before changing this session.` That failure remains unresolved
and is outside shortcut dispatch.

The first isolated head delayed-tail run exceeded the unchanged 90-second
50 MB flood bound at 47,574,107 received and painted bytes. A paired repeat passed
on head in 29.69 s and on main in 35.56 s. Main's first isolated delayed-tail run
also passed. These local timing results are unstable; the earlier head timeout
is retained as a residual, not replaced by an all-green claim. All byte, paint
and timing assertions remain unchanged.

`cargo check --locked --all-targets` and `npm run typecheck:fast` passed.

The two reviewed shortcut regressions are repaired, and existing main tests are
restored. The shared worker-archive failure and the non-reproducing isolated
PTY timeout remain explicit evidence for the operator's final review.
