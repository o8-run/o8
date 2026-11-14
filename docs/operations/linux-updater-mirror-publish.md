# Linux updater mirror publish

Legacy Linux source publication is held during the GPUI migration. The old
mirror copy remains manual and defaults off; it is not the GPUI publisher.
`linux-release-preview.yml` does not dispatch builds on release publication.
Actions review packages alone do not update releases or updater feeds.

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
`assertLinuxArtifactChannels`. It then requires the source release's matching
channel manifest to name that exact channel and version, and applies the existing
completion publisher's download-anchor validation. It attaches only the AppImage and signature,
using `o8-<version>-x86_64.AppImage`, without replacing existing assets.

DEB and RPM remain Actions review artifacts. They have no authenticated channel
identity and cannot be published through this path. No updater manifest is
written by this workflow. Mirror and channel-feed completion still require the
release host's existing authenticated publication checks. Keep the old mirror copy disabled while the GPUI publication path awaits review.

The glibc 2.35 build, offline-window acceptance, and catalog-name changes must
be reviewed before enabling this path for a release. Support remains tracked
in #1672. This wiring does not establish catalog acceptance.

## Mirror and updater completion

The attachment workflow writes only the source repository. Before running
`npm run ship:linux-sig -- --tag vX.Y.Z` on the release host, the identical
AppImage must already exist in both release repositories, including the updater
mirror. Copying to that mirror remains a separate operator action. Its scoped
`RELEASES_MIRROR_TOKEN` credential requires Contents read/write for the mirror;
source-repository Actions credentials cannot write there.

Signature completion verifies the updater signature and the AppImage's embedded
identity, then selects the matching channel manifest. It validates destination
manifests and preserves other platforms under the shared publication lock.
Do not relabel with an environment override or upload DEB/RPM through a separate
workflow. See [release channels](release-channels.md) for the authenticated
channel and immutable-candidate requirements.

For a local default-off policy receipt, run
`node scripts/prepare-linux-release-attachment.mjs` with `O8_PUBLISH_LINUX` unset.
It reports `status: disabled` and prepares no assets. The workflow maps its
approval input to that process variable; neither changes any saved setting.
The enabled preparation command performs only authenticated reads and local
copies. The workflow's separately guarded upload step is the only remote writer.


## Build retention and channel

Build artifacts expire after **7 days**. Attach them within that period or rerun
`linux-downloads.yml` at the same release tag, then sign the new exact bytes and
use the new run ID. The attached GPUI AppImage identifies as the **beta channel
today**, even when attached to a stable release. This workflow does not change
that behavior or relabel the binary. Its destination channel manifest must match.

The attachment job checks out `refs/tags/<release_tag>` without persisted Git
credentials. All verification code, the glibc gate and the updater public key
come from that tag. Tags without the verifier scripts cannot use this path.
It requires `o8-<version>-x86_64.AppImage` and scans every shipped ELF against
glibc 2.35 before preparing the authenticated pair.

Both files are verified locally before one upload command. A failed upload rolls
back only assets labelled with that run's unique identifier and absent from its
initial inventory. Existing assets are never replaced or removed. After a partial
upload failure, confirm cleanup succeeded and rerun with the same inputs. If
cleanup itself failed, inspect the uniquely labelled orphan before removing it;
the next run refuses existing names rather than deleting them.
