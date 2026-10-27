# o8 roadmap

o8 is for one operator running several coding agents at once. It turns work into missions and packets, runs each packet in its own worktree, keeps the operator in the approval path, and records enough evidence to explain later what happened. All seven pillars serve one outcome: an operator delegates useful work, understands its state while away, steps in when needed, and approves the result without replaying the whole session. This page says where that is going and what is open to work on.

Taste is a gate on every row here, not a pillar of its own. A change that reads badly, responds slowly, or behaves unpredictably is not finished, whichever pillar it belongs to.

## At a glance

1. **Governance is the product.** Workers cannot merge their own work. The goal is to record every decision and make every failure visible and actionable.
2. **Organizational memory.** Rules and past outcomes stay with the project, not with one model vendor.
3. **Runs on your subscriptions.** The coding-agent CLIs you already pay for, behind one runtime contract.
4. **One control plane, every surface.** Desktop, phone, CLI, MCP, headless, voice. Same verbs, different authority.
5. **Smooth for people and for agents.** Fast and legible for a person; drivable through a real interface for a program.
6. **Runs where you are.** Light on the machine, on the machine you have. Mac today; Linux and Windows have compile evidence, while maintainer VM validation is paused. Windows help is welcome.
7. **Ahead.** Longer-term bets, advanced when their next proof warrants it.

## Current focus

The [focus plan through October 27](./docs/operations/focus-through-2026-10-27.md) is the execution order for this month: installed first-run acceptance, trustworthy funnel measurement, paid-tier behavior, and Symon reliability. It includes two bounded contributor queues and weekly checkpoints. The pillar tables below retain longer-term work; an open arc is not automatically permission to start it this month.
<!-- TODO: Maintainer to review the priorities and contributor queues tied to the October 27 focus plan when it ends. -->

## Now

