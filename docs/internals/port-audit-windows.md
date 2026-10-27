# Windows Port Structural Audit

Scope: greenfield structural Windows risks in the current o8 implementation. Static audit only.

## Executive Top 10 Greenfield Findings

1. **Updater metadata publishes only Darwin artifacts, so Windows clients have no update channel** — BLOCKER — `scripts/release.mjs:48`, `scripts/release.mjs:50`, `scripts/release.mjs:109`, `scripts/release.mjs:114`
2. **Tauri handles `o8://` callbacks only in a macOS `RunEvent::Opened` branch and has no Windows protocol registration** — BLOCKER — `src-tauri/src/lib.rs:4568`, `src-tauri/src/lib.rs:5624`, `src-tauri/src/lib.rs:5625`, `src-tauri/tauri.conf.json:68`
3. **Tracked sidecar shutdown calls the Unix `kill` binary from un-cfg'd Rust used by update relaunch** — BLOCKER — **Fixed in #1739** — `src-tauri/src/sidecar_lifecycle.rs:25`, `src-tauri/src/sidecar_lifecycle.rs:40`, `src-tauri/src/sidecar_lifecycle.rs:55`, `src-tauri/src/lib.rs:1772`
4. **Node 22/better-sqlite3 ABI pin has no Windows resolver while Node bundling is disabled** — BLOCKER — `src-tauri/src/lib.rs:1215`, `src-tauri/src/lib.rs:1236`, `scripts/bundle-node.mjs:23`, `scripts/bundle-node.mjs:28`
5. **Packaged sidecars list macOS helper names only, including voice helpers not built for Windows** — BLOCKER — `src-tauri/tauri.conf.json:47`, `src-tauri/tauri.conf.json:48`, `src-tauri/tauri.conf.json:49`, `src-tauri/build.rs:80`
6. **WebView local trust/CORS allowlists trust `tauri://localhost` but not WebView2 `.localhost` origins** — BLOCKER — `src/middleware.ts:150`, `src/middleware.ts:154`, `src/ws-server.ts:4558`, `src/ws-server.ts:4561`
7. **Bundled `o8` CLI is a POSIX shell wrapper with no `.cmd`/PowerShell shim** — STRUCTURAL — `scripts/tauri-export.mjs:581`, `scripts/tauri-export.mjs:588`, `scripts/tauri-export.mjs:598`, `scripts/tauri-export.mjs:606`
8. **Worktree cleanup lacks Windows file-lock retry/quarantine semantics** — STRUCTURAL — `src/lib/worktree/manager.ts:1245`, `src/lib/worktree/manager.ts:1258`, `src/lib/worktree/manager.ts:1330`, `src/lib/lane/worktree-side-merge.ts:774`
9. **Worktree setup symlinks `node_modules`, which needs elevated/developer-mode semantics on Windows** — STRUCTURAL — `src/lib/worktree/manager.ts:895`, `src/lib/worktree/manager.ts:901`, `src/lib/worktree/manager.ts:978`, `src/lib/worktree/manager.ts:981`
10. **Tauri window config ships macOS chrome assumptions to all targets** — ADJUSTMENT — `src-tauri/tauri.conf.json:13`, `src-tauri/tauri.conf.json:23`, `src-tauri/tauri.conf.json:25`, `src-tauri/tauri.conf.json:30`

## Tauri Shell And OS Integration

### Windows update channel is missing from `latest.json`

- Evidence: the release script hardcodes macOS bundle paths (`scripts/release.mjs:48`, `scripts/release.mjs:50`) and writes only `darwin-x86_64` and `darwin-aarch64` platform entries (`scripts/release.mjs:109`, `scripts/release.mjs:114`).
- Why Windows breaks: Tauri updater requires a Windows platform key and a Windows installer/update artifact. A Windows build can check forever and never see an applicable update.
- Linux impact: Yes; Linux platform keys are also absent.
- Known vs greenfield: Greenfield. The inception docs mention per-OS signing/CI, not that the shipped updater manifest excludes all non-Darwin platforms.
- Direction: Split artifact discovery by target and publish NSIS/MSI plus Linux artifacts into the shared manifest/upload path.

