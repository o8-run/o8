# Current UI parity

Refreshed for #5563 from the Linux gap audit in #5553
([linux-gap-audit.md](../../docs/internals/linux-gap-audit.md), base `801fb1402`),
which reconciled every `partial` and `missing` row of the #4714 inventory against
current registrations.

`ported` means the named surface's existing interaction is available; `partial`
means a usable slice exists with the gaps listed; `missing` means there is no
native counterpart. A `partial` row records an implementation, not a claim that
every desktop interaction is equivalent. These states describe functionality, not
visual or accessibility equivalence.

Platform columns:
- **macOS**: the native build's reference platform.
- **Linux**: from the audit's Linux runs (X11 under Xvfb, software Vulkan). Linux
  fixture screenshots establish shell rendering only, without accounts or provider
  sessions.
- **Windows**: source only. Nothing has been built or run on Windows. Windows takes
  the same non-macOS code branches as Linux, so its column repeats Linux's and is
  not a test result.

The current UI inventory comes from [canvas kinds](../../src/components/desktop/Canvas.tsx),
[settings tabs](../../src/components/desktop/settings/shared.tsx),
[Customize tabs](../../src/components/desktop/customize/CustomizeHeader.tsx), and
the desktop shell. Native registration lives in [shell.rs](src/shell.rs).

| Current UI surface | macOS | Linux | Windows | Native surface and remaining scope |
| --- | --- | --- | --- | --- |
| Workspace shell, tabs, commands and restore | partial | partial | partial | `shell.rs`, `shell_features/window_state.rs`, `pane_tree.rs`; tabs, restore, navigation and a saved pane tree. Off macOS, All Glass installs no system blur and the window uses an ordinary titlebar |
| Projects and repository selection | partial | partial | partial | `projects_model.rs`, `projects_view.rs`; project CRUD, repository registration and switching. Full desktop parity unverified |
| Session list, history and live transcript (`transcript`) | partial | partial | partial | `ui.rs`, `rich.rs`, `retained.rs`; retained transcript and live stream. Unsupported media cards remain |
| Composer and queued messages | partial | partial | partial | `composer.rs`; queue, steer, approvals, attachments and voice actions. Off macOS, the recent-screenshot picker is empty and the held dictation shortcut is not intercepted |
| Worker sessions | partial | partial | partial | `surfaces/workers/actions.rs`, `drafts.rs`; delivery, interrupt, resume and persisted pending requests |
| Split session panes | partial | partial | partial | `pane_layout.rs`, `pane_tree.rs`, `shell_features/panes.rs`; fixed grid plus a saved binary split tree |
| Terminal | partial | partial | partial | [Protocol and limits](TERMINAL-PROTOCOL.md); attach, input, resize and replay. Selection, copy and mouse reporting missing |
| Brain conversation, search and sources | partial | partial | partial | [Brain](BRAIN.md); conversation, sources and local search. Memory editing and deletion missing |
| Inbox: Needs reply, Contributions, Approvals, Agent issues, History | partial | partial | partial | `inbox.rs`, `surfaces/inbox.rs`; production-route reads and actions. Account sign-in missing |
| Issues list, detail and creation (`issue`, `new-issue`) | partial | partial | partial | `issues.rs`, `issues_view.rs`, `surfaces/issues.rs`; list, detail, creation, discussion and contextual tabs |
| File tree and text file viewer/editor (`file`) | partial | partial | partial | `files_panel.rs`, `files_panel/editor.rs`; tree, editor, syntax and large files. Off macOS, video poster thumbnails fall back to a plain tile |
| Diff and review (`diff`) | partial | partial | partial | `diff_ui.rs`, `files_panel/file_diff.rs`; split and unified patches and commit diffs. Right-panel Review parity is tracked in #5576 |
| Commit detail (`commit`) | partial | partial | partial | `surfaces/activity/commit.rs`; Activity opens a native commit diff |
| Pull request detail and list (`pr`, `pull-requests`) | partial | partial | partial | [Native PRs](docs/surfaces/pull-requests.md); list, detail and confirmed actions. Linked-packet actions and persisted view and draft state missing |
| Git history (`git-log`) | missing | missing | missing | No history workspace; Activity shows recent commits and a commit diff |
| CI runs (`ci`) | partial | partial | partial | `surfaces/activity/view.rs`; CI summaries, details, retry and links in Activity. No standalone CI workspace |
| Deployments (`deploy`) | missing | missing | missing | No registered surface |
| Usage (`usage`) | partial | partial | partial | `surfaces/usage.rs`; limits and local usage history |
| Automations (`automations`) | partial | partial | partial | `surfaces/scheduled.rs`; local, manual and cron automations and connected schedules |
| Activity feed and packet controls | partial | partial | partial | [Activity parity](evidence/activity/parity.md); grouped feed, details, holds, mission stop, lane stop/resume/merge, archive and restore, proposals and dossiers. Right-panel parity is tracked in #5576 |
| Plugin catalog (`plugins`) | partial | partial | partial | `surfaces/customize/plugins.rs`; local action plugins. No remote catalog, search, install or update |
| Customize (`customize`) | partial | partial | partial | See the Customize table below and [detailed parity](docs/surfaces/customize/verification.md) |
| README and Markdown documents (`readme`) | partial | partial | partial | `files_panel/markdown_view.rs`, `files_panel/spec.rs`; Markdown renders in Files and Workspace Notes. No separate document tab |
| Images and PDFs (`image`) | partial | partial | partial | `files_panel/media.rs`, `transcript_images.rs`; raster images. PDF, video and audio previews missing |
| Interactive visualization cards (`visualization`) | partial | partial | missing | [Inline cards](docs/surfaces/visualizations.md); interactive macOS documents, resizing, theme and saved state. Linux renders a static picture with theme and width refresh. Windows shows an error and retry row |
| Diagrams (`mermaid`) | partial | partial | partial | `transcript_diagram.rs`; transcript diagram parser, layout and interaction |
| Browser/preview (`preview`) | partial | missing | missing | `browser_panel.rs`; off macOS the pane reads "The Browser needs macOS for now." and remote previews show an error row |
| Timeline (`timeline`) | missing | missing | missing | No registered surface |
| Audit log (`audit-log`) | missing | missing | missing | No registered viewer |
| Welcome and onboarding (`welcome`) | partial | partial | partial | [First-run setup](docs/surfaces/setup.md); projects, tools, privacy, providers and first conversation |
| Sign-in and account binding | missing | missing | missing | `shell_features/connection.rs`; explicit local connection only, no account or sign-in page |
| Mobile pairing (`mobile-pairing`) | partial | partial | partial | `surfaces/settings/mobile.rs`; pairing and revoke |
| Notifications, toasts and quick drawers | partial | partial | partial | `shell_features/toasts.rs`, `right_panel/drawer.rs`, `shell_features/inbox_reply.rs`; shell toasts, reply actions and drawers. OS notification parity not established |
| Voice, dictation and attention overlays | partial | partial | partial | `shell_features/dictation.rs`, `settings_voice_fields.rs`; Live, dictation and attention settings. Off macOS the held shortcut is not intercepted |
| Live device viewer | partial | missing | missing | `devices_panel.rs`; device state and agent controls everywhere, the live viewer on macOS only |

