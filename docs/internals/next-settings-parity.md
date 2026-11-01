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
| Shell / navigation | General, Account, Appearance, Voice, Permissions; Dispatch, Providers; Worktrees & storage, Projects, Git & PRs, Indexing; MCP, Mobile; Analytics, Diagnostics, About | partial | partial: native General, Appearance, Voice, Keyboard, Dispatch, Models & providers, Local models, Git & PRs, Worktrees & storage, API keys, Indexing, Connections, Diagnostics and About; remaining pages and controls are listed below |
| Shell / search | Search settings, ranked matches, Enter first match, Escape clear, section target | partial | present: weighted field matches across sections, Open first match, Enter to the section/field, automatic reveal, Clear search, Cmd/Ctrl+F and Escape clear; inactive remote panels remain unloaded |
| Shell / history | Back, Forward, Back to workspace, section menus | missing | partial: Back/Forward, forward-history truncation and Back to workspace present; classic section menus remain |
| Shell / feedback | Send feedback entry | missing | missing |
| General / Startup | Launch at login | missing | missing: classic `autostart_set` host command, no native Settings bridge |
| General / Startup | When closing with active agents: Ask every time, Keep working, Stop and quit (Windows/Linux) | missing | missing: classic host close lifecycle |
| General / Updates | Update channel: Stable/Beta and confirmation | missing | missing: classic host release-channel command |
| General / Conversations | Model-generated titles | present | present |
| General / Presentation | Quiet mode; Review notifications, held off during quiet mode | present | present: live classic presentation receipt in existing review tests |
| General / Privacy | Share usage data; Share crash reports; Automatically upload local crash logs | present | present: preference controls only; reporting/redaction internals skipped |
| Account / Profile, Session | Profile; sign in; sign out; manage account | missing | skipped: account and authentication reviewer |
| Appearance / Theme | Light Solid; Dark Solid; All Glass, immediate repaint and persisted selection | missing | present: Settings choices reuse the native shell action, repaint/material switch and saved appearance |
| Voice / Voice shortcuts | Hold/double-tap Fn; Right Option; Ctrl+Z; Right Command; Escape; Cmd+Option+,; external Fn guidance | missing | missing: classic host gestures, do not advertise as native shortcuts |
| Voice / Symon | Open Symon settings | missing | missing: classic host surface |
| Voice / Permissions | Accessibility; Input Monitoring; Fn key binding and system settings | missing | skipped: permission/security review |
| Voice / Dictation | Mic input (dictate/record); Top pill; Live dictation (at caret/modal); External keyboard Fn and status | missing | missing: classic host preferences |
| Voice / Transcription | Groq API key shortcut | missing | skipped: credentials |
| Voice / Voice brain | Escalation; Conversation provider; Background provider; Model preset; Model | missing | missing: classic host voice preferences |
| Voice / Proactive attention | Automatic AI commentary; Spoken updates | missing | present: native switches use the existing shared preferences |
| Voice / Proactive attention | Hourly budget; Quiet hours; Quiet window start/end | missing | present: dependent controls and clock validation |
| Voice / Proactive attention | Work needs you; Approvals; Review verdicts; Failures and limits; Completed work | missing | present: switches disabled while Spoken updates is off |
| Voice / Proactive attention | Calendar events; Calendar lead time; Time check-ins | missing | present: lead time requires spoken calendar updates |
| Voice / Symon text brain | Automatic/connected-planner/managed routing | missing | missing |
| Voice / Symon conversations | List saved conversations; Open transcript; Back; Refresh | missing | missing |
| Voice / iMessage bridge access | Allow Symon on iMessage; Use OpenClaw for iMessage; connection setup | missing | skipped: access and authentication |
| Voice / Native Messages receiver | Enabled; authorized senders; Save; confirm native receiver; status | missing | skipped: sender authorization |
| Permissions / macOS permissions | Microphone, Accessibility, Input Monitoring, Screen Recording; check/request/open settings; relaunch | missing | skipped: permission/security reviewer |
| Dispatch / Fleet | Capacity presets (2, 5, 8); Concurrent agents | partial | present: native numeric editor plus classic 2/5/8 presets, saved selection and shared environment/busy locks |
| Dispatch / Fleet | Overlapping work: Warn/Block | present | present |
| Dispatch / Supervision | Automatically fix failed checks; Investigate failures in chat; Automatically review completed work; Merge approval | present | present |
| Dispatch / Supervision | Install app updates automatically: Off/When idle | present | present |
| Dispatch / Change reports | Explain completed changes; Create a summary after merge | present | present |
| Dispatch / Task spending limits | Spending limit per task; Backup input-token limit | present | present: control writes do not execute paid work |
| Dispatch / Related settings | Models & providers; Worktrees & storage | missing | missing cross-links |
| Dispatch / Advanced | Edit settings.toml; Reload; Save; Cancel; stale-file handling | present | present: existing implementation; credential/redaction internals untouched |
| Dispatch / Thinking & task models | Thinking effort; Prompt caching | present | present |
| Dispatch / Thinking & task models | Adaptive orchestrator thinking; Show Ultra effort | missing | missing: client preferences |
| Dispatch / Thinking & task models | Targeting triage runtime/effort; Targeting action runtime/effort | missing | partial: effort controls present and preserve runtime/model; runtime choices remain held with house discovery |
| Dispatch / Brain advanced | Brain answer model; Brain uses Claude CLI; Pre-warm Brain runtimes; Workers use the Brain | present | present |
| Dispatch / Task limits & setup | UI loop iterations/minutes/diff bytes/diff files/preview timeout; Workspace manifest execution | present | present |
| Dispatch / Experimental | o8 next; Canvas mode; Native browser-view | missing | missing: may launch/switch application surfaces |
| Providers / provider navigation | Installed/configured provider tabs; Show available; tool scan retry | missing | skipped pending security review: inventory response combines account diagnostics and stored TOML; needs a native-safe projection |
| Providers / each CLI house | Runtime status; Version; Binary path; Model selection guidance; Runtime configuration guidance | missing | partial outside Settings: composer already has house/model selection |
| Providers / each CLI house | Account status; connection evidence; sign-in; who pays; account usage/limits and dashboard links | missing | skipped: account/authentication/billing review |
| Providers / Adapter capabilities | Worker actions; Session transforms; Usage support; Account-limit observation support | missing | present: read-only configured worker capabilities, refresh, unavailable/error recovery; no account data |
| Providers / Codex models | Worker effort | missing | present: shared saved effort choices |
| Providers / Claude models | Worker effort; Claude fallback model | missing | present: shared effort and fallback choices |
| Providers / Claude connection | Model source; Model; Codex authorization; reconnect/reset/setup | missing | skipped: authentication/carrier setup |
| Providers / OpenCode models | Show in dispatch pickers; fallback model | missing | partial: dispatch visibility present; live fallback catalog remains |
| Providers / built-in worker | Availability; Managed model; Use in a conversation; Usage/limits guidance; Setup | missing | missing |
| Providers / Orchestrator | Lead provider; Code review provider | missing | partial: reviewer control present; lead availability needs native-safe inventory |
| Providers / Workers | Subscription profile; Default worker; one allow switch per runtime; Your Pi setup | missing | partial: subscription profile and read-only saved default/pool present; discovery/pool/Pi setup need a native-safe inventory projection |
| Providers / Pi setup | Cache warming: Off/During runs/During and between runs | missing | missing |
| Providers / Advanced orchestrator options | OpenCode fallback model; Combined answer provider; Existing setup uses Claude | missing | partial: combined answer and existing setup present; OpenCode live catalog remains |
| Providers / Advanced worker setup | Codex launch method (Direct/Via Ori) | missing | skipped: credential carrier |
| Providers / Advanced worker setup | Worker quota fallback | missing | present |
| Providers / Engineering Brain | Answer routing; Codex model; Codex effort | present | present: all eight frozen classic model presets, editable saved/custom model, routing and effort |
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
| Local models / Local models | Dispatch model (Ollama/LM Studio/Cloud); Local endpoint/presets; Chat model/presets; Embedding model; Save/test | missing | missing: endpoint fields deliberately skipped for network-binding review; chat/embedding model-name controls present; dispatch choice/presets/test remain |
| Worktrees & storage / Storage usage | Workspace files: allocated/logical; Refresh usage; Space for new tasks: free/reserved/available | missing | present: measured/partial/unknown accounting with refresh; signed task headroom and unknown values remain truthful |
| Worktrees & storage / Automatic cleanup | Workspace count per repository; Disk usage per repository | present | present |
| Worktrees & storage / Advanced | Reuse dependencies (APFS) | missing | missing: native-safe defaults omit the effective environment override; needs that projection before an accurate switch can be offered |
| Worktrees & storage / Workspace parking | Parking mode | present | present |
| Worktrees & storage / Workspace parking | Fleet parking: parked/eligible/opted out; each repository's pressure parking switch | missing | partial: fleet counts present; repository opt-out controls remain |
| Worktrees & storage / Minimum free space | Volume reserve; Absolute floor | present | present |
| Worktrees & storage / Storage categories | Source, dependencies, build files, runtime files, transcripts: allocated/logical/method | missing | present: categories, measurement time and method |
| Worktrees & storage / Finished work | Repository choice; review cleanup candidates/retained recovery; reviewed cleanup action | missing | missing: no cleanup executed by this task |
| Projects / Overview | Repositories/context/locks summary; create project; suggested grouping/dismiss | missing | partial: existing separate native Projects surface |
| Projects / Active project context | Search saved projects; Details; Open workspace; Edit; Back; Tasks | missing | partial: separate native Projects surface, no Settings link |
| Projects / project editor | Name; description; main repo; repository attach/detach; instructions; lock file add/remove; save/cancel/delete | missing | partial: separate native Projects surface |
| Git & PRs / GitHub | Identity; Repository & CLI access; device flow; token entry; sign out; Automation app install/manage | missing | skipped: account/authentication |
| Git & PRs / Branches | Branch prefix | present | present |
| Git & PRs / Commits | Tag commits created by agents | present | present |
| Git & PRs / Pull requests | Open pull requests (In o8/Browser) | present | present |
| Indexing / Repositories | Every repository index status; Refresh docs; Retry | missing | present: repository status, per-repository refresh receipt, retry after error |
| Indexing / Engineering Brain | Saved instructions; Recorded task outcomes; Knowledge storage | missing | partial: instruction/outcome totals present; knowledge storage details remain |
| Indexing / Conversation history | Choose ZIP/JSON conversation export; Import conversation history; local profile/topic/unfinished-project summary | missing | skipped: account-export/profile ingestion review |
| Indexing / Knowledge sources | Folder; include patterns; exclude patterns; add/refresh/remove source and facts | missing | missing: source ingestion/redaction behavior skipped |
| MCP / Clients | Claude Desktop, Claude Code, Hermes Agent, OpenClaw status; Install/Update/Remove | missing | skipped: writes authenticated client configuration |
| MCP / External servers | Add command/URL/JSON; candidate edit/add; manual name/transport/command/args/env/URL; enable; worker/Symon injection; test; remove | missing | skipped: arbitrary environment, credentials and network endpoints |
| MCP / ChatGPT task review | Held task; exact requirements; approve/deny review | missing | skipped: authorization |
| MCP / Diagnostics | Manual config disclosure/copy; System details disclosure (backend, install mode, CLI path/Node, Node.js, Codex, gh, database, webview) | missing | skipped: manual config and network binding; non-secret installed-tool facts in scope |
| Mobile / Remote access | Connect this Mac | missing | skipped: authenticated relay |
| Mobile / Symon Messages | Text Symon; allowed phone number; save/status | missing | skipped: sender access |
| Mobile / Pairing | Show pairing QR | missing | skipped: credentials |
| Mobile / Paired devices | Refresh; revoke/remove each device | missing | skipped: credentials |
| Analytics / Autonomy | Clean merge receipts; success rate; partial or failed; outcomes | missing | missing |
| Analytics / Governance | Approval rate; pending; rejected; review latency | missing | missing |
| Analytics / Totals | Total spend, messages, cost/hour, input/output tokens, cache hit rate; date-range and refresh controls | missing | missing: existing native Usage surface may cover part; not yet verified |
| Analytics / Spend over time, By surface | Spend chart; per-surface breakdown | missing | missing |
| Diagnostics / Connection health | Check installed tools / Check again; each installed tool's status | missing | missing: authentication text skipped; install/version facts in scope |
| Diagnostics / Feature diagnostics | Shipped feature audit; default-off feature flags; Refresh; release age/first shipped/promotion status | missing | present: read-only feature audit with refresh, lifecycle/source/age and unavailable state |
| Diagnostics / Maintenance | Archive old Codex sessions; result counts/duration | missing | skipped: current production retention contract refuses external-provider transcript archival; no maintenance executed |
| Diagnostics / Reset app data | Factory reset; confirmation text; confirm/cancel; result | missing | skipped: wipes credentials |
| Diagnostics / Diagnostic authorization | Enable/disable developer tools | missing | skipped: authorization boundary |
| Diagnostics / Recall health | Outcomes/directives; recall p50/p95/p99 24h/p95 7d; substrate health; Refresh | missing | skipped: classic developer-diagnostics authorization boundary; Brain totals available under Indexing |
| Diagnostics / Loop status | Cron; prompt; open PRs; active lanes; recent merges disclosure; refresh | missing | skipped: classic developer-diagnostics authorization boundary |
| Diagnostics / Demo sequence | Run demo; confirm/cancel; live trace | missing | skipped: diagnostic authorization |
| About / Version | Version; Platform; Mode; Check for updates and result | missing | present: connected version, native platform/mode, verified check-only update result |
| About / Links | GitHub; Documentation; Releases | missing | present: native link controls |
| About / Onboarding | Replay onboarding | missing | missing: native onboarding surface not present |
| About / Report an issue | Enable sharing; Bug/Request; Message; attach/paste/drop/remove image; Send; status | missing | skipped: upload/redaction and outbound report review |
| About / Credits | Framework/runtime and design credits | missing | present: native GPUI/runtime credits |
| About / Developer | Reset + run onboarding; Preview onboarding; View detection | missing | missing: classic host onboarding |
| Legacy Workers / tokens and fleet | Label; Scope; Max workers; create/copy/revoke token; remote runtime flag; fleet status | missing | skipped: credentials and remote access; not routed by current SettingsPage |
| Legacy Cloud workers / team | Label; Team ID; create/connect/revoke/refresh | missing | skipped: credentials and account; not routed by current SettingsPage |
| About / Release notes signup | Email entry; subscribe; status | missing | skipped: account details and outbound subscription |
| Quick drawer / Account | Account/sign in | missing | skipped: authentication; existing native profile surface untouched |
| Quick drawer / Settings | Open Settings (Cmd+,) | present | present in existing native profile surface |
| Quick drawer / Appearance | Expand; Light; Dark; All Glass; selected state; close after choose | present | present in existing native profile surface; no rail changes |
| Quick drawer / Get help | Expand; Keyboard shortcuts (Cmd+/); Community Discord; Documentation | present | present in existing native profile surface; no rail changes |
| Quick drawer / capacity helper | Plan capacity rows; refresh; select/register plan | missing | skipped: account/billing (helper is not mounted by current drawer) |
| Quick drawer / theme helper | Light; Dark; glass surface toggle | partial | partial: current drawer uses three complete looks; helper itself is not mounted |
| Keyboard / shortcuts | Open shortcut help and close it, keyboard scrolling | partial | partial: Settings opens the native help and restores focus; Tab stays in Settings and reveals navigation; controls activate once on release and non-secret editors remain reachable; classic host-only shortcut coverage remains |
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

