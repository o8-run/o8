# Beta and stable update feeds

Settings > General > Updates offers Stable (the default) and Beta. The preference
persists in the native update settings. Manual, launch and background checks use
the same native updater. The primary service receives the selected channel;
mirrors read `beta.json` from the independent `beta` anchor or `latest.json`
from the existing stable endpoint. Update checks
and installation refuse artifacts retained across a channel change.

Beta uses normal release versions and checks both beta and stable, taking the
newer available version on the primary endpoint or its mirror fallback. Returning
to Stable retains the installed version until stable advertises a higher version. It never installs an older
stable build automatically.

## Publish and promote

The ship command uses the source build intent and embeds its channel before
signing. Publication verifies the signed build identity and writes `beta.json`
to the immutable candidate and the independent `beta` prerelease anchor in each
repository. The environment cannot relabel the build. There is no tag-local
`latest.json` compatibility alias. Keep the stable publisher's artifact,
installer, receipt and announcement guards unchanged. See
[Release channels](release-channels.md) for the existing publication controls.

For Linux, complete the port build and mirror copy for that candidate, then run
`npm run ship:linux-sig -- --tag vX.Y.Z` on the release host. The command verifies
the AppImage's updater signature and embedded identity before selecting the
manifest. A beta artifact completes the candidate's `beta.json` and adds its
exact installer hash without changing other platform entries. It updates the
rolling beta anchor only when that anchor already has the same version. An old
completion cannot replace a newer candidate. No stable compatibility manifest
is written. See [Linux mirror publication](linux-updater-mirror-publish.md).

After installed smoke acceptance, separately authorized promotion reads the
candidate's tagged `beta.json` in every repository. It refuses mismatched
candidates, missing stable platforms, conflicting artifacts for an already
promoted version, or a stable downgrade. It copies every artifact URL and
signature unchanged and sets the feed identity to `stable`, so stable clients
can accept it. The signed build identity remains attached. No promotion
rebuilds, signs or retags an artifact.

Promotion uses the same exclusive publication lock as beta publication and
Linux completion, before reading any feed and through the last stable write.
All writers run on one release host with the same `O8_RELEASE_FEED_LOCK`
location. An overlapping command fails. Retry after the owner exits; an older
version must still fail if a newer version has become stable. Never bypass the
lock or use independent lock locations. Confirm the recorded owner is no
longer publishing before explicitly removing a stale lock.

Feed writes across repositories are sequential. A failure can leave one mirror
advanced; retry the exact candidate to finish reconciliation. Do not rebuild or
replace its artifacts. Missing anchors or mismatched manifests require repair
before retrying.

The primary update service must select the matching manifest using
`X-O8-Channel` and preserve its `channel: beta` marker. A primary response
without the requested channel identity is refused, with channel-specific fallback. Its deployment is maintained outside this repository; verify that
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
