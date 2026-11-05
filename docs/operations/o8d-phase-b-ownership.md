# Phase B ownership and protected boundaries

Refs #5422 and #5243. This is an implementation audit of the server domains, not a
claim that the Rust server port is complete. The saved-session optimization keeps
`O8D_NATIVE_SESSION_READS` default off. The repository integration adds the
default-off `O8D_NATIVE_REPOSITORY_READS` flag for branch GETs. Neither change
introduces a store writer, and every existing TypeScript fallback remains
available. The repository/git domain is only partially implemented.

The ownership investigation began at `dd2a6e687`. Main subsequently landed
additional read/write splits and a comparison-diff ref guard; the checkpoint was
rebased onto `a1613de91`. Re-evaluate remaining candidates against those changes
before using this initial writer inventory as a cutover plan.

The existing native session set relies on the TypeScript handlers being
gate-scoped. If those handlers gain additional principal or ownership filtering,
the native projection must match it or that route must stay on TypeScript. The
default-off flag is unchanged, including the issue's latency gate for enabling it.

## Transport

The current native admission block in
[`native-http-routes.ts`](../../src/lib/ws-server/native-http-routes.ts) admits only
the four saved-session GET paths. The daemon's explicit child environment in
[`o8d-bridge.ts`](../../src/lib/ws-server/o8d-bridge.ts) forwards only that native
domain flag. Reusing this admission and flag-propagation mechanism for another
domain would require extending those seams. The task excludes changes to
existing authorization and environment allowlists, so this change does not
extend either seam.

The repository registry wrapper instead calls
[`repository-http-client.ts`](../../src/lib/ws-server/repository-http-client.ts)
after the existing public middleware gate. That new client starts an o8d
standalone HTTP reader on an ephemeral loopback port and forwards the original
bearer through its existing authentication. Only flagged branch GETs use it;
unavailability or a missing native response marker returns control to the
existing TypeScript handler. The existing authorization implementation and
environment allowlists remain unchanged. This read-only transport does not
establish a transaction or ownership protocol for the unfinished write domains.

## Domain ownership audit

| Requested domain | Current boundary and unfinished work |
| --- | --- |
| Session reads | The saved JSON/SQLite projections remain read-only. Native threads batch Git work after pagination and share a fresh SQLite connection within each request. Live runtime transcripts, durable lane overlays, network projections, parked-workspace receipts and dynamic steering still fall back to TypeScript. This is not a session writer cutover. |
| Repository/git reads | Branch GET has a flagged native implementation through the separate loopback client. The domain remains partial. File browsing owns lexical and realpath containment. Commit/file diffs own credential-aware viewer redaction and full-source identity checks. Comparison-diff remains unported; main now guards its revision argument. Panel status reports TypeScript runtime and terminal health. Repository-ledger read/write splits landed after the initial audit and need a fresh ownership check. |
| Composer queue/chat writes | `composer-queue.ts` owns enqueue, claim, promote, defer, admit, settle, cancel, recovery and stop/hold mutations. The heartbeat and WS chat-stop path are writers too. `chat-history-store.ts` coordinates search-index writes, JSON replacement and synchronous lock callbacks; callers include mobile, runtime handoff, inbox, network projection, auto-compaction, title generation and repository repointing. Forwarding only HTTP writes or final file writes would leave split ownership or lose read/modify/write isolation. |
| Cortex memory | Writers span the indexer queue/worker/watcher, knowledge indexing, compaction, decay, forget, spec ingestion, directives, proposals and startup migrations. Orchestrator context-relay also writes `session_outcomes`. Some GETs start indexing, flush timing data or trigger repository repairs. A complete writer cutover has not been implemented. |
| Lanes/worktrees/supervisor | Lane reconciliation, creation, attachment, archival and deletion share worker-run transactions and event publication. Worktree metadata combines SQLite callbacks, identity-checked mirrors and mutation leases. Worktree creation/cleanup also owns storage admission, safety hooks and environment bootstrap. These must move together with their background callers. |
| Runtime adapters | Codex, Claude Code and Pi share lifecycle writers across launch, resume, interrupt, recovery, archive, rebinding and exit handling. `owned-session/run-controller.ts` owns worker credentials and mandatory sandbox preparation; `credential-spawn.ts` holds the provider lock across credential policy and launch admission; `restricted-spawn-env.ts` owns environment allowlisting and key selection. Parsing streams alone would not complete this domain. |
| Orchestrator | Mission JSON, SQLite mission snapshots, idempotency receipts, approvals and session governance have writers across control-plane, mission registry, headless dispatch/recovery, lane release/stop and repository repointing. State GET reconciles and writes; active-registry reads schedule archival. Snapshot-only handlers do not preserve those semantics. |
| MCP tools | Existing native passive readers remain unchanged. Mutation tools follow the domain owners above. Tool publication binds policy to credentials, the TypeScript process and its generation; operator HTTP forwarding already owns bearer refresh. Adding wrappers without the domain cutovers would not move ownership. |

