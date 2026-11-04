# Phase B ownership and protected boundaries

Refs #5422 and #5243. This is an implementation audit of the server domains, not a
claim that the Rust server port is complete. The saved-session optimization keeps
`O8D_NATIVE_SESSION_READS` default off and introduces no writer or domain flag.
Every existing TypeScript fallback remains available.

The existing native session set relies on the TypeScript handlers being
gate-scoped. If those handlers gain additional principal or ownership filtering,
the native projection must match it or that route must stay on TypeScript. The
default-off flag is unchanged, including the issue's latency gate for enabling it.

## Transport prerequisite

The current native admission block in
[`native-http-routes.ts`](../../src/lib/ws-server/native-http-routes.ts) admits only
the four saved-session GET paths. The daemon's explicit child environment in
[`o8d-bridge.ts`](../../src/lib/ws-server/o8d-bridge.ts) forwards only that native
domain flag. Reusing this admission and flag-propagation mechanism for another
domain would require extending those seams. The task excludes changes to
existing authorization and environment allowlists, so this change does not
extend either seam. A separate registry/client integration must preserve those
boundaries and prove native execution and fallback before it can ship.

The existing public API loopback client is not a private domain RPC client. A
registry wrapper forwarding the same route to that listener would recurse. The
supervisor socket supports process spawn, attach and signal, not arbitrary
domain operations. Registry wiring alone cannot complete those cutovers.

## Domain ownership audit

| Requested domain | Current boundary and unfinished work |
| --- | --- |
| Session reads | The saved JSON/SQLite projections remain read-only. Native threads batch Git work after pagination and share a fresh SQLite connection within each request. Live runtime transcripts, durable lane overlays, network projections, parked-workspace receipts and dynamic steering still fall back to TypeScript. This is not a session writer cutover. |
| Repository/git reads | Branch GET is a native candidate once transport admission can be extended. File browsing owns lexical and realpath containment. Commit/file diffs own credential-aware viewer redaction and full-source identity checks. Panel status reports TypeScript runtime and terminal health. Repository-ledger reads can repair and persist remote metadata. |
| Composer queue/chat writes | `composer-queue.ts` owns enqueue, claim, promote, defer, admit, settle, cancel, recovery and stop/hold mutations. The heartbeat and WS chat-stop path are writers too. `chat-history-store.ts` coordinates search-index writes, JSON replacement and synchronous lock callbacks; callers include mobile, runtime handoff, inbox, network projection, auto-compaction, title generation and repository repointing. Forwarding only HTTP writes or final file writes would leave split ownership or lose read/modify/write isolation. |
| Cortex memory | Writers span the indexer queue/worker/watcher, knowledge indexing, compaction, decay, forget, spec ingestion, directives, proposals and startup migrations. Orchestrator context-relay also writes `session_outcomes`. Some GETs start indexing, flush timing data or trigger repository repairs. A complete writer cutover has not been implemented. |
| Lanes/worktrees/supervisor | Lane reconciliation, creation, attachment, archival and deletion share worker-run transactions and event publication. Worktree metadata combines SQLite callbacks, identity-checked mirrors and mutation leases. Worktree creation/cleanup also owns storage admission, safety hooks and environment bootstrap. These must move together with their background callers. |
| Runtime adapters | Codex, Claude Code and Pi share lifecycle writers across launch, resume, interrupt, recovery, archive, rebinding and exit handling. `owned-session/run-controller.ts` owns worker credentials and mandatory sandbox preparation; `credential-spawn.ts` holds the provider lock across credential policy and launch admission; `restricted-spawn-env.ts` owns environment allowlisting and key selection. Parsing streams alone would not complete this domain. |
| Orchestrator | Mission JSON, SQLite mission snapshots, idempotency receipts, approvals and session governance have writers across control-plane, mission registry, headless dispatch/recovery, lane release/stop and repository repointing. State GET reconciles and writes; active-registry reads schedule archival. Snapshot-only handlers do not preserve those semantics. |
| MCP tools | Existing native passive readers remain unchanged. Mutation tools follow the domain owners above. Tool publication binds policy to credentials, the TypeScript process and its generation; operator HTTP forwarding already owns bearer refresh. Adding wrappers without the domain cutovers would not move ownership. |

## Left on TypeScript for a separate review

These are route families, including their registered methods. Keeping the entire
handler retains its existing checks; none of those checks is copied into Rust.

| Routes | Reason |
| --- | --- |
| `/api/panel/branches` | GET needs a separate registry/client integration that preserves existing admission and flag propagation; DELETE also couples lanes, worktrees and live-process guards. |
| `/api/panel/files`, `/api/panel/file-asset`, `/api/v2/files`, `/api/v2/files/quick-docs`, `/api/panel/serve-image` | Filesystem containment, symlink/identity checks or credential-aware file handling. |
| `/api/panel/commits`, `/api/panel/commits/[hash]`, `/api/panel/file-diff` | Credential-aware viewer/diff redaction; file diff also owns workspace containment. |
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

The historical A1 note that comparison-diff GET writes should not be reused as a
current finding: the inspected implementation runs Git diff reads. It still
requires the new transport boundary before it can become a native candidate.

No domain is declared complete solely because a small fixture passes. New writer
ownership needs stateful parity, background/recovery coverage and a loopback
cutover for all remaining TypeScript callers before enabling its flag.
