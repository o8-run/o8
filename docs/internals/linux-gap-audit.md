# o8 next Linux gap audit

Audited 2026-11-04 for #5275 at base `801fb140275b4ca25965a3333b1e5d2770fe32ac`.
Host: Ubuntu 26.04 x86_64, X11 under a private 1440×1024 Xvfb display, software Vulkan.
Source paths below are relative to `native/o8-next/` unless they start with `scripts/` or `.github/`.

This is an implementation and test audit, not a claim of complete desktop parity.
The current [parity inventory](../../native/o8-next/PARITY.md) has no Linux/Windows columns:
all 62 `partial`/`missing` rows were swept and reconciled below rather than treating old labels as current failures.
“Shared native gap” means the same absence exists beyond Linux; it is not evidence of a Linux regression.
A cfg fallback is established from source; a skipped assertion is only a coverage gap.
Size guesses: S is localized work, M needs a component/platform adapter, L needs a substantial workflow or renderer.

Excluded: #5274, #5318, #5319, #5320, #5384, #1672, #5191.

## Gaps

| Surface | What Linux shows | Evidence | Size |
| --- | --- | --- | --- |
| Automation UI command | Fixed in this branch (`224b04d76`): opens the existing Scheduled surface and saves its tab. Previously showed “Automations are not in o8 next yet.” Shared native gap. | `src/shell_features/ui_commands.rs:125`; `shell::feature_tests::ui_command_automations_opens_the_registered_scheduled_surface`: before fix, `panicked at src/shell_feature_tests.rs:194:5:`, active session instead of Scheduled; after fix, `1 passed; 0 failed; 0 ignored`. | S |
| Embedded Browser | Stub/error pane: “The Browser needs macOS for now.” Navigation chrome remains; page content, agent evaluation, popups and site favicons have no Linux implementation. | `src/browser_panel/web.rs:466-500`, `view.rs:433,473`, `favicon.rs:81`; `tests.rs:441,757` omit document-commit and popup regressions on Linux. | L |
| Remote previews | Error row: “Remote previews currently require macOS.” Production skips task discovery; the native host constructor is a stub. Tests bypass the discovery gate. | `src/browser_panel/remote.rs:78-81`; `remote/web.rs:211-225`. | L |
| Live device viewer | Stub message: “The live device viewer needs macOS for now.” Device state and agent/roster controls remain available. | `src/devices_panel.rs:5,37,61,80`; `devices_panel/view.rs:396,418,424`. | L |
| Recent screenshot picker | Nothing: the recent-screenshot list is always empty. Existing file attachment paths remain separate. | `src/composer/screenshots.rs:36-37`; discovery and thumbnails use `defaults` and `sips` at lines 14 and 94. | M |
| Video poster thumbnails | Plain video tile when the poster request fails; the helper invokes the absent macOS Quick Look command. | `src/files_panel/media.rs:31-64`: `/usr/bin/qlmanage`; `src/files_panel/notes_assets.rs:169-172,258-260` renders a fallback tile. | M |
| All Glass and window chrome | Opaque root, dark by default; choosing Glass does not install system blur. Linux uses an ordinary titlebar without traffic lights. | `src/theme.rs:55,58`; `shell_material.rs:8-54`; `shell_view.rs:248-250`. | M |
| Hold-to-dictate shortcut | Nothing from the macOS hold gesture: Ctrl+Z is not intercepted for dictation. The microphone control still has its own actions. | `src/shell_features/dictation.rs:141-152` only enables the held shortcut on macOS. | M |
| PDF, video and audio file previews | Error row: “PDF/Video/Audio preview is not available yet.” Raster images and Markdown already render. Shared native gap. | `src/files_panel.rs:340-344`; `src/files_panel/media.rs:66-72`. | L |
| Terminal selection, copy and mouse reporting | Terminal renders, accepts keys/paste and scrolls, but a click only focuses it; there is no selection/copy UI or terminal mouse-report dispatch. Shared native gap. | `PARITY.md:23`; `src/terminal.rs:166-205,315-330`. | M |
| Brain memory management | Conversation, source excerpts and local search; no memory editing/deletion controls, and conversation text is kept in memory rather than shell restore. Shared native gap. | `PARITY.md:24`; `BRAIN.md:6-8,24`; `src/brain.rs`. | L |
| Git history workspace | Nothing: Activity exposes recent commits and a commit diff, but there is no registered history workspace. Shared native gap. | `PARITY.md:31`; `src/shell.rs:44-70`; `surfaces/activity/commit.rs:5-23`. | L |
| Standalone CI workspace | Activity CI summaries/details, retry and links; no standalone CI workspace. Shared native gap. | `PARITY.md:32`; `src/shell.rs:44-70`; `src/surfaces/activity/view.rs`. | L |
| Deployments workspace | Nothing: no registered deployment surface. Shared native gap. | `PARITY.md:33`; `src/shell.rs:44-70`. | L |
| Timeline workspace | Nothing: no registered timeline surface. Activity is a separate feed. Shared native gap. | `PARITY.md:44`; `src/shell.rs:44-70`. | L |
| Audit-log workspace | Nothing: no registered audit-log viewer. Settings feature diagnostics are a different surface. Shared native gap. | `PARITY.md:45`; `src/shell.rs:44-70`. | M |
| Account/sign-in management | Local connection/credential setup and provider controls, but no native account/sign-in settings page. Shared native gap. | `PARITY.md:47,61,63`; `src/settings_fields.rs:266-287`; `src/shell_features/connection.rs`. | L |
| PR review and restore | PR controls render, but linked-packet merge/auto-merge enable are refused; per-PR view/draft state has no persisted slice. Shared native gap. | `src/surfaces/pull_requests/model.rs:622-644`; `src/surfaces/pull_requests.rs:11` (`Slice = EmptyState`); `docs/surfaces/pull-requests.md:54-57`. | L |
| OS startup integration | General defaults and privacy toggles exist; no native launch-at-login control. Shared native gap. | `PARITY.md:60`; `src/settings_fields.rs:288-365` enumerates General controls. | M |
| OS permission settings | Nothing: no native operating-system permission page. Shared native gap. | `PARITY.md:77`; `src/settings_fields.rs:266-287`. | M |
| Cloud-worker settings | Nothing: no dedicated cloud-worker settings page. Dispatch defaults, worker actions and Machines are separate existing surfaces. Shared native gap. | `PARITY.md:74`; `src/settings_fields.rs:266-287`. | L |
| Local model lifecycle management | Editable model names for an already configured inference endpoint; no install/remove/start/stop model manager. Shared native gap. | `PARITY.md:65`; `src/settings_fields.rs:724-740` exposes only model-name fields. | L |
| Plugin catalog | Local action-folder review/link/run management exists; no remote catalog/search/install/update workflow. Shared native gap. | `PARITY.md:37,89`; `src/surfaces/customize/plugins.rs:1-16`; `view.rs:14-22`. | L |
| Customize Commands | Nothing: no Commands tab/inventory in Customize; the shell palette is available separately. Shared native gap. | `PARITY.md:86`; `src/surfaces/customize/view.rs:14-22`. | M |
| Customize Instructions | Authored inventory; indexed references are excluded and there is no backing-file edit/forget workflow. Shared native gap. | `PARITY.md:85`; `src/surfaces/customize/inventory.rs:118-126`; `view.rs` only edits saved prompts. | M |
| Customize Prompts | Create/edit/copy/delete exists; no import or scope-reassignment control. Composer insertion is available separately. Shared native gap. | `PARITY.md:87`; `src/surfaces/customize/view.rs:219-263` preserves an existing prompt’s scope. | M |
| Customize Skills | Metadata rows; no full-content view, import or bundle-management controls. Shared native gap. | `PARITY.md:88`; `src/surfaces/customize/inventory.rs:93-119`; `view.rs`. | M |
| Customize Connections | Metadata/built-in inventory; no server-management controls in this tab. Settings does have external-client connection controls. Shared native gap. | `PARITY.md:90`; `src/surfaces/customize/inventory.rs`; `src/surfaces/settings/mcp.rs`. | M |
| Customize Agents | Metadata rows; no backing-file view. Shared native gap. | `PARITY.md:91`; `src/surfaces/customize/inventory.rs:93-119`; `view.rs`. | M |
| Customize Hooks | Event metadata rows; no complete hook configuration/backing-file workflow. Shared native gap. | `PARITY.md:92`; `src/surfaces/customize/inventory.rs:93-119`; `view.rs`. | M |
| Composer IME coverage | The editor remains available with Linux key mappings, but two macOS-only tests omit IME/emoji/paste and command-navigation assertions here. This is a coverage gap, not a demonstrated Linux input failure. | `src/input_tests.rs:54,123`: `macos_ime_emoji_paste_and_command_shortcuts`, `macos_command_navigation_and_deletion`. | M |
| Native shell visual regression coverage | Normal module runs skip the owned-X11 screenshot probe. The shell measurement captures a fixture frame but does not replace these visual assertions. | `src/shell_tests.rs:116-119`: `shell::tests::correction_native_screenshots`; `src/shell_look_tests.rs:25-28`: `shell::tests::look::correction_native_screenshots`. | M |
| Large-file timing receipt coverage | Large-file editor tests run normally, but the explicit 10k/100k/1M open/scroll/edit/highlight receipt is ignored by default. | `src/files_panel/tests.rs:715-716`: `files_panel::tests::large_file_receipt`. | S |
| Transcript throughput receipt coverage | Transcript tests run normally, but the explicit 2,000-row/20 Hz receipt is ignored by default. | `src/transcript_tests.rs:467-469`: `ui::transcript_tests::transcript_2000_rows_20hz_measurement`. | S |
| Split-pane throughput receipt coverage | Split panes remain available; the streaming CPU measurement is ignored by default. | `src/pane_grid_tests.rs:304-306`: `pane_grid::tests::pane_grid_measurement`. | S |
| Multi-terminal throughput receipt coverage | Terminal panes remain available; the six-slot/three-flooding-terminal measurement is ignored by default. | `src/grid_terminal_tests.rs:212-214`: `pane_grid::tests::terminals::grid_terminal_measurement`. | S |
| Session switching/input timing receipt coverage | The session UI remains available; its paired switch/scroll/key-paint receipt is ignored unless launched by its dedicated fixture runner. | `src/speed_receipt.rs:31-33`: `ui::speed_receipt::paired_speed_receipt`. | S |
| Parity inventory freshness | The written inventory still calls implemented surfaces missing and has no Linux/Windows status columns. Treating it as current would invent platform gaps. | `PARITY.md:3,27,29,34-35,39,42,48-50,62,65,70-72,76,78-79`; current registrations and panels are reconciled below. | S |

