# Worker completion receipts audit

Refs #6040 and #6060. Source baseline: `c87d0ab6d524e5cc40556072e8f239e5bec809d6`.
Persistent lead turn reporting is handled by #6042; MCP projections are tracked by #6054.
This audit distinguishes a runtime turn ending, work becoming reviewable, and a packet being released.

| Surface | Turn-end conversion or downstream presentation | Source | Disposition |
| --- | --- | --- | --- |
| Owned provider exit | A clean child exit notifies the supervisor without a task outcome. Provider result events also establish runtime `completedTurn`, not a task receipt. | `src/lib/runtimes/shared/owned-session/run-controller.ts:273`; `run-notifications.ts:23`; `src/lib/runtimes/declarative-workers.ts:35,72,115,160` | Needs the worker receipt contract below. Process exit proves that provider process ended, not that every child command it launched ended. |
| Supervisor push and polling | Clean owned completion ingress becomes `finished`; missing fleet entries after 30 seconds, `idle`, and `reviewing` also become `finished`. The callback's absent verdict permits a `completed` broadcast. | `src/lib/supervisor/agent-supervisor.ts:354,670,709`; `src/lib/supervisor/recovery-status.ts:14,20,22`; `src/ws-server.ts:8466` | #6060 blocks unexpected callback errors. Normal no-report completion still needs the receipt contract. `completionReported` is a deduplication flag, not a worker-authored outcome. |
| Normal worker completion | Auto-commit and successful verification move the lane to `reviewing`; optional transcript receipt capture happens afterward. | `src/lib/supervisor/agent-completion.ts:217,343,350`; `src/lib/supervisor/post-completion-packet.ts:105` | Needs the receipt contract. A check result or an auto-commit cannot substitute for an agent report. |
| Silent-exit salvage | Dead session plus verified/salvaged commits moves work to review even when completion was never reported. | `src/lib/supervisor/silent-exit-detector.ts:445,519`; `src/lib/supervisor/silent-exit-completion.ts:34,40` | Decide how retained, verified work is exposed for attention without asserting a worker handback. The separate already-merged branch at detector lines 312-314 uses ancestry evidence; preserve that authority. |
| Forced self-review | A stalled worker can be interrupted after preservation and verification, moved to review, then broadcast `completed` without requiring a complete outcome receipt. | `src/lib/supervisor/force-self-review.ts:54,79,87` | Decide whether this is a distinct operator salvage action; it must not impersonate a normal reported worker outcome. |
| Completion context ledger | Missing self-review yields `partial`, with last assistant prose as a fallback summary. It does not itself prove success. | `src/lib/orchestrator/context-relay.ts:427,430,495`; `src/lib/orchestrator/context-relay-outcome.ts:17-34` | Preserve `partial`. Decide which parsed self-review qualifies as the canonical exact-run report before gating lane review on it. |
| Review notice and task pool | Entering `reviewing` emits review-ready notifications. Task pool maps reviewing/awaiting_review to review; completed/archived/released to done. | `src/lib/lane/lifecycle.ts:59`; `src/lib/tasks/pool.ts:193-204` | Downstream consumers inherit the producer's classification. `lane-lifecycle` mutation `status: completed` at line 73 means the mutation settled; its separate `laneStatus` is the task state. Do not change mutation semantics. |
| Task and packet reports | `o8_task_report` forwards to `reportTask`; non-blocking reports update activity only. Packet `agent_report` likewise records progress or blocking events. Neither defines a typed successful terminal outcome. | `src/lib/mcp/operator-handlers/mission.ts:795,973`; `src/lib/tasks/actions.ts:630,647,661`; `src/lib/lane/agent-report.ts:15,90-104` | No turn-end-to-done conversion here to patch. Preserve progress semantics; define a terminal report contract rather than treating arbitrary event names or old activity as completion. |
| Remote worker and cloud jobs | Explicit `completed` events map to completion; the leased cloud event can carry a null payload, and transport completion defaults missing result to empty text. Task pool then presents the remote job for review. | `src/lib/cloud/sqlite-job-store.ts:284-295`; `src/lib/runtimes/remote/customer-worker-transport.ts:138-142`; `src/lib/runtimes/cloud-adapter.ts:140`; `src/lib/tasks/pool.ts:200` | These have an event/lease protocol, not just a local exit observation. Decide the required outcome payload and attempt binding before changing compatibility. Remote review authority has additional commit/source checks; preserve them. |
| Conversational orchestrator adapters | ACP/openclaw turn completion sets a conversation to ready and publishes completed metadata. | `src/lib/lane/orchestrator-backends/acp.ts:415,430`; `src/lib/lane/orchestrator-backends/openclaw.ts:337,496` | Distinguish ordinary chat availability from a task-owned lead turn. Persistent leads use their separate outcome classifier; broad chat semantics need an explicit ownership decision. |
| Read-only packet completion | A complete `finding_ready` receipt with Outcome, Evidence and Residual is required; missing evidence parks the lane and holds the packet. | `src/lib/orchestrator/read-only-completion.ts:54,105,124-134` | Already gated. Preserve its generation/owner checks and release requirements. |

## Decision required before the remaining changes

Choose a canonical terminal worker report: either extend task/packet reporting with a typed outcome,
or adopt the existing parsed packet self-review as that report. Specify required fields, exact
run/attempt identity, receipt freshness after a resumed turn, and whether a retained verified diff
without a report is an attention state distinct from review-ready work. Specify the corresponding
remote event payload and the behavior of legacy unmanaged watches. A progress event, an old report,
a provider success event, an empty remote result, or passing verification must not implicitly satisfy
that contract.

This is a cross-producer compatibility decision. The audit deliberately does not invent an event
store or change review, approval, merge, release, or ordinary conversation gates. The contained
#6060 change handles an established failure: a thrown completion check returns a blocking verdict,
retains the current lane for input, and cannot publish a successful handback. Existing turn guards
continue to protect newer work from an older callback.
