# Linux updater mirror publish

The Tauri updater (`o8.app`'s `UpdateCard`) reads `latest.json` from the
public updater mirror, `hurttlocker/o8-releases`. `github.token` in this
repo's Actions runs cannot write to that other repo, so publishing the Linux
AppImage there needs its own cross-repo credential.

## One-time setup

1. Create a fine-grained GitHub personal access token scoped to
   `hurttlocker/o8-releases` only, with the **Contents: Read and write**
   repository permission.
2. Add it as an encrypted GitHub Actions secret named `RELEASES_MIRROR_TOKEN`
   on `o8-run/o8`.

## What the workflow does — and does not — do

Run the `Port Build` workflow (`.github/workflows/port-build.yml`) against an
existing public release tag with `publish_to_mirror` enabled. The
`publish-mirror` job:

- Downloads `o8-<version>-x86_64.AppImage` from the source
  release on `o8-run/o8` (uploaded there by the `publish-preview` job in
  the same run, or a previous one).
- Copies it to the mirror release for the same tag on
  `hurttlocker/o8-releases`, authenticated with `RELEASES_MIRROR_TOKEN`. If a
  `.sig` already sits next to the AppImage on the source release, it copies
  that too; if not, it copies the AppImage alone and prints a notice — this
  is expected and not an error, since the mirror copy has to exist before the
  local signing step will sign it (see below).
- Fails closed — with no upload — if the secret is missing, the mirror
  release for that tag does not exist yet, or the AppImage itself is not on
  the source release yet.

Copying an asset is not the same as advertising it: only `latest.json`
advertises a platform to the updater, and this job never touches it. That
manifest is written exclusively by `scripts/lib/linux-appimage-signature.mjs`
via the operator's local `npm run ship:linux-sig` step, because the minisign
updater key never leaves the ship machine. That step requires the AppImage to
already be present on every target repository — including the mirror —
before it will sign anything, which is exactly what this job exists to
provide.

## Order of operations for a full Linux updater publish

1. Dispatch `Port Build` with `release_tag` set (and `publish_target: linux`
   or `both`) — the `publish-preview` job publishes the AppImage to the
   source release. For a stable release this happens automatically: the
   `Linux Release Preview` workflow (`.github/workflows/linux-release-preview.yml`)
   dispatches `Port Build` with `publish_target: linux` when the release is
   published. Check that run before continuing.
2. Dispatch `Port Build` again with `release_tag` set and
   `publish_to_mirror: true` — the `publish-mirror` job copies the
   (still-unsigned) AppImage to the mirror release for the same tag.
3. Run, on the release host: `npm run ship:linux-sig -- --tag vX.Y.Z`. This
   signs the AppImage with the updater key and uploads the `.sig` to both the
   source repo and the mirror, then regenerates `latest.json` on the mirror
   with a `linux-x86_64` entry.
4. No re-dispatch of step 2 is needed — step 3 uploads the `.sig` to the
   mirror itself.

## GPUI publication preparation (operator opt-in)

The held legacy Linux jobs remain disabled. `linux-gpui-publish.yml` is manual
and defaults `publish_linux` to `false`. The exact approval switch is the
workflow input `publish_linux: true`. Do not enable it until Linux support
review (#1672) is complete.

Build the release tag with `linux-downloads.yml` first. Download its
`linux-gpui-review-packages` artifact and sign the exact AppImage bytes on the
release host with the existing updater signer. Supply that public signature as
`updater_signature`, the successful build's `build_run_id`, and `release_tag`
to the attachment workflow. No private signing key is sent to Actions.
The workflow checks that the build ran manually at the release tag, verifies
the updater signature, then reads the embedded channel and version using
`assertLinuxArtifactChannels`. It attaches only the AppImage and signature,
using `o8-<version>-x86_64.AppImage`, without replacing existing assets.

DEB and RPM remain Actions review artifacts. They have no authenticated channel
identity and cannot be published through this path. No updater manifest is
written by this workflow. Mirror and channel-feed completion still require the
release host's existing authenticated publication checks. The old mirror job
is held and must not be used as a GPUI publication path.