## Native module tests

The 55 file-backed top-level modules and the inline `tests` module are taken
from `src/main.rs` (56 groups). Each command runs alone
with `CARGO_BUILD_JOBS=4`, the existing `CARGO_TARGET_DIR`, and two test threads:

```sh
CARGO_BUILD_JOBS=4 xvfb-run -a \
  -s '-screen 0 1440x1024x24 -nolisten tcp -noreset -br' \
  cargo test --locked --manifest-path native/o8-next/Cargo.toml \
  --bin o8-next '<module>::' -- --test-threads=2
```

Where a substring filter also matches another top-level module, that other
module is excluded from the invocation with `--skip`; every discovered test is
accounted for in its own module. Zero-test modules are listed explicitly.
The persisted-history fixture daemon is built serially with CI's
`cargo build --locked --manifest-path crates/o8d/Cargo.toml --features experimental-http --bin o8d`,
and supplied through `O8D_HTTP_TEST_BINARY`.
These are debug-profile native tests; GPUI test-context scene assertions do not
establish real-window GPU presentation or release throughput.

| Module | Passed | Failed | Ignored |
| --- | ---: | ---: | ---: |
| `render_region` | 0 | 0 | 0 |
| `activity` | 7 | 0 | 0 |
| `app_parent` | 2 | 0 | 0 |
| `brain` | 0 | 0 | 0 |
| `browser_panel` | 9 | 0 | 0 |
| `client` | 5 | 0 | 0 |
| `clock` | 0 | 0 | 0 |
| `composer` | 55 | 0 | 0 |
| `devices_panel` | 0 | 0 | 0 |
| `diff` | 0 | 0 | 0 |
| `diff_tests` | 2 | 0 | 0 |
| `diff_ui` | 0 | 0 | 0 |
| `files_panel` | 78 | 0 | 1 |
| `grid_sessions` | 1 | 0 | 0 |
| `icon` | 1 | 0 | 0 |
| `inbox` | 1 | 0 | 0 |
| `lineage` | 9 | 0 | 0 |
| `input_reuse_tests` | 1 | 0 | 0 |
| `issues` | 0 | 0 | 0 |
| `merge` | 1 | 0 | 0 |
| `model` | 0 | 0 | 0 |
| `motion` | 2 | 0 | 0 |
| `pane` | 2 | 0 | 0 |
| `pane_tree` | 3 | 0 | 0 |
| `pane_grid` | 4 | 0 | 2 |
| `pane_layout` | 0 | 0 | 0 |
| `project_icon` | 0 | 0 | 0 |
| `projects` | 0 | 0 | 0 |
| `projects_model` | 0 | 0 | 0 |
| `retained` | 9 | 0 | 0 |
| `rich` | 0 | 0 | 0 |
| `settings` | 12 | 0 | 0 |
| `settings_fields` | 0 | 0 | 0 |
| `settings_secret` | 0 | 0 | 0 |
| `shell` | 536 | 0 | 5 |
| `shell_state` | 0 | 0 | 0 |
| `sidebar` | 0 | 0 | 0 |
| `stream` | 16 | 0 | 0 |
| `switch_receipt` | 3 | 0 | 0 |
| `terminal` | 5 | 0 | 0 |
| `terminal_grid` | 0 | 0 | 0 |
| `terminal_transport` | 0 | 0 | 0 |
| `text` | 6 | 0 | 0 |
| `thread_messages` | 2 | 0 | 0 |
| `theme` | 1 | 0 | 0 |
| `theme_tests` | 4 | 0 | 0 |
| `trace` | 11 | 0 | 0 |
| `subagents` | 10 | 0 | 0 |
| `transcript_actions` | 2 | 0 | 0 |
| `transcript_diagram` | 16 | 0 | 0 |
| `transcript_peek` | 4 | 0 | 0 |
| `transport` | 0 | 0 | 0 |
| `ui` | 119 | 1 | 2 |
| `visualizations` | 13 | 0 | 0 |
| `wake` | 2 | 0 | 0 |
| `tests` | 1 | 0 | 0 |
| **Total** | **955** | **1** | **10** |