### `o8://` runtime handling is macOS-only and packaging does not register Windows protocol activation

- Evidence: the pending auth callback buffer is documented for `o8://auth/callback` (`src-tauri/src/lib.rs:4568`), but the handler is behind `#[cfg(target_os = "macos")]` (`src-tauri/src/lib.rs:5624`, `src-tauri/src/lib.rs:5625`). The Tauri config only configures the updater plugin block (`src-tauri/tauri.conf.json:68`) and has no deep-link/protocol bundle entry.
- Why Windows breaks: Windows protocol activation must be registered by the installer/registry and delivered to an existing or newly launched process. Current code neither registers it nor handles it on Windows.
- Linux impact: Yes; Linux needs `.desktop`/MIME protocol registration and equivalent runtime handoff.
- Known vs greenfield: Greenfield. The baseline mentions DPAPI and signing, not auth callback protocol wiring.
- Direction: Add a cross-platform deep-link plugin/registration plan and single-instance handoff tests for cold launch and already-running callback delivery.

### Tauri window definition is macOS-shaped across all targets

- Evidence: `macOSPrivateApi` is enabled globally (`src-tauri/tauri.conf.json:13`), the main window uses overlay titlebar (`src-tauri/tauri.conf.json:23`), traffic-light coordinates (`src-tauri/tauri.conf.json:25`), and transparency (`src-tauri/tauri.conf.json:30`).
- Why Windows breaks: WebView2 does not have macOS traffic lights and has different transparent-window hit-testing/chrome rules. A shared config risks unsupported settings, invisible drag areas, or broken system controls.
- Linux impact: Partial; Linux also needs non-macOS chrome, but Windows hit testing is the larger risk.
- Known vs greenfield: Greenfield. The baseline covers vibrancy fallback, not titlebar and traffic-light chrome.
- Direction: Build the main window with per-OS config or split config files so Windows gets native decorations/custom-titlebar logic explicitly.
- Resolved (#1743): `src-tauri/tauri.windows.conf.json` and `src-tauri/tauri.linux.conf.json` overlay the main window with `decorations: true` + `transparent: false`; the macOS-only keys (overlay titlebar, hidden title, traffic-light position) simply drop out. **Editing the window object in `tauri.conf.json` means editing all three files** — tauri-utils merges platform overlays with RFC 7386 JSON Merge Patch, which REPLACES arrays wholesale, so `app.windows` has to be restated in full and a key added only to the base is silently lost off macOS. The frontend half: `window.__O8_HOST_PLATFORM__` (stamped by the main window's initialization script) pins `surface = 'solid'` and suppresses the DOM traffic lights off macOS. A Linux shell launched with `O8_LINUX_GLASS=1` is the one opt-in exception: the initialization script also stamps `window.__O8_LINUX_GLASS__ = true`, the theme keeps the glass surface and defaults All Glass on (a stored All Glass opt-out still wins), and `globals.css` paints a fixed gradient backdrop under `html[data-linux-glass='true']` because the window stays opaque (`tauri.linux.conf.json`, `transparent: false`). Traffic lights, keychain and permission checks still follow `isNonMacShell()`.

## Sidecar And Process Lifecycle

### Update relaunch depends on Unix `kill`

- Evidence: `kill_tracked_children()` is compiled for all platforms (`src-tauri/src/sidecar_lifecycle.rs:25`) but shells out to `kill -TERM` (`src-tauri/src/sidecar_lifecycle.rs:40`) and `kill -KILL` (`src-tauri/src/sidecar_lifecycle.rs:55`). `restart_app()` calls it before app restart (`src-tauri/src/lib.rs:1772`, `src-tauri/src/lib.rs:1774`).
- Why Windows breaks: Windows has no POSIX `kill` command or signal semantics. The app can relaunch after update while old Next/ws-server children continue holding ports, or cleanup simply fails.
- Linux impact: No for normal Linux hosts.
- Known vs greenfield: Greenfield extension. The baseline calls out Unix signal/process-model gaps generally; this concrete un-cfg'd relaunch cleanup path is a separate blocker.
- Direction: Introduce a platform process-tree supervisor: Job Objects on Windows, current signal path on Unix, and confirm port release before relaunch.
- Status: **Fixed in #1739.** `kill_tracked_children()` now cfg-branches instead of un-cfg'd shelling to `kill`: the Unix TERM→wait→KILL escalation is unchanged, and Windows force-kills each tracked PID's full process tree via `taskkill /PID <pid> /T /F` in one shot (there is no SIGTERM-equivalent step to escalate from on Windows). A Job Object per spawned child remains the more thorough tree-ownership model and is still open if `taskkill` proves insufficient in practice.

### Crash-survivable worker spawn has a Windows branch but no matching tree ownership model

- Evidence: owned sessions spawn Windows workers with `detached: true` (`src/lib/runtimes/shared/owned-session/store.ts:684`, `src/lib/runtimes/shared/owned-session/store.ts:687`) and then `unref()` them (`src/lib/runtimes/shared/owned-session/store.ts:712`). The documented reason is Unix-style `setsid+unref` crash survival (`src/lib/runtimes/shared/owned-session/store.ts:654`, `src/lib/runtimes/shared/owned-session/store.ts:656`).
- Why Windows breaks: Detached Windows children are not automatically grouped like Unix process groups. Stop/reset/update cleanup cannot rely on the same PID semantics, and descendants may survive while holding files/worktrees.
- Linux impact: No; the Unix model is intentional there.
- Known vs greenfield: Greenfield. This is the post-spawn ownership problem, distinct from the known tmux/ConPTY rewrite.
- Direction: Persist a Windows Job Object or equivalent process-tree handle for every owned run and route interruption/escalation through it.

## Release, Installer, And Bundled Runtime

### Node 22 is required but Windows discovery is absent and bundling is disabled

- Evidence: Node 22 is the preferred/supported ABI major (`src-tauri/src/lib.rs:1215`, `src-tauri/src/lib.rs:1222`), discovery scans `.nvm`, `.fnm`, `.volta`, and Homebrew paths (`src-tauri/src/lib.rs:1236` through `src-tauri/src/lib.rs:1241`), and the old bundling script exits immediately with "Node.js bundling disabled" (`scripts/bundle-node.mjs:23`, `scripts/bundle-node.mjs:28`).
- Why Windows breaks: Windows users commonly install Node through MSI, winget, Chocolatey, Scoop, or nvm-windows. None of those locations are scanned, and "some node on PATH" is unsafe because better-sqlite3 is ABI-pinned.
- Linux impact: Partial; Linux has some Unix version-manager coverage but no distro/package-manager story.
- Known vs greenfield: Greenfield. The inception docs mention login-shell PATH; this is the deeper ABI distribution question.
- Direction: Either bundle Node per platform or implement a shared Windows-aware Node 22 locator used by Rust sidecar, MCP, CLI, and worker entrypoints.
- **Update (#1740):** the Tauri Rust sidecar boot path now has a Windows-native resolution strategy — `where node`, then nvm-windows/Volta/fnm/official-installer/winget/choco roots (`src-tauri/src/windows_node_locate.rs`, wired into `run_node_preflight` in `src-tauri/src/lib.rs`) — gated behind `cfg(target_os = "windows")` so macOS/Linux behavior is unchanged. `cli_locate::well_known_cli_bin_dirs()` gained matching Windows version-manager dirs for PATH augmentation. Node *bundling* and the MCP re-exec locator below remain open.

### MCP Node 22 re-exec repeats the Unix-only locator

- Evidence: the operator MCP locator yields `.nvm`, `.fnm`, `.volta`, `/opt/homebrew`, and `/usr/local` candidates (`src/lib/mcp/operator-node22-locator.ts:63`, `src/lib/mcp/operator-node22-locator.ts:86`) and warns with `brew install node@22` / `nvm install 22` guidance (`src/lib/mcp/operator-node22-locator.ts:126`, `src/lib/mcp/operator-node22-locator.ts:128`).
- Why Windows breaks: Even after the Tauri sidecar is fixed, packaged MCP servers may re-exec under the wrong Node or keep running under an ABI-incompatible Node.
- Linux impact: Partial.
- Known vs greenfield: Greenfield, because it identifies a second runtime entrypoint with its own resolver.
- Direction: Replace duplicated locators with one cross-platform Node 22 resolution module and Windows installer guidance.

### Packaged external sidecars are macOS-first

- Evidence: Tauri `externalBin` lists `helpers/speech_recognizer` and `helpers/speech-local` (`src-tauri/tauri.conf.json:47`, `src-tauri/tauri.conf.json:48`, `src-tauri/tauri.conf.json:49`). `build.rs` describes the Swift recognizer compile as macOS-specific (`src-tauri/build.rs:80`, `src-tauri/build.rs:84`).
- Why Windows breaks: Tauri validates externalBin paths for the target. Windows would need target-triple `.exe` sidecars or the externalBin list must be cfg/split so Windows packaging does not look for Swift/macOS helpers.
- Linux impact: Yes; Linux has the same validation issue unless sidecars are provided or removed per target.
- Known vs greenfield: Greenfield packaging detail. The baseline says voice/Symon is Mac-only; this is the build-time consequence in the bundle config.
- Direction: Split sidecar resources by OS and remove Mac voice helpers from Windows bundle targets.

### Bundled `o8` CLI wrapper is POSIX-only

- Evidence: `tauri-export` writes a `#!/bin/sh` wrapper (`scripts/tauri-export.mjs:581`), resolves symlinks with `readlink` (`scripts/tauri-export.mjs:588`), probes `zsh`/`bash`/`sh` for Node (`scripts/tauri-export.mjs:598`), and `chmod +x`s the wrapper (`scripts/tauri-export.mjs:606`).
- Why Windows breaks: There is no `.cmd`/PowerShell shim, POSIX symlink resolution, or execute bit. Worker callbacks that expect `o8` on PATH will not run.
- Linux impact: No, assuming POSIX shell tools exist.
- Known vs greenfield: Greenfield.
- Direction: Emit `o8.cmd` and `o8.ps1` beside `o8.mjs`, register an app-local bin path, and use `%O8_NODE_BIN%` or the shared Node resolver.
- Status (#1741): addressed for the shim + first-run PATH registration. `scripts/tauri-export.mjs` now emits `o8.cmd`/`o8.ps1` beside `o8.mjs`; `src-tauri/src/windows_cli_path.rs` copies them into `%USERPROFILE%\.o8\bin` and appends that directory to `HKCU\Environment\Path` on first launch (no elevation, mirrors the macOS symlink flow's contract); `cli/src/commands/install.ts`'s `o8 doctor --repair` gained the same win32 branch. Still open: uninstall does not remove the PATH entry — no NSIS `installerHooks`/`tauri.conf.json` schema could be verified from a macOS-only dev loop, so this needs a real Windows build to land safely. `remove_path_entry` in `windows_cli_path.rs` is unit-tested and ready to wire into that hook once one exists.

## WebView2, Origins, And Local Networking

### Local app origin allowlists are WebKit-shaped

- Evidence: middleware explicitly trusts `tauri://localhost` (`src/middleware.ts:150`, `src/middleware.ts:154`), while ws-server CORS allowlist includes `tauri://localhost` but not `.localhost` (`src/ws-server.ts:4558`, `src/ws-server.ts:4561`).
- Why Windows breaks: Windows WebView2/Tauri commonly uses `http://tauri.localhost`-style origins. Requests from the desktop app can fail local-origin checks or CORS despite coming from the trusted webview.
- Linux impact: Yes for non-`tauri://localhost` WebKitGTK origins.
- Known vs greenfield: Greenfield. The baseline says loopback+token exists; it does not cover desktop-origin differences.
- Direction: Trust desktop app calls based on stamped socket peer plus a tested platform-origin allowlist that includes `http://tauri.localhost`.

### Loader and browser-side networking assume 127.0.0.1 HTTP after boot

- Evidence: the loader probes `http://127.0.0.1:<port>/api/setup/identity` (`scripts/tauri-export.mjs:119`) and navigates to `http://127.0.0.1:<port>/dashboard` (`scripts/tauri-export.mjs:126`).
- Why Windows breaks: This likely works for the main dashboard, but it means the app’s effective origin is plain loopback HTTP rather than a Tauri custom origin. Any Windows-specific WebView2 storage/cookie or auth behavior must be tested against this deliberate origin shift.
- Linux impact: Yes.
- Known vs greenfield: Greenfield seam. The baseline focuses on remote loopback and middleware, not packaged-client origin/storage consequences.
- Direction: Decide whether Windows desktop runs as loopback HTTP or `tauri.localhost`, then make middleware, CSP, Clerk/session storage, and WS URL construction share that decision.

## Worktree, Git, And Filesystem

### Cleanup does one-shot deletion with no Windows lock quarantine

- Evidence: cleanup runs `git worktree remove` with a 15s timeout (`src/lib/worktree/manager.ts:1245`, `src/lib/worktree/manager.ts:1246`) and then directly `rm`s the directory if it remains (`src/lib/worktree/manager.ts:1258`, `src/lib/worktree/manager.ts:1259`). Orphan scan also directly removes old packet dirs (`src/lib/worktree/manager.ts:1330`), and merge cleanup calls manager cleanup after merge (`src/lib/lane/worktree-side-merge.ts:774`).
- Why Windows breaks: Windows refuses deletion while any process, shell, editor, node watcher, Git process, or Defender scan holds a handle. One-shot removal can leave half-deleted worktrees and stale git metadata.
- Linux impact: Less severe; open files can be unlinked.
- Known vs greenfield: Greenfield. The baseline covers merge-by-local-path, not file-lock lifecycle.
- Direction: Add Windows cleanup states: stop owning jobs, retry with backoff, rename to quarantine, defer deletion, and clear metadata only after confirmed removal.

### Worktree dependency fast paths depend on symlinks

- Evidence: same-lockfile setup uses `ln -s` for `node_modules` (`src/lib/worktree/manager.ts:895`, `src/lib/worktree/manager.ts:901`), and the APFS hydration path symlinks `node_modules` with `fs.symlink` (`src/lib/worktree/manager.ts:978`, `src/lib/worktree/manager.ts:981`).
- Why Windows breaks: Symlink creation may require Developer Mode/elevated privileges, directory symlink type handling differs, and node tooling may treat junctions/symlinks differently under antivirus scanning.
- Linux impact: No.
- Known vs greenfield: Greenfield.
- Direction: Use Windows junctions or copy strategy explicitly, and fall back without shelling to `ln`.

### Path comparisons use Unix separators in ownership filters

- Evidence: Rust orphan ownership checks look for `/.o8`, `/o8/`, and `/o8.app/` substrings (`src-tauri/src/sidecar_lifecycle.rs:405`, `src-tauri/src/sidecar_lifecycle.rs:407`, `src-tauri/src/sidecar_lifecycle.rs:408`, `src-tauri/src/sidecar_lifecycle.rs:409`).
- Why Windows breaks: Backslash paths and drive-letter roots will not match these filters, so any future Windows process ownership/orphan reaper built on this helper would misclassify o8 children.
- Linux impact: No.
- Known vs greenfield: Greenfield.
- Direction: Normalize to `Path` components or separator-insensitive helpers before comparing ownership.

## Shell-Outs And Native UI Routes

### Folder/file pickers are AppleScript server routes

- Evidence: the folder picker route documents "macOS Finder via osascript" (`src/app/api/panel/browse-folder/route.ts:8`) and executes `osascript` (`src/app/api/panel/browse-folder/route.ts:21`). File IO picker repeats the pattern (`src/app/api/panel/file-io/route.ts:133`, `src/app/api/panel/file-io/route.ts:150`).
- Why Windows breaks: Windows has no `osascript`; these core picker flows return null/fail.
- Linux impact: Yes.
- Known vs greenfield: Greenfield. The baseline mentions Mac voice/Symon, not general desktop file dialog APIs.
- Direction: Use Tauri dialog plugin from desktop UI, with web fallback only for browser mode.

### Dev and diagnostic scripts are POSIX-shell-only beyond the known process-list tools

- Evidence: package scripts use `sh -c` for build/start (`package.json:17`, `package.json:18`) and `bash` for measurement scripts (`package.json:34` through `package.json:37`). The side predev cleanup uses `lsof | xargs kill -9` (`package.json:43`).
- Why Windows breaks: Even developer verification and local sidecar flows require a POSIX shell or Unix networking tools. This is separate from the production Tauri app but blocks Windows contributors/builders.
- Linux impact: No for Linux with standard shell tools.
- Known vs greenfield: Known-adjacent. `lsof` is known; the broader npm script shell model is greenfield.
- Direction: Replace package scripts with Node scripts or platform-specific npm script branches.
- Status (#1744): the contributor path is shell-neutral. `build`/`start` became `scripts/build.mjs`/`scripts/start.mjs` (same env delta, `next` resolved through `require.resolve` and run under `process.execPath` rather than the `node_modules/.bin` shim, which is a `.cmd` on Windows); every inline `VAR=value` prefix now goes through `scripts/run.mjs`; `predev:cleanup:side` became `scripts/kill-port.mjs` (`lsof` on POSIX, `netstat -ano` + `taskkill /T /F` on Windows, parsers unit-tested in `tests/script-shell-neutral.test.ts`); `scripts/dev.mjs` resolves `next`/`tsx` the same way so `npm run dev` spawns a real child PID off POSIX. Deliberately left POSIX: `measure:*` (`bash` scripts, diagnostics only) and the release chain `ship`/`tauri:build:signed`/`tauri:build:nonotary` (`sh -c` with `$(cat ~/.tauri/…)`, already macOS-only signing/notarization). The Port Build workflow keeps `npm config set script-shell bash` until a Windows run proves the conversion.

## What The Inception Docs Already Cover

I filtered these known baseline items from the greenfield list:

- No tmux/ConPTY persistence rewrite: known; terminal persistence itself is not counted.
- No Unix sockets/`setsid`: known; concrete un-cfg'd relaunch cleanup and worker ownership paths are counted separately.
- No `lsof`/`pgrep`/`ps`: known; process-list call sites are supporting evidence only.
- Login-shell PATH model: known; Node 22 ABI distribution and duplicated MCP locator are counted separately.
- DPAPI vs Keychain: known; master-key storage is not counted.
- Authenticode signing/per-OS CI: known; missing Windows updater artifacts and rollback/update semantics are separate.
- Mac voice/Symon stack: known; voice feature absence is not counted, but externalBin packaging fallout is.
- Vibrancy to solid fallback: known; titlebar/traffic-light/window config is separate.
- Merge-via-local-path-fetch: known; not counted.

## Verification

- Static audit only; no UI server or browser smoke was run.
- Existing source/docs were not modified.
- Report-only change in the `o8` repo. No sibling repos changed.