- General: `settings_parity_general_groups_and_global_search` failed on the absent Conversations group, then passed (1/1). It clicks the persisted usage switch, filters across pages, clears with the button, and clears with Escape without closing Settings.
- Baseline: `settings_opens_from_shell_command_palette` passed (1/1).

- Appearance: `settings_parity_appearance_drives_the_running_shell` passed (1/1), clicking Light Solid, Dark Solid and All Glass through Settings and observing the running shell theme. Persistence uses the existing native theme owner.

- Model defaults: `settings_parity_model_defaults_persist` passed (1/1). Real selectors/edits persist worker efforts, reviewer/combined routing, fallback model, worker fallback, visibility, local model names and triage/action efforts. A single-provider profile pins the reviewer; tier edits preserve the saved runtime and model. House discovery remains held for a native-safe inventory response.

- Voice notifications: `settings_parity_spoken_notifications_persist_and_gate_controls` passed (1/1). It clicks all notification switches, verifies saved values, checks disabled dependencies, saves the hourly budget and quiet-window start, and refuses an invalid time without changing the saved end.

- Keyboard: `settings_parity_keyboard_opens_help_and_returns_to_settings` passed (1/1), opening the real shell help modal, closing back to Settings, then reopening it with Enter from the restored focus. The page renderer moved to `settings_render.rs` to keep the existing row-controls file below its size limit; internal Settings navigation scrolls without visible bars.

