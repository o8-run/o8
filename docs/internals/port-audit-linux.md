# Linux Port Structural Audit

Scope: greenfield Linux blockers and structural seams in the current o8 implementation.

## Linux surface support table

Three surfaces are macOS-native code paths with no Linux implementation. Each has an in-app fallback rather than a crash — the feature reads as unavailable, not broken.

| Surface | Status on Linux | Why | Fallback |
| --- | --- | --- | --- |
| Voice dictation (Symon push-to-talk, `Fn`/right-`Option` hotkeys, on-device Apple transcription) | Unsupported | The Symon capture stack is a native macOS Swift binary driven through the Accessibility API; it is not built for Linux at all. The composer's own mic-button dictation path (`useDictation.ts`) additionally depends on WebKitGTK's `MediaRecorder`/`getUserMedia`/`SpeechRecognition` support, which is unverified on this platform (see "Web mic and recorder APIs need Linux WebKitGTK validation" below). Linux backends now exist in `crates/o8-linux-voice` but dictation is not wired into the shell yet: `o8-speech-recognizer` speaks the Swift helper's protocol with on-device whisper.cpp (model downloaded on demand to `~/.o8/models/whisper`), and `audio_ducker` ducks through `pactl`. | Type directly into the composer; there is no voice input path today on Linux. Read-aloud's offline floor is the system engine (`system_tts_speak`: piper, espeak-ng or spd-say), then WebKitGTK speechSynthesis. |
| Native browser pane (embedded Browser tab / canvas browser cards, agent-grab) | Unsupported | `src-tauri/src/browser_view.rs` builds the pane as a native AppKit child window; the `#[cfg(not(target_os = "macos"))]` stubs for `open`/`eval`/`navigate` compile to no-ops (`open` returns `Ok(())` with no window ever created, `eval` returns `false`, `eval_result` returns the literal error `"native browser-view is macOS-only"`). | The pane's own "Open in Browser tab" / external-open control (`openExternal` in `src/components/desktop/O8BrowserPane.tsx`, backed by `openExternalUrl`) opens the same URL in the system default browser instead of the embedded webview. |
| Folder/file picker (`osascript`-backed native chooser) | Unsupported | `src/app/api/panel/browse-folder/route.ts` and the `pick` action in `src/app/api/panel/file-io/route.ts` shell out to `osascript`/AppleScript. On Linux `osascript` does not exist, so the `execSync`/`execFileAsync` call throws `ENOENT`; both routes catch that and return `{ path: null }` — the same shape as a user cancelling. | Callers (`pickRepoFolder.ts`, `AddRepoDialog.tsx`, `OnboardingReposStep.tsx`) treat a null path as "no native picker available" and fall through to a manual path-entry prompt (`requestPrompt`) — the operator types the absolute folder/file path directly. |

## Executive Top 10 Greenfield Findings

