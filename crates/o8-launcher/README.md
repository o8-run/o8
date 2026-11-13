# Opt-in launcher, work in progress

Part of #6130. Nothing in packaging or the shipped app selects this binary.
The separate crate keeps application launch ownership separate from the Linux
batch supervisor documented in `../o8d/SUPERVISOR.md`. Shared shell mechanics
are imported from `o8-launch-core` rather than depending on Tauri.

The experimental entry point is `o8-launcher --config <absolute-json-file>`.
Configuration requires absolute `data_dir`, `server_dir`, `node`, and `window`
paths, `api_port`, `ws_port` (zero selects free ports), `version`, and optional
`dialog` (an executable failure presenter for fixtures). Use temporary data and
free ports for fixtures. The production bundle is not wired to this entry point.

## Evidence and blocker

The macOS check passed. Real-entry tests spawn fixture server and window
executables, without displaying a window. After shortening the fixture Unix
socket path, four of five tests passed: cold start and health waiting; shutdown
and port release; child crash/restart and shutdown during retry; second instance;
and injected startup failure are covered across those four tests.

The orphan-cleanup test still failed on its second suite run:

```text
crashed_parent_orphans_are_cleaned_without_touching_foreign_listener ... FAILED
assertion failed: TcpListener::bind(("127.0.0.1", port)).is_ok()
test result: FAILED. 4 passed; 1 failed
```

Fixture server processes survived the crashed-parent test. Their exact fixture
process groups were cleaned after the test. A possible cause is that a receipt
captures an interpreter command before it finishes exec and later rejects the
changed identity. This needs investigation through the entry point. A mismatched
receipt must never be discarded while an unresolved owned child can survive.
The two-failure stop rule ended this implementation attempt.

## Remaining work before review

- Repair and prove orphan ownership across exec, PID reuse and foreign receipts.
- Share the bundled server environment construction instead of duplicating it.
- Restore the login-shell PATH, provider-key and helper-path setup from the shell.
- Add native application lifecycle and Dock reopen/focus handling.
- Connect the existing admitted restart/drain protocol. Step 4 must receive the
  admitted restart reservation, drain before stopping servers, and retain child
  ownership and instance locking through updater handoff.
- Verify restart exhaustion, failed respawn, foreign receipt refusal, permissions,
  window restart after server restart, long socket paths and all new guards.
- Wire Linux executable tests into hosted verification and run the full gates.
- Check the shell against the moved library in a checkout with generated assets.

The binary is not ready for a packaging switch or daily use.
