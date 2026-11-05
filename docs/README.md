# o8 documentation

This documentation covers using o8, understanding and extending its architecture, and operating production builds.

Agents start with [`AGENTS.md`](../AGENTS.md). Detailed commands, repository orientation, and the
map from former always-loaded instructions to scoped sources live in
[`AGENT_REFERENCE.md`](../AGENT_REFERENCE.md).

## Reference collections

| Collection | What it contains |
|---|---|
| [Design](design/) | The visual language, interaction rules, review rules, and operator-locked geometry. |
| [Agents](agents/) | Guidance for external agents that drive o8 through its supported interfaces. |

## User

For operators who want to understand the product and run governed agent work without reading implementation details.

| Document | What you will learn |
|---|---|
| [Product brief](user/o8-product-brief.md) | What o8 is, who it serves, and the boundaries of the product. |
| [How o8 works](user/how-o8-works.md) | How missions, packets, lanes, review, and memory fit together. |
| [Voice](user/voice.md) | Symon, the voice layer: what it does, the macOS controls, first-time setup, and the free and paid tiers. |
| [First-run receipt (2026-09-12)](user/first-run-receipt-2026-09-12.md) | Timed source setup through the first merged packet, including every stall and workaround. |
| [Runtime dogfood receipt](user/runtime-dogfood-receipt-2026-08-10.md) | One bounded operational run of a non-frontier runtime, with cost and review outcome. |
| [Canonical workflow](user/canonical-workflow.md) | The expected path from a task request through reviewed integration. |
| [Self-tuning harness](user/self-tuning-harness.md) | How grounded features, execution contracts, lift measurements, skeptical review, CI, and portable bundles fit together. |
| [Orchestration playbook](user/orchestration-playbook.md) | How to brief, monitor, review, recover, and close agent work well. |
| [Persistent lead handoff](user/persistent-leads.md) | How an external liaison starts, continues, waits on, and stops one durable o8 lead. |
| [Agent handoffs](user/agent-handoffs.md) | Find an agent by codename, send a bounded exchange, reply, and stop. |
| [Claude Code model carriers](user/claude-code-model-carriers.md) | How native, API-billed, and Codex subscription model sources work behind the Claude Code harness. |
| [Operator MCP bridge](user/operator-mcp-bridge.md) | How terminal and MCP clients drive the same governed control plane as the app. |
| [Local PII MCP](user/local-pii-mcp.md) | Attach an on-device PII detect/redact MCP to the tool-spine and workers. |
| [Persistent terminals](user/persistent-terminals.md) | How terminal sessions survive restarts and recover their scrollback. |
| [Telemetry privacy](user/product-telemetry-privacy.md) | What optional product telemetry can contain and how consent is enforced. |
| [Vocabulary](user/vocabulary.md) | The precise meanings of runtime, agent, session, packet, lane, mission, review, and approval. |

## Internals

For contributors who are reading the code, extending o8, or maintaining a cross-process contract.