## Left on TypeScript for a separate review

These are route families, including their registered methods unless a method is
named explicitly. Keeping the handler retains its existing checks; none of those
checks is copied into Rust. Some entries remain because ownership or projection
work is unfinished, rather than because their handler owns a protected concern.

| Routes | Reason |
| --- | --- |
| `DELETE /api/panel/branches` | Couples lanes, worktrees and live-process guards. GET retains the TypeScript fallback behind its separate native flag. |
| Unsupported `GET /api/panel/branches` configurations | Diff helpers can execute programs; partial clones can fetch and persist missing objects; option-like default refs can become Git options. These cases defer to TypeScript. Native reads disable those execution paths, bound work and output, and cancel/reap active commands when their parent exits. |
| `/api/panel/files`, `/api/panel/file-asset`, `/api/v2/files`, `/api/v2/files/quick-docs`, `/api/panel/serve-image` | Filesystem containment, symlink/identity checks or credential-aware file handling. |
| `/api/panel/commits`, `/api/panel/commits/[hash]`, `/api/panel/file-diff` | Credential-aware viewer/diff redaction; file diff also owns workspace containment. |
| `GET /api/orchestrator/comparison-diff` | Retained on TypeScript. The initial audit found a Git option write path; main subsequently added a base-ref guard. A native diff implementation and corpus are still unfinished. |
| `/api/panel/status` | Live TypeScript/terminal health and audit projections have not moved. |
| Composer-queue mutations and chat-history mutations | Route-local principal/workspace checks plus incomplete shared writer cutover. Existing flagged saved GETs retain their original admission and fallback. |
| `/api/cortex/*` | Writer closure is incomplete. Proposal writes also check operator/worker, packet and lane ownership; corrections/sources enforce operator authority; inference resolves credentials. |
| `/api/lanes`, `/api/lanes/*`, `/api/worktrees`, `/api/worktrees/*` | Operator/worker scope and packet ownership; coupled reconciliation, mutation leases and lifecycle operations. |
| `/api/runtime/*` | Runtime lifecycle ownership is incomplete; spawn requires credentials, sandboxing and environment policy. |
| `/api/orchestrator/state`, `/api/orchestrator/review`, `/api/orchestrator/review-state`, `/api/orchestrator/merge`, `/api/orchestrator/merge-preview`, `/api/orchestrator/comparison-pick`, `/api/orchestrator/stop-packet`, `/api/orchestrator/packet-spec`, `/api/orchestrator/packet-transcript`, `/api/orchestrator/propose-spec` | Existing panel/principal or packet-worker ownership checks; mission writers have not moved. |
| `/api/orchestrator/stop-mission`, `/api/orchestrator/dispatch-halt`, `/api/orchestrator/discard-packet`, `/api/orchestrator/reset-packet`, `/api/orchestrator/rerun-with-feedback`, `/api/orchestrator/receipts`, `/api/orchestrator/session-rules` | Explicit operator restrictions or worker scope; shared lifecycle/governance state. |
| `/api/orchestrator/steer-packet` | Device-principal admission. |
| Other orchestrator lifecycle/status routes and MCP mutation tools | Existing handler-local authorization and unresolved domain writers. |
| Mobile, relay, pairing and end-to-end encryption | Excluded from this port; #5301. No TypeScript implementation files in these domains were edited. |

The initial comparison-diff finding was reproduced in an owned temporary
repository. Main fixed that input boundary before the final rebase. This PR
retains the upstream fix and makes no edits to that TypeScript route.

No domain is declared complete solely because a small fixture passes. New writer
ownership needs stateful parity, background/recovery coverage and a loopback
cutover for all remaining TypeScript callers before enabling its flag.
