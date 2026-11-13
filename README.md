<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/o8-ring-dark.png">
    <img src="./assets/o8-ring-light.png" alt="o8" width="160">
  </picture>
</p>

# o8

[![CI](https://github.com/o8-run/o8/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/o8-run/o8/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/o8-run/o8)](https://github.com/o8-run/o8/releases) [![Follow @o8dotrun on X](https://img.shields.io/badge/follow-%40o8dotrun-000000?logo=x&logoColor=white)](https://x.com/o8dotrun)

**Your agents write the code. o8 reviews it, sends it back until it's right, and merges it.**

o8 is a free, open-source review and merge layer for coding agents. Write code wherever you like: T3 Code, Codex, Claude Code, Cursor, or your own editor. o8 takes the work in, and an independent agent, ideally a different model, reviews the actual diff. o8 sends the findings back to the author, re-reviews the fix, and merges the approved commit with a receipt. It runs on one machine, usually your biggest, and serves every tool and machine you connect.

[**Download for macOS**](https://o8.run/download) · [Linux](#linux) · [Build from source](#from-source) · [Follow @o8dotrun for updates](https://x.com/o8dotrun)

![A session reviews the working tree, gives its verdict, commits when asked, and shows the log](./assets/review-and-commit.gif)

- **Independent review.** The agent that wrote the code never approves it. A separate reviewer reads the real diff, and its approval is tied to the exact commit it reviewed.
- **Findings go back to the author.** Rejected work returns to the agent that wrote it, with the saved findings. Each handoff has a receipt, corrections are capped at two rounds, and a stopped worker is never restarted.
- **Merges you can audit.** The commit that was reviewed is the commit that merges, and every step leaves evidence. A single governed merge operation is being built.
- **Works with your tools.** Reach o8 from the `o8` CLI or any MCP client. It runs the agent CLIs already on your machine, on your own subscriptions or keys, as reviewers and fixers.

**Where this stands.** On `main`: findings go back to their author, and submitted reviews show with the commit they reviewed. Being built, in order: re-review of a fix, autonomous merge within a policy the project sets once, intake of pull requests from any tool, and reviewers that learn from past outcomes. The [roadmap](./ROADMAP.md) tracks each one.

| Platform | Status |
|---|---|
| macOS 14+ | Signed, auto-updating universal installer: [download](https://o8.run/download) |
| Linux | Preview packages (AppImage, DEB, RPM) from 0.1.810 on [Releases](https://github.com/o8-run/o8/releases/tag/v0.1.810), or [run from source](#linux). Full Linux support, for running o8 on a server, is [in progress](https://github.com/o8-run/o8/issues/1672). |
| Windows | An early x64 preview (0.1.664, August 2026) is on [Releases](https://github.com/o8-run/o8/releases/tag/v0.1.664). A Windows build of the current app is in progress. |

## The review loop

1. **Work arrives.** Today work enters as an o8 mission or packet. Pull requests from any tool or person are next ([#5816](https://github.com/o8-run/o8/issues/5816)).
2. **An independent reviewer reads the diff.** Its findings are saved together with the commit it reviewed.
3. **Rejected work goes back to its author.** One action sends the saved findings to the agent that wrote the code, with a receipt. Corrections are capped at two rounds.
4. **The fix is re-reviewed** against those findings, and approval moves to the new commit ([#5835](https://github.com/o8-run/o8/issues/5835), in progress).
5. **The approved commit merges** through one governed operation. Rules the project sets once decide when o8 may merge without a person ([#5817](https://github.com/o8-run/o8/issues/5817), [#5822](https://github.com/o8-run/o8/issues/5822)).
6. **Outcomes are recorded.** Reviewers retrieve verified past outcomes in the next relevant task ([#5823](https://github.com/o8-run/o8/issues/5823)).

Reviewers keep every tool they need. A reviewer can spawn workers to reproduce a bug, run the tests or try a fix, and each one runs in its own git worktree.

![One ask, three workers: the task splits into packets, each worker builds its page in its own worktree, and every tile reports as it goes](./assets/three-workers.gif)

A merge that fails climbs a five-step ladder that ends at a human card. The same verbs work from the app, the `o8` CLI and any MCP client. The long version is [How o8 works](./docs/user/how-o8-works.md).

## Runtimes

| Orchestrate or work | Workers (dispatchable) |
|---|---|
| Claude Code · Codex · OpenCode 2 | Gemini · Cursor · Grok Build · Pi · GitHub Copilot CLI · Crush |
| | Aider · Goose · Kimi Code · OpenHands · Qwen Code · Qoder |
| | 3code · Prime Agent · DeepSeek Harness |

o8 finds the coding-agent CLIs you already have installed and runs them behind one adapter contract, as reviewers, fixers and workers. The table lists every runtime o8 can detect today, and a test keeps it equal to the registry. Readiness differs by CLI version and platform, so the first-run picker shows what is installed and working on your machine. Adding a runtime is a small documented patch: [runtime adapter contract](./docs/internals/runtime-adapter-contract.md). Claude Code can also keep its tools and session behavior while another model supplies inference: [model carriers](./docs/user/claude-code-model-carriers.md).

![Before sending: the Lead chip sets the model and its thinking effort, and the mode chip sets Solo, Multitask, Compare plans, or Fusion](./assets/choose-before-you-send.gif)

## Get it

### macOS

Download the signed universal DMG from [o8.run/download](https://o8.run/download) or [Releases](https://github.com/o8-run/o8/releases/latest). It runs natively on Apple Silicon and Intel, needs macOS 14 or later, and updates itself.

### Linux

The 0.1.810 [preview packages](https://github.com/o8-run/o8/releases/tag/v0.1.810) (AppImage, DEB, RPM, with checksums) are six releases behind macOS and use the older WebKit shell. The native app's packages are built on Ubuntu 24.04 in CI ([details](./docs/internals/linux-download-packages.md)) and are not published yet.

From source, o8 has run agent turns on Ubuntu. Use the steps below without the Xcode tools; `npm run dev` serves the app at `http://localhost:47120`. A full install-to-merge run on a mainstream distro is not proven yet ([#1672](https://github.com/o8-run/o8/issues/1672)).

### From source

You need Node 22.x (native modules are built against the Node 22 ABI), Rust stable, and on macOS the Xcode Command Line Tools.

Install `nvm` before using the commands below. If Node 22.x is already installed another way, verify it with `node --version` and skip the two `nvm` commands.

```bash
git clone https://github.com/o8-run/o8.git
cd o8
nvm install && nvm use   # .nvmrc pins Node 22
npm install
npm run dev              # web loop: Next.js :47120 + WS :47125
```

The source web loop does not install the global `o8` command. Build the source CLI once, then use `node cli/dist/o8.mjs` wherever [`AGENTS.md`](./AGENTS.md) shows `o8`:

```bash
npm run build:cli
node cli/dist/o8.mjs repo add /absolute/path/to/repo
node cli/dist/o8.mjs mission create --title "First packet" --body "Add one README line" --repo /absolute/path/to/repo --runtime codex
```

Use the returned mission and packet IDs with `mission dispatch`, `mission wait`, `packet diff`, and `packet review --approve --packet <id>`. If review creates an operator card, finish it with `inbox list` and `inbox approve <id>`. The native app installs the global `o8` command after it runs once.

Managed source builds register generated output before the compiler runs. The [generated-output lifecycle](docs/operations/generated-output-lifecycle.md) describes preservation, recovery and journaled retirement.

`npm run tauri:dev` builds the native shell (a much longer first build). After a hard kill, `node scripts/dev.mjs cleanup` recovers the ports. Bring at least one agent CLI you already use (`claude`, `codex`, `grok`, `opencode`, `gemini`); no API keys are needed to start, and [`.env.example`](./.env.example) documents every optional one.

- **Phone:** pair by QR. The mobile web surface ships in this repo and works from any phone on your network; the iPhone app is below.
- **Headless:** `o8 serve` runs the control plane on a machine with no screen, same gates. Pair a phone or attach the desktop later.
- **MCP:** Settings → MCP → Install exposes the operator tools (`create_mission`, `submit_review`, `approve_and_merge`, `cortex_ask`, and the webview controls) to Claude Desktop, Claude Code, or any MCP client.

### iPhone app

The iPhone app is a remote control for the desktop: approve work, steer an agent, watch the fleet, and talk to Symon. It is in open beta on [TestFlight](https://testflight.apple.com/join/kp4RQG5Q). Install it, then pair it from the desktop: the phone button in the status bar opens a QR code, and the app scans it.

## Your data

o8 runs on your machine against your own subscriptions and keys; it is not in the path between your agents and their providers. Worktree isolation covers repository changes: today workers run under your user account and can read what you can read. Usage analytics default on after the first-run privacy screen, with one-click off and earlier choices preserved. Crash reports and error transmission remain off by default and opt-in. [`SECURITY.md`](./SECURITY.md) covers what dispatched workers can reach and what the sandbox does and does not do today.

### Telemetry

Usage analytics are on by default for new installs and installs without an earlier choice. An explicit earlier opt-out stays off after an update. Before the first event, the first-run privacy screen lists every event and field, shows an example payload, and offers a **Turn off** button that saves immediately. Turning usage off and on cannot bypass an unanswered privacy screen. Settings → General → Privacy changes the choice immediately. The complete allowlist is nine events: `app.opened`, `brain.asked`, and `orchestrator.message` (no properties); `dispatch.started` (worker-runtime enum); `merge.approved` (runtime and pushed boolean); `repo.added` (hasRemote and isGitRepo booleans); `worker.first_launched` and `merge.first_completed` (no properties); and `session.ended` (clean boolean). Usage events never include code, prompts, file paths, repo names, or file contents. No identity is collected beyond sign-in. See the [product telemetry disclosure](docs/user/product-telemetry-privacy.md) for the storage and validation rules. Crash reports, local crash-log uploads, and error transmission remain separate, off by default, and opt-in.

The read-only [daily product numbers command](docs/operations/daily-product-metrics.md) prints dated usage aggregates by app version. Its fixture mode is verified; live reporting needs the hosted telemetry export endpoint and its read-only environment credential.

Each desktop update check sends a random device identifier, app version, target, chip architecture, macOS version (on macOS), and release channel to o8's update service, as described on the [privacy page](https://o8.run/privacy). The identifier is saved locally at first launch and is separate from sign-in and hosted-model identifiers. The ping is always on as part of checking for updates, independent of the usage-analytics toggle. It sends no code, paths, repository names, prompts, or account details. The service contract prohibits storing IP addresses or linking the identifier to an account. GitHub remains the fallback, and update signature verification stays the same.

## Free and open source

o8 is MIT licensed and free, and there is nothing to buy. The agents run on your own subscriptions or API keys, and you can use o8 without an account.

## Voice

Symon is the voice layer. Ask "what needs me?" without turning around, approve the one thing that is blocking, and dictate anywhere on the Mac. Anything with a side effect goes through a spoken confirm card, so voice never becomes a way around governance. Controls, setup, and tiers: [Voice](./docs/user/voice.md).

## Where it is going

o8 aims to be the best substrate for reviewing and merging agent work. Any agent writes the code. o8 reviews it, gets it corrected, merges what you intended, and learns from every outcome. It asks a person only when your rules say so.

[ROADMAP.md](./ROADMAP.md) leads with three pillars: the review and merge loop, governance and security, and plugging into the tools you already use.

## Contributing

Start with [CONTRIBUTING.md](./CONTRIBUTING.md) and the issues labeled [`claimable`](https://github.com/o8-run/o8/issues?q=is%3Aissue+is%3Aopen+label%3Aclaimable) or [`help wanted`](https://github.com/o8-run/o8/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22). UI changes read [`docs/design`](./docs/design/DESIGN.md) first. The full documentation index is [`docs/README.md`](./docs/README.md); the detailed agent and `o8` CLI reference is [`AGENT_REFERENCE.md`](./AGENT_REFERENCE.md).

[![Contributors to o8](https://contrib.rocks/image?repo=o8-run/o8&max=24)](https://github.com/o8-run/o8/graphs/contributors)

Follow [@o8dotrun](https://x.com/o8dotrun) on X for updates: release notes and dev clips post there first. Community: [Discord](https://discord.gg/TFK2x9A5WS) · Built in public by [@marquisehurtt](https://x.com/marquisehurtt)

## License

MIT © Rainwater. The o8 name and logo are trademarks of Rainwater. Third-party code and adapted works are credited in [`NOTICE.md`](./NOTICE.md).
