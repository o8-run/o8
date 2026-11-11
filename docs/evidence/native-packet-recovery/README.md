# Native packet recovery evidence

Captured from the native Activity pane on macOS, using this change's release
build copied immediately to a private, ignored worktree location. The embedded
source path was checked before launch. Binary SHA-256:
`8eb8c5769ac46c9f06dad2d2fda5aa383c29c9a8aa4d001675d8ec2fddd354f1`.

The window used a disposable Activity fixture, its own data directory and its
own shell-state file. No running development or installed app was rebuilt or
restarted. Fixture replies never kill a worker or dispatch a provider turn.

- `idle.png`, `busy.png`, `error.png`: existing packet action row, in-flight feedback submission and inline refusal.
- `reset-confirmation.png`: shared clearing-reset confirmation, captured on the running-worker variant.
- `feedback-idle.png`, `feedback-busy.png`, `feedback-error.png`: editable feedback,
  busy disabled state and the complete retained draft after refusal.
- `stop-reset-confirmation.png`: the running-worker label and discard confirmation.

Native tests: all four control tests fail against the previous UI (missing
selectors), then all four pass with the implementation. They exercise the real
registered Activity pane and HTTP fixture: Retry retains its original receipt
identity after an unknown outcome; Reset can be canceled and retried after a
refusal; Stop and reset rejects duplicate confirmation while polling the same
receipt; Start over requires valid feedback, enforces the server's UTF-16 limit,
and retains feedback after refusal, Cancel and Escape. Recovery controls share the existing content-width action row and are hidden for queued drafts and archived lanes.

Production-route coverage: the native WS listener is started with Next stopped,
and the actual reset/rerun handler responses are compared with the TypeScript
handlers. Both route parity and the four reset-current-registry tests passed
(5 tests total). Existing native transport tests also cover operator auth and
worker refusal for these already registered routes; those assertions were read,
not rerun locally here.

Local release cargo check and build passed using the shared cache. Touched-file
ESLint and rule-check passed. Full typecheck, hermetic tests and verify:ci were
attempted but are not green in this checkout without installed dependencies.
The latter two were stopped after repeated collection failures. No new dependency
installation or copy was made. Live worker retirement, checkout deletion and
provider redispatch were not exercised by this proof.

Layout revision: four native control tests passed again (4/4), including row alignment, button width, feedback field width, Cancel and Escape. Release cargo check/build passed; all captures were refreshed. Lifecycle actions, receipt handling and keyboard handling are now separate formatted modules.
