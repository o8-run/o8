# App shell (#4548)

The installed macOS app carries the native shell as a Tauri sidecar. In Settings,
open the Experimental group and enable **o8 next**. The switch is off by default;
enabling opens the native window, disabling closes it, and restart restores the
saved choice. With it off, the existing startup, defaults and data directory stay
unchanged. The server supplies its own loopback origin and operator bearer only
in the child environment at spawn. A stdin lifeline closes the native window if
the server exits or is killed. No bearer enters arguments, saved state or logs.
The switch is saved only after the open native window acknowledges its first
server load. A startup error, early exit or fifteen-second readiness timeout
leaves the switch off and shows one short failure message in Settings.

Open the native app shell without a desktop window:

```sh
o8 next
```

The CLI uses `/Applications/o8.app/Contents/MacOS/o8-next` by default.
`--binary ABSOLUTE_PATH` selects another executable. It reuses a healthy local
server from the existing local configuration, whether owned by the desktop or
`o8 serve`. If none is healthy, it prints startup progress, runs `o8 serve`, and
waits for API and WebSocket health before opening the window. Startup failures
report an error instead of opening a disconnected window.

Packaged startup uses the server payload's native-addon loader before opening
SQLite. The installed 0.1.811 server payload and native binary have been verified
with this CLI using a separate data directory, including cold startup, saved
thread loading, daemon reuse after window closure, and complete daemon shutdown.

Quitting the native window leaves the headless server running. Run `o8 next`
again to reconnect. Stop the headless server with `o8 serve stop`.

