# App shell (#4548)

The installed macOS app carries the native shell as a Tauri sidecar. In Settings,
open the Experimental group and enable **o8 next**. The switch is off by default;
enabling opens the native window, disabling closes it, and restart restores the
saved choice. With it off, the existing startup, defaults and data directory stay
unchanged. The server supplies its own loopback origin and operator bearer only
in the child environment at spawn. A stdin lifeline closes the native window if
the server exits or is killed. No bearer enters arguments, saved state or logs.

The separate CLI remains available for explicit fixtures and development. Build
the crate and CLI as described in [the README](README.md#build-and-use), then launch:

```sh
node cli/dist/o8.mjs next --enable-next --binary "$PWD/native/o8-next/target/release/o8-next" --app-shell
```

In this mode the CLI uses its existing local port/token resolver. It passes the
credential through the child environment, never arguments or saved view state.
The native client still permits only numeric loopback HTTP, with no redirects or
proxies. A worker launch keeps worker authority even if a native operator
credential was inherited. An explicit different origin never receives the local
configuration's disk credential. The normal explicit fixture modes remain available.

The shell lists workspaces with saved sessions. Ctrl+K or Cmd+K opens searchable
commands; arrows and Enter choose, Escape cancels. Open session, Open grid and
New message use the existing views; New message focuses the selected session's
composer. Open Inbox opens the native Needs reply, Contributions, Approvals,
Agent issues and History surface. Its tab is restored with the other open surfaces.
Ctrl+Tab cycles surfaces and Ctrl+W closes a surface. Grid shortcuts,
including Ctrl+Alt+W to close one pane, reach the grid. Drafts remain in memory
while switching workspaces and sessions. An unavailable local server has a clear
error and Retry control.

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
