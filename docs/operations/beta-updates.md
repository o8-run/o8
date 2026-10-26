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

## Publication

Stable remains the default publication channel. A separately authorized
`O8_RELEASE_CHANNEL=beta npm run ship` publishes an immutable prerelease with
signed artifacts and `beta.json`, then advances only rolling `beta.json` on
each repository's existing stable feed anchor. Beta never uploads `latest.json`
or `fixed.json`, changes the latest stable release, reconciles report receipts,
publishes the stable changelog, or posts stable announcements.

A separately authorized normal stable release retains the full stable workflow:
report intake reconciliation, cumulative `fixed.json`, source and mirror assets,
stable update warmup, public changelog, report announcements and release
announcements. Its metadata range starts at the previous published stable
ancestor, so fixes first included in an intervening beta still receive receipts.
The explicit preview path remains separate and advances neither feed.
Signing, notarization, version tags and credentials retain their existing controls.

Linux completion reads the candidate's `beta.json`, adds only its signed Linux
entry, and uploads the signature and `beta.json` to the candidate tag. It patches
rolling beta only when that feed still matches the candidate version. Older or
newer rolling versions stay unchanged. Stable Linux completion retains
`latest.json`; beta completion never writes it. See
[Linux mirror publication](linux-updater-mirror-publish.md).

Beta publication and Linux completion share an exclusive channel lock across
versions and destinations, held through every write. An overlapping command
fails. Use one release host, or set `O8_UPDATE_FEED_LOCK_PATH` to the same shared
filesystem lock. Locks are removed only by their owner on exit. After an
interrupted process, confirm no channel writer is running before removing its
stale lock. Publication refuses beta downgrades and conflicting same-version
artifacts. Platform completion requires matching version and channel and preserves
all other entries and metadata.

Promotion is outside this change and is tracked in
[#4857](https://github.com/o8-run/o8/issues/4857). There is no promotion command.

Feed writes across repositories are sequential. A failure can leave one mirror
advanced. Retry `O8_RELEASE_CHANNEL=beta npm run release` in the retained
release checkout with the original version, artifacts and signature files to
finish reconciliation. Do not rerun `npm run ship`, which builds artifacts and
has a separate published-version preflight. Before writing any local manifest or
publishing assets, beta publication checks both feeds at every destination and refuses
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