## Settings

The native settings slice uses `settings.rs`, `settings_fields.rs` and
`settings_secret.rs`. Native grouping differs from desktop tab names. A shared
API field does not establish parity with every control on its desktop tab. No
settings row has a platform-specific gate, so the three platform states match.

| Current settings tab | macOS | Linux | Windows | Available scope or gap |
| --- | --- | --- | --- | --- |
| General | partial | partial | partial | Operator defaults and privacy toggles; no launch-at-login control |
| Account | missing | missing | missing | No account or sign-in page |
| Appearance | partial | partial | partial | Light, dark and glass, and chat width (`settings_panels.rs`). Off macOS, glass installs no system blur |
| Models | partial | partial | partial | Defaults, provider instances and connection forms; account sign-in missing |
| API keys | partial | partial | partial | Key presence, save, remove and refusal flows |
| Local models | partial | partial | partial | Local-model defaults; no install, remove, start or stop manager |
| Operator defaults | partial | partial | partial | Dispatch and model fields |
| Worktrees | partial | partial | partial | Storage defaults, usage, allocated space and parking (`settings_storage.rs`); full cleanup workflow unverified |
| Projects | partial | partial | partial | Project management lives in its own native surface (`surfaces/projects.rs`), not a Settings tab |
| Git & PRs | partial | partial | partial | Git defaults; branch, commit and PR actions live in their native surfaces |
| Indexing | partial | partial | partial | Indexing read and refresh (`settings_indexing.rs`) |
| MCP | partial | partial | partial | External-client connection management (`surfaces/settings/mcp.rs`); no server management in Customize Connections |
| Connections | partial | partial | partial | Adapter diagnostics, Machines and Devices (`settings_connections.rs`); the live device viewer is macOS only |
| Workers | partial | partial | partial | Worker defaults in Dispatch and model fields, lifecycle actions in Workers; no dedicated tab |
| Cloud workers | missing | missing | missing | No cloud-worker settings page |
| Analytics | partial | partial | partial | Spend and usage live in the Usage workspace; no separate Analytics page |
| Voice | partial | partial | partial | Voice, dictation, speech-to-text and attention fields (`settings_voice_fields.rs`) |
| Permissions | missing | missing | missing | No operating-system permission page |
| Diagnostics | partial | partial | partial | Feature audit and switch diagnostics (`settings_diagnostics.rs`) |
| About | partial | partial | partial | Version, platform, update information and links (`settings_about.rs`) |

