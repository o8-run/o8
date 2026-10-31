# Linux download artifacts

The `Linux GPUI download artifacts` workflow builds **o8 next**, the exported o8
server, Linux native addons and a private Node 22 runtime on `ubuntu-24.04`.
It does not build a Tauri/WebKitGTK window. The runner and cache key are pinned
to Ubuntu 24.04, and every shipped ELF must require glibc **2.39 or older**.
This establishes an Ubuntu 24.04 baseline, not support for older distributions.

## Review builds

The workflow runs on relevant pull requests or manual dispatch. It has read-only
repository permissions and produces seven-day Actions artifacts, never releases
or feed updates. Legacy automatic Linux preview dispatch and manual Linux release
publication are held during this migration. Windows and macOS paths are unchanged.

Build inputs are pinned by URL, version and SHA256 in
`scripts/linux/build-inputs.json`. The type-2 runtime's upstream `continuous` URL
can move: a changed checksum stops the build rather than silently upgrading it.
`fetch-build-inputs.mjs CACHE_DIRECTORY` accepts an operator-populated cache and
prints the verified tool/runtime paths. No build tools are downloaded at app launch.

After building the native release and running the existing server export:

```sh
node scripts/linux/stage-payload.mjs --server out/server --node-root NODE_ROOT \
  --next-binary native/o8-next/target/release/o8-next --output NEW_STAGE
nice -n 10 node scripts/linux/package-payload.mjs --stage NEW_STAGE \
  --output NEW_PACKAGES --appimagetool APPIMAGETOOL --runtime TYPE2_RUNTIME
node scripts/ci/check-linux-glibc.mjs --max 2.39 NEW_PACKAGES/*.AppImage \
  NEW_PACKAGES/*.deb NEW_PACKAGES/*.rpm
```

The packager requires a beta export and a new output directory. It produces an
AppImage, DEB and RPM from the same `/usr` tree. RPM automatic dependency discovery
and stripping are disabled so it retains the bundled runtime and native binaries;
explicit runtime dependencies are declared instead. No system Node is required.
The uncompressed payload budget is **512 MiB** and each download's budget is
**256 MiB**. `linux-downloads.json` records actual sizes, hashes, application,
version, channel, platform, baseline and `published: false`. This is a build
receipt, not a replacement for the authenticated updater manifest.

## AppImage lifetime

The CLI detaches its server and may return while the window remains open.
AppImage mount/extraction paths are temporary and change between launches.
AppRun therefore copies the application files atomically into a stable directory
under `$XDG_DATA_HOME/o8/appimage/PAYLOAD_ID` (default
`~/.local/share/o8/appimage/PAYLOAD_ID`) before launching the bundled CLI. Copies
of the same payload reuse this directory and its live daemon. User profiles stay
in their existing data directory and are never copied into this application cache.

The first launch requires room for this additional uncompressed copy. Old payload
directories are retained; remove one only after its windows and server are stopped.
Updates are manual. The packages include the build runner's xkbcommon,
xkbcommon-x11 and xcb-xkb runtime libraries and their distribution copyright
files. AppImage puts that private directory first in its child's library path;
DEB/RPM use their declared system dependencies. Bundled libraries receive the
same GLIBC 2.39 check and count toward the uncompressed budget. AppImage still
requires a working graphics stack, Vulkan driver, base X11/XCB libraries and
`flock` from util-linux. The pinned runtime contains its own FUSE library. CI exercises
AppImage extract-and-run mode; a desktop FUSE mount remains a separate acceptance
check.

## Acceptance and publication boundary

Separate fresh Ubuntu 24.04 runners download the artifacts. One installs the DEB,
then runs the real GPUI/server through the installed launcher with a minimal PATH.
Both a new server and an existing terminal-started daemon must produce one connected
window, a real first frame, measured idle RSS, repeat-launch reuse and window reopen.
After DEB removal, the private test profile must survive. The other runs the same window cases
through the AppImage without installing the DEB first. Screenshots and measurements stay in
Actions artifacts. RPM is built, extracted, checked and executed; RPM-distribution
installation is not established by the Ubuntu runner.

Run the package regression with the pinned tools installed:

```sh
O8_LINUX_PACKAGE_TESTS=true O8_APPIMAGETOOL=APPIMAGETOOL \
  O8_APPIMAGE_RUNTIME=TYPE2_RUNTIME \
  npx vitest run tests/linux-download-packages-real-path.test.ts
```

The ordinary integration lane runs the size, overwrite and ABI rejection cases;
the dedicated workflow also runs the real package-tool and AppImage-daemon case.

Nothing here publishes. After operator review, the existing signed AppImage beta
path can populate `beta.json` and the website can offer a version-matched GPUI
AppImage. Existing publisher guards refuse DEB/RPM until those formats have an
authenticated channel identity; this change deliberately leaves that boundary
intact. The website consequently exposes AppImage only, and shows unavailable
until the beta manifest contains a matching Linux asset. Signing, DEB/RPM
publication, automatic updates and full Linux install-to-merge acceptance remain
separate work.