- About: `settings_parity_about_links_version_and_verified_update_check` and `settings_parity_about_repeated_checks_without_intermediate_frames` passed in the fresh serial run. Each variant drives five check-only requests, including current/available, unverified, HTTP failure and recovery, and requires exactly one new request per click. The result area keeps stable space as feedback changes; the framed variant also asserts the button cannot move during a press. Links and connected version remain covered. These are HTTP-peer/GPUI receipts, not installed-app update acceptance.

- Connections: `settings_parity_connections_read_only_capabilities_and_recovery` passed in the combined serial run. Real selectors read declared capabilities, switch configured workers, recover from an unavailable adapter, and prove search performs no inactive-panel reads until a result is opened. `settings_parity_actions_follow_shell_settings_lifecycle` passed: the global palette opens Projects and drops both Settings subscriptions together.

- Diagnostics: the committed `settings_parity_diagnostics_feature_audit_refresh_and_error` case covers unverified and attention audit states, flag metadata, and HTTP 503 clearing the cached audit. It stops after the 503; post-error recovery is not claimed by this test. Developer-gated diagnostics remain skipped.

- Storage: `settings_parity_storage_refresh_keeps_unknown_accounting` covers complete data, signed headroom parsing, a 503 tagged observed, partial/null accounting, malformed/unavailable responses and recovery to measured zero. The additional `settings_correction_5220_signed_headroom_from_producer_shape` drives native Refresh with negative, positive and null admission projections and checks rendered values. Negative headroom now remains negative in “Task space after reserves”; known allocation metrics stay visible.

