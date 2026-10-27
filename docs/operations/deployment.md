# Desktop build and deployment

o8 ships as a Tauri v2 desktop application containing the web frontend, the local Next.js server, the WebSocket bridge, native helpers, and the `o8` CLI.

## Prerequisites

- Node.js 22 and the repository’s npm dependencies.
- A current stable Rust toolchain.
- Xcode Command Line Tools for macOS builds.
- Signing and updater credentials only when producing a signed release; [`.env.example`](../../.env.example) documents the supported variables without embedding secrets.

Run `npm install` after cloning so JavaScript and native-module dependencies match the lockfile.

## Local development

- `npm run dev` starts the coordinated Next.js and WebSocket development stack.
- `npm run tauri:dev` starts the native shell and its coordinated local backend.
- `npm run desktop:dev:side` uses the side-by-side ports intended for installed-app bridge work.

Development ports are conveniences, not protocol constants. The packaged shell allocates ports dynamically and writes `~/.o8/api-port` and `~/.o8/ws-port`.

## Build pipeline

1. `npm run tauri:prebuild` exports the frontend and compiles the Node server bundles and helpers into `out/`.
2. `npm run tauri:build` creates an unsigned local production build.
3. `npm run tauri:build:signed` creates the signed, updater-capable build when the required credentials are present.

The stable ship workflow uses `npm run tauri:build:stable-macos`, which targets `universal-apple-darwin`. Before signing and again before publication, the release scripts inspect the Mach-O headers of the app executable, `speech_recognizer`, and `speech-local` and require both x86_64 and arm64 slices. The packaged server gate separately requires the x86_64 and arm64 prebuilds for `better-sqlite3` and `node-pty`; the installed host's Node 22 runtime selects the matching prebuild through `process.arch`.

The export step keeps native modules external where required, copies runtime-read assets beside the server bundles, and packages the resources declared by `src-tauri/tauri.conf.json`.

Changed releases reuse verified web, native, and speech compiler intermediates through the [release build cache](release-build-cache.md). The cache never reuses final bundles or bypasses signing, notarization, publication, or exact-output verification. Any invalid entry falls back to the normal cold build.

## Verification

Before a release candidate:

```bash
npm run typecheck:fast
# Slower TypeScript 5.8.2 cross-check: npm run typecheck:tsc
npm test
cd src-tauri && cargo check
```

Then complete the [pre-ship gate](PRE-SHIP-GATE-CHECKLIST.md) against a clean profile. Verify that the app launches its sidecars, resolves dynamic ports, opens the dashboard, and can complete a real governed packet path before treating the bundle as releasable.

External report reconciliation has its own [configuration and recovery runbook](intake-reconciliation.md). Its preflight state is reported alongside the release checks, but an intentionally disabled intake never blocks an otherwise valid release.

## Release boundary

A local build or commit is not a release. Publishing uses the repository’s guarded ship workflow and requires explicit operator authorization in the current session. Keep signing material out of the repository, never run concurrent ship processes, and verify the published version and installer after notarization completes.

The automated architecture gates prove artifact composition, not native execution. A stable candidate that changes macOS architecture support still requires a signed, notarized, fresh-profile launch on both Apple Silicon without Rosetta and Intel before the new artifact is described as hardware-accepted.

Linux release artifacts are produced on a Linux build host. Before `npm run ship`, copy the resulting `bundle/appimage/*.AppImage`, matching `.sig`, and any `bundle/deb/*.deb` files into the corresponding directories under `src-tauri/target/release/bundle/` on the release host. The release script detects them automatically, uploads them with the macOS assets, and adds the signed AppImage to the `linux-x86_64` updater entry.

### Linux signature

Publishing a stable release also starts the `Linux Release Preview` workflow, which dispatches the port-build workflow for that tag with `publish_target: linux`. It attaches the `.deb`, `.rpm` and AppImage previews and their checksum file about an hour after publication. Only the AppImage carries an embedded GPG signature; the `.deb` and `.rpm` packages carry build-provenance attestations. It fails without uploading if Linux preview assets are already on the release; dispatch port-build with `replace_existing_assets` to replace them.

When the AppImage was built by the port-build workflow instead, it is published unsigned — that build disables updater artifacts, and the updater signing key never reaches a CI runner. Sign the published asset afterwards, from the release host:

```bash
npm run ship:linux-sig -- --tag v0.1.724
```

The step verifies the tag's release is published (never a draft) and holds the expected `o8_<version>_linux_amd64_preview.AppImage` in every target repository, downloads that asset, signs it with the same updater key and invocation the macOS artifact uses, then uploads `<asset>.sig` beside it along with a regenerated `latest.json` that gains exactly one `linux-x86_64` entry. The macOS entries are carried across untouched. Any missing asset, version mismatch, draft release, or absent signing key aborts before anything is published. Repositories default to the source repo and the public updater mirror; override with repeated `--repo owner/name`.
