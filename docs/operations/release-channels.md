# Release channels

`main` is the integration branch. Pull requests retain the required checks and
operator merge decision. This runbook changes neither signing nor notarization,
release workflow permissions, or publication credentials.

## Build identity and candidate shipping

`release-build.json` records build intent in source. Its default is `beta`.
The export step embeds `o8-build-channel.json` in the packaged server resources
before the existing app and updater signing steps. It contains the schema,
version and channel. The build recipe includes this source input, so changing
intent invalidates retained build output. Preview versions embed `preview`.

After the version change is reviewed, the normal `npm run ship` command uses
the existing preflight, build, signing and notarization steps, then the separate
beta publisher. That publisher verifies the updater signature before reading
the embedded identity. It also checks universal and selected CPU archives,
installer identity, the current sidecar receipt and native dependencies.
`O8_RELEASE_CHANNEL` cannot relabel an existing artifact or choose its publisher.
An interrupted beta publication retried through `npm run release` fails before
any stable publication effect. A repeated immutable candidate requires a fresh
version.

Beta publication creates prereleases with `--latest=false` and `beta.json`.
It never writes `latest.json`, `fixed.json`, stable receipts or announcements.
Both repositories must already have a published prerelease anchor tagged
`beta`; provisioning that anchor is a separate operator action. The publisher
neither creates nor moves that tag. The rolling feed is
`releases/download/beta/beta.json`, independent of the latest stable release.
Both destinations are checked before the first remote mutation. Invalid,
repeated or older candidates are refused.

All feed writers share a local publication lock. Concurrent publication fails
closed. A killed process can leave a lock; confirm that its recorded process is
no longer publishing before explicitly removing it. Use one release host and
one lock location for all writers. Never override the lock to overlap writers.
A channel feed must never move backwards. Linux completion can only add or
replace its platform entry when the feed already names that exact version.

## Installed checks

Settings offers Stable (the default) and Beta. Enrollment persists locally.
Stable reads the existing stable endpoints and accepts only manifests explicitly
marked `stable`. Beta reads its own primary feed and the mirror feed where
available, then checks Stable and chooses the newest acceptable version. Each
feed must have the expected channel identity, including fallback responses.
Unmarked legacy manifests fail closed; the first feed produced by this change
must include the explicit marker before clients rely on it.

Checks use native session, sequence, channel and enrollment-generation tickets
across all windows, launch checks and background checks. The server and UI reject
superseded completions and queued events. Returning to Stable uses the normal
version comparator: an older stable version reports current and never installs
over a newer installed build. It waits for a newer stable release.

## Manual downgrade compatibility

The queue ledger compaction migration in #5021 keeps applied steer text readable
by older builds, including v0.1.812. Inline images are removed from delivered
receipts, so older builds can omit those images from the steer transcript.
After a manual downgrade below the release containing this migration, retrying a
message that was already delivered returns an identity conflict instead of its
receipt. Nothing is lost and new messages work. The updater never downgrades;
returning to Stable waits for a newer stable release as described above.

## Linux signature completion

The Linux build must include the same embedded build identity in the AppImage.
On the release host, install `unsquashfs` as a read-only inspection prerequisite.
`npm run ship:linux-sig -- --tag <vX.Y.Z>` downloads the candidate AppImage, uses the
existing updater signer, verifies its signature, then reads the identity from
its authenticated filesystem without executing the binary. Publication selects
`beta.json`, `latest.json` or `preview.json` from that artifact identity, never
from the environment. Every fetched manifest must carry its matching marker.

The command validates all destination manifests before writing, preserves every
other platform entry, and holds the shared lock throughout. An older beta
candidate may receive its immutable release's Linux entry, but cannot replace a
newer rolling beta feed. Only the matching version on the independent beta
anchor is completed. Missing or invalid identities, extraction failures and
mixed-channel AppImages refuse publication.

Local `.deb` and `.rpm` installers have no authenticated channel identity and
are refused in publisher upload lists. Remove them from the candidate bundle
or add separately reviewed authenticated packaging support; an unsigned JSON
marker is insufficient. The AppImage and its signature remain supported.

## Stable and preview

The stable publisher retains its existing archive, installer, sidecar, native,
receipt and announcement guards. It requires a signed `stable` build identity
and contains no beta branch or beta guard exemption. The normal ship command
requires candidate build intent. Stable manifests keep the existing
`releases/latest/download/latest.json` address.

Preview versions use the existing prerelease path and `preview.json`; neither
stable effects nor clobbering an existing candidate are allowed. Inspect policy
with `node scripts/release.mjs --dry-run`. Beta artifact inspection uses
`node scripts/release-beta.mjs --dry-run`; neither command signs, notarizes or
publishes during a dry run.

Promotion is separate work in #4857. Installed-build smoke acceptance remains
in draft #4813. This change does not establish a smoke receipt or perform a
release, tag operation or promotion.

## Development and nightly verification

Develop in short-lived branches. Source testing beside an installed app uses
disposable data directories and separate API and WebSocket ports. The existing
nightly workflow verifies source; it creates no installer or release and does
not establish installed-build acceptance.