- Indexing: `settings_parity_indexing_refresh_docs_and_independent_counts` covers the original receipt/path and independent index/totals availability cases. `settings_correction_5221_refresh_docs_updates_rendered_totals` now checks a changed rendered total after the actual native docs action, a follow-up totals 503 and recovery, unconfirmed/missing-result and explicit-false responses, a docs POST 503, and successful retry. `settings_correction_5221_revisit_refreshes_rendered_totals` checks a changed total after leaving and revisiting Indexing.

- Fleet presets: `settings_parity_classic_fleet_presets_persist_and_recover` failed first on the missing preset selector, then passed. It persists 2, 5 and 8 through the production settings route, refuses a failed write without changing the saved capacity, and recovers after Refresh.

- Brain model presets: `settings_parity_classic_brain_model_presets_persist` failed first on the absent selector, then passed. It selects and persists all eight classic model values through the production route and preserves the custom-model editor.

- Search and history: `settings_parity_classic_search_navigation_and_history` passed after its missing-control, Tab-focus and deferred-scroll failures. It clicks ranked results, presses Enter to reveal a field, clears search, drives Back/Forward and truncated history, and returns to the workspace. A 580px-high window proves Tab reveals the bottom of the Settings list. Supplied focus handles carry the Tab policy; direct list scrolling runs during layout without a frame callback or animation loop.

