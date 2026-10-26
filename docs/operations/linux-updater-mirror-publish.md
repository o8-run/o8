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

- Downloads `o8_<version>_linux_amd64_preview.AppImage` from the source
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

Copying an asset is not the same as advertising it: `beta.json` advertises
candidate platforms, and the stable feed anchor's `latest.json` advertises
stable platforms. This job never updates either feed. The operator's local
`npm run ship:linux-sig` step requires the AppImage on every target repository
before it signs it. The existing signing key and invocation stay unchanged.

## Order of operations for a full Linux updater publish

1. Ship the macOS candidate to beta. Its tag contains `beta.json` and an
   identical tag-local `latest.json` compatibility alias for Linux completion.
   The rolling stable manifest stays on the existing stable feed anchor.
2. Dispatch `Port Build` for that candidate tag with `publish_target: linux`
   or `both`, then copy the AppImage to the mirror with `publish_to_mirror`.
   Both repositories must hold the same candidate's AppImage before signing.
3. Run `npm run ship:linux-sig -- --tag vX.Y.Z` on the release host. The
   existing signer adds the signed Linux entry to the tag-local `latest.json`.
   Completion copies the full manifest to tag-local `beta.json` in every
   repository, then refreshes the rolling beta feed beside stable. Darwin
   entries are preserved. Completion also adds the exact AppImage hash to the
   installer list, so promotion requires its own installed smoke receipt. No
   re-dispatch is needed for the signature copy.
4. Verify the completed beta candidate on every platform, run installed-build
   smoke acceptance, then use `npm run promote -- --version X.Y.Z`. Promotion
   copies every signed candidate platform unchanged and refuses a candidate
   missing any platform already served by stable. Never promote the macOS-only
   intermediate manifest when stable also serves Linux.
5. Serialize promotions with the common release-host lock. An overlapping
   command fails and may be retried after the owner exits. A candidate older
   than stable is refused, including after a concurrent newer promotion.
   See [beta and stable feeds](beta-updates.md) for lock recovery and retries.
