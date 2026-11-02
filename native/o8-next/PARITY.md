# Current UI parity

Inventory at #4714. `ported` means the named surface's existing interaction is
available; `partial` means a usable slice exists with the gaps below; `missing`
means there is no native counterpart. These states describe functionality, not
visual or accessibility equivalence. Linux fixture screenshots establish shell
rendering only, without accounts or provider sessions. No new screen is added by
the Linux CI work.

The current UI inventory comes from [canvas kinds](../../src/components/desktop/Canvas.tsx),
[settings tabs](../../src/components/desktop/settings/shared.tsx),
[Customize tabs](../../src/components/desktop/customize/CustomizeHeader.tsx), and
the desktop shell. Native registration lives in [shell.rs](src/shell.rs).

| Current UI surface | State | Native surface and remaining scope |
| --- | --- | --- |
| Workspace shell, tabs, commands and restore | partial | [App shell](APP-SHELL.md); saved local workspaces and supported surfaces, no complete desktop navigation or window management |
| Projects and repository selection | partial | `projects.rs`; registered projects, repository context and switching, no complete desktop project management |
| Session list, history and live transcript (`transcript`) | partial | `surfaces/session.rs`, `ui.rs`; retained transcript and live stream, unsupported rich cards remain below |
| Composer and queued messages | partial | `composer.rs`; queue, steer and approvals, no full attachment/voice interaction |
| Worker sessions | partial | Existing runtime inventory/history; read-only workers, no full worker lifecycle controls |
| Split session panes | partial | `surfaces/grid.rs`; saved 1/2/4/6 panes, no arbitrary desktop canvas arrangement |
| Terminal | partial | [Protocol and limits](TERMINAL-PROTOCOL.md); attach/input/resize/replay, selection/copy and mouse reporting missing |
| Brain conversation, search and sources | partial | [Brain](BRAIN.md); conversation/memory slice, no full desktop memory management |
| Inbox: Needs reply, Contributions, Approvals, Agent issues, History | partial | `surfaces/inbox.rs`; scoped cards, navigation and decisions, real account acquisition/refresh missing |
| Issues list, detail and creation (`issue`, `new-issue`) | partial | `surfaces/issues.rs`; existing issue slice, full desktop issue workflow missing |
| File tree and text file viewer/editor (`file`) | missing | No registered file surface |
| Diff and review (`diff`) | partial | `surfaces/diff.rs`, `diff_ui.rs`; native review slice, full desktop integration missing |
| Commit detail (`commit`) | missing | No commit surface |
| Pull request detail and list (`pr`, `pull-requests`) | partial | [Native PRs](docs/surfaces/pull-requests.md); list/detail and confirmed actions, packet-linked merge, thread controls and view persistence missing |
| Git history (`git-log`) | missing | No history surface |
| CI runs (`ci`) | partial | Activity exposes lazy CI failure details/retry/links; no standalone CI workspace |
| Deployments (`deploy`) | missing | No deployment surface |
| Usage (`usage`) | missing | No analytics workspace |
| Automations (`automations`) | missing | No automation workspace |
| Activity feed and packet controls | partial | [Activity parity](evidence/activity/parity.md); grouped feed, details, holds and mission stop; complete packet editing, lifecycle and review navigation missing |
| Plugin catalog (`plugins`) | missing | No catalog or installation UI |
| Customize (`customize`) | partial | See section inventory below and [detailed parity](docs/surfaces/customize/verification.md) |
| README and Markdown documents (`readme`) | missing | Transcript prose is not a document surface |
| Images and PDFs (`image`) | missing | Transcript placeholders only |
| Interactive visualization cards (`visualization`) | partial | [Inline cards](docs/surfaces/visualizations.md); interactive macOS documents, resizing, theme and saved state; Linux and Windows show an error and retry row; workspace expansion and version controls remain open |
| Diagrams (`mermaid`) | missing | No diagram renderer |
| Browser/preview (`preview`) | missing | No browser surface |
| Timeline (`timeline`) | missing | No timeline surface |
| Audit log (`audit-log`) | missing | No audit-log viewer |
| Welcome and onboarding (`welcome`) | partial | [First-run setup](docs/surfaces/setup.md); project registration, tools, privacy and first conversation; full desktop onboarding parity remains open |
| Sign-in and account binding | missing | Explicit local opt-in connection only |
| Mobile pairing (`mobile-pairing`) | missing | No pairing or mobile UI |
| Notifications, toasts and quick drawers | missing | No equivalent desktop overlay system |
| Voice, dictation and attention overlays | missing | No native voice surface |

## Settings

The native settings slice uses `settings.rs`, `settings_fields.rs` and
`settings_secret.rs`. Native grouping differs from desktop tab names. A shared
API field does not establish parity with every control on its desktop tab.

| Current settings tab | State | Available scope or gap |
| --- | --- | --- |
| General | partial | Existing general operator defaults; desktop startup/privacy controls incomplete |
| Account | missing | No account/sign-in management |
| Appearance | missing | Shared native theme, no desktop theme controls |
| Models | partial | Provider/model defaults and connection fields; account flows incomplete |
| API keys | partial | Existing key presence, save/remove and refusal flows |
| Local models | missing | No local model management |
| Operator defaults | partial | Existing dispatch, supervision and model fields |
| Worktrees | partial | Storage defaults; full usage/cleanup/parking UI missing |
| Projects | partial | Separate native project slice; complete settings tab missing |
| Git & PRs | partial | Existing Git defaults; full branch/commit/PR controls missing |
| Indexing | missing | No indexing settings |
| MCP | missing | Customize connection inventory is not server management |
| Connections | missing | No remote access or device management |
| Workers | missing | No worker settings |
| Cloud workers | missing | No cloud worker settings |
| Analytics | missing | No spend/usage settings |
| Voice | missing | No voice settings |
| Permissions | missing | No operating-system permission settings |
| Diagnostics | missing | No diagnostics/reset UI |
| About | missing | No version/credits/onboarding settings |

## Customize

| Current Customize tab | State | Available scope or gap |
| --- | --- | --- |
| Instructions (`rules`) | partial | Authored inventory; backing-file edit/forget and indexed references missing |
| Commands | missing | No command inventory/actions |
| Prompts | partial | Saved prompt create/edit/copy/delete; imports, insertion and scope reassignment missing |
| Skills | partial | Metadata inventory; full content, import and bundle management missing |
| Plugins | missing | No plugin management |
| Connections | partial | Basic metadata and built-in inventory; management missing |
| Agents | partial | Metadata inventory; backing-file view missing |
| Hooks | partial | Event/type inventory; complete configuration controls missing |

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
