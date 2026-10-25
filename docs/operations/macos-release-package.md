# macOS release package

## Release notes and feed recovery

`release-notes/next.md` accepts blank lines and Markdown bullets beginning with
`-`, `*`, or `+`. Headings and plain paragraphs fail ship preflight before
native work starts. The preflight uses the same parser and public-text scrub
as the feed publisher. Missing or empty notes retain the commit-based fallback.

If installer publication succeeded but public feed generation failed, recover
the metadata separately. From the intended release's source checkout, correct
the notes and generate a local preview:

```sh
node scripts/release.mjs --dry-run --out-dir "$TMPDIR/o8-feed-preview"
```

Inspect the generated `latest-ship.json`, version, publication date and public
text. With operator authorization to update the public feed, use:

```sh
bash scripts/sync-public-changelog.sh --latest-ship "$TMPDIR/o8-feed-preview/latest-ship.json"
```

The recovery script commits only `CHANGELOG.md`, `STATS.md` and
`latest-ship.json` in the feed mirror. It does not replace installers, updater
manifests, archives or signatures. Do not rerun installer publication to repair
a feed-only failure.

## Notarization credentials in Keychain

Store notarization credentials once in a notarytool Keychain profile. Run this
interactively as the user who will run the approved release:

```sh
xcrun notarytool store-credentials o8-notary
```

Enter the Apple ID, team ID and app-specific password at the prompts. Do not
put the password in command arguments, shell startup files or environment
variables. The credentials remain in Keychain. Select the profile with the
non-secret setting `APPLE_KEYCHAIN_PROFILE=o8-notary` in the release environment.
`APPLE_SIGNING_IDENTITY` and the Tauri updater signing key are still required.

When `APPLE_KEYCHAIN_PROFILE` is set, the signing pass uses
`--keychain-profile` for both the app and installer submissions and does not
read `APPLE_ID`, `APPLE_PASSWORD` or `APPLE_TEAM_ID`. Preflight verifies access
with `notarytool history` before building. It discards the command output and
reports only credential setting names, never profile or credential values.
A missing, inaccessible or invalid profile stops preflight without falling back.

Without a profile, the existing `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID`
environment settings remain supported. Preflight warns that this fallback
exposes the password to child processes. After configuring a profile, remove
any existing password export yourself and start a fresh release shell.

## Compression

The final universal and CPU-specific DMGs use ULMO (LZMA) compression. The
`hdiutil` manual requires macOS 10.15 or newer for ULMO; the app minimum in
`src-tauri/tauri.conf.json` is macOS 14.0. The final installer format is selected
in `scripts/sign-and-notarize.mjs`.

Use the normal approved release workflow from the clean, tagged release checkout.
On macOS, set the system `tar` writer's gzip compression level for that command:

```sh
TAR_WRITER_OPTIONS=gzip:compression-level=9 npm run ship
```

The macOS `tar` manual documents `TAR_WRITER_OPTIONS` as the default options for
format and compression writers, and gzip compression levels from 1 through 9.
This command uses level 9 only within the release process and its children.

The [package size preflight](../../scripts/lib/mac-package-size.mjs) creates a
fresh archive with this setting. The [signing and notarization
entry point](../../scripts/sign-and-notarize.mjs) uses it again when packaging the
final signed and stapled app. Both retain `COPYFILE_DISABLE=1` to exclude
AppleDouble metadata that the updater cannot extract.

The bundle files, tar format and updater extraction path stay the same. The
existing checks still require full bundle-content equality, universal binaries,
valid signatures, notarization and the unchanged [footprint
ceilings](../../scripts/lib/footprint-budget.mjs). The final signed and stapled
archive must pass its size check before publication. An archive measured before
notarization supplies only a packaging diagnostic.

For an approved [remote app handoff](./remote-release-build.md), include the same
task-local setting alongside `O8_RELEASE_APP_HANDOFF`. The normal handoff identity
and import checks still apply.

## CPU-specific packages in development

CPU delivery is off by default. [#3646](https://github.com/o8-run/o8/issues/3646)
tracks signed-package and installed update acceptance. Intel delivery can be
accepted separately while Apple Silicon remains on the universal package.
[#3656](https://github.com/o8-run/o8/issues/3656) tracks Apple Silicon
installed acceptance before enabling a dedicated arm64 package.

Both CPU apps come from the same final universal app. Only the four native
executables are thinned. A derivation receipt binds the source bundle; comparison
checks preserve executable payloads, shared runtime files, modes and relative
links. Existing Node 22/24 and x64/arm64 addon prebuilds remain in both apps.
Preparation refuses existing output and retains failed staging for inspection.

For an unsigned development preparation in a release checkout:

```sh
node scripts/macos-cpu-packages.mjs
```

Set `O8_MACOS_CPU_PACKAGES=x86_64` for Intel-only preparation. Without a
selection, this development command prepares both CPU copies.
The output is under the universal bundle's `cpu/x86_64` and `cpu/arm64`
directories. It is not an installer or accepted release. Preparation does not
change the universal app, start a server or launch a model.

After Intel installed acceptance and a separately approved release, the normal
ship entry point can build universal and Intel distributions:

```sh
O8_MACOS_CPU_PACKAGES=x86_64 TAR_WRITER_OPTIONS=gzip:compression-level=9 npm run ship
```

In this mode, `darwin-x86_64` uses the Intel archive and its signature, while
`darwin-aarch64` keeps the universal archive and signature. No arm64 package
is required, signed or published. Unselected output is never included in the
release. Each selected package must pass all existing integrity gates;
an invalid or missing Intel package stops publication.

Only after installed acceptance on both CPUs and a separately approved release,
the normal ship entry point can build all three distributions:

```sh
O8_MACOS_CPU_PACKAGES=1 TAR_WRITER_OPTIONS=gzip:compression-level=9 npm run ship
```

The signing pass notarizes the universal app first, derives the selected CPU
copies, and signs and notarizes each selected copy and installer. It preserves sidecar
entitlements, signing requirements and runtime flags. Unchanged addon binaries
retain their signatures. All archive contents, updater signatures, installer
contents, native prebuilds and notarization tickets must verify before a selected
CPU entry can be published. A missing or mismatched package stops publication.

The updater maps `darwin-x86_64` to `o8_x86_64.app.tar.gz` and
`darwin-aarch64` to `o8_arm64.app.tar.gz`, each with its own signature.
The universal archive, signature and installer remain uploaded for fallback
and rollback. Stable and preview manifests retain their existing channels.
No website download selection or saved user setting changes in this mode.

Installed acceptance must cover first launch, update from universal to CPU
packages, update back to universal, relaunch/Dock behavior, workers, terminals,
settings, voice sidecars and native addon loading on each selected CPU. Static slice or
signature checks cannot substitute for these checks.
