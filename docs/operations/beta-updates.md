# Beta and stable update feeds

Settings > General > Updates offers Stable (the default) and Beta. The preference
persists in the native update settings. Manual, launch and background checks use
the same native updater. The primary service receives the selected channel;
mirrors read `beta.json` or `latest.json` from the same directory. Update checks
and installation refuse artifacts retained across a channel change.

Beta uses normal release versions. Returning to Stable retains the installed
version until stable advertises a higher version. It never installs an older
stable build automatically.

## Publish and promote

A separately authorized `npm run ship` publishes the new version as a candidate,
uploads `beta.json` with the signed artifacts, then advances the rolling
`beta.json` beside `latest.json` on each repository's existing latest release.
The existing stable release remains the feed anchor. Do not change that anchor
with a manual latest-release edit: updater URLs resolve through it.

The default publication channel is beta. Direct stable publication is refused.
The existing explicit preview path remains separate and does not advance beta.
Signing, notarization, version tags and publication credentials retain their
existing controls.

After verifying the beta candidate, a separately authorized
`npm run promote -- --version X.Y.Z` reads its tagged `beta.json` in every target
repository, checks version and artifact consistency, then replaces only
`latest.json` at each stable feed anchor. It preserves all artifact URLs and
signatures and performs no build, signing or tag changes. Promotion refuses a
stable downgrade or conflicting artifacts for an already-promoted version.

Feed writes across repositories are sequential. A failure can leave one mirror
advanced; retry the exact candidate to finish reconciliation. Do not rebuild or
replace its artifacts. Missing anchors or mismatched manifests require repair
before retrying.

The primary update service must select the matching manifest using
`X-O8-Channel` and preserve its `channel: beta` marker. A primary response
without beta identity falls back to the beta mirror. Its deployment is maintained outside this repository; verify that
service separately before enabling beta publication in production. The app's
configured mirror fallback uses the same channel even if the primary is absent.
