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
descendants receive bounded escalation. Orphan receipts require this install,
profile, kernel birth identity, server working directory, orphan parent, and
process group; unresolved receipts are preserved and refused.

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

Current review state: WIP. The launcher passes 34 macOS and Linux fixture/unit
tests, and the shared crate passes 19 macOS tests. Repository verification is
blocked by the existing provider-instance encryption suite: both the full Linux
run and an isolated rerun fail with "Master key unavailable or changed". The
two-failure limit stops this correction round; the failure and verification
receipts are recorded in the pull request.
