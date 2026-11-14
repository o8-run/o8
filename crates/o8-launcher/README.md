# Opt-in macOS launcher

Part of #6130. Nothing in packaging or the shipped app selects this binary.
The separate crate keeps application launch ownership separate from the Linux
batch supervisor documented in `../o8d/SUPERVISOR.md`. Shared shell mechanics
are imported from `o8-launch-core` rather than depending on Tauri.

The experimental entry point is `o8-launcher --config <absolute-json-file>`.
Configuration requires absolute `data_dir`, `server_dir`, `node`, and `window`
paths plus `version`. Omitted ports use the shell's default ranges; zero selects
free ports. Always supply zero ports and a temporary data directory for fixtures.
Optional executable injections `dialog`, `probe`, and `focus`, and
`native_lifecycle: false`, allow headless tests without displaying windows.
The production bundle is not wired to this entry point.

## Lifecycle

The launcher uses the shared login-shell probe, PATH augmentation, runtime
preflight, port/identity files, explicit child environment, restart policy, and
authenticated server-owned GPUI request. Node continues to create its credential
files and owns the window arguments and optional o8d bridge. Server logs rotate
once per boot at `logs/next-server.log` and `logs/ws-server.log`.

A private instance lock and Unix socket serialize launches. Reopen requests are
coalesced even while preflight is pending. AppKit supplies Dock reopen and quit
events without a web view. Focus requires the configured executable to be a
direct child of this launcher's API server; otherwise the server reopens it.

Shutdown stops the API before WS. Each leader receives TERM before its process
group: closing producer pipes lets GPUI and o8d drain. The launcher reaps children
and verifies released ports before reporting successful shutdown. Surviving
descendants receive bounded escalation. Orphan receipts require a proven install,
profile, kernel birth identity, server working directory, orphan parent, and
process group. Stale identity and unproven moved-install receipts are removed without signalling. A moved install is adopted only with matching data directory and birth identity, an orphan group leader, the server working directory, and a `node` executable beneath the old launcher directory. Other unresolved live ownership is refused.

The original orphan failure came from comparing mutable command text across
interpreter exec. A stable kernel birth identity replaces that comparison. The
original port-release assertion remains in the real-entry test.

## Restart handoff for step 4

`launcher.sock` accepts newline-terminated JSON followed by write-side EOF:
`{"op":"prepare-restart"}`, `{"op":"cancel-restart","reservation":"…"}`,
and `{"op":"restart","reservation":"…"}`. Preparation returns a reservation.
Restart uses the shared final work inspection and cloud-job drain before stopping
children. An `admitted` response is admission, not a shutdown receipt; an updater
must wait for process exit and port release, then retain ownership and instance
exclusion across its handoff. Feed, signature, download, replacement, and relaunch
logic remain step 4 work.

## Verification and limits

Run `cargo test --locked --manifest-path crates/o8-launcher/Cargo.toml -- --test-threads=1`.
The tests spawn this binary with fixture servers and windows in temporary
directories on free ports. They cover health and boot identity, environment,
crash/restart exhaustion, shutdown during retry/preflight, drain ordering and
descendant pipe drain, second launch, ownership refusal and orphan cleanup,
private files, bounded control input, voice-only suppression, and injected dialog.
`tests/launcher-binary-real-path.test.ts` runs these tests and isolated shared
unit tests in the Linux integration lane.

Dock reopen, unhide/focus, native quit, and native failure-alert appearance need a
live macOS check before a packaging switch. The shell check also needs generated
helpers and frontend assets. Optional helper installation remains shell-owned;
the launcher forwards an existing `O8_CODEBASE_MEMORY_BIN` and bundled helper
paths. This crate does not download helpers or implement updater, voice, menu,
signing, or packaging changes.

Native termination **needs live check** before bundling. Do this on an isolated
macOS test account with no unsaved work:

1. From the repository root, build with `cargo build --locked --manifest-path
   crates/o8-launcher/Cargo.toml`. Generate an isolated fixture configuration:

   ```sh
   python3 - <<'PYFIXTURE'
   import json, pathlib, tempfile
   source = pathlib.Path('crates/o8-launcher/tests/support/mod.rs').read_text()
   script = source.split('let script = r#"', 1)[1].split('"#;', 1)[0]
   root = pathlib.Path(tempfile.mkdtemp(prefix='o8-launch-live-', dir='/tmp'))
   for name in ['node', 'dialog', 'window', 'probe', 'focus']:
       path = root / name
       path.write_text(script)
       path.chmod(0o700)
   for name in ['server.js', 'ws-server.mjs']:
       (root / name).write_text('fixture')
   config = dict(data_dir=str(root), server_dir=str(root), node=str(root/'node'),
                 window=str(root/'window'), dialog=str(root/'dialog'),
                 probe=str(root/'probe'), focus=str(root/'focus'), version='fixture',
                 api_port=0, ws_port=0, native_lifecycle=True)
   (root/'config.json').write_text(json.dumps(config))
   print(root/'config.json')
   PYFIXTURE
   ```

   Run `crates/o8-launcher/target/debug/o8-launcher --config <printed-path>`.
   If using `CARGO_TARGET_DIR`, use that directory's `debug/o8-launcher` instead.
2. Launch from a terminal. Record child PIDs and the published temporary ports.
3. Choose Quit from the Dock. Confirm both servers exit, both ports can be bound,
   and the launcher exits without requiring a second Quit.
4. Relaunch with a new temporary directory. Request logout, then repeat separately
   for restart and shutdown. Confirm the system action proceeds after cleanup.
5. Repeat with an injected server that ignores TERM. Confirm bounded escalation,
   port release, and system action completion. If cleanup fails, confirm the
   shutdown error is logged and the termination reply still permits the action.
6. Relaunch with a fresh fixture directory, remove only that temporary directory's
   `launcher-api.json`, then request Quit or logout. Confirm the receipt cleanup
   error is logged before exit, both ports are released, and the action proceeds.

These steps have not been run here. Headless fixtures test the same termination
state's later/allow decision on successful and failed stop; they do not exercise
AppKit or authorize switching packaging. Pending spawn receipts and Linux
subreaper orphan adoption remain follow-up work in #6143.
