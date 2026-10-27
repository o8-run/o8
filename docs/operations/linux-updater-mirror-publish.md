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

1. Ship the macOS candidate to beta using the existing approved controls. Its
   tag contains `beta.json`; the independent `beta` anchor carries the rolling
   beta feed. Stable's existing `latest.json` anchor is unchanged.
2. Dispatch the port build for that candidate and copy its AppImage to the
   mirror. Both repositories must hold the same candidate before completion.
   The AppImage must contain the matching signed build channel identity.
3. Run `npm run ship:linux-sig -- --tag vX.Y.Z` on the release host. It verifies
   the signature and embedded identity, adds the Linux platform and exact
   installer hash to each candidate `beta.json`, and preserves all other
   entries. The rolling beta anchor is completed only at that exact version;
   an old completion cannot move it backwards. No `latest.json` alias is used.
4. Download the final manifest and every installer it advertises. Run
   `npm run smoke:installed -- --artifact <installer> --manifest <beta.json> --receipt <smoke.json>`
   on each supported platform. Later manifest changes invalidate all receipts.
5. Inspect every passing receipt before separately authorized promotion:
   `npm run promote -- --version X.Y.Z --smoke-receipt <smoke.json>`.
   Repeat the receipt option for all installers. Promotion preserves every
   signed platform, refuses any gap relative to stable and sets stable feed
   identity without rebuilding the artifacts.
6. All feed writers share `O8_RELEASE_FEED_LOCK` on the same release host.
   An overlapping operation fails; retry after its owner exits. Promotion
   rechecks stable immediately before each write and refuses backwards moves.
   See [beta and stable feeds](beta-updates.md) for recovery and receipt details.
