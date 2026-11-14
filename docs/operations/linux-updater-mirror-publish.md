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

Only **beta prereleases** can receive attachments today. The GPUI build embeds
beta identity, and preparation requires that release's `beta.json` to carry the
same version and channel. A stable release has no matching beta manifest.
Stable support requires a stable build identity and a matching authenticated
stable manifest and publication policy, reviewed separately.

After approval, use this order (substitute the release version and run ID):

1. Dispatch `gh workflow run linux-downloads.yml --repo o8-run/o8 --ref vX.Y.Z`.
   Wait for success; the build's `head_sha` must equal the tag commit.
2. Within **7 days**, download the exact bytes on the release host:
   `gh run download RUN_ID --repo o8-run/o8 --name linux-gpui-review-packages --dir packages`.
3. With the existing updater signing key environment configured on that host, run
   `cargo tauri signer sign packages/o8-X.Y.Z-x86_64.AppImage`.
   Use the resulting `packages/o8-X.Y.Z-x86_64.AppImage.sig` verbatim as the
   public signature. No private key goes to Actions.
4. Dispatch the attachment workflow from the default branch:
   `gh workflow run linux-gpui-publish.yml --repo o8-run/o8 --ref main -f release_tag=vX.Y.Z -f build_run_id=RUN_ID -f updater_signature="$(cat packages/o8-X.Y.Z-x86_64.AppImage.sig)" -F publish_linux=true`.
   This step requires the separate operator approval described above.
5. After the separately approved mirror and `ship:linux-sig` completion below,
   do not re-dispatch or re-run attachment for that tag. The workflow refuses
   an existing completed pair or any unlabelled/mixed-ownership target assets
   before deleting anything, including a signature replaced by `ship:linux-sig`.

The read-only `verify` job checks run-to-tag binding and the catalog filename,
parses and authenticates the signature, reads the embedded channel and version,
and validates the matching published manifest. It prepares the authenticated
pair, then scans its shipped ELF files against glibc 2.35 using `unsquashfs`,
without executing the AppImage. It transfers only that pair and explicit SHA-256
outputs. The separate `attach` job checks both output patterns and recomputes
both digests before upload. The entire `attach` job has `contents: write`.
Its pinned actions can access `github.token`; checkout and setup-node receive it
through their default `token` inputs. Checkout does not persist credentials.
Only the upload command explicitly sets `GH_TOKEN` in its environment.
The jobs share no environment or path files. No updater feed is written.

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

`ship:linux-sig` later re-signs the AppImage and replaces the signature asset
attached by this workflow. Signature completion verifies the updater signature and the AppImage's embedded
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
use the new run ID. The attached GPUI AppImage identifies as beta today and requires the matching
beta prerelease manifest, as described above.

Both jobs check out `refs/tags/<release_tag>` without persisted credentials;
attachment checks out only the upload script. Tags created before this workflow
and its scripts merged cannot use this path. Create no replacement tag to bypass
that requirement.

The upload has a 30-minute internal deadline and a separate five-minute cleanup
budget within a 60-minute job. Cleanup attempts every owned asset even if one
delete fails, and retries a failed inventory. A rerun removes only leftovers
from one prior attempt: every target-named asset present shares that attempt's
ownership label, and a member is missing or has not reached `uploaded`. A pair
whose two members are both `uploaded` under one label is a committed release and
is refused whatever the rerun's local files are, so a re-signed or rebuilt
artifact never replaces it. Mixed labels or any unlabelled target cause refusal
before any deletion. A new upload must be `uploaded` and match the local size
and, when provided, SHA-256 digest before it is accepted.
After a verified successful upload, both ownership labels are cleared so release
entries display their filenames. A label-clearing error is reported without
removing the uploaded pair, and a rerun does not finish the clearing: clear the
remaining label by hand in the release editor, or with
`gh api --method PATCH repos/<owner>/<repo>/releases/assets/<id> -f label=`.

The pinned action token defaults are documented in
[checkout](https://github.com/actions/checkout/blob/11bd71901bbe5b1630ceea73d27597364c9af683/action.yml#L11-L21)
and [setup-node](https://github.com/actions/setup-node/blob/49933ea5288caeca8642d1e84afbd3f7d6820020/action.yml#L20-L22).