All 966 discovered tests are accounted for exactly once. The post-fix sweep
has one failure, #5318, which remains excluded from the gap inventory.
Its first panic site is `panicked at src/worker_tests.rs:103:9:` with
`worker reply must paint before timing ends`. No new test failure was found.

Of the ten ignored entries, five are explicit timing/throughput receipts and
two are native screenshot probes; their coverage gaps are listed above.
One is #5191. The remaining two are owned child helpers,
`shell::startup_tests::first_load_probe` and `shell::tests::glass_shell_probe`:
their passing parent tests invoke them explicitly, so the default ignored
status does not establish an untested first-load or appearance feature.

The automation regression was also run alone before and after the one-line
fix with `--exact --test-threads=2`: red was `0 passed; 1 failed; 0 ignored`,
then green was `1 passed; 0 failed; 0 ignored`. It also passed in the full
`shell::` module run. The red assertion observed the session tab instead of
Scheduled at `src/shell_feature_tests.rs:194:5`; the green test verifies the
connected schedule row and persisted workspace tab as well as activation.

## Linux shell measurement

Not run. The resume instructions prohibit rebuilding the release target when
`$CARGO_TARGET_DIR/release/o8-next` is absent; it was absent on resume.
The first run's release-build log ends during compilation without a completion receipt.
There are no first-frame or idle-RSS verdict lines from this audit.