- Keyboard activation: `settings_parity_keyboard_activates_each_control_once` failed first because one held Space toggled twice. GPUI already activates `on_click` on Enter/Space release, so the redundant key-down action was removed. The passing regression also moves exactly one history page and types/saves a non-secret field after Tab/Shift+Tab. Tab cycling remains inside the Settings surface. `settings_parity_keyboard_opens_help_and_returns_to_settings` uses a full press/release gesture for reopening help.

- Harness and build receipts: the test peer explicitly uses blocking reads on accepted sockets after its nonblocking accept loop. Earlier intermittent transport failures could occur before a request reached the peer. Both click helpers reveal the entire control before activating it. Three consecutive rapid About runs passed after the visibility adjustment; final combined verification is recorded below. An ENOSPC rebuild and subsequent cached-object link failure were resolved by regenerating only this test crate's generated objects; dependency caches, source and unrelated worktrees were preserved.

- Initial timebox native gate at `895ff4af8`: `cd native/o8-next && CARGO_TARGET_DIR=$PWD/target cargo +1.97.1 test --bin o8-next settings_parity_ -- --test-threads=1 --nocapture` passed **16/16** (643 unrelated tests filtered out; 266.34 seconds). This includes the rapid About request-count regression, both keyboard regressions and the production-route persistence tests. Explicit-file `rustfmt --check` and `git diff --check` passed. No installed-app, release or broad-suite acceptance is claimed.