## Customize

No Customize tab has a platform-specific gate, so the three platform states match.

| Current Customize tab | macOS | Linux | Windows | Available scope or gap |
| --- | --- | --- | --- | --- |
| Instructions (`rules`) | partial | partial | partial | Authored inventory; backing-file edit and forget, and indexed references, missing |
| Commands | missing | missing | missing | No Commands tab; the shell palette is separate |
| Prompts | partial | partial | partial | Create, edit, copy and delete; import and scope reassignment missing. Composer insertion is separate |
| Skills | partial | partial | partial | Metadata rows; full content, import and bundle management missing |
| Plugins | partial | partial | partial | Local action folders; no remote catalog |
| Connections | partial | partial | partial | Metadata and built-in inventory; external-client management lives in Settings › MCP |
| Agents | partial | partial | partial | Metadata rows; backing-file view missing |
| Hooks | partial | partial | partial | Event metadata; configuration workflow missing |

## Linux CI measurements

[The scoped CI job](../../.github/workflows/next-linux.yml) builds release on Linux
x64 with Node 22 and stable Rust. It runs one informational cold launch followed
by three timed launches with fresh fixture hosts under a private 1440 by 1024
Xvfb display with software Vulkan. It never uses the
GPUI test platform (`--offscreen`). Screenshots and numeric receipts are uploaded
as `o8-next-linux-x64`, including screenshots available after a failure.

The cold receipt is informational only. The median of the three timed first-frame
measurements must meet the launch budget; each timed idle RSS must meet the RSS
budget. Renderer caches are shared across the four launches and removed afterward.
Both checked-in budgets stay unchanged.

Launch to first frame is wall time from spawning the release binary to observing
more than 32 colors in a full-display PNG. Capture and polling overhead are
included. The runner requests exposure with `xrefresh -none` while waiting for
the inactive window to paint on bare Xvfb. This is an external first-frame observation, not physical presentation
latency. The display must be blank before each launch. Capture uses the display
root, so changing input focus cannot select a different capture target.

After fixture-backed persisted tabs appear, the runner settles for two seconds
and records the maximum of five process RSS samples 200 ms apart. RSS includes
the native process and renderer threads; the separately running fixture host is
excluded. A successful run also requires production session-list/history reads,
a final nonblank frame and child cleanup. Startup and command timeouts fail
closed. No account credentials or raw child logs enter artifacts.

Failures after runner setup persist `failure.json`, including fixture-host startup
failures before any screenshot exists. It records the controlled stage, run and
completed-run counts, and a sanitized reason. A new invocation removes the prior
failure report. Raw child output and exception details are excluded.

After measurements, CI compiles every native test target with `cargo test --no-run`
and runs all four native CLI integration suites. Either a test-only compilation
error or a failing CLI assertion fails the job. Tests run after screenshots so
test-support features cannot replace the release binary being measured. The full
GPUI fixture/throughput suite has recorded runs over 25 minutes and is excluded
from this nine-minute launch gate; its unit assertions are compiled but not run.

[Recorded budgets](linux-budgets.json) contain three initial measurements. Each
limit is the ceiling of the largest corresponding sample times 1.25. CI checks
every run, including equality at the limit; missing/invalid samples fail. To
review a deliberate rebaseline, run the same release workload with `--record`
and review all three receipts and PNGs. Normal CI never rewrites the budgets.

```sh
cargo build --release --locked --manifest-path native/o8-next/Cargo.toml
# Set VK_ICD_FILENAMES to the installed software Vulkan ICD JSON first.
xvfb-run -a -s '-screen 0 1440x1024x24 -nolisten tcp -noreset -br' node scripts/next/linux-headless.mjs --output work/next-linux
```