The current `.github/workflows/next-linux.yml:29-35` builds with
`cargo build --release --locked --manifest-path native/o8-next/Cargo.toml`, then runs
`scripts/next/linux-headless.mjs` under a private Xvfb display. That runner measures
one warm-up plus three fresh fixture hosts, first frames and idle RSS.
Its successful verdict would be
`warm median launchToFirstFrameMs <value>; three runs within idle RSS budget`.
No measurement is inferred from the CPU-scene native tests above.

## Packaging

The unsigned, unpublished GPUI packaging path is
`.github/workflows/linux-downloads.yml:29-52`, rather than the separate desktop
port/signing workflow. It fetches pinned Node/AppImage inputs, builds the native
release and the exported server (`npm run tauri:prebuild`), then invokes
`scripts/linux/stage-payload.mjs` and `scripts/linux/package-payload.mjs`.
The package script produces AppImage, DEB, RPM and `linux-downloads.json`, checks
a GLIBC 2.39 ceiling, and enforces 512 MiB payload / 256 MiB artifact budgets.
These review artifacts need no secrets or signing.

The first run fetched the pinned inputs and attempted `npm run tauri:prebuild`.
It reached `Creating an optimized production build ...` before interruption;
there is no completed server export. The retained staging receipt used:

```sh
node scripts/linux/stage-payload.mjs --server out/server \
  --node-root <pinned-node-root> \
  --next-binary "$CARGO_TARGET_DIR/release/o8-next" \
  --output <new-stage-directory>
```