| Document | What you will learn |
|---|---|
| [System architecture](internals/system-architecture.md) | The major processes, data flows, persistence layers, and trust boundaries. |
| [API reference](internals/api.md) | The HTTP route families, request shapes, and authorization expectations. |
| [Loopback API security](internals/loopback-api.md) | How socket identity, bearer tokens, origins, and public-route exceptions are enforced. |
| [Connect contract](internals/connect-contract.md) | The desktop-to-relay wire protocol, ownership rules, and web-surface behavior. |
| [Runtime adapter contract](internals/runtime-adapter-contract.md) | The supported runtime model and the recipe for adding another agent CLI. |
| [Execution carriers](internals/execution-carriers.md) | Typed argv and credential wrappers that preserve the underlying runtime identity. |
| [Local-model coverage](internals/local-model-coverage.md) | Which orchestrators, workers, and support surfaces can use local inference today. |
| [Task-pool control plane](internals/agent-task-pool-control-plane.md) | How tasks project onto packets, lanes, locks, CLI commands, and MCP tools. |
| [Interactive task artifacts](internals/task-artifacts.md) | How an agent hands the operator a sandboxed form whose exact payload returns to the session that asked. |
| [Fleet state model](internals/fleet-state-model.md) | The canonical status vocabulary for agents, packets, squads, and review. |
| [Cortex memory integration](internals/cortex-memory-integration.md) | How session outcomes become searchable organizational memory. |
| [Codebase-memory build](internals/codebase-memory-build.md) | How the codebase-memory helper is sourced, packaged, and verified. |
| [Performance principles](internals/performance-architecture-principles.md) | The render, bootstrap, streaming, and measurement rules for responsive surfaces. |
| [Code conventions](internals/conventions.md) | The repository’s component, styling, API, state, and testing conventions. |
| [UI surface atlas](internals/ui-surface-atlas.md) | Which desktop surfaces are reachable and which component owns each one. |
| [Native browser webview](internals/native-browser-webview-spec.md) | How native browser views connect to the app without weakening isolation. |
| [Mobile control service](internals/mobile-control-service-contract.md) | The entities and endpoints behind paired mobile control. |
| [Mobile diff comments](internals/mobile-diff-comments.md) | The line-anchor and API contract for review comments from a phone. |
| [Mobile end-to-end encryption](internals/mobile-e2ee.md) | The per-device identity, handshake, encryption, and revocation protocol. |
| [OpenClaw integration](internals/openclaw-integration.md) | The orchestrator backend’s HTTP, WebSocket, threading, and streaming contract. |
| [Symon agent mode](internals/symon-agent-mode.md) | The phone-hosted voice and Mac-executed tool contract. |
| [APFS workspace isolation](internals/mac-apfs-cow-isolation-plan.md) | The copy-on-write workspace model, merge path, and fallback behavior. |
| [Worktree storage decision](internals/worktree-storage-path-decision.md) | Why packet worktrees live where they do and which paths remain compatible. |

## Operations

For maintainers who build, verify, release, recover, or harden o8.

| Document | What you will learn |
|---|---|
| [GitHub operating standard](operations/github-operating-standard.md) | How issues, tracking checklists, pull requests, and merges run here, and what a contributor can expect from us. |
| [Plugin package and submission](operations/openai-plugin-submission.md) | The local workflow package, its execution limits, and the checks before directory submission. |
| [Pre-ship gate](operations/PRE-SHIP-GATE-CHECKLIST.md) | The clean-profile checks required before a public build is considered releasable. |
| [Desktop build and deployment](operations/deployment.md) | How the native shell, sidecars, packaging, signing, and runtime prerequisites fit together. |
| [Smoke-test prompt](operations/smoke-test-prompt.md) | The repeatable end-to-end product checks for a candidate build. |
| [Claude worker smoke](operations/claude-worker-smoke.md) | How to prove the Claude worker path reaches real dispatch and completion seams. |
| [Crash survival](operations/daemon-crash-survival.md) | How worker processes and transcripts recover after app or server failure. |
| [Project hardening](operations/project-hardening.md) | The multi-repo project contract, retrieval scope, locks, and expected invariants. |
| [Substrate evaluation gate](operations/substrate-eval-gate.md) | The thresholds and sustainment checks for memory and retrieval quality. |
| [Governed task evaluation](operations/governed-task-evaluation.md) | The sealed paired protocol for final task outcomes, operator effort, recovery evidence, and overhead. |
| [Dependency cache retention](operations/dependency-cache-retention.md) | Download-cache bounds, active-installer protection, legacy preservation, and maintenance receipts. |
| [Sustained work and retirement](operations/sustained-work-retirement.md) | The twenty-check acceptance program for native execution, preservation, automatic retirement and verified restore on macOS and Linux. |

Questions or problems? [Open an issue](https://github.com/o8-run/o8/issues) — the bug template asks for the details that make reports actionable.

<sub>Written by the fleet. Governed by one human.</sub>
