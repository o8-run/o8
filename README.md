<p align="center">
  <img src="./assets/o8-icon.png" alt="" width="104">
</p>

# o8

[![CI](https://github.com/o8-run/o8/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/o8-run/o8/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/o8-run/o8)](https://github.com/o8-run/o8/releases) [![Benchmark](https://img.shields.io/badge/benchmark-published%20with%20losses-8A5CF6)](./docs/user/honest-benchmark-2026-08.md)

**Run a fleet of coding agents. Approve what ships.**

o8 is an open-source control room for one person running several AI coding agents across their repositories, the governance layer above them. Claude Code, Codex, Grok Build, DeepSeek Harness, OpenCode, Gemini, and twelve more do the work in isolated git worktrees; o8 brings the work, the reviews, and the decisions into one place so you can direct the agents without following every terminal.

[**Download for macOS**](https://o8.run/download) · [Build from source](#get-it)

The download page identifies the current Mac installer. A universal DMG runs natively on Apple Silicon and Intel; an Intel-only DMG needs Rosetta on Apple Silicon.

macOS today. Linux compiles in CI, but nobody has yet installed it, launched it, and merged a packet on a mainstream distro. Windows is help wanted. Both are on the [roadmap](./ROADMAP.md).

![One ask, three workers: the orchestrator splits the task into packets, each worker builds its page in its own worktree, and the plan and every tile report as they go](./assets/three-workers.gif)

The aim is that you can hand out several pieces of work, look away, and come back to a readable account of what finished, what is blocked, and what needs your decision. The roadmap says how far along that is.

## What happens when you dispatch

1. You, or the orchestrator model you chose, create a mission. It becomes packets.
2. Each packet runs on the runtime you picked, in its own git worktree, and reports as it goes. Workers never merge their own work.
3. The work lands for review: the diff, the receipts, and the cost when the runtime reports it.
4. You approve, reject, steer, or rerun. You can delegate the review to an orchestrator. By default its approved merges go through, and the approval setting can make every merge wait for you.
5. The merge writes the audit trail and records the outcome. Project rules and recorded outcomes are what the Brain and the next packet retrieve. Learning from your rejections and steers is still an open arc.

![A solo session reviews the working tree, gives its verdict, commits when asked, and shows the log](./assets/review-and-commit.gif)

A merge that fails climbs a five-step ladder that ends at a human card. The lifecycle gaps that remain are on the roadmap. The same verbs work from the app, the `o8` CLI, any MCP client, your phone, and your voice. The long version is [How o8 works](./docs/user/how-o8-works.md).

## Runtimes

| Orchestrate or work | Workers (dispatchable) |
|---|---|
| Claude Code · Codex · OpenCode 2 | Gemini · Cursor · Grok Build · Pi · GitHub Copilot CLI · Crush |
| | Aider · Goose · Kimi Code · OpenHands · Qwen Code · Qoder |
| | 3code · Prime Agent · DeepSeek Harness |

o8 finds the coding-agent CLIs you already have installed and runs them behind one adapter contract. The table lists every runtime o8 can detect today, and a test keeps it equal to the registry. Readiness differs by CLI version and platform, so the first-run picker shows what is installed and working on your machine. Adding a runtime is a small documented patch: [runtime adapter contract](./docs/internals/runtime-adapter-contract.md). Claude Code can also keep its tools and session behavior while another model supplies inference: [model carriers](./docs/user/claude-code-model-carriers.md).

![Before sending: the Lead chip sets the model and its thinking effort, and the mode chip sets Solo, Multitask, Compare plans, or Fusion](./assets/choose-before-you-send.gif)

## Get it

**Easiest:** the latest signed build from [Releases](https://github.com/o8-run/o8/releases). It auto-updates.

**From source** needs Node 22.x (native modules are built against the Node 22 ABI), Rust stable, and Xcode Command Line Tools.

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

Usage analytics are on by default for new installs and installs without an earlier choice. An explicit earlier opt-out stays off after an update. Before the first event, the first-run privacy screen lists every event and field, shows an example payload, and offers a **Turn off** button that saves immediately. Turning usage off and on cannot bypass an unanswered privacy screen. Settings → General → Privacy changes the choice immediately. The complete allowlist is six events: `app.opened`, `brain.asked`, and `orchestrator.message` (no properties); `dispatch.started` (worker-runtime enum); `merge.approved` (runtime and pushed boolean); and `repo.added` (hasRemote and isGitRepo booleans). Usage events never include code, prompts, file paths, repo names, or file contents. No identity is collected beyond sign-in. See the [product telemetry disclosure](docs/user/product-telemetry-privacy.md) for the storage and validation rules. Crash reports, local crash-log uploads, and error transmission remain separate, off by default, and opt-in.

Each desktop update check sends a random device identifier, app version, target, chip architecture, macOS version (on macOS), and release channel to o8's update service, as described on the [privacy page](https://o8.run/privacy). The identifier is saved locally at first launch and is separate from sign-in and hosted-model identifiers. The ping is always on as part of checking for updates, independent of the usage-analytics toggle. It sends no code, paths, repository names, prompts, or account details. The service contract prohibits storing IP addresses or linking the identifier to an account. GitHub remains the fallback, and update signature verification stays the same.

The update service and active-install counts are tracked separately. This change implements the desktop client only.

## Free and paid

Everything that runs on your machine is free and open source: the app, every runtime it detects, governance, memory, the Brain, mobile, and voice with your own keys. Pro is the optional managed edition for the things that run on our servers: higher daily managed-inference limits, early access to experimental features, and remote access to up to 10 Macs from a browser. Convenience, never capability. [Pro · Lifetime](docs/founding-operator-tier.md) is the one-time purchase that keeps its included benefits for life. The future monthly plan is called Pro: [o8.run/pro](https://o8.run/pro).

## Voice

Symon is the voice layer. Ask "what needs me?" without turning around, approve the one thing that is blocking, and dictate anywhere on the Mac. Anything with a side effect goes through a spoken confirm card, so voice never becomes a way around governance. Controls, setup, and tiers: [Voice](./docs/user/voice.md).

## Where it is going

o8 is building toward an operating system for delegated work: models and agents can change while your project's rules, decisions, and history stay with you. The goal is to let you delegate more work without supervising every step, while keeping authority over what happens and evidence of the result. Coding is where we're proving that approach first.

[ROADMAP.md](./ROADMAP.md): seven pillars, what is open, what is missing on each, and what to claim.

## Contributing

Start with [CONTRIBUTING.md](./CONTRIBUTING.md) and the issues labeled [`claimable`](https://github.com/o8-run/o8/issues?q=is%3Aissue+is%3Aopen+label%3Aclaimable) or [`help wanted`](https://github.com/o8-run/o8/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22). UI changes read [`docs/design`](./docs/design/DESIGN.md) first. The full documentation index is [`docs/README.md`](./docs/README.md); the detailed agent and `o8` CLI reference is [`AGENT_REFERENCE.md`](./AGENT_REFERENCE.md).

Community: [Discord](https://discord.gg/TFK2x9A5WS) · Built in public by [@marquisehurtt](https://x.com/marquisehurtt)

## License

MIT © Rainwater. The o8 name and logo are trademarks of Rainwater. Third-party code and adapted works are credited in [`NOTICE.md`](./NOTICE.md).