It stopped with `Linux payload staging failed: ENOENT: no such file or directory, lstat '<checkout>/out'`.
No stage or packages were produced. The release binary is also absent and was
not rebuilt under the resume memory constraint. Package creation, GLIBC scans,
installation/launch checks and uninstall persistence checks remain unverified;
this is a missing receipt, not an established packaging defect. #1672 remains excluded.

## Parity inventory reconciliation

“Present” records an implementation, not a claim that every desktop interaction is equivalent.
Rows with broad “full workflow” remainders and no concrete missing control stay unverified instead of becoming invented Linux bugs.

| Inventory row | Current Linux disposition | Current source evidence |
| --- | --- | --- |
| Workspace shell, tabs, commands and restore | Present; tabs, restore, navigation and arbitrary pane tree are implemented. Platform remainder: All Glass/window chrome row. | src/shell.rs; shell_features/window_state.rs; pane_tree.rs |
| Projects and repository selection | Present: project CRUD, repository registration/membership and switching. Broad full-parity claim remains unverified; no macOS gate found. | src/projects_model.rs; projects_view.rs |
| Session list, history and live transcript (`transcript`) | Present; unsupported media and performance coverage are listed above. | src/ui.rs; rich.rs; retained.rs |
| Composer and queued messages | Present with attachments and voice actions; platform remainder: screenshot picker and held dictation shortcut. | src/composer.rs; shell_features/dictation.rs |
| Worker sessions | The read-only description is stale: controls include delivery, interrupt, resume and persisted pending requests. No additional platform gate found. | src/surfaces/workers/actions.rs; drafts.rs |
| Split session panes | Fixed-size grid remains, and shell panes also support a saved binary split tree. Measurement coverage is listed above. | src/pane_layout.rs; pane_tree.rs; shell_features/panes.rs |
| Terminal | Present; selection/copy/mouse reporting remain in gap table. | src/terminal.rs |
| Brain conversation, search and sources | Present; memory-management remainder is listed above. | src/brain.rs; BRAIN.md |
| Inbox: Needs reply, Contributions, Approvals, Agent issues, History | Present with production-route reads/actions. Account/sign-in remainder is listed above; no extra platform gate found. | src/inbox.rs; surfaces/inbox.rs |
| Issues list, detail and creation (`issue`, `new-issue`) | Present, including creation, discussion and contextual issue tabs. Full desktop parity is unverified; no macOS gate found. | src/issues.rs; issues_view.rs; surfaces/issues.rs |
| File tree and text file viewer/editor (`file`) | Missing label is stale: Files panel includes tree, editor, syntax and large-file handling. | src/files_panel.rs; files_panel/editor.rs |
| Diff and review (`diff`) | Present, including split/unified patches and commit diff. Full desktop parity is unverified; no macOS gate found. | src/diff_ui.rs; files_panel/file_diff.rs |
| Commit detail (`commit`) | Missing label is stale: Activity opens a native commit DiffSurface. | src/surfaces/activity/commit.rs |
| Pull request detail and list (`pr`, `pull-requests`) | Present; disabled linked-packet actions and missing persisted view/draft slice remain listed above. Older detailed parity lists also lag newer controls. | src/surfaces/pull_requests.rs; pull_requests/model.rs |
| Git history (`git-log`) | Gap table: no standalone history workspace. | src/shell.rs:44-70 |
| CI runs (`ci`) | Gap table: Activity slice exists; standalone workspace absent. | src/shell.rs:44-70; surfaces/activity/view.rs |
| Deployments (`deploy`) | Gap table: no registered surface. | src/shell.rs:44-70 |
| Usage (`usage`) | Missing label is stale: native Usage tab reads limits and local usage history. | src/surfaces/usage.rs |
| Automations (`automations`) | Missing label is stale: Scheduled tab supports local/manual/cron automation and connected schedules. | src/surfaces/scheduled.rs |
| Activity feed and packet controls | Present; the older missing-controls list is stale for lane stop/resume/merge, archive/restore, proposals and dossiers. Full parity remains unverified; no macOS gate found. | src/surfaces/activity/packet_controls.rs; proposals.rs; dossiers_view.rs; updates.rs |
| Plugin catalog (`plugins`) | Gap table: local action plugins exist; remote catalog absent. | src/surfaces/customize/plugins.rs |
| Customize (`customize`) | Present; every tab’s remaining scope is reconciled separately below. | src/surfaces/customize/view.rs |
| README and Markdown documents (`readme`) | Missing label is stale: Files panel and Workspace Notes render Markdown. No separate document tab is claimed. | src/files_panel/markdown_view.rs; spec.rs |
| Images and PDFs (`image`) | Image placeholder description is stale: raster images have native previews. PDF/media-preview remainder is listed above. | src/files_panel/media.rs; transcript_images.rs |
| Interactive visualization cards (`visualization`) | Excluded: #5274. | src/visualizations/mod.rs; retained.rs; visualization_tests.rs |
| Diagrams (`mermaid`) | Missing label is stale: transcript diagram parser/layout/interaction exists. | src/transcript_diagram.rs; transcript_diagram/ |
| Browser/preview (`preview`) | Native chrome exists; macOS-only rendering and remote previews remain in gap table. | src/browser_panel.rs; browser_panel/web.rs; remote.rs |
| Timeline (`timeline`) | Gap table: no registered surface. | src/shell.rs:44-70 |
| Audit log (`audit-log`) | Gap table: no registered surface. | src/shell.rs:44-70 |
| Welcome and onboarding (`welcome`) | Present: setup supports project/tools/privacy/provider/first-conversation flow. Full desktop parity remains unverified; no macOS gate found. | src/surfaces/setup/view.rs |
| Sign-in and account binding | Gap table: explicit connection exists; native account/sign-in page absent. | src/shell_features/connection.rs; settings_fields.rs:266-287 |
| Mobile pairing (`mobile-pairing`) | Missing label is stale: Settings Mobile has pairing and revoke controls. | src/surfaces/settings/mobile.rs |
| Notifications, toasts and quick drawers | Missing label is stale: shell toasts, reply actions and right-panel drawers exist. OS notification parity is not established by this sweep. | src/shell_features/toasts.rs; right_panel/drawer.rs; inbox_reply.rs |
| Voice, dictation and attention overlays | Missing label is stale: Live/dictation controls and attention settings exist. Held-shortcut platform remainder is listed above; audio-player fallback is covered below. | src/shell_features/dictation.rs; settings_voice_fields.rs; transcript_actions.rs |
| Settings: General | Privacy toggles are now present; launch-at-login control remains in gap table. | src/settings_fields.rs:288-365 |
| Settings: Account | Gap table: no native account/sign-in page. | src/settings_fields.rs:266-287 |
| Settings: Appearance | Missing label is stale: live/persisted light/dark/glass and chat-width controls exist. Glass platform remainder is listed above. | src/settings_panels.rs:7-85 |
| Settings: Models | Present: defaults, provider instances and connection forms; account/sign-in remainder is listed above. | src/settings_fields.rs; surfaces/settings/providers.rs |
| Settings: API keys | Present: presence/save/remove/refusal flows. No additional platform gate found; full desktop parity is unverified. | src/settings_secret.rs; settings.rs |
| Settings: Local models | Missing label is stale: local-model defaults are exposed. A complete model lifecycle manager is not established by those fields. | src/settings_fields.rs:724-740 |
| Settings: Operator defaults | Present as Dispatch and model fields. No additional platform gate found; full desktop parity is unverified. | src/settings_fields.rs |
| Settings: Worktrees | Usage/allocated-space and parking displays now exist alongside defaults; older missing-UI description is stale. Full cleanup workflow parity is unverified. | src/settings_storage.rs |
| Settings: Projects | Project management is a separate existing native surface rather than a dedicated Settings tab. | src/surfaces/projects.rs; projects_view.rs |
| Settings: Git & PRs | Defaults exist; branch, commit and PR actions also live in their native surfaces. Remaining PR scope is listed above. | src/settings_fields.rs; composer/prompt_controls.rs; surfaces/pull_requests.rs |
| Settings: Indexing | Missing label is stale: indexing read/refresh controls exist. | src/settings_indexing.rs |
| Settings: MCP | Missing label is stale for external-client connection management. Full server management remains absent from Customize Connections. | src/surfaces/settings/mcp.rs |
| Settings: Connections | Missing label is stale: adapter capability diagnostics, Machines and Devices are present. Live device viewer remains listed above. | src/settings_connections.rs; surfaces/settings/machines.rs; devices_panel.rs |
| Settings: Workers | Worker defaults are exposed through Dispatch/model fields and lifecycle actions through Workers; no dedicated tab. Full settings parity is unverified. | src/settings_fields.rs; surfaces/workers.rs |
| Settings: Cloud workers | Gap table: dedicated settings page absent. | src/settings_fields.rs:266-287 |
| Settings: Analytics | The old spend/usage absence is stale for the Usage workspace; there is no separate Analytics settings page. Further settings controls are not specified by this inventory. | src/surfaces/usage.rs; settings_fields.rs:266-287 |
| Settings: Voice | Missing label is stale: voice, dictation, speech-to-text and attention fields exist. | src/settings_voice_fields.rs |
| Settings: Permissions | Gap table: OS permission page absent. | src/settings_fields.rs:266-287 |
| Settings: Diagnostics | Missing label is stale: feature audit and switch diagnostics exist; external transcript retention defers to provider controls. | src/settings_diagnostics.rs |
| Settings: About | Missing label is stale: version/platform/update information and links exist. | src/settings_about.rs |
| Customize: Instructions (`rules`) | Gap table: authored inventory; backing-file edit/forget and indexed references absent. | src/surfaces/customize/inventory.rs; view.rs |
| Customize: Commands | Gap table: no Commands tab. | src/surfaces/customize/view.rs:14-22 |
| Customize: Prompts | Gap table: CRUD/copy exists; import and scope reassignment absent. Composer has a separate insertion picker. | src/surfaces/customize/view.rs; composer/prompt_controls.rs |
| Customize: Skills | Gap table: metadata; no import/content/bundle management. | src/surfaces/customize/inventory.rs; view.rs |
| Customize: Plugins | Gap table: local action management exists; remote catalog absent. | src/surfaces/customize/plugins.rs |
| Customize: Connections | Gap table: inventory here; external-client management exists separately in Settings. | src/surfaces/customize/inventory.rs; surfaces/settings/mcp.rs |
| Customize: Agents | Gap table: metadata; backing-file view absent. | src/surfaces/customize/inventory.rs; view.rs |
| Customize: Hooks | Gap table: event metadata; configuration workflow absent. | src/surfaces/customize/inventory.rs; view.rs |