For a source build, follow [the README](README.md#build-and-use), then use
`node cli/dist/o8.mjs next --binary "$PWD/native/o8-next/target/release/o8-next"`.
`--app-shell` remains accepted. Explicit `--server ORIGIN` attaches to that
origin without starting a daemon. The explicit `--enable-next --server ORIGIN`
fixture modes remain available.

In this mode the CLI uses its existing local port/token resolver. It passes the
credential through the child environment, never arguments or saved view state.
The native client still permits only numeric loopback HTTP, with no redirects or
proxies. A worker launch keeps worker authority even if a native operator
credential was inherited. An explicit different origin never receives the local
configuration's disk credential. The normal explicit fixture modes remain available.

The shell defaults to All Glass on macOS and plain dark elsewhere.
`O8_NEXT_APPEARANCE=glass` or `O8_NEXT_APPEARANCE=plain` selects the appearance
at process startup. On macOS, All Glass installs one window-owned
NSVisualEffectView with FullScreenUI, BehindWindow blending and Active state.
Its size follows the GPUI content view. The desktop's three-stop veil and panel
alpha tokens come from the shared native theme. In-flow surfaces pass through
to that material. Non-macOS and offscreen windows keep an opaque dark root;
they do not emulate system blur. Hidden tests never request a native handle.

The shell lists workspaces with saved sessions. Ctrl+K or Cmd+K opens searchable
commands; arrows and Enter choose, Escape cancels. Open session, Open grid and
New message use the existing views; New message focuses the selected session's
composer. Open Inbox opens the native Needs reply, Contributions, Approvals,
Agent issues and History surface. Its tab is restored with the other open surfaces.
Ctrl+Tab cycles surfaces and Ctrl+W closes a surface. Grid shortcuts,
including Ctrl+Alt+W to close one pane, reach the grid. Drafts remain in memory
while switching workspaces and sessions. An unavailable local server has a clear
error and Retry control.

Workspaces use one searchable switcher, including with 15 or more saved
workspaces. Brain, Refresh and Keyboard shortcuts are palette commands. The shortcut
reference closes with Escape; key hints are absent from permanent chrome.
Session tabs use their conversation titles. The embedded session shares the
shell header. The composer action says Send next or Steer now; its adjacent
disclosure switches the mode, as does Ctrl+Shift+Enter.

Existing session surfaces use the shared typography and geometry in
`src/theme.rs`: compact sidebar rows, top tab pills, and a composer card up to
720 px wide. An empty saved conversation centres that card in the available
column without a tagline or permanent composer hints. The existing per-session Brain dock occupies the right panel slot, with
its draft and focus retained while resizing and switching sessions. Compact
windows reduce the sidebar and right-slot widths without cropping the composer.
The sidebar renderer lives in `src/session_sidebar.rs` to keep the session module
within the repository file limit. Native tracking and raster/compositor
comparison remain unverified; the pinned GPUI API exposes no letter spacing.

Settings opens from the shell's Settings button, the Open settings command, or
Ctrl+, / Cmd+,. This partial port edits shared server defaults, provider keys and
revision-checked settings.toml. It works without a saved workspace. Values are
read from the existing routes; credentials are write-only and never enter shell
state. TOML reads expose declared settings only; additional entries stay on the
server and survive native saves. Text fields reload before Edit and reject a
Save against an older file revision. The running desktop reconciles quiet mode
and notification settings through its existing native commands on focus and a
one-second interval. See the [control parity table](evidence/settings/parity.md) and
[fixture verification](evidence/settings/verification.md) for the remaining
desktop controls and the headless CPU frame measurements.

Projects is available from the shell header and command palette, including on a
first run without saved sessions. It uses the desktop project ledger, membership
and repository routes with the existing operator bearer. Create or edit a project,
register a local Git folder, assign repository roles and a main repository, switch
the active project, or open its repository in the shell. Removal confirms before
calling the existing server action and displays refusals without clearing saved
state. Reopening Projects refreshes its snapshot. Empty active projects stay empty
after restarting the shell. The shared GPUI editor handles text fields.

The disposable host's `--projects` mode exposes these production routes and prints
two owned Git folders with its origin. `--projects-refuse-remove` injects an
uninterruptible fixture session; `--projects-drop-add` loses the first successful
registration response. See [project parity and verification](evidence/projects/verification.md)
for the controls that are ported, the remaining controls and fixture measurements.

Window size/position, selected workspace, open surfaces, sidebar selection and
composer focus are stored in `next-shell.json` beside the resolved local config,
or in `--shell-state ABSOLUTE_FILE`. The grid retains its existing per-workspace
layout/focus in a sibling `grid.json` file. Credentials and drafts are excluded.
Writes are atomic; malformed or oversized state is rejected without replacing
its original file. The selected parent directory must already exist.

For an owned fixture configuration, start the existing host with
`--composer --shell`. It prints a `configDir` JSON record followed by its origin;
set `O8_DATA_DIR` to that returned directory for the launcher. The host writes its
own temporary `api-port` and `ws-token` files and removes them on exit. No secret
needs to be entered or printed. Headless verification uses the same production
window-opening function under GPUI TestAppContext:

```sh
npx vitest run tests/o8-next-shell-real-path.test.ts
cargo test --locked --manifest-path native/o8-next/Cargo.toml
cargo test --release --locked --manifest-path native/o8-next/Cargo.toml shell_palette_switch_restart_and_server_down -- --nocapture --test-threads=1
```

Terminal and packet diff surfaces are not on this branch's main baseline. Their
palette commands report that the surface is unavailable; they do not create
placeholder tabs or claim an attach. Their integration remains open. See
[app shell evidence](evidence/shell/verification.md) for measurements and exact
remaining acceptance. The shipped entry point remains Tauri; the native window requires explicit opt-in.

The prebuild stages arm64, x86_64 and universal release binaries under
`src-tauri/helpers/`; Tauri's existing `externalBin` signing and notarization
cover the bundled sidecar. The release native-bundle gate verifies its presence,
architectures, nested signature, hardened runtime, matching signing team and the
outer app seal. It can also be run directly after signing:

```sh
node scripts/next/verify-app-bundle.mjs PATH_TO_APP
```

Linux fixture tests use fake executables and signing tools. They do not establish
macOS signing/notarization or the compressed installer size; those receipts come
from the next macOS release. At the reported roughly 18 MB per release slice,
the estimated uncompressed payload increase is roughly 18 MB per CPU installer
or 36 MB in a universal app, before compression and signing metadata.
