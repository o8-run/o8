# Launcher updater

Step 4 of #6130. The launcher can check for, verify and install an update
without the classic shell. Nothing ships it yet: the launcher is not bundled
until the packaging step, and that step must not start before both manual
proofs below pass on real release builds.

## Reused from the classic updater

The release side does not change. Everything below is read from the classic
shell (`tauri-plugin-updater` 2.10, configured in `src-tauri/tauri.conf.json`,
driven by `src-tauri/src/update_ping.rs`, fed by `scripts/release.mjs` and
`scripts/lib/release-manifest.mjs`).

| Item | Source | In the launcher |
| --- | --- | --- |
| Public key | `plugins.updater.pubkey` | `update::PUBLIC_KEY`, base64 of the minisign public key file. A unit test fails if the two differ. |
| Feeds | `plugins.updater.endpoints`: the update service, then the release mirror's `latest.json` | `update::ENDPOINTS`, same order and templates (`{{target}}` = `darwin`, `{{arch}}`, `{{current_version}}`). Same unit test. |
| Channels | `update_ping.rs` | Enrollment is read (never written) from the classic `update-ping.json` in `~/Library/Application Support/ai.o8.desktop/`: `pendingChannel`, then `channel`, then `preview` for `preview.*` builds, else `stable`. Beta also checks Stable and takes the newer. Mirror manifests: `latest.json`, `beta.json` (GitHub's `beta` tag), `preview.json`. The manifest's `channel` must match. |
| Service request | `update_ping.rs` | Sent with `X-O8-Channel` only; no install or device identity; 2 s bound; a redirect, error or wrong channel falls back to the mirror (15 s bound). 204 means no update. Same user agent as the classic updater. |
| Manifest | `release-manifest.mjs` | Static (`platforms["darwin-<arch>-app"]` or `["darwin-<arch>"]` with `url` and `signature`) or the service's dynamic shape (`url`, `signature` at the top). |
| Signature | `tauri-plugin-updater` | The same crate, `minisign-verify` 0.2.5: base64-wrapped minisign signature over the archive bytes; prehashed signatures stream, legacy ones are accepted as the classic updater accepts them. Key id mismatch refuses. |
| Archive | release `o8.app.tar.gz` / `o8_<arch>.app.tar.gz` | gzip tar with one top directory holding the bundle, read with the same `tar` and `flate2` crates. |
| Version rule | default comparator | Strictly newer only. The classic updater never downgrades and its feed has no field allowing it, so none is honoured. |

New dependencies, all already used by the classic shell's updater:
`minisign-verify`, `tar`, `flate2`, `semver`, `base64`, and reqwest's `rustls`
feature (the feeds are HTTPS). `minisign` is a dev-dependency only: tests sign
fixture archives with a key generated in the test.

## What an install does

1. `update-apply` refuses at once, before any download, when the bundle is
   translocated, on a read-only volume (such as the disk image), not writable
   by this user, a mount point, or not an `.app` directory.
2. Check the feed again, then download into a new private file under
   `<data>/updates/` (directory 0700, file 0600), refusing more than 1 GiB or
   fewer bytes than announced.
3. Verify the signature over that file. Nothing is unpacked before it holds.
4. Unpack into `<bundle parent>/.<name>.app.update/staged/<name>.app` (0700,
   same volume). Refused: absolute paths, `..`, more than one top directory,
   links whose target leaves the bundle, writing through a link, hard links,
   devices and pipes, duplicates, more than 250,000 entries or 8 GiB. The staged
   bundle's `CFBundleShortVersionString` must equal the announced version, so an
   older validly signed archive cannot be relabelled as new, and its
   `CFBundleExecutable` must exist as an executable file.
5. Restart admission: the same final work inspection and cloud-job drain as
   `restart`. A refusal discards the staged copy and leaves everything running.
6. The launcher's bounded shutdown stops both servers, proves their ports free
   and releases the lock and socket. If any of that fails, nothing is swapped.
7. One `renamex_np(RENAME_SWAP)` exchanges the staged and installed bundles,
   both parents are flushed, and the old bundle is kept at
   `.<name>.app.update/previous/<name>.app` until the next update.
8. Start `<bundle>/Contents/MacOS/<CFBundleExecutable>` with the launcher's
   original arguments and environment, in its own process group, as the
   classic updater restarts. If it cannot be started, the previous bundle is
   swapped back and started instead.

The outcome is kept in `<data>/update-last.json` and returned by
`update-status` after the relaunch.

### Interruption at any point

The installed path is only ever changed by the one atomic swap; downloading,
verifying and unpacking happen elsewhere. A crash or power loss therefore
leaves the complete old bundle or the complete new bundle there, never a mix.
`<data>/update-journal.json` is written before the swap. At the next start,
while holding the instance lock, recovery reads the installed version: if it is
the new one, it moves the old copy to `previous` and records `installed`;
otherwise it deletes the staged copy and records that the old version was kept.
Leftover downloads are deleted. The swap needs a volume with `RENAME_SWAP`
(APFS and HFS+); elsewhere it fails before changing anything.

## Control commands

On `launcher.sock`, newline-terminated JSON followed by write-side EOF, like
the other commands:

- `{"op":"update-check"}`: answers when the check finishes (the main loop keeps
  running): `state` `available` with `available.version`, `notes`, `date`, or
  `current`; `failed` with `error`.
- `{"op":"update-apply"}`: `{"ok":true,"state":"staging"}`, or a refusal with
  `error`. Then poll status: `staging`, `staged`, `installing`, or `failed`.
  On success the launcher exits and the new version starts.
- `{"op":"update-status"}`: `state`, `current`, `channel`, `available`,
  `error`, `blocked` (why this location cannot update, if it cannot), `last`.

Only one update job runs at a time. Other platforms, or a version that is not a
release version, answer `{"ok":false,"state":"unsupported","error":…}`.

Configuration: an optional `update` block. Release builds accept only
`settings` (the enrollment file). `bundle`, `endpoints`, `pubkey` and
`max_download_bytes` exist for fixtures and are refused by release builds, so a
configuration file can never change the key or the feed. Plain HTTP is
accepted only by debug builds and only for `127.0.0.1`.

## Tests

`tests/update.rs` drives the real launcher binary (macOS) against a local feed,
with archives signed by a key generated in the test: a good update installs
after a proven stop and the new version starts with the same arguments; a bad
signature, a truncated download, a signed archive with a traversal entry, a
downgrade and a relabelled older archive each refuse with the installed bundle,
servers and staging untouched; an unwritable location reports before any
download; a crash just before and just after the swap leaves a launchable app
and the next start recovers; a non-release version answers `unsupported`.
Unit tests cover the key and feed match, channel manifests, both manifest
shapes, link containment, unpack refusals and signature tampering.

Not covered here: a real release archive and key, codesign and Gatekeeper on
the swapped bundle, the service endpoint's live behaviour, a read-only or
translocated volume through the binary (path and `statvfs` checks only),
automatic periodic checks, and a new version that starts but then crashes (the
previous copy is kept, but nothing rolls back automatically).

## Manual proof before any release

Both proofs need real signed and notarized release builds and the real update
key, so they are run by the release owner, never by an agent. Use a spare Mac
or a separate macOS user with no unsaved work.

### Old to new: classic app updates to a launcher-based app

1. Install the current classic release (version N) into `/Applications` from its
   disk image, open it once, and quit it.
2. Build a launcher-based release N+1 with the normal release flow and publish
   it to a test channel only: a private mirror path for `latest.json` is enough.
   Point the test machine at it (for example a preview build enrolled in the
   test channel); never publish to Stable for this proof.
3. Open N and install the update from Settings. Confirm: the app restarts on its
   own; `/Applications/o8.app` is N+1 (`defaults read
   /Applications/o8.app/Contents/Info.plist CFBundleShortVersionString`); its
   main program is the launcher; `codesign --verify --deep --strict` and
   `spctl -a -vv` pass on it; the window opens, the servers answer, and push to
   talk and existing sessions still work.
4. Quit from the Dock and confirm both server ports are free and no o8 process
   remains.

### New to new: launcher-based app updates itself

1. With N+1 installed from step 3 above, publish N+2 (launcher-based) to the
   same test channel.
2. Send `{"op":"update-check"}` to `launcher.sock` in the o8 data directory and
   confirm `available.version` is N+2. Send `{"op":"update-apply"}` and poll
   `update-status`.
3. Confirm the launcher exits, both server ports were released before the swap
   (launcher log), the app restarts as N+2, `codesign` and `spctl` pass,
   `.o8.app.update/previous/o8.app` holds N+1, and `update-status` reports
   `last.outcome` `installed` from N+1 to N+2.
4. Refusal checks on the same machine: serve a manifest whose signature is from
   another key, then one announcing an older version, and confirm each refuses
   with N+2 untouched. Copy the app to a read-only disk image, open it from
   there, and confirm `update-status` reports `blocked` and apply refuses.
5. Interruption: start an apply on a test build and cut power while the status
   is `installing`. After boot, confirm `/Applications/o8.app` opens (N+1 or
   N+2), and `update-status` records which.

## Background readiness (#6397, first part)

After startup the launcher checks once, then hourly while no update is staged.
A newer release downloads and passes the existing signature and archive checks
on the updater worker. Background completion holds `state: staged` without
requesting restart admission. `update-apply` reuses that verified staged bundle
and goes through the existing final work inspection and shutdown. Explicit
apply without a staged bundle retains the previous download-and-apply behavior.
Debug fixtures can set `background_delay_ms`; release builds refuse that field.

The native window polls `launcher.sock` using the directory of its explicit
shell-state file. A staged version shows the existing success toast with
`Update installed` and `Relaunch Now`, plus a quiet persistent restart hint.
Dismissal leaves the hint. A failed check or stage offers Retry. Before an
explicit apply the window flushes its layout writer; a save failure keeps the
window running. This does not establish terminal survival, flush the separate
composer draft debounce, apply on normal quit, or recover swap failures in the
old window. Those remain the next lossless-relaunch part of #6397. No terminal
preservation promise appears until the live-session acceptance test passes.

## Local classic-to-launcher chain

On macOS, build the isolated installer in the existing classic updater fixture,
then run the opt-in chain test. Use a worktree-local target directory; debug
symbols and incremental compilation are disabled to bound disk use. Check free
space before each build and stop below the operator's free-space floor.

```sh
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$PWD/target/update-chain"
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0

df -h /
cp src-tauri/Cargo.lock tests/fixtures/update-ping-native/Cargo.lock
cargo build --manifest-path tests/fixtures/update-ping-native/Cargo.toml --bin update-chain-classic

df -h /
O8_CLASSIC_UPDATER_FIXTURE="$CARGO_TARGET_DIR/debug/update-chain-classic" \
  cargo test --manifest-path crates/o8-launcher/Cargo.toml --test update \
  classic_to_launcher_release_chain -- --ignored --exact --nocapture
```

The test generates its own minisign key and loopback feed. In each scenario the
fixture's pinned classic updater installs a signed archive containing the real
launcher built by this test run. The test starts that installed executable with
the existing server fixture configuration. That launcher then checks and applies
NEXT from the same feed. Assertions cover installed executable bytes, version,
relaunch arguments, the previous launcher bundle, and the persisted outcome.
Companion scenarios refuse another key's signature, restore and start NEW when
NEXT's interpreter does not exist, and recover interrupted swaps on startup.

This is plugin-level classic compatibility: a mock application runtime supplies
the installed path, current version, generated public key and loopback endpoint.
The test starts NEW explicitly after the classic installer returns; it does not
exercise the shipped classic shell's restart call, UI, enrollment, admission or
cleanup. The helper uses the desktop lockfile, as the fixture runner does. It
does not run a built release executable. NEW uses debug update overrides and
stub servers; NEXT is a stub executable. After a post-swap interruption, the real launcher entry
point settles the journal using its debug installed-bundle override, since the
installed NEXT is a stub. No release key, Developer ID signing, notarization,
Gatekeeper assessment of a quarantined download, or real server lifecycle is
proven here. The manual release proofs above remain required.