## Complete macOS cfg sweep

The sweep includes `cfg!`, positive/negative `#[cfg]`, and compound `all`/`any` forms in all 40 matching Rust files.
Actual user-facing omissions are grouped in the gap table above. The remaining branches are working platform variants or diagnostics:

| Surface | Sites (`src/`) | Linux result |
| --- | --- | --- |
| Browser | `browser_panel.rs:421`; `browser_panel/web.rs:12,463,466,468,501`; `view.rs:433,473`; `favicon.rs:3,29,81`; `tests.rs:157,441,757` | Browser gap above; loading is false, host methods are stubs, generic icon replaces favicon. Document-commit and popup tests are gated off. |
| Remote previews | `browser_panel/remote.rs:78`; `remote/web.rs:25,209,211,213` | Remote-preview gap above; production error, test-only task-discovery bypass. |
| Devices | `devices_panel.rs:5,37,61,80`; `devices_panel/view.rs:396,418,424` | Live-viewer stub above; the other controls remain. |
| Screenshot drawer | `composer/screenshots.rs:36` | Empty recent list above. |
| Material/window appearance | `shell_material.rs:8,13,15,21,29,31,42,53`; `shell_view.rs:248,249`; `theme.rs:55` | Opaque root, ordinary titlebar, default dark; Glass gap above. |
| Dictation hold gesture | `shell_features/dictation.rs:141` | macOS-only gesture; microphone actions remain. |
| Input navigation/deletion | `composer.rs:289,290`; `composer/keymap.rs:28`; `browser_panel/address.rs:210,211`; `files_panel/editor.rs:466,467` | Ctrl-based word/navigation/edit shortcuts instead of platform-command/Alt variants; no hidden input control. |
| Input/shortcut labels | `composer/stash.rs:236`; `files_panel/notes_context.rs:55`; `surfaces/sidebar/inbox.rs:166,194` | Linux Ctrl hints/modifiers; no feature omitted. |
| Input-only macOS tests | `input_tests.rs:54,123` | Two tests absent; coverage gap above. |
| Platform-adapted editor tests | `composer/native_tests.rs:31`; `projects_tests.rs:55`; `files_panel/tests.rs:304,409,438`; `test_support.rs:114`; `tree_tests.rs:287`; `edit_tests.rs:29,38,65,198,268,303`; `large_file_tests.rs:252`; `spec_tests.rs:56,79,108`; `spec_asset_tests.rs:16,27,123,133,148,155`; `changes_tests.rs:204` | These tests still compile/run on Linux with Ctrl variants; they are not gated away. File basenames following `files_panel/` share that directory. |
| Sidebar tests | `surfaces/sidebar/pr_links_tests.rs:66`; `settle_tests.rs:9,395,473,551` | Linux platform modifier/undo variants; tests remain enabled. |
| Fonts | `theme.rs:504,513` | `system-ui` and `monospace` aliases; platform-specific families on the other branches. |
| Open repository in external editor | `surfaces/sidebar/open_editor.rs:44` | Invokes installed editor CLI; failure produces the existing not-installed toast. No macOS-only launch assumption. |
| Read aloud | `transcript_actions.rs:149` | Uses `mpg123`/`ffplay` in place of the macOS player; `command -v ffplay` returned `/usr/bin/ffplay` here. Audio playback/provider service was not exercised. |
| Composer capture diagnostics | `ui.rs:1,1100` | Opt-in macOS capture driver absent; regular composer and Linux shell screenshot runner remain. This is diagnostics, not a missing composer. |
| Excluded | `visualizations/mod.rs:4,39,41,111,119,121,127,169,219,255,259`; `retained.rs:788`; `visualization_tests.rs:105,171,173,239` | #5274. |

