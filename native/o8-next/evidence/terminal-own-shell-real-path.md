# Terminal own-shell real path

The control uses main `d316df7be76dc77596880329723d4d61a00cfe41`.
The reviewed branch started at `5e925fb987f687140579d48b718701b2653fe709`.
Both checkouts installed dependencies with `npm ci`. Builds are debug builds.
Existing main test assertions and inputs are unchanged.

`tests/terminal_own_shell_cli.rs` runs
`terminal_own_shell_creates_once_reuses_and_accepts_input`. It first builds the
ordinary app binary: Cargo's integration build enables GPUI `test-support`,
which bypasses the native frame driver and is unsuitable for this probe.

The production app shell opens on a private Xvfb/Openbox display with software
Vulkan. The disposable host runs the real ws-server and production HTTP routes.
The selected workspace starts with no terminal or saved terminal selection.
The test checks:

- The mobile terminal inventory contains exactly one session for that workspace,
  with the name derived from `o8-next:<workspace>:terminal`.
- Physical X11 key presses execute a unique `echo` marker followed by `pwd`.
  A read-only WebSocket observer checks the output on that exact session. It
  never creates a session or sends terminal input, and disconnects before close.
- Ctrl+Alt+O lists the existing shell and Enter reattaches without another session.
- Normal window close exits successfully and persists the attached name.
  Reopening without a saved terminal selection adopts the same name, still with
  exactly one workspace session, and accepts another unique typed command.

## Red control

The identical new test on main reaches the feature assertion, rather than a
fixture startup failure:

```text
TERMINAL_OWN_SHELL_FAIL stage=create-1: Terminal surface must create exactly one workspace session (observed 0)
test terminal_own_shell_creates_once_reuses_and_accepts_input ... FAILED
test result: FAILED. 0 passed; 1 failed; 0 ignored
```

## Corrections exposed by the test

The dashboard PTY materialization path omitted `cwd` from its attachment record.
The shell ran in the requested directory, but the mobile inventory omitted that
workspace identity. The attachment now records its resolved cwd.

Normal X11 window close invoked callbacks while holding the X11 client borrow.
State capture or app quit re-entered the client and panicked with
`RefCell already borrowed`. The client borrow is now released before invoking
those callbacks. The test requires both closes to exit successfully.

## Verification

The production harness passed creation, typed input, picker listing, close and
reopen:

```text
TERMINAL_OWN_SHELL_PASS sessions=1 reused=true typedLaunches=2 pickerLists=true
```

Focused Cargo run: 1 passed, 0 failed, 0 ignored (68.20 seconds).
Main's terminal group and head's terminal cases in the full run: each had
7 passed, 0 failed, 1 ignored. An earlier loaded head
terminal run had 4 passed, 3 failed and 1 ignored: a fixture startup deadline and
two 50 MB delivery deadlines. No assertions or deadlines were changed.

- `cargo check --locked --all-targets`: passed.
- `npm run typecheck:fast`, touched-file ESLint, rule-check and shell syntax: passed.
- `npm test`: 9,852 passed, 12 failed, 5 skipped. All 12 failing cases passed in
  focused reruns. The five affected files had 291 passed and two timing failures;
  a final isolated redaction run had 247 passed, including both timing cases.
  Main's matching redaction run also had 247 passed.
- Existing CI installer contracts: 2 passed. The broader CI selector run had
  30 passed and 14 cases exceeding their existing 30-second deadline under load;
  the focused installer contracts passed again after the final package change.

Full native run used `--no-fail-fast` and `--test-threads=4` once. Aggregate:
**341 passed, 1 failed, 8 ignored**. The unit harness had 328 passed, 1 failed,
8 ignored; all 13 CLI cases passed, including the new real-window test again.
The only failure was the known local `sidebar_worker_archive_real_path` (#5018),
which reported "Select a workspace before changing this session."

Hosted Linux shards remain the validation gate. The PR remains unmerged with
auto-merge off.
