# o8 roadmap

o8 lets one operator run several coding agents at once. Work becomes missions and packets. Each packet runs in its own worktree, the operator stays in the approval path, and every step leaves evidence. o8 is free and open source. You bring the coding-agent subscriptions or API keys you already have.

Last updated 2026-11-04. If this date is more than 14 days old, treat every number below as stale and recompute it with the commands in [Live status](#live-status).

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
| Why isn't X in o8 next yet? | [#5576](https://github.com/o8-run/o8/issues/5576) for right-panel tools, [#5358](https://github.com/o8-run/o8/issues/5358) for Settings |

## Live status

Snapshot from 2026-11-04. Rerun the command for the current value.

| Measure | Snapshot | Command |
| --- | --- | --- |
| Stable release | 0.1.815 (2026-10-30), o8 next is the only Mac window | `gh release list --repo hurttlocker/o8-releases --limit 5` |
| Commits on `main` since stable | 193 | `git rev-list --count v0.1.815..origin/main` |
| o8 next parity set closed | 31 of 65 (issues #5246–#5310) | `gh issue list --repo o8-run/o8 --state closed --limit 400 --json number -q '[.[].number\|select(.>=5246 and .<=5310)]\|length'` |
| API paths still needing the Next server | 34 | count `NEXT_ONLY_NATIVE_PATHS` in `tests/o8d-native-route-inventory-real-path.test.ts` on `main` |
| Open issues | about 370 | `gh issue list --repo o8-run/o8 --state open --limit 1000 --json number -q length` |
| Tracking issues and checklist progress | see command | `node scripts/roadmap-status.mjs` |

## Now

Ranked. Work on a lower item does not delay a higher one.

1. **Next release: a complete upgrade over 0.1.815.** Everything merged since 0.1.815 goes out together, once the [release gate](#release-gate) passes. The integration suite on `main` must be green first ([#5317](https://github.com/o8-run/o8/issues/5317)). The classic UI's files leave the packaged app ([#5161](https://github.com/o8-run/o8/issues/5161)). Release goes through the beta channel, then stable ([#2205](https://github.com/o8-run/o8/issues/2205)).
2. **Every classic tool works in o8 next.** Review, Activity, Side chat, Targeting and Inbox reach classic parity in the right panel. Threads stays hidden for now. Tracked in [#5576](https://github.com/o8-run/o8/issues/5576), and Settings parity is [#5358](https://github.com/o8-run/o8/issues/5358).
3. **o8 next backend in Rust.** Target: o8 next runs with the Next server stopped by default, and idle memory is measured on Mac and Linux. Phase A moves the remaining API paths to the native transport, and the count in Live status goes to 0. Plan and slice map: [#5422](https://github.com/o8-run/o8/issues/5422); path list: [#5243](https://github.com/o8-run/o8/issues/5243).
4. **o8 next parity set.** These are the 65 issues #5246–#5310: thread, composer, sidebar, pull request and settings behaviors. An issue counts as done only when a merged PR closes it with `Fixes #n`. [Open items](https://github.com/o8-run/o8/issues?q=is%3Aissue+is%3Aopen+label%3Ao8-next+sort%3Acreated-asc).
5. **Linux as a first-class platform.** A fresh Ubuntu machine goes from install to a merged packet ([#1672](https://github.com/o8-run/o8/issues/1672)).
6. **Your machines, one window.** Per-session machine choice over SSH, Tailscale or Cloudflare, with load-aware routing and remote tools ([#5091](https://github.com/o8-run/o8/issues/5091)).
7. **First ten minutes.** Measure a stranger going from download to a first merged packet: minutes and stalls ([#2211](https://github.com/o8-run/o8/issues/2211)). The last measured baseline, from source, was 6.8 minutes with nine stalls.

### Release gate

A release ships only when all of these hold:

- the full integration suite is green on `main`;
- the release is built from a clean checkout at its tag;
- the signed and notarized artifact passes the release smoke test;
- it has been on the beta channel before stable;
- the maintainer gives a go.

There is no nightly channel: beta is the preview.

## Next up

Not started. These are ranked by how much they help an operator day to day. File an issue before starting one.

| Idea | Why it matters | Status |
| --- | --- | --- |
| Resume a thread automatically when a usage limit resets (opt-in) | Long work stops dead at a subscription limit and waits for a human | not filed |
| One working / blocked / idle state on every agent, across machines, with "needs your answer" raised to the top | The operator should never hunt for the stuck agent | not filed |
| Read model lists from the installed CLI instead of a fixed catalog | New models appear without an o8 release | not filed |
| Choose the model and effort for generated text: commit messages, PR descriptions, branch names, titles | Cheap text should not run on the most expensive model | not filed |
| Review several repositories of one project side by side | Projects already span repos; review should too | not filed |
| Import sessions started outside o8 for every runtime | Codex threads resume today; Claude Code and others should too | not filed |
| Phone review: commits, file jumps, PR review comments | Approve from the phone with the code in view | not filed |
| Optional update delay | Operators in the middle of work choose when an update lands | not filed |
| Images returned by tools render in the transcript | Screenshots from preview and MCP tools are evidence | not filed |
| Agents ask for credentials through a dedicated request, never in chat | Keeps secrets out of transcripts. Security lane | not filed |

## Pillars

These pillars are what o8 is. They don't change month to month. Each open arc links one tracking issue, and that issue's checklist is the real progress. A box is checked when the child issue is closed and its fix is in a shipped release.

**State:**
- `active`: work is in flight now;
- `open`: known gaps, not in Now;
- `parked`: we know what it would take and are not doing it.

| Pillar | Arc | Done means | State | Where |
| --- | --- | --- | --- | --- |
| Governance | Lane lifecycle and recovery honesty | No lane stalls silently; every terminal state is reachable from the UI and the CLI | open | [#2197](https://github.com/o8-run/o8/issues/2197) |
| Governance | Worker capability boundaries | A worker cannot read or reach anything its packet does not grant. Security lane | open | [#2198](https://github.com/o8-run/o8/issues/2198) |
| Governance | Orchestrator prompt matches its turn | The prompt a turn runs with is the prompt it was built for | open | [#2903](https://github.com/o8-run/o8/issues/2903) |
| Governance | Reliable agent workflows | Local reliability burn-down | open | [#3190](https://github.com/o8-run/o8/issues/3190) |
| Subscriptions | Carrier coverage and auth probes | A new agent CLI lands as a registry entry plus a readiness probe, with no fork in dispatch | open | [#2200](https://github.com/o8-run/o8/issues/2200) |
| Subscriptions | Local models first-class | Every surface names its local provider, and a test proves no egress for a full packet | parked | [#1451](https://github.com/o8-run/o8/issues/1451) |
| Subscriptions | Conversation orchestration through a chat plan | Plan and follow CLI work with explicit account and usage boundaries | parked | [#2955](https://github.com/o8-run/o8/issues/2955) |
| Every surface | Remote project operation | Reconnect to the same remote task, preview, diff and approval path | active | [#2282](https://github.com/o8-run/o8/issues/2282) |
| Every surface | Settings take effect everywhere | Change a setting once; every surface uses it on its next action | open | [#2217](https://github.com/o8-run/o8/issues/2217) |
| Every surface | Live terminals as a workspace surface | A tmux or vim session survives an update and a pane switch byte for byte | open | [#1723](https://github.com/o8-run/o8/issues/1723) |
| Every surface | Symon correctness and reliability | Desktop and phone voice flows reviewed; confirmed failures fixed through real entry points | open | [#2534](https://github.com/o8-run/o8/issues/2534) |
| Every surface | Durable Symon on the built-in agent | Symon survives restarts across app, phone and messages | open | [#3456](https://github.com/o8-run/o8/issues/3456) |
| Every surface | Faster operator decisions on the phone | Mobile surfaces ordered by what needs the operator first | parked | [#2445](https://github.com/o8-run/o8/issues/2445) |
| People and agents | Design Mode loop | "Change this button" is one bounded loop with a before-and-after proof | parked | [#1695](https://github.com/o8-run/o8/issues/1695) |
| Runs where you are | Speed and idle work | Interaction budgets hold under real load, not only at idle | active | [#2202](https://github.com/o8-run/o8/issues/2202) |
| Runs where you are | Storage admission and reclaim | o8 never blocks a dispatch it could service and never fills the disk | open | [#2203](https://github.com/o8-run/o8/issues/2203) |
| Runs where you are | Release channels and build integrity | Beta and stable are separable; a build reproduces from its tag | active | [#2205](https://github.com/o8-run/o8/issues/2205) |

### Platforms

| Platform | State | Detail |
| --- | --- | --- |
| macOS | supported | One universal build (x86_64 and arm64), signed and notarized; o8 next is the only window since 0.1.815. It runs installed on Intel every day; an installed run on physical Apple Silicon is still unverified |
| Linux (Ubuntu) | active | The o8 next GPUI app and packages are in progress; install-to-merge proof is open in [#1672](https://github.com/o8-run/o8/issues/1672) |
| Windows | active | An x64 preview of the older shell (0.1.664) is on Releases. o8 next now builds and starts on Windows x64 in CI ([#5649](https://github.com/o8-run/o8/pull/5649)); a signed installer and auto-update are next. Port audit in `docs/internals/port-audit-windows.md`; tracked in [#2204](https://github.com/o8-run/o8/issues/2204) |

### Speed targets

o8 next aims to be the fastest agent app:
- launch in under 1 s;
- a worker running in under 10 s;
- a frame painted in under 8 ms.

Idle memory gets measured once Phase A finishes (Now, item 3).

## Shipped

Per-change detail lives in the [release notes](https://github.com/hurttlocker/o8-releases/releases) and the git history. This list names only the milestones.

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