The build script also links WebKit only when `CARGO_CFG_TARGET_OS` is `macos` (`src/shell_feature_build.rs:4-5`); this supports the same web-backed surfaces above and is not another gap.

## Windows ARM, source only

No Windows build or runtime checks were attempted. There are no `target_arch` conditions in `native/o8-next/src`, so this sweep establishes no ARM-specific difference.
Windows ARM takes the same non-macOS Browser, remote-preview, live-device-viewer, screenshot, material and held-dictation branches listed above.
The input branches choose Ctrl variants; `theme.rs:506,515` selects the Windows UI/monospace families.
`src/surfaces/sidebar/calendar.rs:33,52,99` has a separate Windows C-runtime local-calendar implementation.
`src/shell_features/ui_commands.rs:21,27,75` and `src/surfaces/sidebar/thread_list.rs:664` gate repeat-launch activation handling to Linux; Windows does not compile that handler.
These source observations do not establish whether a separate Windows launcher supplies equivalent behavior.
Unix-only permission/symlink paths in tests and stores do not establish Windows ACL or persistence behavior.

## Decision and limits

The first run supplied the gap inventory, all 62 parity-row dispositions, the
macOS cfg sweep, the Windows ARM source notes, and the automation regression
test draft. It also fetched packaging inputs and started the interrupted release
and server builds. The resumed run completes the remaining receipts and the
permitted small fix; completed inventory sections were retained.

The first run attempted `npm test -- --maxWorkers=1`, but collection stopped with
`No test files found, exiting with code 1` and an `ENOENT` opening a temporary file
under `node_modules/.experimental-vitest-cache`. The supplied install is stale;
this is recorded as **stale install**, not a Linux feature gap or a passing test run.
No dependency installation or typecheck was performed, as instructed. Full
`verify:ci` was not run because it includes the prohibited typecheck.

Outcome: the inventory is complete for this source snapshot, and the small
automation command gap is fixed in `224b04d76`. Evidence: all 56 native module
groups completed with 955 passed, 1 failed and 10 ignored; #5318 is the only
failure. The documentation link check, `git diff --check`, per-file Rust
formatting and `node scripts/roadmap-status.mjs --check` passed.

Residual: no release shell measurement or completed package artifacts; the
TypeScript suite did not collect with the stale install. Windows ARM remains
source-only. Decision: commit the audit separately, push the requested branch,
and hold without a release. No Windows builds, issue creation, pull requests,
signing or publication were performed.