First-run acceptance is the immediate engineering priority. Published stable is [0.1.811](https://github.com/hurttlocker/o8-releases/releases/tag/v0.1.811), released October 26. A fresh stall-free first-run repeat and physical Apple Silicon execution remain unverified. A candidate run is not a public download-to-merge benchmark. Preserve the Solo tools, sent-image, and comparison stop/requeue checks. [#2211](https://github.com/o8-run/o8/issues/2211)

Default-on usage analytics, with a first-run disclosure, preserved opt-outs and matching privacy documentation, is published in 0.1.811 via [#3046](https://github.com/o8-run/o8/pull/3046). Update-service delivery in the installed updater and trustworthy active-install counts remain unverified. Later activation and reporting work is listed below as source work awaiting the next release and installed acceptance.

After first-run acceptance, verify paid-tier behavior through the installed app, then complete the existing Symon reliability review. Its scope includes sessions, models, tool results, interruptions, reconnect and approvals. Current Symon follow-ups retain their own prerequisite and acceptance evidence. [#2534](https://github.com/o8-run/o8/issues/2534)

Outside contributors should choose one open, unclaimed task from the [two contributor queues](./docs/operations/focus-through-2026-10-27.md#two-contributor-queues). Existing contributor PRs keep their owners; passing source checks and a merged PR are separate from release and installed acceptance.

Broad remote-project expansion is outside this month's default queue. Existing separately scoped remote and plugin work keeps its own owner, bounded acceptance and release decision; it is not automatically part of the first-run candidate. Remote recovery and continuation proof remains incomplete. [#2282](https://github.com/o8-run/o8/issues/2282)

Shared-checkout teams shipped in 0.1.771 with four-worker native evidence. Ten-worker, collision and isolated-mode acceptance remain open. Linux and Windows product validation stay parked; running existing tests on Linux does not change that status. [#2772](https://github.com/o8-run/o8/issues/2772), [#1672](https://github.com/o8-run/o8/issues/1672), [#2204](https://github.com/o8-run/o8/issues/2204)

## Source work awaiting installed acceptance

Published stable is [0.1.811](https://github.com/hurttlocker/o8-releases/releases/tag/v0.1.811). The October 26 and 27 merges below are beyond its source tag and await the next release. Merged source does not establish installed acceptance; earlier published work retains its recorded acceptance gaps.

Activation analytics count the first observed successful worker launch, first completed merge and clean or unclean backend session endings in [#4810](https://github.com/o8-run/o8/pull/4810). The daily report in [#4812](https://github.com/o8-run/o8/pull/4812) groups observed installs, activation and session outcomes by version. Fixture verification does not supply production counts; the hosted read-only export remains a separate prerequisite. Installed measurement remains unverified.

Lead effort choices are checked against the installed CLI's advertised vocabulary in [#4865](https://github.com/o8-run/o8/pull/4865). Unmapped concrete pins are refused in [#4858](https://github.com/o8-run/o8/pull/4858); omitted or adaptive choices retain runtime defaults, and unsupported live steers are refused before delivery in [#4901](https://github.com/o8-run/o8/pull/4901). Phone Ask preserves explicit effort through native launch in [#4850](https://github.com/o8-run/o8/pull/4850), while automatic continuations drop inherited pins on leads without a matching transport in [#4914](https://github.com/o8-run/o8/pull/4914). Installed acceptance remains separate.

Runtime launch records its preparation stages and bounds post-worktree observation to 30 seconds in [#4755](https://github.com/o8-run/o8/pull/4755). A timeout names the active step without claiming that a process is absent; unstarted sessions retire only after complete run-history and process-clearance checks. Detached workers receive staged input through a pipe, and an unrecognized empty exit is recorded as failure in [#4854](https://github.com/o8-run/o8/pull/4854). Installed launch and recovery acceptance remain open.

Finished worker panes collapse to outcome cards with review links and transcript expansion in [#4848](https://github.com/o8-run/o8/pull/4848). The project Add entry opens a folder directly and also accepts URL paste or folder drop in [#4845](https://github.com/o8-run/o8/pull/4845). Rail-created chat panes retain independent conversations in [#4805](https://github.com/o8-run/o8/pull/4805). Source and controlled UI evidence do not establish installed acceptance.

Sidebar layout follows applied UI zoom in [#4893](https://github.com/o8-run/o8/pull/4893), and Review retains source anchors through reflow in [#4873](https://github.com/o8-run/o8/pull/4873). Optional surface preloads stay off composer startup in [#4874](https://github.com/o8-run/o8/pull/4874); returning to an unchanged session reuses transcript, visualization and composer work in [#4897](https://github.com/o8-run/o8/pull/4897). Installed responsiveness and the original window comparison remain separate acceptance work.

Completed worker log retention has byte and expiry bounds in [#4851](https://github.com/o8-run/o8/pull/4851). Controlled native measurements do not establish installed acceptance, and the whole-app 500 MB idle-memory target remains unmet.

The native sidebar groups Recents by age and preserves keyboard focus through live reordering in [#4737](https://github.com/o8-run/o8/pull/4737). Native shell startup recovers unreadable state in memory and restores window bounds onto an active display in [#4704](https://github.com/o8-run/o8/pull/4704). Installed acceptance of the experimental shell remains separate.

MCP tool schemas publish required fields, supported values and corrective input errors in [#4832](https://github.com/o8-run/o8/pull/4832). Deterministic contract checks do not establish the unmeasured model-backed operator trial or installed acceptance.

Explicitly forgotten project memory stays excluded from later capture, recall and dispatch in [#4888](https://github.com/o8-run/o8/pull/4888). Source verification does not establish installed acceptance.

Linux package installation recommends Node 22 while retaining the runtime preflight in [#4822](https://github.com/o8-run/o8/pull/4822). Packaged desktop entries pass deep-link URLs in [#4826](https://github.com/o8-run/o8/pull/4826), and package-managed installs use their package manager's update path in [#4825](https://github.com/o8-run/o8/pull/4825). Native browser commands and receiver settings are limited to supported hosts in [#4819](https://github.com/o8-run/o8/pull/4819) and [#4827](https://github.com/o8-run/o8/pull/4827); Linux glass is opt-in in [#4816](https://github.com/o8-run/o8/pull/4816). These merges do not establish Linux install-to-merge acceptance or restart maintainer VM validation.

Verification support: the local CI command derives its checks from the workflow in [#4815](https://github.com/o8-run/o8/pull/4815), and child-exit fixtures stay inside the isolated test data directory in [#4867](https://github.com/o8-run/o8/pull/4867). Release preflight reports competing producer identity in [#4866](https://github.com/o8-run/o8/pull/4866). These changes do not establish a new release or installed acceptance.

Shared screen layout rules, explicit agent readiness, independent project discovery, optional voice and iPhone setup, and sensory feedback are implemented in [#3345](https://github.com/o8-run/o8/pull/3345) and included in 0.1.811. Full-window setup follows native glass while preserving opaque browser and solid surfaces. Built-in agent runtime roles are registered; installed-app acceptance remains open in [#3246](https://github.com/o8-run/o8/issues/3246). Publication does not establish installed first-run acceptance.

Direct tool sign-in recovery, explicit workspace continuation, restart intent, and focus and sound follow-through are implemented in [#3374](https://github.com/o8-run/o8/pull/3374) and included in 0.1.811. A ready discovery result enables continuation; opening a sign-in surface never starts authentication automatically. Installed acceptance remains open; voice and mobile acceptance remain with their existing work.

Explicit adopted-elsewhere Close recovers an original archived clean-exit owner only when manager identity, packet and lane bindings, complete run evidence and native process quiescence agree. The archived worker stays closed; branch preservation, operator-stop state and the existing retirement checks remain in force. Source handler proof is separate from installed acceptance and release. [#4065](https://github.com/o8-run/o8/issues/4065)

Documentation follow-up: worker guidance distinguishes Stop acknowledgements, exact-run interruption and process-tree confirmation before recovery. UI visibility is separate from coordinator and tunnel reachability, while bounded review previews keep their existing contract. This changes documentation only; runtime behavior, installed acceptance and release are unchanged. [#4063](https://github.com/o8-run/o8/issues/4063)

Public voice preference reads derive saved-key presence from legacy values or non-authenticating Keychain metadata, without retrieving or migrating secret data, and run native I/O on a blocking worker. A persisted-read regression and controlled native query inspection cover the source boundary; rebuilt installed-app responsiveness and protected-Keychain acceptance remain open. [#3063](https://github.com/o8-run/o8/issues/3063)

Local ancestry reconciliation preserves cloud-owned packet and lane results even when their remote branch is absent from the coordinator checkout, including conflicting ownership metadata and lanes whose mission has rotated away. Controlled sweep regressions retain review state, event history and the pushed remote commit across repeated sweeps. Live remote/native acceptance and release remain separate. [#3065](https://github.com/o8-run/o8/issues/3065)

Pull request summaries and the Changes toolbar show estimated Code, Tests, Mocks and Other change counts from their already-loaded file metadata. Partial metadata stays separate from authoritative totals, and the disclosure closes when its owning view becomes inactive. Source regression and controlled browser evidence do not establish installed acceptance or release. [#4035](https://github.com/o8-run/o8/issues/4035)

CLI installation and desktop restart share one persisted admission slot across web clients and native restart entries. An active, interrupted or unconfirmed installer defers restart before cloud-job draining or child cleanup; an admitted restart retains ownership through both. Controlled installer, API, client and native fixtures cover the boundary. Packaged acceptance and release remain separate. [#3551](https://github.com/o8-run/o8/issues/3551)

A staged desktop update retains an explicit Restart action. The action checks current work, restarts directly when only parked tasks remain, and asks before interrupting running work. CLI installer and restart ownership remain mandatory; automatic applies stay idle-gated. Source regressions and installed acceptance remain separate. [#4061](https://github.com/o8-run/o8/issues/4061)

Stop records the same worker owner in the current mission and its registry before interrupting the worker. Preserving Retry retains completed work; stale owners and failed registry publication refuse without interrupting a replacement worker. Source regression evidence and installed acceptance remain separate. [#4022](https://github.com/o8-run/o8/issues/4022)

Explicit synchronous dispatch publishes its prepared packet re-arm before worker launch. The real CLI/owned-worker/managed-run regression verifies test execution and held/stopped credential refusal; work-preserving stop/retry reconciliation remains separate in [#4022](https://github.com/o8-run/o8/issues/4022). Installed acceptance remains distinct. [#2536](https://github.com/o8-run/o8/issues/2536)

[0.1.798](https://github.com/hurttlocker/o8-releases/releases/tag/v0.1.798) publishes the workspace frame, composer and worker displays, dictation ownership, delivery recovery, and restricted voice pilot. The published universal macOS app and installer passed signature and notarization verification. General managed voice remains disabled; installed conversation and provider-image acceptance remain open.

Matching late acknowledgements retire only their own delivery warning, including quota-failed attempts and optimistic rows evicted from retained history. Confirmation persists across saved-history reloads and stale writes. Source, native candidate acceptance and release remain separate gates. [#3638](https://github.com/o8-run/o8/issues/3638)

Unaccepted image submissions recover their original preview from the saved send payload after restart. Explicit retry preserves that payload; missing or invalid required images request reattachment instead of sending text alone. Actual provider image receipt and installed release acceptance remain separate. [#2637](https://github.com/o8-run/o8/issues/2637)

Direct chat sends refuse before consuming the composer when saved session context cannot be read. The visible draft and attachments remain available for an explicit retry after storage access returns. Native candidate acceptance and release remain separate gates. [#4004](https://github.com/o8-run/o8/issues/4004)

Send next preserves its original request identity, destination, attachments and routing through an uncertain response, renderer restart and an explicit retry. Queue transport waits are bounded; stale composer completions cannot retire a replacement composer's recovery. Source, private native acceptance and release are tracked separately. [#4002](https://github.com/o8-run/o8/issues/4002)

Ordinary workspace composers retain unsent text, completed image attachments and queued file context across a normal restart, scoped to the selected repository and conversation. Explicit clearing removes saved drafts; storage failure keeps the current input visible and prevents an unsafe conversation transfer. Private native candidate acceptance and release remain separate gates. [#3994](https://github.com/o8-run/o8/issues/3994)

Inbox view labels and count badges are centered within their existing hit areas across selected, hover and keyboard states. Native candidate acceptance and release are recorded separately. [#3995](https://github.com/o8-run/o8/issues/3995)

Known terminal sessions retain their identity when a saved workspace returns after the process has stopped. Restore offers an ended view and an explicit new-shell action; unavailable session status cannot authorize a replacement process. Source regressions cover stop, reload, reconnect and preserved output, including a newer interactive reply when tmux restores stale startup history before its exit marker. Native candidate acceptance and release are recorded separately. [#3992](https://github.com/o8-run/o8/issues/3992)

Managed development environment cleanup source work has closed in [#3337](https://github.com/o8-run/o8/issues/3337). First-run installed acceptance remains open in [#3246](https://github.com/o8-run/o8/issues/3246) and [#2211](https://github.com/o8-run/o8/issues/2211).

Workspace polish source work has closed in [#3670](https://github.com/o8-run/o8/issues/3670), [#3672](https://github.com/o8-run/o8/issues/3672), [#3673](https://github.com/o8-run/o8/issues/3673), and [#3675](https://github.com/o8-run/o8/issues/3675). Its checks cover quieter conversation groups, visible working agents, reliable pane dragging, terminal reconnect, and reopening a hidden worker without stopping it. Right-panel restoration, search failure recovery, and Markdown image presentation source work has also closed: [#3480](https://github.com/o8-run/o8/issues/3480), [#3490](https://github.com/o8-run/o8/issues/3490), and [#3491](https://github.com/o8-run/o8/issues/3491). Development evidence does not establish installed release acceptance. The restoration and reconnect changes are integrated in [#3716](https://github.com/o8-run/o8/pull/3716).

Verification support: sidebar date-fold fixtures and the rendered view share a fixed local clock, with an explicit midnight-boundary case. Existing fold and attention assertions remain intact; production date grouping is unchanged. [#3544](https://github.com/o8-run/o8/issues/3544)

Verification support: Browser-open real-path fixtures advance their clock and polling between React commits, preserving the original request deadline, host acknowledgement, actual navigation and single-open assertions. Boundary cases retain pending results beyond the deadline and observe later navigation without replay. Production Browser behavior is unchanged. [#4006](https://github.com/o8-run/o8/issues/4006)

Verification support: the prepared-dispatch publication-conflict fixture requires Stop to refuse mismatched ownership without changing either store, relaunching or interrupting its worker. The fixture teardown remains separate; production dispatch and Stop guards are unchanged. [#4048](https://github.com/o8-run/o8/issues/4048)

Verification support: registered-owner Retry observes its exact persisted interruption before requiring salvage. A controlled exit-finalization race must refuse safely, preserve ownership and committed work, and recover through a fresh explicit Retry after completion; production stop guards are unchanged. [#4050](https://github.com/o8-run/o8/issues/4050)

## What we need to prove

Three outcomes decide whether the pillars add up. The first-diff comparisons below provide evidence on code quality; operator effort and the full loop's value still need measurement. A green checklist is progress on a row, not proof of the outcome.

- **A new operator finishes the loop.** Download to first merged packet, with the minutes and the stalls measured. Baseline from source: 6.8 minutes, nine stalls. The download path has no baseline yet; the update-check and usage-analytics changes above provide it. [#2211](https://github.com/o8-run/o8/issues/2211)
- **Interrupted work stays visible and recoverable.** A refusal surfaces, retries are bounded, and a replaced mission leaves no live packets behind. [#2197](https://github.com/o8-run/o8/issues/2197)
- **The governed loop earns its cost.** The product question is whether the existing workflow helps an operator finish correct, acceptable work with less measured active operator effort. Initial-patch quality remains a separate diagnostic under its original rule. Compare final accepted quality, total attempts, reviews and rework, elapsed time, and attributable usage or subscription capacity. An accurate ledger supports that comparison; it does not establish that delegation saves time or money, and subscription capacity is recorded as capacity, never converted into an invented per-token dollar saving. [#2289](https://github.com/o8-run/o8/issues/2289), [#1684](https://github.com/o8-run/o8/issues/1684), [#1791](https://github.com/o8-run/o8/issues/1791)

## How to read this

Only open arcs appear in the pillar tables. Shipped arcs are listed once at the bottom with the release they landed in. Each open arc links to one tracking issue whose checklist is the real progress; a box is checked when the child issue is closed and its fix is in a shipped release, and GitHub shows the count on the issue itself.

State words mean: **open** has children in flight; **parked** means we know what it would take and are not doing it now; **not usable** means the platform does not run o8 today, whatever the checklist says. Read the Gap column first. It says what is missing in words.

A `pillar/*` label locates a subsystem. An `area:*` label identifies an optional cross-cutting concern. Assignees and named claims record who has taken the work; categories do not assign ownership.

`node scripts/roadmap-status.mjs` prints the checklist counts. `node scripts/roadmap-status.mjs --check` fails when a checked child is still open or when a Now link points at a closed issue. A closed child whose box is unchecked is reported as awaiting release, not as drift. CI runs this check on pushes, the Sunday scheduled run, and manual dispatches, not on pull requests. The check reads issue state only: it does not read release tags and it cannot judge a Gap sentence, so the words on this page are the maintainers' to keep true.

## 1. Governance is the product

Execution is separated from approval. Workers cannot merge their own packets. This pillar requires decisions and failures to be recorded and visible, with a supported path to resolve them; the lifecycle row below tracks the remaining gaps.

| Arc | Done means | State | Gap | Where |
| --- | --- | --- | --- | --- |
| Lane lifecycle and recovery honesty | No lane stalls silently. Every terminal state is reachable from the UI and the CLI. | open | Every child is shipped as of 0.1.756. No interrupted lane has been shown end to end settling to a terminal state that is reachable from both the UI and the CLI, so the outcome is unproven. | [#2197](https://github.com/o8-run/o8/issues/2197) |
| Task-contract review evidence truth | File deliverables and process constraints receive distinct review evidence, and a missing default contract has an explicit recovery decision before merge. | open | Both repairs are merged in source but not released. A released-build proof and the exact packet rerun remain. | [#2682](https://github.com/o8-run/o8/issues/2682) |
| Worker capability boundaries | A worker cannot read or reach anything its packet does not grant. | open | Native workers run under the operator's user account and can read the operator's environment. | [#2198](https://github.com/o8-run/o8/issues/2198) |
| Contributor-ready public repo | An outside pull request gets green checks and a human reply without maintainer plumbing. | open | Every child is shipped as of 0.1.750. No outside pull request has gone through the claiming protocol end to end, so the outcome is unproven. | [#2199](https://github.com/o8-run/o8/issues/2199) |
| First-diff quality | A governed packet's first diff scores at least as well as the raw model coding alone on the same issue. | parked | Earlier headline comparisons reported 0/3 governed wins, but those scores were later withdrawn because judge bias could not be ruled out. Over-engineering and missed requirements remain the target failure modes. The later [paired contract trial](./docs/user/honest-benchmark-2026-08.md#track-1--coding-does-a-pre-edit-contract-improve-first-diff-quality) was mixed. The [September 12 fixed trial](https://github.com/o8-run/o8/issues/1684#issuecomment-5645498074) scored two complete tasks, with zero decisive contract wins in either runtime; one task was excluded for an invalid contract. The original decision rule remains unmet. Future intervention research is separate. | [#1684](https://github.com/o8-run/o8/issues/1684) |
| Governed task completion and operator effort | A bounded comparison produces an auditable decision about final correctness, operator effort, and overhead. | open | Protocol [#2290](https://github.com/o8-run/o8/pull/2290) is merged. The near-term step is [#2296](https://github.com/o8-run/o8/issues/2296), three real-work dogfood observations one at a time; the formal [#2288](https://github.com/o8-run/o8/issues/2288) paired pilot remains parked. | [#2289](https://github.com/o8-run/o8/issues/2289) |
| Typed judgment referee | Every advisory referee surface (approval card, Brain routing, merge-gate warning, phone inbox order and chips) runs behind one setting, writes a receipt per call, and reads a threshold only where the local calibration replay earned it. | open | Advisory surfaces shipped in 0.1.759 and replay labels shipped in 0.1.760. The risk score has no gate-failure signal in the local replay, so nothing gates on it. Replay and measurement come before another surface or a promotion decision; managed judgment has a separate hosted-service gate. | [#2481](https://github.com/o8-run/o8/issues/2481) |

## 2. Organizational memory

Project rules and prior outcomes stay attached to the project, not to one model vendor. An orchestrator and its workers share the same operating context across runtimes.

| Arc | Done means | State | Gap | Where |
| --- | --- | --- | --- | --- |
| Cost and capacity ledger | The ledger's number and the provider's invoice agree. | open | Nothing measures what role routing and context controls save. | [#1791](https://github.com/o8-run/o8/issues/1791) |
| Memory the operator shapes | What the operator rejects, steers, or edits becomes memory the Brain and the next worker retrieve, and any single retained item can be withdrawn from future retrieval without erasing the record that it was once applied. | open | Rejection and steer reasons are stored for audit and read by no retriever; the schema's rework flag is never written; the only way to forget one rule is to reset the whole database. | [#2221](https://github.com/o8-run/o8/issues/2221) |

## 3. Runs on your subscriptions

Local worker adapters launch the coding-agent CLIs you already pay for and reuse the authentication those tools already hold. The runtime contract keeps callers independent of any one provider's protocol.

Hermes worker dispatch is implemented through the shared owned ACP path in [#3391](https://github.com/o8-run/o8/pull/3391). Entry-point fixtures cover model selection, launch, interrupt, reconnect, and persisted transcripts. Installed provider acceptance remains open in [#3388](https://github.com/o8-run/o8/issues/3388).

Native Muse Code worker and orchestrator support is implemented in [#3602](https://github.com/o8-run/o8/pull/3602), and explicit ACP registry preparation and local onboarding in [#3603](https://github.com/o8-run/o8/pull/3603). Model-switch refusal and uncertainty, session isolation, saved model identity, and capability reporting are tracked in [#3597](https://github.com/o8-run/o8/issues/3597). Local protocol and process fixtures establish source behavior; signed-in provider, paid-model and installed-app acceptance remain separate gates.

| Arc | Done means | State | Gap | Where |
| --- | --- | --- | --- | --- |
| Carrier coverage and auth probes | A new carrier lands as a registry entry plus a readiness and auth probe, with no fork in the dispatch path. | open | Readiness and auth checks are written per CLI, and the operator cannot see what evidence o8 used to call a runtime connected. The one adapter waiting is blocked on an upstream build for Intel Macs. | [#2200](https://github.com/o8-run/o8/issues/2200) |
| Local models first-class | Every surface names its local provider, and a test proves no egress for a full packet lifecycle. | parked | No surface-by-surface local path exists, and nothing proves that a packet leaves nothing behind on the network. The first narrow step is an egress baseline that names every contacted host and surface, even when it fails. | [#1451](https://github.com/o8-run/o8/issues/1451) |

## 4. One control plane, every surface

Local machine identity [#3120](https://github.com/o8-run/o8/issues/3120) uses the neutral label This computer in the machine selector and phone session response. Legacy This Mac identities still resolve to the same local target without rewriting saved sessions. Source fixtures cover labels, repeated disclosure, parsing and persisted-session continuity; native platform acceptance and release remain separate.

Runtime connection evidence [#2214](https://github.com/o8-run/o8/issues/2214) carries observed providers, source kinds and actual check times into Providers, dispatch and CLI/MCP status. Empty probes stay indeterminate; configured carriers remain distinct from verified provider access. Account identity and external tools remain explicitly unreported when the runtime exposes no evidence.

Local development account startup [#3810](https://github.com/o8-run/o8/issues/3810) keeps exact loopback browser workspaces usable when a production account key is configured. Native sign-in and production web authentication retain their own paths.

Desktop, mobile, CLI, MCP, headless, and voice reach the same governed control plane. Each caller gets its own authority; none of them gets the operator's by default.

Mobile voice intent resolution is implemented in [#3146](https://github.com/o8-run/o8/pull/3146). Entry-point tests cover paired-device access, confirmed choices scoped to a submitted chat and repository, and offline replay. Paired-phone and provider acceptance remain open.

| Arc | Done means | State | Gap | Where |
| --- | --- | --- | --- | --- |
| Terminals as a workspace surface | A tmux or vim session survives an update and a pane switch byte for byte, and agent terminal actions go through a governed adapter. | open | CLI discovery is tracked in #2727, verified Codex turn events in #2729, repo-less reload in #2732, and cross-profile tmux ownership in #2733. Other CLI states, governed actions, and native multi-terminal add/close proof remain open. | [#1723](https://github.com/o8-run/o8/issues/1723) |
| Settings take effect everywhere | An operator changes a setting once and every surface uses the new value on its next action, with no reload and no second place to set it. | open | Operator defaults are snapshotted at page load and cached per terminal server; the same bug has recurred under four names. | [#2217](https://github.com/o8-run/o8/issues/2217) |
| Remote project operation | An operator reconnects to the same remote task, preview, diff, evidence, and approval path; a later packet can use another supported agent system with the same project rules. | open | Durable worker and preview work has advanced in source. The full operator-visible recovery and continuation proof remains open; broader expansion is outside the current focus window. | [#2282](https://github.com/o8-run/o8/issues/2282) |
| ChatGPT conversation orchestration | An operator plans and follows bounded CLI work with explicit account, permission and usage boundaries, while approvals remain in o8. | open | Installed private reads, one explicit continuation, retry deduplication and the current worker report passed. Source work adds a plan connection, durable held task drafts, a per-session single-attempt runtime limit, an account transition/admission guard, a controlled worker credential/tool restriction, permanent operator task/attempt admission through actual spawn and exact-contract desktop review controls. Mounted plan-settings tests now hide prior-account details in the first identity-changing commit and refuse stale replies; hosted task dispatch remains disabled. Publication, installed sign-in acceptance, installed account/lifecycle proof, installed worker admission acceptance, plan-use qualification, controlled dispatch and the allowance comparison remain open. | [#2955](https://github.com/o8-run/o8/issues/2955) |
| Symon correctness and reliability | Existing desktop and phone flows have a recorded correctness and reliability review. Confirmed failures become bounded issues; resulting fixes are verified through their real entry points and shipped. | open | The review is queued after the repair batch. | [#2534](https://github.com/o8-run/o8/issues/2534) |

ACP reply and mobile continuation repair [#2473](https://github.com/o8-run/o8/issues/2473) records an explicit incomplete-reply marker after tool activity without starting a retry. Phone continuations retain recorded thread choices and report the observed model; display-only defaults never become model pins. Controlled ACP and WebSocket fixtures cover continuation, interruption, duplicate sends, persisted attribution and mode instructions. Local source verification and independent review passed; PR CI, live phone/provider acceptance and release remain separate.

## 5. Smooth for people and for agents

Sign-in error disclosure [#3441](https://github.com/o8-run/o8/issues/3441) binds each expanded reason to its own control and keeps retry actions distinct from disclosure state. Mounted component regressions cover independent cards, collapse/reopen, retry and dismissal. Native assistive-technology acceptance and release remain separate.

Account resolution [#3762](https://github.com/o8-run/o8/issues/3762) bounds unresolved loading, hides unconfirmed profile details, and offers native account initialization recovery without confirming sign-out or losing the app transport guard.

Account recovery [#3990](https://github.com/o8-run/o8/issues/3990) keeps the workspace mounted when initialization settles, preserving the open view and unsent input. Native timeout and recovery acceptance remains separate from source checks and release.

Settings shell [#3958](https://github.com/o8-run/o8/issues/3958) keeps its shared header transparent while the content body retains its active palette. Development verification and release remain separate.

Composer worker status [#3953](https://github.com/o8-run/o8/issues/3953) uses one compact count at the composer edge. The existing popup keeps worker identities, states, pane navigation and activity receipts; the transcript no longer duplicates the live group. Recorded membership determines the count, and completed work does not imply a merge. Development verification and release remain separate.

Project-led navigation [#3957](https://github.com/o8-run/o8/issues/3957) places the existing assistant action under Home and starts the chat rail with projects. Empty project and conversation views expose the existing creation actions after loading. Viewing the rail does not launch work. Development verification and release remain separate.

Chat section disclosure [#3954](https://github.com/o8-run/o8/issues/3954) places chevrons after section labels and reveals them on hover or keyboard focus. The shared header keeps label geometry, toggle state and neighboring actions stable. Development verification and release remain separate.

Terminal appearance [#3949](https://github.com/o8-run/o8/issues/3949) applies the active palette before canvas consumers read it. Existing workspace and contextual terminals keep their output and attachment through light, dark and All Glass changes; glass keeps the shared translucent backdrop. Development checks, native acceptance, reviewed merge and release remain separate.

Right-panel terminal recovery [#3115](https://github.com/o8-run/o8/issues/3115) offers an explicit route to the main workspace when its local bridge is unavailable. Recovery focuses an existing matching shell before creating one, preserves other tabs, and keeps failures actionable. Development checks, reviewed merge and release remain separate.

Ended terminal output [#3128](https://github.com/o8-run/o8/issues/3128) remains readable with an explicit new-shell action and bounded saved text. Tmux teardown preserves the last useful screen; a transport client status is never presented as the shell's exit code. Process-level exit evidence, native development checks, reviewed merge and release remain separate.

Bottom-terminal continuity [#3129](https://github.com/o8-run/o8/issues/3129) treats X and the panel shortcut as visibility changes. The existing tile, shell, output and split ratio remain in place across hide/show, with the main workspace preserved. Development checks, reviewed merge and release remain separate.

Terminal replay [#2844](https://github.com/o8-run/o8/issues/2844) retains historical-output provenance through workspace handles and hidden buffers. Saved terminal queries render without sending their answers into the shell; fresh CLI queries and typed input remain enabled. A WebSocket-to-panel regression covers the reproduced reattach leak. Native acceptance, reviewed merge and released-build acceptance remain separate.

Worker corrections [#3930](https://github.com/o8-run/o8/issues/3930) reuse the regular composer and real worker cards. A compact control appears when workers or a recoverable request exist; activity receipts and session merge restrictions stay behind explicit disclosure. The dock and transcript coordinate their expanded card, while All Glass uses the shared floating material outside clipped workspace panels. Focused checks and native development verification cover disclosure, drafts, activity and glass; publication remains a separate release gate.

Caret-local dictation feedback [#3927](https://github.com/o8-run/o8/issues/3927) keeps listening, measured waveform, processing and the delivered text in the existing text modal. Plain Fn does not duplicate those phases in the top dock. Voice windows initialize for attached development shells as well as bundled launches. The shared Symon mark has standalone color fallbacks; measured waveform sensitivity matches the dock without resetting on text partials, and the polishing stroke moves until delivery. The resting top pill defaults off, with a saved Voice setting and a global Command-Option-Comma shortcut to Voice Settings. Session fencing prevents duplicate completion and older events from reopening the modal. Focused route verification, native acceptance, review, merge and release remain separate gates.

Caret-local dictation placement [#3931](https://github.com/o8-run/o8/issues/3931) keeps feedback with the focused input across displays, using native desktop logical points without scaling global monitor origins. A missing caret falls back to the focused application window, then the pointer display. The separately selected legacy HUD keeps its existing placement. Geometry regressions, native multi-display acceptance, review, merge and release remain separate gates.

Per-task worker selection [#3889](https://github.com/o8-run/o8/issues/3889) lets the orchestrator discover the configured worker pool and choose a runtime, model and effort for each task. Explicit choices are validated before launch and retained in shared or isolated worker receipts. The composer keeps lead controls, while worker eligibility stays in Settings. Native execution confirmed both an explicit choice and an automatic choice against provider records, with unchanged settings and same-session card reopening. Mixed-runtime routing is covered at the API/MCP boundary; native acceptance used the enabled pool. Review, merge, installed acceptance and release remain separate.

Live worker chat navigation [#3881](https://github.com/o8-run/o8/issues/3881) opens an existing delegated worker beside its parent using the shared session surface and independent shared composers. Card clicks only navigate; stale or unrelated parent membership cannot launch work. Native follow-up, same-session hide/reopen, reload, and matching composer geometry passed. Successful sends add no receipt row. TypeScript, 39 focused checks and the frozen combined-checkout hermetic gate (7,065 passed, 4 skipped) passed; PR review, merge, installed acceptance and release remain separate.

Shared-team reconciliation [#3896](https://github.com/o8-run/o8/issues/3896) lets the owning lead review an exact checkout state before releasing a settled team. Independent edits and original baseline receipts are preserved. Active workers, stale review, omitted paths, uncommitted worker edits and unsupported nested repositories remain blocked. Public lifecycle tests cover persisted review, reconnect and unchanged source; source review, merge and release remain separate.

Two lanes, one pillar. The people lane covers the surfaces a person works in. The agents lane covers whether another program can drive o8 through a real interface instead of imitating a mouse.

The compact transcript subagent card and explicit default-worker picker [#3869](https://github.com/o8-run/o8/issues/3869) reuse existing participant identities, workspace navigation and runtime dispatch. Focused component and dispatch-entry tests and light/dark development previews passed. Required PR checks and released-build acceptance remain separate gates; no new automatic runtime-selection policy is introduced.

Current workspace polish is verified in development and awaiting integration: Ports layering [#3842](https://github.com/o8-run/o8/issues/3842), empty-header window dragging [#3843](https://github.com/o8-run/o8/issues/3843), adaptive project repository navigation [#3844](https://github.com/o8-run/o8/issues/3844), stable usage hover [#3845](https://github.com/o8-run/o8/issues/3845), and worker-local review controls [#3846](https://github.com/o8-run/o8/issues/3846). Native window and webview checks passed; required PR checks and released-build acceptance remain separate gates.

The development workspace rehearsal [#3876](https://github.com/o8-run/o8/issues/3876) demonstrates exact subagent navigation, default versus task-specific worker selection, and review state using local fixtures. Native wide and compact interaction checks passed; the demo launches no workers and preserves the live chat when closed. Follow-up [#3878](https://github.com/o8-run/o8/issues/3878) places the rehearsal in the shared chat renderer with registry-backed worker examples and the sidebar status indicator; a merge label requires a recorded merge receipt.

Shared GitHub quota and durable PR watching are implemented in [#3606](https://github.com/o8-run/o8/pull/3606), and commit-pinned review guides in [#3607](https://github.com/o8-run/o8/pull/3607). Paused queue restoration, acknowledged delivery, draft recovery, repository-scoped attachments and narrow-layout corrections are tracked in [#3598](https://github.com/o8-run/o8/issues/3598). Browser and route fixtures cover reload, dismissal, repeat actions and uncertain receipts. Queued intent never replays automatically after reload; released-build acceptance remains open.

Workspace GitHub refresh [#4018](https://github.com/o8-run/o8/issues/4018) separates remote PR and linked-issue reads from local Git refreshes. Controlled route replay covers repeated and concurrent refreshes, cooldown recovery, cached-age warnings and effective CLI credential changes. The broader shared refresh policy [#3460](https://github.com/o8-run/o8/issues/3460) remains open. Local source checks and independent review passed; PR CI, native acceptance and release remain separate.

| Arc | Lane | Done means | State | Gap | Where |
| --- | --- | --- | --- | --- | --- |
| First ten minutes | people | A stranger goes from download to a first merged packet, and the minutes and the stalls are measured. | open | Measured once, from source: 6.8 minutes and nine stalls. The eight frictions from that run shipped in 0.1.750. The download path is unmeasured, and no second run confirms the fixes. | [#2211](https://github.com/o8-run/o8/issues/2211) |
| Design Mode loop | people | "Change this button" is one bounded loop with a before-and-after proof card. | open | Screenshot crop timing is not measured through the supported capture path. | [#1695](https://github.com/o8-run/o8/issues/1695) |
| Bounded peer conversations | people, agents | The operator sees named participants in split transcripts and a repo-scoped Handoffs pane. Every reply has a verifiable conversation and prior message, and the server stops the exchange at its turn budget or an earlier close. | open | The UI and protocol are merged in source; an isolated preview exercised grouped turns and operator stop/extend. A native installed two-agent exchange and release check remain. | [#2690](https://github.com/o8-run/o8/issues/2690) |
| Agent-facing API manifest | agents | One manifest lists every operator verb and its surfaces, and CI fails when a verb exists on one surface and not another. | open | No manifest exists; parity between the CLI, MCP, and the webview socket is checked by hand. | [#2212](https://github.com/o8-run/o8/issues/2212) |

Tool updates [#3859](https://github.com/o8-run/o8/issues/3859) keep the default action specific to o8, place explicit CLI actions under Tools, and report per-tool progress and verified results. OpenCode checks preserve complete channel versions and the selected package family. Unrecognized installations keep their original updater. Source verification, required PR checks, and released-build acceptance remain separate gates.

The snapshot restart-cycle fixture [#3880](https://github.com/o8-run/o8/issues/3880) now uses explicit ordered receipt timestamps. This removes an accidental dependency on wall-clock monotonicity while preserving the production stale-transition guard and its regression coverage.

Local-server routing [#3125](https://github.com/o8-run/o8/issues/3125) now opens newly announced apps in the existing Browser instead of adding a second terminal viewer. Retained output is marked across WebSocket transports; repeat announcements from a terminal session do not reopen a closed page. Ports exposes an immediate clickable app list. The old inline viewer is retired. Development and regression acceptance are tracked separately from CI and installed releases.

Browser field typing [#3805](https://github.com/o8-run/o8/issues/3805) accepts an empty string to clear a field and preserves leading spaces, trailing spaces and line breaks. Controlled-field event coverage and native development checks are separate from required PR CI and released-build acceptance.

Settings page history [#3853](https://github.com/o8-run/o8/issues/3853), a keyboard-accessible Brain conversation beside the composer [#3854](https://github.com/o8-run/o8/issues/3854), and chat-local sidebar review actions [#3855](https://github.com/o8-run/o8/issues/3855) are implemented in development. Native Settings and Brain checks and focused review-target checks passed. Required PR checks and released-build acceptance remain pending.

Optional tool updates [#3862](https://github.com/o8-run/o8/issues/3862) follow o8 status and release notes. Each tool starts with an Update action and a compatibility notice; custom installations keep their original updater. Qoder is omitted from this update surface. Native development checks and released-build acceptance remain separate gates.

Composer Brain routing [#3863](https://github.com/o8-run/o8/issues/3863) prefers an authenticated native Codex or Claude connection and uses the Terra or Sonnet answer tier. Explicit Codex Brain model choices remain effective. Managed Brain is the fallback when neither supported native connection is ready; other runtime inference adapters remain separate work. Connected conversation retrieval is lexical and does not start paid semantic embedding calls. Native Codex acceptance, fixture coverage and released-build acceptance remain separate gates.

Saved Preview layouts [#3119](https://github.com/o8-run/o8/issues/3119) now offer visible Close preview and Open in Browser actions, preserving the surviving terminal and reclaiming its workspace space. A saved obsolete tile no longer mounts another browser iframe. Development acceptance does not imply publication.

Source-editor recovery [#3122](https://github.com/o8-run/o8/issues/3122) uses bundled editor and language-worker assets, shows readable source while initialization is pending or unavailable, and retries with a fresh loader. Inactive file tabs inherit workspace visibility so an editor cannot paint over a chat. Source/chat switching is verified in development; installed acceptance remains separate.

Semantic control clicks [#3802](https://github.com/o8-run/o8/issues/3802) refuse disabled and inert targets before dispatching input, including nested labels and model rows. Successful receipts identify the actionable ancestor and describe input dispatch rather than claiming a selection changed.

Browser opening [#3803](https://github.com/o8-run/o8/issues/3803) confirms its repository-scoped visible host, requested page URL and native window geometry before reporting opened. Pending requests can be observed by identifier without replay. Initial navigation survives development effect remounts; source and native development evidence do not imply release.

Project library navigation [#3116](https://github.com/o8-run/o8/issues/3116) exposes Open workspace directly beside each project and labels details separately from editing. Development checks cover repeated opening and failure recovery. Required PR checks and released-build acceptance remain separate gates.

Workspace utility navigation [#3133](https://github.com/o8-run/o8/issues/3133) retains the originating tab and tab order, including a fresh unsent conversation. A workspace composer keeps its draft while hidden. Persistence and native development checks remain distinct from released-build acceptance.

Bound cloud thread navigation [#3108](https://github.com/o8-run/o8/issues/3108) uses one Threads control beside the task identity and Refresh. Ordinary project list and detail navigation remain available. Native development acceptance uses simulated task data; it does not establish remote execution acceptance.

Saved repository recovery [#3870](https://github.com/o8-run/o8/issues/3870) can restore a validated registered-repository path without waiting for a worktree scan. External paths still require exact authoritative membership, and stale inventory cannot overwrite a newer removal. Native recovery and automated evidence remain separate from release inclusion.

Browser tab closure [#3909](https://github.com/o8-run/o8/issues/3909) exposes a named close action for active and hovered tabs. Rendered checks cover two- and five-tab layouts, surviving tab order and persisted selection. Attached development confirms the named empty-tab action and restored empty scope; release acceptance remains separate.

Fresh-session receipts [#3804](https://github.com/o8-run/o8/issues/3804) publish completion only after exact mounted-tab and post-focus verification. Unverified creation expires to an explicit unknown result without replay, and terminal or newer receipts remain intact. Real-root creation and surface-state regressions are verified; native and packaged acceptance remain separate gates.

Native Browser reload [#3801](https://github.com/o8-run/o8/issues/3801) reloads the current document instead of navigating to its existing address. Attached development verifies fresh HTML and module code after a cached-module update, while the tab identity and selection remain stable. Packaged acceptance and release remain separate.

Browser overlay detection [#3799](https://github.com/o8-run/o8/issues/3799) accounts for effective ancestor opacity before hiding the native child. Transparent cached portals do not count as painted covers; visible covers and explicit occlusion still hide and restore the child. Controlled development reproduction and rendered regressions are recorded separately from remaining native visual acceptance.

Fresh-session dialog guards [#3916](https://github.com/o8-run/o8/issues/3916) ignore invisible cached portals at the app-owned creation boundary while visible dialogs still refuse creation. Real-root tests cover direct requests, late visibility changes and multiple dialogs without weakening identity or inventory checks.

Built-in command activity [#3553](https://github.com/o8-run/o8/issues/3553) names the command requested by run/help tools in running and expanded transcript rows. Mounted component regressions cover streamed arguments, namespaced tool names and the original detail panel. Local source checks are separate from installed acceptance and release.

## 6. Runs where you are

o8 should be light on the machine it runs on, and it should run on the machine you have.

| Arc | Done means | State | Gap | Where |
| --- | --- | --- | --- | --- |
| Linux | A fresh Ubuntu machine installs o8, launches it, dispatches a packet, and merges it through the governed path. | parked | Maintainer VM validation is paused; install-to-merge proof remains outstanding. | [#1672](https://github.com/o8-run/o8/issues/1672) |
| Windows | The same as Linux, on Windows. | parked | Maintainer VM validation is paused; install-to-merge proof remains outstanding. | [#2204](https://github.com/o8-run/o8/issues/2204) |
| Speed and idle-work pass | Interaction budgets hold under real load, not only at idle. | open | Conversation switching and long histories slow down under streaming load. | [#2202](https://github.com/o8-run/o8/issues/2202) |
| Packaged release size | Reduce exported dependencies toward the 250 MiB app and 75 MiB update targets. | open | Shared package ceilings remain 350/100 MiB. CPU-specific preparation is in development under #3646. Intel delivery stays off until Intel acceptance; Apple Silicon keeps universal delivery pending #3656. | [#3545](https://github.com/o8-run/o8/issues/3545) |
| Signed bundle immutability | Ordinary cache reads and updates leave the installed app's signed files intact. | open | The correction is published in 0.1.794 and real cache regressions pass; installed signature checks after GUI use and relaunch remain pending. | [#3619](https://github.com/o8-run/o8/issues/3619) |
| Provider and workflow release | Publish the reviewed provider, review and conversation changes. | shipped | 0.1.794 is signed and notarized; public downloads and updater signature are verified. Installed acceptance is tracked separately. | [#3613](https://github.com/o8-run/o8/issues/3613) |
| Storage admission and reclaim | o8 never blocks a dispatch it could have serviced, and never fills the disk. | open | Admission uses one flat free-space reserve instead of the job's size; a stale dashboard write can replay a prior hold or queued packet after recovery. | [#2203](https://github.com/o8-run/o8/issues/2203) |
| Release channels and build integrity | Preview and stable are separable, and a build is reproducible from a tag. | open | Preview enrollment with an isolated app identity and data does not exist. The production web build also fails to resolve the shared settlement module; its source fix and build proof are tracked in #3268. | [#2205](https://github.com/o8-run/o8/issues/2205) |

Windows is help wanted. Maintainer VM validation is paused; a contributor can take a bounded child with the required proof. The port audit is written, with file-and-line evidence, in `docs/internals/port-audit-windows.md`.

## 7. Ahead

Longer-term bets, ordered by evidence and dependencies rather than a calendar year. Each row is an outcome we think operators will need, what already exists in o8 toward it, and the next child that would move it. A shipped child moves only the part it proves; a bounded outcome can move into an active pillar with an owner and an explicit proof. Basic remote project operation now has that scope in pillar 4. Rows are reviewed at the start of each month; a bet nobody has touched in a quarter gets cut, not carried.

| Bet | What already exists | Next child | Where |
| --- | --- | --- | --- |
| Portable execution across worker fleets. Placement policy, warm environments, suspension, and migration preserve the packet and merge gate. | Headless o8, the mobile relay, crash survival, the durable execution spine; a bounded remote-project milestone is active in pillar 4. | A portable worker environment profile, composed with cross-device continuity, extends the first remote proof to more environments. | [#1690](https://github.com/o8-run/o8/issues/1690), [#1727](https://github.com/o8-run/o8/issues/1727) |
| The right model for each packet, chosen and escalated by o8. A failed packet retries on a stronger tier without the operator choosing. | The carrier registry, per-packet model pins, the merge-failure escalation chain. | A worker escalation ladder that retries a failed packet on the next tier, with bounded attempts, the effective model visible, and a refusal instead of a silent fallback when the requested tier is unavailable. | [#2209](https://github.com/o8-run/o8/issues/2209) |
| Proof that travels. Receipts and control that systems outside o8 can verify and plug into, so o8 is the human gate inside other people's agent graphs. | Signed packet receipts and truth queries, the ACP orchestrator backend, MCP on both sides. | A receipt format another organization can verify without an o8 install, and a mission exported as an observed agent graph that an outside validator accepts. | [#1997](https://github.com/o8-run/o8/issues/1997), [#1998](https://github.com/o8-run/o8/issues/1998), [#2230](https://github.com/o8-run/o8/issues/2230) |
| Nothing leaves the machine unless you say so. Local and on-device models as a real mode with a test that proves it. | Local endpoint probes, the local chat tier for the Brain, an audit of surfaces without a local path. | A named egress baseline across a full packet lifecycle, listing every contacted host and surface, as the first narrow proof; remediation stays with the parked all-surfaces epic. | [#2228](https://github.com/o8-run/o8/issues/2228), [#1451](https://github.com/o8-run/o8/issues/1451) |
| Two operators, one approval path. Teams share a workspace without weakening who can approve what. | Principal-based authorization for operator, worker, and remote callers. | A workspace identity and role model. | [#1875](https://github.com/o8-run/o8/issues/1875) |
| Agents that use the screen, not only the repo. A packet can drive a browser or a GUI with the same isolation, review, and receipt. | The embedded browser agent and its governed verbs. | Computer-use as a worker capability behind the packet contract. | not yet filed |

## Shipped

- **0.1.771:** project-first onboarding, permission success and restart recovery, agent-assisted setup, and the shared workspace integration ([#2817](https://github.com/o8-run/o8/issues/2817)). Existing-chat project changes persist before send; completed workers update without reload. Signed public artifacts and installed first-run restart passed. Broader worker and terminal acceptance remains in its open trackers.

Arcs whose every child is closed and released. They stay here so the pillars read as a whole, and they get no tracking issue.

- **Governance:** merge-gate truth (0.1.738); dispatch honesty (0.1.749); signed receipts and truth queries (0.1.722); Broadcast, the audit trail as a live feed (0.1.717).
- **Organizational memory:** Engineering Brain question and answer ([#915](https://github.com/o8-run/o8/issues/915)); workers write back to memory (0.1.716); automatic title state preserved across history saves ([#2530](https://github.com/o8-run/o8/issues/2530), 0.1.764); spec review inversion, where the operator owns the rules and agents only annotate.
- **Runs on your subscriptions:** OpenCode 2 and ACP, a non-subscription CLI as worker and orchestrator backend (0.1.750); execution carriers (0.1.748); declarative runtimes (0.1.725).
- **One control plane, every surface:** headless o8 (0.1.727); mobile as an operator surface ([#1074](https://github.com/o8-run/o8/issues/1074)); voice as an operator surface, with the planning seat as a registry choice (0.1.748).
- **Smooth for people and for agents:** canvas IDE parity, carved scope ([#1664](https://github.com/o8-run/o8/issues/1664), 0.1.722); rich Markdown editor (0.1.722); interaction budgets (0.1.748); control surfaces instead of scraping (0.1.749); CLI and MCP symmetry (0.1.738); Composer selector ([#2314](https://github.com/o8-run/o8/issues/2314), 0.1.753). The separate effort-compatibility audit remains open.
- **Runs where you are:** Mac hardening, a populated daily profile through an unchanged native idle gate (0.1.748).

## Claiming work

Start from a tracking issue above, open its checklist, and pick an unchecked child labeled `claimable`. Comment "claiming" on that child. A maintainer flips it to `claimed`, which expires after seven days with no linked pull request. The full protocol, including what a pull request needs before review, is in [CONTRIBUTING.md](./CONTRIBUTING.md#claiming-work).

## Not on this map

Bug fixes, chores, security advisories, and dependency work are tracked as plain issues, not as roadmap arcs.

Composer controls [#3961](https://github.com/o8-run/o8/issues/3961) use compact named access and checkout icons. Compatible new chats default to Shared; workers are delegated when requested or useful, with Worktrees available explicitly. Saved no-delegation choices and forced-single surfaces stay restricted. Permissions, capability checks and historical wire parsing remain authoritative. Development verification and release remain separate.

Conversation worker hover [#3967](https://github.com/o8-run/o8/issues/3967) reuses the existing chat preview for recorded shared and worktree workers. Identity and status remain scoped to the hovered parent; development verification and release remain separate.

Activity refresh [#3460](https://github.com/o8-run/o8/issues/3460) excludes transcript-only realtime batches from remote repository list invalidation. Mixed batches, lifecycle refresh and the existing fallback remain active. Broader cache policy, native acceptance and release remain separate.

<!-- issue3131-activity-reliability -->
Activity folder-state follow-up (#3131): selected local folders retain their scope, local Git failures stay visible beside remote history, and Retry rechecks the same folder. Review/Workspace existing remedies are preserved. Source verification and native acceptance remain separate; no release is included.
