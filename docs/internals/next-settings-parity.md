# o8 next Settings parity

This checklist is the implementation plan and receipt. Classic is frozen. Inventory
baseline: `SettingsPage.tsx`, every mounted body under `settings/`, and
`SettingsQuickDrawer.tsx` / `settings-quick-drawer/`, inspected 2026-10-31.
Native baseline: `settings.rs`, `settings_view.rs`, `settings_fields.rs`, and the
Settings shell registration. No classic source changes are planned.

Status: **present** = native reachable behavior exists; **partial** = some behavior
exists, with the remaining gap stated; **missing** = not ported; **skipped** = an
explicit scope boundary, not a completed port. Baseline and current are separate
so completed work does not erase the initial inventory. Related controls share a
row only when they have the same status. Dynamic rows mean every returned item.

## Structure study

Reviewed [T3 Code](https://github.com/pingdotgg/t3code/tree/5732bbee397f0a2b0e61d0c2e432f01dca6df3dc/apps/web/src)
at commit `5732bbee397f0a2b0e61d0c2e432f01dca6df3dc`:
`routes/_chat.settings.tsx`, `routes/_chat.settings.general.tsx`,
`components/settings/SettingsPanels.tsx`, `SettingsGroup.tsx`,
`SettingsSidebarNav.tsx`, and `settingsSearch.ts`.

Borrow: named sections containing divided rows; label and explanation together;
switches for booleans; compact choices opposite the label; one search across
sections with keyboard focus and a clear action; render only the selected page.
o8's controls, names, semantic colors and existing GPUI switches win. No upstream
implementation is copied. Do not transplant its React routing or scope system.

## Inventory and plan

Source paths below are relative to `src/components/desktop/`. A native row uses
the existing operator-defaults route unless another owner is named.

| Classic tab / section | Controls (all dynamic rows included) | Baseline | Current / residual |
| --- | --- | --- | --- |
| Shell / navigation | General, Account, Appearance, Voice, Permissions; Dispatch, Providers; Worktrees & storage, Projects, Git & PRs, Indexing; MCP, Mobile; Analytics, Diagnostics, About | partial | partial: native General, Dispatch, Models & providers, Git & PRs, Worktrees & storage, API keys only |
| Shell / search | Search settings, ranked matches, Enter first match, Escape clear, section target | partial | partial: native cross-page field filtering and Cmd/Ctrl+F; no clear action or section context yet |
| Shell / history | Back, Forward, Back to workspace, section menus | missing | missing |
| Shell / feedback | Send feedback entry | missing | missing |
| General / Startup | Launch at login | missing | missing: classic `autostart_set` host command, no native Settings bridge |
| General / Startup | When closing with active agents: Ask every time, Keep working, Stop and quit (Windows/Linux) | missing | missing: classic host close lifecycle |
| General / Updates | Update channel: Stable/Beta and confirmation | missing | missing: classic host release-channel command |
| General / Conversations | Model-generated titles | present | present |
| General / Presentation | Quiet mode; Review notifications, held off during quiet mode | present | present: live classic presentation receipt in existing review tests |
| General / Privacy | Share usage data; Share crash reports; Automatically upload local crash logs | present | present: preference controls only; reporting/redaction internals skipped |
| Account / Profile, Session | Profile; sign in; sign out; manage account | missing | skipped: account and authentication reviewer |
| Appearance / Theme | Light Solid; Dark Solid; All Glass, immediate repaint and persisted selection | missing | missing in Settings (same three choices already exist in native profile menu) |
| Voice / Voice shortcuts | Hold/double-tap Fn; Right Option; Ctrl+Z; Right Command; Escape; Cmd+Option+,; external Fn guidance | missing | missing: classic host gestures, do not advertise as native shortcuts |
| Voice / Symon | Open Symon settings | missing | missing: classic host surface |
| Voice / Permissions | Accessibility; Input Monitoring; Fn key binding and system settings | missing | skipped: permission/security review |
| Voice / Dictation | Mic input (dictate/record); Top pill; Live dictation (at caret/modal); External keyboard Fn and status | missing | missing: classic host preferences |
| Voice / Transcription | Groq API key shortcut | missing | skipped: credentials |
| Voice / Voice brain | Escalation; Conversation provider; Background provider; Model preset; Model | missing | missing: classic host voice preferences |
| Voice / Proactive attention | Automatic AI commentary; Spoken updates | missing | missing |
| Voice / Proactive attention | Hourly budget; Quiet hours; Quiet window start/end | missing | missing |
| Voice / Proactive attention | Work needs you; Approvals; Review verdicts; Failures and limits; Completed work | missing | missing |
| Voice / Proactive attention | Calendar events; Calendar lead time; Time check-ins | missing | missing |
| Voice / Symon text brain | Automatic/connected-planner/managed routing | missing | missing |
| Voice / Symon conversations | List saved conversations; Open transcript; Back; Refresh | missing | missing |
| Voice / iMessage bridge access | Allow Symon on iMessage; Use OpenClaw for iMessage; connection setup | missing | skipped: access and authentication |
| Voice / Native Messages receiver | Enabled; authorized senders; Save; confirm native receiver; status | missing | skipped: sender authorization |
| Permissions / macOS permissions | Microphone, Accessibility, Input Monitoring, Screen Recording, Full Disk Access; check/request/open settings; relaunch | missing | skipped: permission/security reviewer |
| Dispatch / Fleet | Capacity presets (2, 5, 8); Concurrent agents | partial | partial: numeric concurrency exists, preset controls missing |
| Dispatch / Fleet | Overlapping work: Warn/Block | present | present |
| Dispatch / Supervision | Automatically fix failed checks; Investigate failures in chat; Automatically review completed work; Merge approval | present | present |
| Dispatch / Supervision | Install app updates automatically: Off/When idle | present | present |
| Dispatch / Change reports | Explain completed changes; Create a summary after merge | present | present |
| Dispatch / Task spending limits | Spending limit per task; Backup input-token limit | present | present: control writes do not execute paid work |
| Dispatch / Related settings | Models & providers; Worktrees & storage | missing | missing cross-links |
| Dispatch / Advanced | Edit settings.toml; Reload; Save; Cancel; stale-file handling | present | present: existing implementation; credential/redaction internals untouched |
| Dispatch / Thinking & task models | Thinking effort; Prompt caching | present | present |
| Dispatch / Thinking & task models | Adaptive orchestrator thinking; Show Ultra effort | missing | missing: client preferences |
| Dispatch / Thinking & task models | Targeting triage runtime/effort; Targeting action runtime/effort | missing | missing |
| Dispatch / Brain advanced | Brain answer model; Brain uses Claude CLI; Pre-warm Brain runtimes; Workers use the Brain | present | present |
| Dispatch / Task limits & setup | UI loop iterations/minutes/diff bytes/diff files/preview timeout; Workspace manifest execution | present | present |
| Dispatch / Experimental | o8 next; Canvas mode; Native browser-view | missing | missing: may launch/switch application surfaces |
| Providers / provider navigation | Installed/configured provider tabs; Show available; tool scan retry | missing | missing |
| Providers / each CLI house | Runtime status; Version; Binary path; Model selection guidance; Runtime configuration guidance | missing | partial outside Settings: composer already has house/model selection |
| Providers / each CLI house | Account status; connection evidence; sign-in; who pays; account usage/limits and dashboard links | missing | skipped: account/authentication/billing review |
| Providers / Adapter capabilities | Worker actions; Session transforms; Usage support; Account-limit observation support | missing | missing: capability facts only, not account data |
| Providers / Codex models | Worker effort | missing | missing |
| Providers / Claude models | Worker effort; Claude fallback model | missing | missing |
| Providers / Claude connection | Model source; Model; Codex authorization; reconnect/reset/setup | missing | skipped: authentication/carrier setup |
| Providers / OpenCode models | Show in dispatch pickers; fallback model | missing | missing |
| Providers / built-in worker | Availability; Managed model; Use in a conversation; Usage/limits guidance; Setup | missing | missing |
| Providers / Orchestrator | Lead provider; Code review provider | missing | missing |
| Providers / Workers | Subscription profile; Default worker; one allow switch per runtime; Your Pi setup | missing | missing |
| Providers / Pi setup | Cache warming: Off/During runs/During and between runs | missing | missing |
| Providers / Advanced orchestrator options | OpenCode fallback model; Combined answer provider; Existing setup uses Claude | missing | missing |
| Providers / Advanced worker setup | Codex launch method (Direct/Via Ori) | missing | skipped: credential carrier |
| Providers / Advanced worker setup | Worker quota fallback | missing | missing |
| Providers / Engineering Brain | Answer routing; Codex model; Codex effort | present | present |
| Providers / Codex app | Show chats in the Codex app | present | present |
| Providers / Runtime routing | Orchestrate, Build, Review, Brain, Triage, Action; expand configured/effective/source/availability/why/change path/last run/fallbacks; refresh | missing | missing |
| Providers / Judgment | Judgment referee choices; managed allowance and beta availability | missing | missing |
| Providers / More setup | API keys; Local models; Task review & supervision links | missing | missing (API-key link skipped) |
| Providers / Local ACP | Registry search/install/connect/disconnect; command; arguments; environment forwarding; add/remove environment rows; test | missing | skipped: execution environment can store credentials |
| Providers / ChatGPT plan | Active account; Plan access; connect/disconnect | missing | skipped: account/sign-in |
| Providers / Muse | Sign in; Models; Usage | missing | skipped: account/sign-in |
| API Keys / Provider keys | Every provider key input; Save/Replace/Remove/Enable/Validate; OpenRouter connection/models/work/usage | partial | skipped: existing native key surface left untouched |
| API Keys / Symon & voice keys | Every voice-service secret input; Save/Replace/Remove; status | missing | skipped: credentials and `settings_secret.rs` |
| API Keys / Key storage | Storage details and key setup | missing | skipped: credential storage |
| Local models / Local models | Dispatch model (Ollama/LM Studio/Cloud); Local endpoint/presets; Chat model/presets; Embedding model; Save/test | missing | missing: endpoint fields deliberately skipped for network-binding review; model names in scope |
| Worktrees & storage / Storage usage | Workspace files: allocated/logical; Refresh usage; Space for new tasks: free/reserved/available | missing | missing |
| Worktrees & storage / Automatic cleanup | Workspace count per repository; Disk usage per repository | present | present |
| Worktrees & storage / Advanced | Reuse dependencies (APFS) | missing | missing |
| Worktrees & storage / Workspace parking | Parking mode | present | present |
| Worktrees & storage / Workspace parking | Fleet parking: parked/eligible/opted out; each repository's pressure parking switch | missing | missing |
| Worktrees & storage / Minimum free space | Volume reserve; Absolute floor | present | present |
| Worktrees & storage / Storage categories | Source, dependencies, build files, runtime files, transcripts: allocated/logical/method | missing | missing |
| Worktrees & storage / Finished work | Repository choice; review cleanup candidates/retained recovery; reviewed cleanup action | missing | missing: no cleanup executed by this task |
| Projects / Overview | Repositories/context/locks summary; create project; suggested grouping/dismiss | missing | partial: existing separate native Projects surface |
| Projects / Active project context | Search saved projects; Details; Open workspace; Edit; Back; Tasks | missing | partial: separate native Projects surface, no Settings link |
| Projects / project editor | Name; description; main repo; repository attach/detach; instructions; lock file add/remove; save/cancel/delete | missing | partial: separate native Projects surface |
| Git & PRs / GitHub | Identity; Repository & CLI access; device flow; token entry; sign out; Automation app install/manage | missing | skipped: account/authentication |
| Git & PRs / Branches | Branch prefix | present | present |
| Git & PRs / Commits | Tag commits created by agents | present | present |
| Git & PRs / Pull requests | Open pull requests (In o8/Browser) | present | present |
| Indexing / Repositories | Every repository index status; Refresh docs; Retry | missing | missing |
| Indexing / Engineering Brain | Saved instructions; Recorded task outcomes; Knowledge storage | missing | missing |
| Indexing / Knowledge sources | Folder; include patterns; exclude patterns; add/refresh/remove source and facts | missing | missing: source ingestion/redaction behavior skipped |
| MCP / Clients | Claude Desktop, Claude Code, Hermes Agent, OpenClaw status; Install/Update/Remove | missing | skipped: writes authenticated client configuration |
| MCP / External servers | Add command/URL/JSON; candidate edit/add; manual name/transport/command/args/env/URL; enable; worker/Symon injection; test; remove | missing | skipped: arbitrary environment, credentials and network endpoints |
| MCP / ChatGPT task review | Held task; exact requirements; approve/deny review | missing | skipped: authorization |
| MCP / Diagnostics | Manual config disclosure/copy; System details disclosure (backend, install mode, CLI path/Node, Node.js, Codex, gh, database, webview) | missing | skipped: manual config and network binding; non-secret installed-tool facts in scope |
| Mobile / Remote access | Connect this Mac | missing | skipped: authenticated relay |
| Mobile / Symon Messages | Text Symon; allowed phone number; save/status | missing | skipped: sender access |
| Mobile / Pairing | Show pairing QR | missing | skipped: credentials |
| Mobile / Paired devices | Refresh; revoke/remove each device | missing | skipped: credentials |
| Analytics / Totals | Cost/tokens/requests; date-range and refresh controls | missing | missing: existing native Usage surface may cover part; not yet verified |
| Analytics / Spend over time, By surface | Chart range; grouping; breakdown | missing | missing |
| Diagnostics / Connection health | Check installed tools / Check again; each installed tool's status | missing | missing: authentication text skipped; install/version facts in scope |
| Diagnostics / Feature diagnostics | Shipped feature audit; default-off feature flags; Refresh; release age/first shipped/promotion status | missing | missing |
| Diagnostics / Maintenance | Archive old Codex sessions; result counts/duration | missing | missing: no maintenance executed by this task |
| Diagnostics / Reset app data | Factory reset; confirmation text; confirm/cancel; result | missing | skipped: wipes credentials |
| Diagnostics / Diagnostic authorization | Enable/disable developer tools | missing | skipped: authorization boundary |
| Diagnostics / Recall health | Outcomes/directives; recall p50/p95/p99 24h/p95 7d; substrate health; Refresh | missing | missing |
| Diagnostics / Loop status | Cron; prompt; open PRs; active lanes; recent merges disclosure; refresh | missing | missing |
| Diagnostics / Demo sequence | Run demo; confirm/cancel; live trace | missing | skipped: diagnostic authorization |
| About / Version | Version; Platform; Mode; Check for updates and result | missing | missing |
| About / Links | GitHub; Documentation; Releases | missing | missing |
| About / Onboarding | Replay onboarding | missing | missing: native onboarding surface not present |
| About / Report an issue | Enable sharing; Bug/Request; Message; attach/paste/drop/remove image; Send; status | missing | skipped: upload/redaction and outbound report review |
| About / Credits | Contributor attribution | missing | missing |
| About / Developer | Reset + run onboarding; Preview onboarding; View detection | missing | missing: classic host onboarding |
| Quick drawer / Account | Account/sign in | missing | skipped: authentication; existing native profile surface untouched |
| Quick drawer / Settings | Open Settings (Cmd+,) | present | present in existing native profile surface |
| Quick drawer / Appearance | Expand; Light; Dark; All Glass; selected state; close after choose | present | present in existing native profile surface; no rail changes |
| Quick drawer / Get help | Expand; Keyboard shortcuts (Cmd+/); Community Discord; Documentation | present | present in existing native profile surface; no rail changes |
| Quick drawer / capacity helper | Plan capacity rows; refresh; select/register plan | missing | skipped: account/billing (helper is not mounted by current drawer) |
| Quick drawer / theme helper | Light; Dark; glass surface toggle | partial | partial: current drawer uses three complete looks; helper itself is not mounted |
| Keyboard / shortcuts | Open searchable shortcut help and close it, keyboard scrolling | present | present as separate native modal; Settings entry missing |
| Sounds | No separate Sounds tab, sound picker, volume or mute control exists in the frozen Settings references | present | present as an inventory fact; do not invent preferences. Spoken updates are listed under Voice |

## Execution order

1. General grouping, global search and clear behavior; preserve live switches.
2. Appearance, reuse native shell material and persistence.
3. Models/Agents and houses, shared non-secret defaults and runtime controls.
4. Notifications and spoken-update settings, preserving dependent disabled states.
5. Keyboard entry, non-credential Connections, About, Diagnostics.
6. Remaining workspace and indexing items within the three-hour bound.

## Verification receipts

Each implementation commit adds or updates GPUI tests that activate real debug
selectors through the shell. Run only affected native tests with Rust 1.97.1 and
the worktree target cache. Serial fixture execution avoids shared-store races.
No full suite, npm install, push, PR, release, rail changes, or secret changes.