## Correction round 1

The review was pinned to `c9afdd94641a39703bde0164d15122c79b5e018a`; this
round starts from `895ff4af8`. The later `de6019c79` already changed the admission
DTO to `Option<i64>`, but still clamped its display to zero.

- **#5220:** Keep signed headroom in the displayed metric. The regression uses
  the admission fields returned by `readPacketStorageAdmissionProjection`, inside
  the retention-usage response shape: 100 available minus 500 reserve minus 300
  reserved gives **-700 B**; 1000 available gives **200 B**; unavailable admission
  gives **Unknown** in a partial/503 response. Allocated and logical measurements
  remain visible. The rendered-value selectors inspect the same value given to
  the native text element.
- Red: `CARGO_TARGET_DIR=$PWD/target cargo +1.97.1 test --bin o8-next settings_correction_ -- --test-threads=1 --nocapture`
  failed **0/3 passed**, including `settings_correction_5220_signed_headroom_from_producer_shape`
  at the negative rendered-value assertion. Only tests and rendered-value
  selectors had been added before this run.
- Green for #5220: `CARGO_TARGET_DIR=$PWD/target cargo +1.97.1 test --bin o8-next settings_correction_5220_ -- --test-threads=1 --nocapture`
  passed **1/1**, 661 unrelated tests filtered out, in **0.15 seconds**. The
  producer-shaped regression passes for negative, positive and null values
  through native navigation/Refresh.
