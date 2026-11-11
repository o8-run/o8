# Native packet recovery evidence

Captured from the native Activity pane on macOS, using this change's release
build copied immediately to a private, ignored worktree location. The embedded
source path was checked before launch. Binary SHA-256:
`b6939b7033117bea3e54f6ff0bbfd4e86b1565a905f203ac4ed094e74738ebfe`.

The window used a disposable Activity fixture, its own data directory and its
own shell-state file. No running development or installed app was rebuilt or
restarted. Fixture replies never kill a worker or dispatch a provider turn.

- `idle.png`, `busy.png`, `error.png`: packet recovery strip, in-flight Retry and inline refusal.
- `reset-confirmation.png`: explicit work-discard confirmation.
- `feedback-idle.png`, `feedback-busy.png`, `feedback-error.png`: editable feedback,
  busy disabled state and the complete retained draft after refusal.
- `stop-reset-confirmation.png`: the running-worker label and discard confirmation.

Native tests: all four control tests fail against the previous UI (missing
selectors), then all four pass with the implementation. They exercise the real
registered Activity pane and HTTP fixture: Retry retains its original receipt
identity after an unknown outcome; Reset can be canceled and retried after a
refusal; Stop and reset rejects duplicate confirmation while polling the same
receipt; Start over requires valid feedback, enforces the server's UTF-16 limit,
and retains feedback after refusal.

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
