# Native update check tests

Run from the repository root:

```sh
node scripts/test-update-ping-native.mjs
```

This compiles the production update-ping module with Tauri's mock runtime and calls `check_app_update` through IPC. Real local HTTP servers exercise the updater transport and manifest parsing; a temporary settings file proves identity persistence across app instances. The runner uses the desktop lockfile. It does not launch the desktop app or its sidecars.

The fixture covers unreachable services, HTTP errors, redirects, malformed manifests, stalled response bodies, exact path and header fields, and the absence of ping headers on fallback requests and downloadable update resources. A signed installed-app update and the live service remain release verification boundaries.

## Install handoff race tests

This crate compiles the production updater, launch, scheduler, journal and task
modules with a mock native runtime. It never launches the installed app.

`build.rs` copies those source modules into its generated output. It adds two
checked, exact-match fixture edges: a pause in each existing pre-install gap,
and a wrapper around each platform installer call. Source drift fails fixture
compilation. Other code, including channel persistence, native commands, signed
download verification, admission and journal behavior, runs unchanged.

Only tests that manage `install_race_edge::Hooks` replace installer effects with
a counter or callback. Without hooks, the original installer remains in use by
the existing platform-specific fixture tests. Race tests use precomputed public
signature fixtures; they never sign, notarize or publish.

`update_ping_channel_change_cancels_pending_install_after_epoch_guard` pauses
both the real manual IPC path and automatic candidate path after their original
epoch checks, saves Stable, then resumes. It requires zero installer calls and
no automatic-install marker. Companion tests cover an in-flight download,
installation winning the race, reentrant channel saves, clock callbacks, and
recovery after an expected installer refusal.