The remaining open Linux blockers are release artifacts ([#1898](https://github.com/o8-run/o8/issues/1898)), installed deep-link and bundle registration ([#1899](https://github.com/o8-run/o8/issues/1899)), and stale-listener reclaim ([#1926](https://github.com/o8-run/o8/issues/1926)).

1. **FIXED — Linux Tauri builds could fail before launch because macOS voice sidecars were bundled unconditionally.** Fixed by commit `0436a4845f`: `src-tauri/tauri.macos.conf.json:3-7` now scopes the sidecars to the macOS bundle, and `src-tauri/build.rs:163` gates the recognizer build to macOS. Blocks: none from this finding.
2. **BLOCKER — The ship/updater pipeline publishes only macOS artifacts and Darwin `latest.json` platforms.** Evidence: `scripts/release.mjs:93`, `scripts/release.mjs:194-203`. Follow-up: [#1898](https://github.com/o8-run/o8/issues/1898). Blocks: desktop client.
3. **FIXED — Native Node addons were copied from the build host and then forced through a macOS-only multi-ABI bundle path.** Fixed by commit `739748f267`: `scripts/tauri-export.mjs:527-558` keeps the host-compiled modules for non-Darwin builds and runs the multi-ABI selector only on Darwin. Blocks: none from this finding.
4. **BLOCKER — Linux runtime deep-link delivery exists, but installed `.desktop`/MIME registration and Linux bundle targets remain unverified.** Evidence: `src-tauri/tauri.linux.conf.json:20-23`, `src-tauri/src/lib.rs:6981-6991`, `src-tauri/src/lib.rs:7262-7324`. Follow-up: [#1899](https://github.com/o8-run/o8/issues/1899). Blocks: desktop client.
5. **BLOCKER (PARTIALLY FIXED) — Tracked-child shutdown now splits Unix and Windows process killing, but stale-listener reclaim remains macOS-only.** Fixed slice: commit `62e7bbb977`, `src-tauri/src/sidecar_lifecycle.rs:241-278`. Open slice: `src-tauri/src/sidecar_lifecycle.rs:746-748` returns `false` off macOS from Linux-reachable callers at `src-tauri/src/lib.rs:925`, `src-tauri/src/lib.rs:7656`, and `src-tauri/src/lib.rs:7675`. Follow-up: [#1926](https://github.com/o8-run/o8/issues/1926). Blocks: desktop client.
6. **STRUCTURAL — Headless live-session/orphan logic depends on optional `lsof`, `pgrep`, and GNU/BSD `ps` shapes.** Evidence: `src-tauri/src/sidecar_lifecycle.rs:219`, `src-tauri/src/sidecar_lifecycle.rs:319`, `src/lib/runtimes/claude-code.ts:721`, `src/lib/runtimes/shared/codex-process-cwd.ts:37`. Blocks: headless node.
7. **STRUCTURAL — Native Browser Pane / agent-grab is compiled as macOS-only and silently no-ops on Linux.** Evidence: `src-tauri/src/browser_view.rs:60`, `src-tauri/src/browser_view.rs:90`, `src-tauri/src/browser_view.rs:333`, `src-tauri/src/browser_view.rs:353`. Blocks: desktop client.
8. **STRUCTURAL — Repo/file picker API routes shell out to `osascript`, so Linux desktop chooser flows return null.** Evidence: `src/app/api/panel/browse-folder/route.ts:7`, `src/app/api/panel/browse-folder/route.ts:21`, `src/app/api/panel/file-io/route.ts:133`, `src/app/api/panel/file-io/route.ts:150`. Blocks: desktop client.
9. **ADJUSTMENT — Web dictation/realtime voice uses WebKitGTK-sensitive `getUserMedia`, `MediaRecorder`, and browser speech APIs, independent of the known Swift/Symon cut.** Evidence: `src/components/desktop/dictation/useDictation.ts:9`, `src/components/desktop/dictation/useDictation.ts:46`, `src/components/desktop/dictation/useDictation.ts:170`, `src/lib/voice/realtime-client.ts:206`. Blocks: desktop client.
10. **ADJUSTMENT — First-run autostart/background settings use macOS launch semantics while the UI exposes a generic launch-at-login control.** Evidence: `src-tauri/src/lib.rs:4709`, `src-tauri/src/background.rs:13`, `src-tauri/src/background.rs:122`, `src-tauri/src/background.rs:183`. Blocks: desktop client.

## Full Catalog

### Packaging, Build, and Distribution

#### Unconditional macOS sidecars in Linux Tauri bundle (fixed)

- Severity: FIXED (was BLOCKER)
- Blocks: none from this finding
- Known vs greenfield: GREENFIELD. The inception docs say the voice/Symon stack is Mac-only; they do not call out that sidecar packaging can break a Linux build even when voice is out of scope.
- Status: FIXED by commit `0436a4845f`.
- Evidence:
  - Original finding: the base bundle declared `helpers/speech_recognizer` and `helpers/speech-local`, while their generators produced only Darwin binaries.
  - `src-tauri/tauri.macos.conf.json:3-7` now declares both sidecars only in the macOS bundle patch.
  - `src-tauri/build.rs:163` gates the recognizer build behind `#[cfg(target_os = "macos")]`.
- Why it broke on Linux: the bundle validator required Darwin-only sidecars before launch even though voice was out of scope.
- Resolution: non-Darwin targets no longer declare the voice sidecars, so their host builds do not require Darwin binaries.

#### Mac-only release and updater artifacts

- Severity: BLOCKER
- Blocks: desktop client only
- Known vs greenfield: GREENFIELD.
- Status: OPEN. Tracked by [#1898](https://github.com/o8-run/o8/issues/1898).
- Evidence:
  - `scripts/release.mjs:93` still gates a release preparation step on Darwin.
  - `scripts/release.mjs:194-203` emits only `darwin-x86_64` and `darwin-aarch64` updater platforms.
  - `src/lib/app-update/client-restart.ts:49` uses the Tauri updater uniformly from the client.
- Why it breaks on Linux: Linux installs will never see a matching updater platform in `latest.json`. `UpdateCard` can keep checking and attempting install semantics that only make sense for the Darwin asset set.
- Suggested direction: decide the Linux distribution floor and package channels first. If AppImage is the only auto-updatable Linux channel, gate the silent/idle update UX by package type and send deb/rpm users to manual download or distro repository instructions.

#### Native Node addon ABI/OS coupling (fixed)

- Severity: FIXED (was STRUCTURAL)
- Blocks: none from this finding
- Known vs greenfield: GREENFIELD.
- Status: FIXED by commit `739748f267`.
- Evidence:
  - Original finding: the export copied host-native modules and then unconditionally ran the Darwin multi-ABI and signing path.
  - `scripts/tauri-export.mjs:527-535` copies the host-compiled native modules into the server bundle.
  - `scripts/tauri-export.mjs:538-558` runs multi-ABI selection and signing only on Darwin; non-Darwin builds keep the host-compiled modules.
- Why it broke on Linux: the export path treated Darwin's two-architecture artifact as a requirement for every host.
- Resolution: Linux exports retain native modules compiled on the Linux build host and skip Darwin-only selection and signing.

#### WebKitGTK floor is implicit

- Severity: ADJUSTMENT
- Blocks: desktop client only
- Known vs greenfield: PARTIALLY KNOWN. WebKitGTK testing is known; the packaging floor is not.
- Evidence:
  - `src-tauri/Cargo.lock:6180` includes `webkit2gtk` through Tauri/Wry.
  - `src-tauri/Cargo.toml:33` pins Tauri `2.10.3`.
  - `src-tauri/tauri.conf.json:45` uses `targets: "all"` without per-distro floor.
- Why it breaks on Linux: Tauri v2 Linux packages depend on system WebKitGTK packages whose names and versions vary by Ubuntu/Debian/Fedora/Arch. No code currently states a floor or package prerequisite.
- Suggested direction: pick Ubuntu 24.04 LTS as the practical floor for desktop testing and publish dependency notes for Debian/Fedora/Arch. Headless node should not depend on WebKitGTK at all.

### Tauri Desktop Shell

#### Linux installed deep-link and bundle registration remains open

- Severity: BLOCKER
- Blocks: desktop client only
- Known vs greenfield: GREENFIELD.
- Status: OPEN. Runtime delivery and scheme configuration exist, but installed `.desktop`/MIME registration and Linux bundle proof remain in [#1899](https://github.com/o8-run/o8/issues/1899).
- Evidence:
  - Original finding: only the macOS plist and `RunEvent::Opened` path handled the URL scheme.
  - `src-tauri/tauri.linux.conf.json:20-23` now configures the `o8` scheme for Linux.
  - `src-tauri/src/lib.rs:6981-6991` and `src-tauri/src/lib.rs:7262-7324` now provide Linux runtime delivery and registration.
  - The repository still has no tracked `.desktop` entry that proves the installed MIME handler, and the Linux package targets have not been verified.
- Why it remains open on Linux: runtime handling does not prove that an installed package registers `x-scheme-handler/o8` or emits the intended Linux bundle targets.
- Suggested direction: generate and inspect the installed `.desktop` entry and validate each supported Linux bundle target.

#### Stale-listener kill path remains compiled out on Linux

- Severity: BLOCKER (tracked-child shutdown slice fixed)
- Blocks: desktop client only
- Known vs greenfield: GREENFIELD.
- Status: OPEN. Tracked by [#1926](https://github.com/o8-run/o8/issues/1926).
- Evidence:
  - Fixed by commit `62e7bbb977`: `src-tauri/src/sidecar_lifecycle.rs:241-278` splits tracked-child shutdown into Unix and Windows implementations.
  - `src-tauri/src/lib.rs:925`, `src-tauri/src/lib.rs:7656`, and `src-tauri/src/lib.rs:7675` still call `kill_orphan_and_wait` on Linux-reachable stale-listener paths.
  - `src-tauri/src/sidecar_lifecycle.rs:709-748` implements `kill_orphan_and_wait` only for macOS and returns `false` off macOS.
- Why it breaks on Linux: the identity-gated port allocator can identify a stale o8 listener, call the helper, and still fail to reclaim the port because the Linux branch is a no-op.
- Suggested direction: promote the Unix `term_then_kill` and bind-poll logic into a Linux-capable helper. Avoid relying on `lsof` where `/proc/<pid>` is available.

#### Native Browser Pane is macOS-only

- Severity: STRUCTURAL
- Blocks: desktop client only
- Known vs greenfield: GREENFIELD for Linux client; the inception doc only says the native browser-view stays local for remote-node MVP.
- Evidence:
  - `src-tauri/src/browser_view.rs:60` gates `open` on macOS.
  - `src-tauri/src/browser_view.rs:90` creates a `WebviewWindowBuilder` with external URL and initialization script.
  - `src-tauri/src/browser_view.rs:308` attaches as an AppKit child window.
  - `src-tauri/src/browser_view.rs:333` makes non-macOS `open` return `Ok(())`; `src-tauri/src/browser_view.rs:353` makes eval return `native browser-view is macOS-only`.
- Why it breaks on Linux: the UI can believe the browser pane opened, while the native window and eval/agent-grab path do nothing.
- Suggested direction: either hide Browser Pane agent-grab on Linux or implement a Wry/WebKitGTK-specific host path with explicit feature detection and honest UI capability flags.

#### Autostart/background semantics are macOS-shaped

- Severity: ADJUSTMENT
- Blocks: desktop client only
- Known vs greenfield: GREENFIELD.
- Evidence:
  - `src-tauri/src/lib.rs:4709` initializes autostart with `MacosLauncher::LaunchAgent`.
  - `src-tauri/src/background.rs:13` says launch-at-login defaults ON.
  - `src-tauri/src/background.rs:122` enables autostart on first run.
  - `src-tauri/src/background.rs:183` opens macOS System Settings targets and no-ops off macOS.
- Why it breaks on Linux: Linux autostart is `.desktop` based, desktop-environment-dependent, and not tied to macOS voice hotkeys. The Settings UI can show a generic launch-at-login switch whose reason and behavior are Mac-specific.
- Suggested direction: gate default-on autostart to macOS voice builds; on Linux make it opt-in and verify the plugin writes a valid autostart `.desktop` entry.

#### Tray and notifications need Linux runtime dependencies

- Severity: ADJUSTMENT
- Blocks: desktop client only
- Known vs greenfield: GREENFIELD.
- Evidence:
  - `src-tauri/Cargo.toml:33` enables Tauri tray icons.
  - `src-tauri/Cargo.lock:7070` includes `libappindicator`.
  - `src-tauri/src/lib.rs:2676` builds a tray menu and `src-tauri/src/lib.rs:2776` sends native notifications.
  - `src-tauri/tauri.conf.json:37` defines a tray icon.
- Why it breaks on Linux: tray visibility depends on AppIndicator support and distro packages such as libayatana-appindicator; notifications depend on a desktop portal/notification daemon.
- Suggested direction: document Linux package prerequisites and add startup capability logging so a missing tray backend is visible rather than silent.

### Headless Execution Node

#### Live session discovery depends on optional userland tools

- Severity: STRUCTURAL
- Blocks: headless node
- Known vs greenfield: GREENFIELD.
- Evidence:
  - `src/lib/runtimes/shared/codex-process-cwd.ts:37` shells to `ps`; `src/lib/runtimes/shared/codex-process-cwd.ts:63` shells to `lsof`.
  - `src/lib/codex/sessions.ts:274` reads process CWD through `lsof`.
  - `src/lib/codex/sessions.ts:291` parses environment using `ps eww`.
  - `src/lib/runtimes/claude-code.ts:721` uses `bash -c "ps ... | grep ..."`, then `src/lib/runtimes/claude-code.ts:737` uses `lsof`.
  - `src-tauri/src/sidecar_lifecycle.rs:319` uses `pgrep`; `src-tauri/src/sidecar_lifecycle.rs:346` uses `lsof`; `src-tauri/src/sidecar_lifecycle.rs:365` and `src-tauri/src/sidecar_lifecycle.rs:384` use `ps`.
- Why it breaks on Linux: `lsof` is often absent from minimal server images, `pgrep` lives in procps, and `ps` flags/output vary. On a headless node this degrades liveness, ownership, interrupt, and orphan cleanup.
- Suggested direction: create a Linux process-inspection provider using `/proc/<pid>/cwd`, `/proc/<pid>/cmdline`, `/proc/<pid>/environ`, and `/proc/net/tcp*`; keep shell-outs as fallback.

#### Local filesystem adjacency remains in merge and cleanup paths

- Severity: STRUCTURAL
- Blocks: headless node
- Known vs greenfield: KNOWN for merge via local-path fetch; GREENFIELD for cleanup/status implications.
- Evidence:
  - `src/lib/lane/worktree-side-merge.ts:145` takes both `repoPath` and `worktreePath`.
  - `src/lib/lane/worktree-side-merge.ts:151` fetches from the worktree filesystem path.
  - `src/lib/lane/worktree-side-merge.ts:183` fetches from the main repo path back into the worktree.
  - `src/lib/lane/worktree-side-merge.ts:616` creates a local manager from `lane.repoPath`; `src/lib/lane/worktree-side-merge.ts:619` maps by local path.
- Why it breaks on Linux headless: the inception doc already calls out merge-via-local-path-fetch; the adjacent cleanup/status code also assumes the control plane can stat and manage the same worktree path.
- Suggested direction: model `worktreeHost` explicitly. Remote nodes should compute diff/status/cleanup on the node and send artifacts; central o8 should merge from origin refs only.

#### Node discovery is desktop-login-shell oriented

- Severity: ADJUSTMENT
- Blocks: desktop client and headless node
- Known vs greenfield: GREENFIELD.
- Evidence:
  - `src-tauri/src/lib.rs:1211` describes `zsh -> bash -> sh` login-shell node lookup.
  - `src-tauri/src/lib.rs:1236` looks for Homebrew Node paths at `/opt/homebrew` and `/usr/local/opt`.
  - `src-tauri/src/lib.rs:1280` tries `zsh -l`, `bash -l`, then `sh -l`.
  - `src-tauri/src/lib.rs:1349` includes `Library/pnpm` plus XDG pnpm paths.
- Why it breaks on Linux: headless systemd/SSH services may not have `zsh`, interactive shell init, Homebrew, or user dotfiles. The intended node binary should be part of the execution-node contract, not inferred from desktop login behavior.
- Suggested direction: require an explicit `O8_NODE_BIN` or packaged Node for headless nodes; keep login-shell discovery only for interactive desktop installs.

#### Development script cleanup uses `lsof`

- Severity: ADJUSTMENT
- Blocks: headless node and developer Linux workflows
- Known vs greenfield: GREENFIELD.
- Evidence:
  - `package.json:43` uses `lsof -ti :3010 -sTCP:LISTEN | xargs kill -9`.
  - `src/ws-server.ts:5716` also uses `lsof` to find listeners before binding.
- Why it breaks on Linux: dev scripts and server startup cleanup fail on minimal systems where `lsof` is not installed.
- Suggested direction: replace port discovery with a Node implementation or Linux `/proc` fallback; keep `lsof` as an optional fast path.

### Filesystem and Worktree Semantics

#### APFS clone path is safely gated but its config still leaks into cross-platform planning

- Severity: ADJUSTMENT
- Blocks: neither by default; headless performance feature only
- Known vs greenfield: GREENFIELD.
- Evidence:
  - `src/lib/worktree/apfs.ts:78` disables APFS CoW outside Darwin.
  - `src/lib/worktree/manager.ts:50` has `O8_APFS_COW_WORKSPACES`.
  - `src/lib/worktree/manager.ts:972` documents `cp -cR`.
  - `src/lib/worktree/manager.ts:993` shells to `cp -cR` only after APFS capability passes.
- Why it matters on Linux: this does not currently break Linux because capability gating is correct, but Linux execution nodes need a different fast hydration story for large repos.
- Suggested direction: document Linux as `git-worktree` only for now; later consider reflink-aware `cp --reflink=auto` under an explicit Linux capability detector.

#### Case-sensitive path scan did not find duplicate tracked source paths

- Severity: none
- Blocks: neither
- Known vs greenfield: GREENFIELD negative finding.
- Evidence:
  - `git ls-files 'src/*' | awk '{print tolower($0)}' | sort | uniq -d` produced no duplicates.
  - `find src -type f | sed 's#^src/##' | awk '{print tolower($0)}' | sort | uniq -d` produced no duplicates.
- Why it matters on Linux: Linux's case-sensitive default should not immediately explode due to duplicate source paths.
- Suggested direction: still rely on `npm run typecheck:fast` on Linux to catch import-case mismatches. Use `npm run typecheck:tsc` for the slower TypeScript 5.8.2 cross-check.

### WebKitGTK Structural Seams

#### Web mic and recorder APIs need Linux WebKitGTK validation

- Severity: ADJUSTMENT
- Blocks: desktop client only
- Known vs greenfield: GREENFIELD because this is the web dictation path, not the known Swift/Symon Mac stack.
- Evidence:
  - `src/components/desktop/dictation/useDictation.ts:9` selects `MediaRecorder` MIME types.
  - `src/components/desktop/dictation/useDictation.ts:46` probes browser `SpeechRecognition` / `webkitSpeechRecognition`.
  - `src/components/desktop/dictation/useDictation.ts:170` calls `navigator.mediaDevices.getUserMedia`.
  - `src/lib/voice/realtime-client.ts:206` gates realtime voice on `getUserMedia`.
- Why it breaks on Linux: WebKitGTK builds and distro GStreamer stacks vary in MediaRecorder/audio codec support, and Web Speech API availability is not a safe assumption.
- Suggested direction: make dictation capability-driven. Expose a disabled state on Linux unless `getUserMedia`, `MediaRecorder`, and accepted audio MIME are present.

#### `window.open` has mixed handling

- Severity: ADJUSTMENT
- Blocks: desktop client only
- Known vs greenfield: GREENFIELD.
- Evidence:
  - `src/lib/desktop/open-external.ts:4` says `window.open` is a no-op inside Tauri and wraps Tauri shell open.
  - Some surfaces still call `window.open` directly, e.g. `src/components/desktop/settings/AboutTab.tsx:126`, `src/components/desktop/settings/GitHubTab.tsx:322`, and `src/components/desktop/thoughts/mission-panel/review-card/PacketBuyinDocPane.tsx:47`.
- Why it breaks on Linux: even if WebKitGTK allows popups in some cases, direct `window.open` behavior is inconsistent with the Tauri shell-open wrapper and can silently fail.
- Suggested direction: route all desktop external opens through `openExternalUrl`; treat raw `window.open` as web/mobile only.

#### Service worker logic is Tauri-gated but Linux desktop still needs confirmation

- Severity: ADJUSTMENT
- Blocks: desktop client only
- Known vs greenfield: GREENFIELD.
- Evidence:
  - `src/app/layout.tsx:61` registers service worker cleanup only when `!window.__TAURI_INTERNALS__`.
  - `src/lib/mobile/push-client.ts:59` registers `sw-push.js` for mobile push.
- Why it matters on Linux: the Tauri internal marker must be present in WebKitGTK consistently; otherwise desktop could register/retain mobile push service workers in the app webview.
- Suggested direction: verify the marker on Linux WebKitGTK and consider a server-injected desktop flag independent of Tauri internals.

### Security, Data, and OS Integration

#### Key storage has a Linux fallback but not a secret-service integration

- Severity: ADJUSTMENT
- Blocks: neither for launch; impacts desktop security posture
- Known vs greenfield: GREENFIELD.
- Evidence:
  - `src/lib/db/master-key.ts:5` says `O8_MASTER_KEY` wins for headless/CI.
  - `src/lib/db/master-key.ts:6` uses macOS Keychain only on Darwin.
  - `src/lib/db/master-key.ts:42` creates `~/.o8/master-key`.
  - `src/lib/db/master-key.ts:54` writes mode `0600`.
- Why it matters on Linux: the fallback is operationally workable, but Linux desktop installs usually expect Secret Service/KWallet/GNOME Keyring for long-lived app secrets.
- Suggested direction: keep file fallback for headless nodes, but consider `libsecret`/Secret Service for full desktop client if Linux becomes a supported user-facing platform.

#### Unix socket path is acceptable but token/socket lifecycle needs Linux multi-user testing

- Severity: ADJUSTMENT
- Blocks: neither by default
- Known vs greenfield: GREENFIELD.
- Evidence:
  - `src-tauri/src/lib.rs:4743` defaults `O8_TAURI_MCP_SOCKET` to `/tmp/tauri-mcp-o8-<user>.sock`.
  - `src-tauri/src/lib.rs:4751` writes a token beside the socket with `0600`.
  - `src-tauri/src/sidecar_lifecycle.rs:495` cleans stale socket files on Unix.
- Why it matters on Linux: `/tmp` is sticky and shared; username-derived paths avoid most collisions but not all container/user-namespace edge cases.
- Suggested direction: prefer `$XDG_RUNTIME_DIR/o8/tauri-mcp.sock` on Linux when available; keep `/tmp` as fallback.

## What the Inception Docs Already Cover

No credit taken for these already-known items:

- WebKitGTK needs testing for the Linux desktop client.
- Vibrancy/glass should fall back to solid surfaces on Win/Linux.
- Voice/Symon native stack is Mac-only and should be cut from remote/headless scope.
- Merge via local-path fetch is the central remote-node wall.
- tmux persistence is a good Linux primitive and should remain part of the headless node design.
- Windows is a larger and separate campaign.
