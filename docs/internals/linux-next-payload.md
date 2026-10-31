# Staged Linux o8 next payload

This is the Linux GPUI desktop payload, tracked by #5166 under #1672. It contains
o8 next, Node 22 and the exported server. It does not use a Tauri/WebKitGTK window.
Package formats, distro dependency closure, updates and publication are separate work.
The macOS build and release path is unchanged.

## Build and stage

Build on Linux x64 with Node 22, npm dependencies and the prerequisites in
`.github/actions/next-linux-setup/action.yml`. Ubuntu 24.04 is the intended release
builder. A stage built on a newer host is diagnostic evidence for that host only;
package assembly must enforce the agreed GLIBC_2.39 ceiling across shipped ELFs.
Run build and CI/type generation sequentially in each checkout; both use
`.next/types`.

Use an extracted official Linux x64 Node 22 distribution, retaining its LICENSE.
Verify its tarball against the official SHASUMS256.txt before extraction. The
initial VM proof used Node 22.23.3, `node-v22.23.3-linux-x64.tar.xz`, SHA-256
`df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de`.
The staging command takes local inputs and performs no downloads.

```sh
df -h /
CARGO_TARGET_DIR="$HOME/o8-native11-target" nice -n 10 cargo build --release --locked --manifest-path native/o8-next/Cargo.toml
O8_DATA_DIR=/tmp/o8-linux-build-data CORTEX_IDE_DATA_DIR=/tmp/o8-linux-build-data nice -n 10 npm run build
nice -n 10 node scripts/build-pi-write.mjs
O8_DATA_DIR=/tmp/o8-linux-build-data CORTEX_IDE_DATA_DIR=/tmp/o8-linux-build-data nice -n 10 node scripts/tauri-export.mjs
node scripts/linux/stage-payload.mjs \
  --server out/server \
  --node-root "$HOME/linux-dl-cache/node-v22.23.3-linux-x64" \
  --next-binary "$HOME/o8-native11-target/release/o8-next" \
  --output /tmp/o8-linux-stage
```

Use a fresh ordinary checkout for this unpublished build and export path. Keep
the build data profile separate from operator data. The export includes its native
modules and support resources and does not build a Linux Tauri window. The stager requires
a new output directory with an existing parent and never overwrites a prior stage.
It checks Linux x64 ELF executables, Node 22, a SQLite query and a real PTY child
using the bundled Node. Failed addon probes retain the incomplete stage for diagnosis.

```text
AppRun
usr/bin/o8
usr/lib/o8/node
usr/lib/o8/o8-next
usr/lib/o8/server/             exported server and native addons
usr/lib/o8/server/cli/o8.mjs   compiled CLI
usr/lib/o8/server/cli/desktop.mjs
usr/share/applications/o8.desktop
usr/share/icons/hicolor/256x256/apps/o8.png
usr/share/doc/o8/              application and Node licenses
```

## Launch and lifecycle

Run `<stage>/usr/bin/o8` or `<stage>/AppRun`. Both resolve their location through
symlinks and work after relocation, including paths with spaces. Installed desktop
menus invoke `/usr/bin/o8` directly so an older CLI on PATH cannot intercept the
desktop launch. The staged tree is not a system install.
The launcher uses bundled Node regardless of the desktop session's Node installation.
Arguments such as `o8 serve`, `o8 serve status` and `o8 serve stop` use the normal CLI.

A desktop launch sets `O8_PACKAGED_APP=1`, an absolute `O8_NEXT_BIN`, and
`O8_NEXT_MAIN_WINDOW=1` before invoking packaged `o8 serve`. The server's existing
`app-window.ts` opens the first GPUI window. An existing terminal daemon cannot
inherit these variables; the launcher uses packaged `o8 next --binary ...` when
there is no window. The existing CLI owns health, port and connection resolution.
For a fresh server, the launcher requests a per-launch result file through
`O8_NEXT_STARTUP_RESULT`. The server writes it atomically after its actual window
attempt: `ready` after the first-paint handshake, or `failed` after reaping an
unsuccessful child. The launcher waits for that result while checking daemon health;
it has no independent deadline that could race a delayed startup hook. Only a
completed failed attempt permits the CLI fallback. Result files are removed when
the launch finishes. A missing result while the server stays healthy keeps the
launch pending, rather than risking a second window.

An advisory `flock` in the existing data directory serializes desktop launches.
Linux `/proc` inspection reuses a running GPUI executable with the same shell-state
path, including a server-owned window, and excludes `--offscreen` hosts. CLI status
responses are parsed from stdout and validated before use. Stderr warnings remain
separate. Closing the window and launching again opens
a new window against the same daemon. Repeated launches do not raise/focus an existing
window; that desktop interaction remains open work.

State stays in `~/.o8`, honoring `O8_DATA_DIR` and `CORTEX_IDE_DATA_DIR`. Serve logs
remain in `logs/serve.log`; GPUI state remains in `next-shell.json`. Quitting a CLI-owned
window leaves the daemon running. Use `o8 serve stop` for the existing daemon lifecycle.
If a CLI-owned window remains open after its daemon stops, close that window before
launching again. The launcher reports the unhealthy server and avoids a second window.
The launcher requires util-linux `flock`, Linux `/proc`, and the GPUI runtime libraries.

## Installed headless proof

The smoke copies the stage to a path with spaces outside the checkout, uses disposable
profiles with a minimal PATH, and launches real server and GPUI processes. It verifies
fresh-server and terminal-daemon attachment, newly persisted connected shell state,
a painted frame, repeat launch, window reopening, daemon reuse, idle RSS and data
preservation after removing the installation. Screenshots and logs stay outside the repo.

```sh
export LIBGL_ALWAYS_SOFTWARE=1
export VK_ICD_FILENAMES="$(find /usr/share/vulkan/icd.d -name 'lvp_icd*.json' -print -quit)"
xvfb-run -a -s '-screen 0 1440x1024x24 -nolisten tcp -noreset -br -ac' \
  node scripts/linux/smoke-payload.mjs --stage /tmp/o8-linux-stage --output /tmp/o8-linux-proof
```

This uses an isolated Xvfb display without TCP. `-ac` accommodates the existing
server window child's restricted display environment; its allowlist is unchanged.
The smoke does not prove DEB/RPM installation, AppImage behavior, or Ubuntu 24.04
compatibility when run on a newer VM. Those require the package builder and distro checks.
