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
`latest.json` and `beta.json`, then refreshes only the rolling beta feed. Check
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

Promotion takes an exclusive lock across all versions and destinations before
reading stable, holds it through every write, and rechecks stable immediately
before each write. An overlapping command fails; retry it after the owner exits.
A retry of an older version must fail once a newer version is stable. Run all
promotions on one release host (or set `O8_PROMOTE_LOCK_PATH` to the same shared
filesystem lock). Do not run independent promotion hosts with separate locks.
Locks are removed only by their owner on exit. After an interrupted process,
confirm no promotion is running before removing its stale lock.

Feed writes across repositories are sequential. A failure can leave one mirror
advanced; retry the exact candidate to finish reconciliation. Do not rebuild or
replace its artifacts. Missing anchors or mismatched manifests require repair
before retrying.

The primary update service must select the matching manifest using
`X-O8-Channel` and preserve its `channel: beta` marker. A primary response
without beta identity falls back to the beta mirror. Its deployment is maintained outside this repository; verify that
service separately before enabling beta publication in production. The app's
configured mirror fallback uses the same channel even if the primary is absent.

## Installed smoke before promotion

Run this flow only after the separate publication approval. These commands do
not grant permission to publish or promote by themselves.

1. Run the normal ship command to publish the candidate to beta.
2. Finish Linux port publication and `ship:linux-sig` before downloading the
   final tagged `beta.json`. Linux completion adds its exact AppImage hash to
   `installers` while retaining the macOS installer identities. Download every
   installer named there. A later Linux completion changes the manifest and
   requires fresh smoke receipts for every installer before promotion.
3. On each installer's supported platform, run:

   ```sh
   npm run smoke:installed -- --artifact <installer> --manifest <beta.json> --receipt <smoke.json>
   ```

   The command mounts a disk image read-only and copies its app to a temporary
   location, or extracts an AppImage or package into a temporary location. It
   launches that installed executable, checks the version and hydrated first
   window through an isolated native acknowledgment (the optional control
   plugin is not required), then runs both chat backends and a worker through the installed
   server. Each reply must match a fresh sentinel and complete successfully.

   Each chat uses its explicitly selected backend without fallback. The worker
   uses an installed local runtime when either is available, otherwise the
   primary fixture runtime. Installed CLIs are used when found on PATH;
   an absent CLI gets an offline fixture that exercises the same app routing and
   protocol parsers. Output and the receipt report `real` or `fixture` for each
   provider. An installed but failing CLI fails the step. Fixture success is
   protocol evidence, not live account or model acceptance.

   The child receives a throwaway home, configuration, cache, data directory,
   repository, ports and control socket. The app's isolated native-test mode
   suppresses daily-instance integration and keychain access. No credentials or
   profiles are copied from the operator. Real providers therefore need usable
   environment-based authentication; missing authentication fails the step.
   Provider output and credentials are omitted from the receipt and failure log.

4. Inspect the passing receipt for every advertised installer, then run the
   separately authorized promotion:

   ```sh
   npm run promote -- --version X.Y.Z --smoke-receipt <smoke.json>
   ```

   Repeat `--smoke-receipt` for multiple installers. Promote refuses before its
   first stable write unless every installer has a passing receipt for the exact
   version, installer hash and complete beta manifest. A changed artifact,
   manifest, failed step or incomplete cleanup requires another smoke run.

A failed smoke exits non-zero naming `artifact`, `unpack`, `first-window`,
`codex-chat`, `claude-chat`, `worker-dispatch`, or `cleanup`. It never writes a
passing receipt on failure. Cleanup terminates only the launched process group
and checks the isolated listener before deleting temporary state. If cleanup
cannot confirm shutdown, it retains that isolated state and fails. Preserve it
for inspection; never use broad process killing or delete the daily profile.

The command supports disk images on macOS and AppImage or `.deb` extraction on
Linux. Unsupported package formats fail at `unpack`. Platform command fixtures
and source-runtime tests do not establish acceptance of a real signed installer;
retain that installer's actual passing receipt before production promotion.
