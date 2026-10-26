# Beta and stable update feeds

Settings > General > Updates offers Stable (the default) and Beta. The preference
persists in the native update settings. Manual, launch and background checks use
the same native updater. The primary service receives the selected channel;
mirrors read `beta.json` or `latest.json` from the same directory. Update checks
and installation refuse artifacts retained across a channel change.

Beta uses normal release versions and checks both beta and stable, taking the
newer available version on the primary endpoint or its mirror fallback. Returning
to Stable retains the installed version until stable advertises a higher version. It never installs an older
stable build automatically.

## Publish and promote

A separately authorized `npm run ship` publishes the new version as a candidate,
uploads `beta.json` and an identical tag-local `latest.json` compatibility alias
with the signed artifacts, then advances the rolling
`beta.json` beside `latest.json` on each repository's existing latest release.
The existing stable release remains the feed anchor. Do not change that anchor
with a manual latest-release edit: updater URLs resolve through it.

The default publication channel is beta. Direct stable publication is refused.
The existing explicit preview path remains separate and does not advance beta.
Signing, notarization, version tags and publication credentials retain their
existing controls.

For Linux, run the port build and mirror-copy steps for the candidate tag, then
`npm run ship:linux-sig -- --tag vX.Y.Z` on the release host. The existing signer
reads the candidate tag's `latest.json`; completion updates both tag-local
`latest.json` and `beta.json`, then patches only the Linux entry in rolling beta when its version still matches.
Late completion never advances or rolls back a rolling feed: completing 0.1.900
while beta serves 0.1.902 leaves beta at 0.1.902, even if stable is 0.1.901.
The older candidate remains available on its own tag. Check
that beta contains every supported platform before verification. The stable
feed anchor's `latest.json` remains unchanged until promotion. See
[Linux mirror publication](linux-updater-mirror-publish.md).

After verifying the beta candidate, a separately authorized
`npm run promote -- --version X.Y.Z` reads its tagged `beta.json` in every target
repository, checks version and artifact consistency, then replaces only
`latest.json` at each stable feed anchor. It preserves all artifact URLs and
signatures and performs no build, signing or tag changes. Promotion refuses a
stable downgrade, conflicting artifacts for an already-promoted version, or
any candidate missing a platform advertised by stable. All candidate platform
entries, including Linux, are copied unchanged; promotion never fills a gap
with an older artifact. Finish the Linux completion step before retrying.

Ship, Linux completion and promotion take the same exclusive channel lock
across all versions and destinations before reading or publishing manifests.
Each holds it through every write and rechecks the destination immediately
before upload. Ship refuses a beta downgrade or replacement of an existing
version. Promotion refuses a stable downgrade. Platform completion requires
the destination's existing version and channel to match, and changes only that
platform entry, preserving every other entry and manifest field. An overlapping
command fails; retry it after the owner exits.
A retry of an older version must fail once a newer version is stable. Run all
channel writers on one release host (or set `O8_PROMOTE_LOCK_PATH` to the same shared
filesystem lock). Do not run independent channel writers with separate locks.
Locks are removed only by their owner on exit. After an interrupted process,
confirm no channel writer is running before removing its stale lock.

Feed writes across repositories are sequential. A failure can leave one mirror
advanced. Retry `npm run release` (or `node scripts/release.mjs`) in the retained
release checkout with the original version, artifacts and signature files to
finish reconciliation. Do not rerun `npm run ship`, which builds artifacts and
has a separate published-version preflight. Before writing any local manifest or
publishing assets, publication checks both feeds at every destination and refuses
an older version or conflicting content for the same version. It then downloads
existing candidate assets and verifies the complete asset set, artifact bytes,
signature bytes and manifest fields. The original publication date is retained.
Matching candidate releases are reused without editing or uploading their assets;
missing releases are created and rolling beta is reconciled. A completed retry is
safe to repeat. No clobber override is allowed.

Do not rebuild, re-sign or replace candidate artifacts for a retry. Changed or
incomplete candidate assets, missing anchors, unavailable reads and mismatched
manifests fail closed before publication writes. Restore repository access or
repair the incomplete release under the release controls before retrying; use a
new version for different artifact content. A retry cannot restore an older beta
after either feed has advanced past that version.

The primary update service must select the matching manifest using
`X-O8-Channel` and preserve its `channel: beta` marker. A primary response
without beta identity falls back to the beta mirror. Its deployment is maintained outside this repository; verify that
service separately before enabling beta publication in production. The app's
configured mirror fallback uses the same channel even if the primary is absent.
