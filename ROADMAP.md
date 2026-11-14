# o8 roadmap

o8 is the review and merge layer for coding agents. Write code in the tool you like: T3 Code, Codex, Claude Code, Cursor, or your own editor. o8 takes that work in and has an independent agent, ideally a different model, review the real diff. It sends the findings back to the author, re-reviews the fix, and merges the approved commit with a receipt. The operator sees only the decisions that need a person. o8 runs on one machine, usually the biggest one a person has, and takes in work from every tool and machine they already use. o8 is free and open source. You bring the coding-agent subscriptions or API keys you already have.

Direction set on 2026-11-10. o8 no longer competes as the app where code gets written. The o8 next window stays, re-aimed at work flowing in and the reviewers' transcripts. Work that served the earlier "agent app" framing is listed under [Parked](#parked).

Last updated 2026-11-10. If this date is more than 14 days old, treat every number below as stale and recompute it with the commands in [Live status](#live-status).

## For agents: read this first

This file exists so an agent can answer an operator's questions about where o8 is going without guessing. Use it this way:

1. **Recompute before you quote.** Each number in [Live status](#live-status) has the command that produces it. Run that command, report the result, and give the date you ran it.
2. **Say which priority a request falls under.** Map an operator's request to a [Now](#now) item by its issue number. If nothing in Now covers it, say so. Being in a pillar table is not permission to start the work.
3. **Keep these states distinct:** merged on `main`, in a beta build, released as stable, and verified on an installed app. Never call merged source "shipped".
4. **Stay out of the security lane.** Anything touching worker sandboxing, credentials or keychain storage, auth or tokens, network binding, encryption, or content redaction belongs to the security maintainers. Do not review, fix or dispatch it; point the operator to the issue instead.
5. **Claim before you build.** Search open pull requests for `Fixes #<n>` first, then follow [Claiming work](#claiming-work).

Questions an operator usually asks, and where the answer is:

| Question | Answer from |
| --- | --- |
| What version should I run? | [Live status](#live-status): stable and beta |
| What's being built right now? | [Now](#now) |
| When does the next release ship? | No date. A release ships when the [release gate](#release-gate) passes. |
| Does o8 run on Linux or Windows? | [Platforms](#platforms) |
| Can I help? | [Claiming work](#claiming-work) |
| What is o8 for now? | The top of this file, then [Now](#now) |
| Why isn't X in o8 next yet? | [#5576](https://github.com/o8-run/o8/issues/5576) for right-panel tools, [#5358](https://github.com/o8-run/o8/issues/5358) for Settings |

## Live status

Snapshot from 2026-11-10. Rerun the command for the current value.

| Measure | Snapshot | Command |
| --- | --- | --- |
| Stable release | 0.1.818 (2026-11-10) | `gh release list --repo hurttlocker/o8-releases --limit 5` |
| Commits on `main` since stable | 7 | `git rev-list --count v0.1.818..origin/main` |
| Review and merge loop progress | see command | `node scripts/roadmap-status.mjs` (tracking issue #5815) |
| Open issues | 121 | `gh issue list --repo o8-run/o8 --state open --limit 1000 --json number -q length` |
| Tracking issues and checklist progress | see command | `node scripts/roadmap-status.mjs` |

## Now

Ranked. Work on a lower item does not delay a higher one.

1. **The review and merge loop.** Work from any author moves through intake, independent review, findings sent to the author, re-review of the fix, and a governed merge of the approved commit, with durable receipts. Tracked in [#5815](https://github.com/o8-run/o8/issues/5815).
   - Done, unreleased: findings go to the original author ([#5828](https://github.com/o8-run/o8/pull/5828), [#5833](https://github.com/o8-run/o8/pull/5833), proven with a real worker), submitted reviews show with their reviewed commit ([#5825](https://github.com/o8-run/o8/pull/5825)), an author's correction is re-reviewed against the saved findings ([#5840](https://github.com/o8-run/o8/pull/5840)), and an external pull request is adopted into one review task ([#6070](https://github.com/o8-run/o8/pull/6070)).
   - Next, in order:
     1. merge the approved commit through one governed operation ([#5817](https://github.com/o8-run/o8/issues/5817));
     2. a project automation policy, set once and shown before work runs, which lets o8 merge on its own within explicit rules ([#5822](https://github.com/o8-run/o8/issues/5822));
     3. reviewers learn from verified past outcomes ([#5823](https://github.com/o8-run/o8/issues/5823)).
   - The goal is autonomous: o8 reviews, corrects and merges what the user intended, and asks a person only when a rule says so.
2. **Governance and security.** The reason to trust the loop. No lane stalls silently ([#2197](https://github.com/o8-run/o8/issues/2197)), and a worker cannot reach anything its packet does not grant ([#2198](https://github.com/o8-run/o8/issues/2198), security lane).
3. **Other tools plug in.** Work written in another tool enters review without copy and paste. Its author sees verdicts and findings natively inside that tool, so nobody switches apps. o8's MCP server and CLI carry them ([#5841](https://github.com/o8-run/o8/issues/5841)).
4. **The window shows the review.** o8 next keeps every surface it has. The sidebar lists work flowing in, and a selected item shows the reviewer's transcript. Reviewers can still spawn workers ([#5842](https://github.com/o8-run/o8/issues/5842)).
   - In progress: a native Review scorecard beside Activity, with durable outcome figures and change lists ([#5879](https://github.com/o8-run/o8/issues/5879)).
5. **Linux as a home for o8.** The machine that hosts o8 is often a Linux server. A fresh Ubuntu machine goes from install to a merged review ([#1672](https://github.com/o8-run/o8/issues/1672)).
6. **Finish the Rust server port.** It is close to done, so it gets finished rather than left half moved. The remaining o8 next API paths move from the web server to the native daemon, one pull request per surface, with login rules unchanged ([#5243](https://github.com/o8-run/o8/issues/5243); plan in [#5422](https://github.com/o8-run/o8/issues/5422)). The classic web pages that nothing still loads are archived after it.
7. **Next release.** What has merged since 0.1.818 ships together once the [release gate](#release-gate) passes. The integration suite on `main` must be green first ([#5317](https://github.com/o8-run/o8/issues/5317)). Releases go through beta, then stable ([#2205](https://github.com/o8-run/o8/issues/2205)).

### Release gate

A release ships only when all of these hold:

- the full integration suite is green on `main`;
- the release is built from a clean checkout at its tag;
- the signed and notarized artifact passes the release smoke test;
- it has been on the beta channel before stable;
- the maintainer gives a go.

There is no nightly channel: beta is the preview.

## Next up

Not started. Ranked by how much they help the review loop. File an issue before starting one.

| Idea | Why it matters | Status |
| --- | --- | --- |
| One working, blocked or idle state on every reviewer and author, with "needs your answer" raised to the top | The operator should never hunt for the stuck review | not filed |
| Review several repositories of one project side by side | Projects already span repos; review should too | not filed |
| Images returned by tools render in the transcript | Screenshots from preview and MCP tools are review evidence | not filed |
| Agents ask for credentials through a dedicated request, never in chat | Keeps secrets out of transcripts. Security lane | not filed |

## Parked

Parked on 2026-11-10 when o8 became the review layer. These may not be needed. Nothing here is removed from the app; parked means no new work starts.

| Work | Why parked | Where |
| --- | --- | --- |
| o8 next parity set (#5246–#5310) and classic right-panel parity | These existed for o8 as the coding app; review surfaces are re-aimed under Now item 4 instead | [#5576](https://github.com/o8-run/o8/issues/5576), [#5358](https://github.com/o8-run/o8/issues/5358) |
| o8 on the phone: the phone PR tab, route failover, free relay access, relay encryption | One less surface for now. The goal is review that fixes and merges what the user intended, so fewer approvals reach a person. If o8 gains traction, phone review comes back | [#2445](https://github.com/o8-run/o8/issues/2445), [#5299](https://github.com/o8-run/o8/issues/5299), [#5787](https://github.com/o8-run/o8/issues/5787) |
| First ten minutes measurement | Remeasure after the review loop is the main path | [#2211](https://github.com/o8-run/o8/issues/2211) |
| Agent-app ideas: resume after a usage reset, model lists read from the CLI, generated-text model choice, importing outside sessions, optional update delay | The coding tools own these | not filed |

## Pillars

These pillars are what o8 is. The top three, set on 2026-11-10, are review and merge, governance and security, and plugging into every tool. They lead [Now](#now). The rest keep the app healthy. Each open arc links one tracking issue, and that issue's checklist is the real progress. A box is checked when the child issue is closed and its fix is in a shipped release.

**State:**
- `active`: work is in flight now;
- `open`: known gaps, not in Now;
- `parked`: we know what it would take and are not doing it.

| Pillar | Arc | Done means | State | Where |
| --- | --- | --- | --- | --- |
| Review and merge | Agent review and integration without manual handoffs | Work from any author moves through intake, independent review, correction and governed merge with durable evidence | active | [#5815](https://github.com/o8-run/o8/issues/5815) |
| Plugs into every tool | Other tools plug into o8 review and merge | Work from any coding tool enters review, and its author sees verdicts and findings natively inside that tool, with no app switching | active | [#5841](https://github.com/o8-run/o8/issues/5841) |
| Governance | Lane lifecycle and recovery honesty | No lane stalls silently; every terminal state is reachable from the UI and the CLI | open | [#2197](https://github.com/o8-run/o8/issues/2197) |
| Governance | Worker capability boundaries | A worker cannot read or reach anything its packet does not grant. Security lane | open | [#2198](https://github.com/o8-run/o8/issues/2198) |
| Governance | Orchestrator prompt matches its turn | The prompt a turn runs with is the prompt it was built for | open | [#2903](https://github.com/o8-run/o8/issues/2903) |
| Governance | Reliable agent workflows | Local reliability burn-down | open | [#3190](https://github.com/o8-run/o8/issues/3190) |
| Subscriptions | Carrier coverage and auth probes | A new agent CLI lands as a registry entry plus a readiness probe, with no fork in dispatch | open | [#2200](https://github.com/o8-run/o8/issues/2200) |
| Subscriptions | Local models first-class | Every surface names its local provider, and a test proves no egress for a full packet | parked | [#1451](https://github.com/o8-run/o8/issues/1451) |
| Subscriptions | Conversation orchestration through a chat plan | Plan and follow CLI work with explicit account and usage boundaries | parked | [#2955](https://github.com/o8-run/o8/issues/2955) |
| Every surface | Settings take effect everywhere | Change a setting once; every surface uses it on its next action | open | [#2217](https://github.com/o8-run/o8/issues/2217) |
| Every surface | Live terminals as a workspace surface | A tmux or vim session survives an update and a pane switch byte for byte | parked | [#1723](https://github.com/o8-run/o8/issues/1723) |
| Every surface | Symon correctness and reliability | Desktop and phone voice flows reviewed; confirmed failures fixed through real entry points | parked | [#2534](https://github.com/o8-run/o8/issues/2534) |
| Every surface | Durable Symon on the built-in agent | Symon survives restarts across app, phone and messages | parked | [#3456](https://github.com/o8-run/o8/issues/3456) |
| Every surface | Faster operator decisions on the phone | Mobile surfaces ordered by what needs the operator first | parked | [#2445](https://github.com/o8-run/o8/issues/2445) |
| People and agents | Design Mode loop | "Change this button" is one bounded loop with a before-and-after proof | parked | [#1695](https://github.com/o8-run/o8/issues/1695) |
| Runs where you are | Speed and idle work | Interaction budgets hold under real load, not only at idle | open | [#2202](https://github.com/o8-run/o8/issues/2202) |
| Runs where you are | Storage admission and reclaim | o8 never blocks a dispatch it could service and never fills the disk | open | [#2203](https://github.com/o8-run/o8/issues/2203) |
| Runs where you are | Release channels and build integrity | Beta and stable are separable; a build reproduces from its tag | active | [#2205](https://github.com/o8-run/o8/issues/2205) |

### Platforms

| Platform | State | Detail |
| --- | --- | --- |
| macOS | supported | One universal build (x86_64 and arm64), signed and notarized; o8 next is the only window since 0.1.815. It runs installed on Intel every day; an installed run on physical Apple Silicon is still unverified |
| Linux (Ubuntu) | active, Now item 5 | The likely home for o8 on a server. The o8 next GPUI app and packages are in progress; install-to-merge proof is open in [#1672](https://github.com/o8-run/o8/issues/1672) |
| Windows | active | An x64 preview of the older shell (0.1.664) is on Releases. o8 next now builds and starts on Windows x64 in CI ([#5649](https://github.com/o8-run/o8/pull/5649)); a signed installer and auto-update are next. Port audit in `docs/internals/port-audit-windows.md`; tracked in [#2204](https://github.com/o8-run/o8/issues/2204) |

### Speed targets

The o8 next window keeps these targets. The Rust server port is finishing under [Now](#now) item 6; no other speed work is planned:
- launch in under 1 s;
- a worker running in under 10 s;
- a frame painted in under 8 ms.

Idle memory gets measured once the Rust server port lands.

## Shipped

Per-change detail lives in the [release notes](https://github.com/hurttlocker/o8-releases/releases) and the git history. This list names only the milestones.

- **0.1.818 (2026-11-10):** the o8 next Inbox sidebar and the right-panel tool list.
- **0.1.815 (2026-10-30):** o8 next becomes the only Mac window.
- **0.1.811:** usage analytics with first-run disclosure and opt-out.
- **0.1.798:** workspace frame, composer and worker displays, dictation ownership.
- **0.1.771:** project-first onboarding, agent-assisted setup, shared-checkout teams.
- **0.1.750 and earlier:** merge-gate truth, dispatch honesty, signed receipts and truth queries, headless o8, mobile and voice as operator surfaces, OpenCode and ACP runtimes, CLI and MCP symmetry.

## Claiming work

Start from a tracking issue in [Now](#now) or [Pillars](#pillars). Open its checklist and pick an unchecked child labeled `claimable`. Comment "claiming" on that child. A maintainer flips it to `claimed`, which expires after seven days with no linked pull request. The full protocol, including what a pull request needs before review, is in [CONTRIBUTING.md](./CONTRIBUTING.md#claiming-work).

## Not on this map

Bug fixes, chores, security advisories and dependency updates are tracked as plain issues, not as roadmap arcs.

`node scripts/roadmap-status.mjs --check` fails in two cases: a checked child issue is still open, or a link in [Now](#now) points at a closed issue. CI runs it on pushes to `main`, on the Sunday schedule and on manual dispatch.