- Receipt reconciliation: the Diagnostics recovery claim was narrowed to what its
  committed test proves. Storage unavailable/503/recovery cases are present in
  the later committed tests. The original Indexing case is described without
  claiming unconfirmed-success or docs-retry coverage.
- **#5221:** A confirmed docs refresh invalidates saved-instruction/outcome totals
  and fetches them after the POST. An invalidated in-flight totals read queues a
  fresh read instead of publishing its old snapshot. Native section selection
  also refreshes totals on revisit. A failed totals request clears the old count
  and renders **Unavailable**, without turning a confirmed docs receipt into an
  unconfirmed write or pretending that a failed write succeeded.
- Red: in the pre-implementation combined run,
  `settings_correction_5221_refresh_docs_updates_rendered_totals` failed because
  the rendered total stayed at 4 after Refresh docs;
  `settings_correction_5221_revisit_refreshes_rendered_totals` failed because the
  cached total survived leaving and revisiting the page.
- Green for #5221: `CARGO_TARGET_DIR=$PWD/target cargo +1.97.1 test --bin o8-next settings_correction_5221_ -- --test-threads=1 --nocapture`
  passed **2/2**, 660 unrelated tests filtered out, in **0.40 seconds**. The
  controls render totals **4 → 7**, **Unavailable** after the following totals
  503, **11** after recovery, and **12** after retrying failed/unconfirmed docs
  writes. The new totals GET follows the docs POST; every POST uses the selected
  repository's exact path. Revisit changes **4 → 19** without requiring manual
  Refresh.
- Combined correction gate: the original red command then passed **3/3**,
  659 unrelated tests filtered out, in **0.57 seconds**.
- Existing parity regression gate: `CARGO_TARGET_DIR=$PWD/target cargo +1.97.1 test --bin o8-next settings_parity_ -- --test-threads=1 --nocapture`
  passed **16/16**, 646 unrelated tests filtered out, in **203.70 seconds**.
  Explicit-file `rustfmt --check` and `git diff --check` passed.
- These are native-control/HTTP-peer regressions, not execution of the live
  ingestion producer or installed-app acceptance. Both findings remain local
  commits for parent diff review. No push, merge, release, security changes,
  installs or new target caches; parent-owned Linux paths and live dev stayed
  untouched.

## Host and security handoff

- Keep house discovery, default-worker/pool editing, role-readiness details and Pi
  setup held until the reviewer provides an inventory projection without account
  diagnostics or stored TOML. The native-safe defaults remain the source for
  configured runtime IDs and non-secret model preferences.
- Startup, close-with-active-work, update-channel and voice hardware preferences
  belong to classic's host bridge. No native Settings endpoint exists for these;
  no replacement server or host lifecycle was added.
- APFS dependency reuse also needs its effective environment override in a native-safe
  response; the file preference alone would be misleading.
- The native shortcut reference lists actual native bindings. Classic's quick-actions,
  new-orchestrator-tab, panels, composer and global voice rows must only be added
  when their underlying native handlers are verified. Do not advertise host-only bindings.
- API Keys, `settings_secret.rs`, sign-in/accounts, credential storage/carriers,
  pairing/relay access, arbitrary MCP environment/config, permission/authorization,
  reset-with-keys, report redaction/upload and binding/address controls are held.

## Initial timebox outcome

Feature work stopped at the approximately three-hour bound. Full parity is not
complete. The checklist has 42 present, 15 partial, 29 missing and 38 skipped rows
(these are grouped checklist rows, not a count of individual controls).

Remaining safe work includes host startup/close/update-channel and voice bridges;
provider discovery, worker/Pi/routing details after a native-safe inventory exists;
client-only dispatch preferences; storage parking/cleanup review; Settings project
integration; analytics; and onboarding. Every remaining control stays marked in
the table. Security-related skips stay with the reviewer.

Decision: local commits only for lead review. No push, pull request, version bump
or release was performed. Classic, server code, `settings_secret.rs`, sidebar,
nav rail and bot rail were not edited.
