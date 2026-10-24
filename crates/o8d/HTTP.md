# Experimental native HTTP with a TypeScript owner

The existing `experimental-http` feature and `--experimental-http` flag remain
required. Without an owner, this retains the saved-history-only experiment.
With `--owner-upstream`, o8 next uses o8d for saved reads and the existing
TypeScript WS process for reconciliation, runtime discovery, writes and live
streams. No Next server process is required. The shipped launch path is unchanged.

Build with `cargo build --locked --manifest-path crates/o8d/Cargo.toml
--features experimental-http --bin o8d`. Start the existing WS entry point with
an explicitly selected profile and resolved owner port:

```sh
O8_NEXT_HTTP_OWNER=1 O8_DATA_DIR="$O8D_PROFILE_DIR" \
  CORTEX_IDE_DATA_DIR="$O8D_PROFILE_DIR" \
  CORTEX_IDE_DB_PATH="$O8D_PROFILE_DIR/cortex-ide.db" \
  O8_API_PORT="$OWNER_PORT" O8_WS_PORT="$OWNER_PORT" \
  node --import=./scripts/register-server-only-stub.mjs --import=tsx src/ws-server.ts
```

Select an available loopback HTTP port separately, then start:

```sh
crates/o8d/target/debug/o8d --experimental-http \
  --listen "127.0.0.1:$HTTP_PORT" --data-dir "$O8D_PROFILE_DIR" \
  --owner-upstream "127.0.0.1:$OWNER_PORT"
```

Run the existing native CLI with `--enable-next --server` selecting that HTTP
origin and supply its existing operator credential through `O8_NEXT_API_TOKEN`.
The WS owner publishes its resolved port to the selected profile after binding.
Native `ws-info` uses the existing live-probe handler, and native clients connect
directly to the authoritative WS owner. o8d does not invent stream checkpoints.
`O8_WS_O8D` remains a separate opt-in; it is not required by this HTTP mode.
The process supervisor remains separate; see [SUPERVISOR.md](SUPERVISOR.md).

Every o8d request rechecks the selected profile's existing `ws-token`, including
rotation. Invalid operator credentials are refused and `o8ro_` retains its 403
refusal. The owner applies the existing default-deny middleware and route auth
before accepting bodies or importing handlers. Forwarded requests carry only
method, path/query, body, bearer and content type; client-supplied principal,
peer and profile headers are discarded. A daemon-stamped canonical profile digest must
match the owner's profile. The upstream must be a numeric loopback address;
redirects and environment proxies are disabled. An unavailable owner returns
503 without retrying or duplicating writes.

SQLite saved reads remain read-only and reopen per request, preserving committed
WAL updates. Saved files, databases and their symlink targets remain bounded to
the selected profile; MCP profile headers cannot select HTTP data. o8d forwards
only the native route allowlist. Request and response bodies are capped at
16 MiB, matching the native response ceiling; saved input parsing retains its
64 MiB record guard. Rust implements no dispatch, merge, review or governance
policy. The shared lazy route registry hosts the existing handlers in the owner;
its WS checkpoint, transcript and headless-tick HTTP dependencies use that same
process when the opt-in is enabled. Dispatch readiness and the commentary feed
also retain their existing handlers. Core proxy event streams flush incrementally
with backpressure and cancellation instead of waiting for the handler to finish.
The owner runs the existing one-time transcript repairs before binding and warms
runtime and inbox state during owner readiness. These initialization
steps are limited to the owner opt-in.

## Native route inventory

Derived from [client.rs](../../native/o8-next/src/client.rs),
[grid_sessions.rs](../../native/o8-next/src/grid_sessions.rs),
[composer.rs](../../native/o8-next/src/composer.rs),
[diff.rs](../../native/o8-next/src/diff.rs) and their handlers.
The current client has ten JSON read paths, four write calls and a WebSocket
upgrade. Review and Git diff routes were added after the original seven-path
inventory. There is no separate terminal HTTP endpoint.

| Native request | Response | Handler and o8d support |
| --- | --- | --- |
| `GET /api/mobile/orchestrator/threads?limit=500` | `{threads:[{id,title,runtime,status,messageCount,lastMessageAt,projectId,repoPath,repoName,repoBranch,githubOwner,githubRepo,backend,agent,pinned}]}` | [threads](../../src/app/api/mobile/orchestrator/threads/route.ts). Saved JSON, backend/archive filtering, default 20, ceiling 500. |
| `GET /api/orchestrator/state` | `{mission,dag:{currentWave,totalWaves,waves},agents}` | [state](../../src/app/api/orchestrator/state/route.ts). The owner runs the existing mission synchronization, DAG and lane/status projection; saved-only mode supports empty missions without lanes. |
| `GET /api/runtime/inventory?fresh=1` | `{generatedAt,meta,squads,agents,events,artifacts}` | [inventory](../../src/app/api/runtime/inventory/route.ts). The owner performs live discovery; no invented persisted snapshot. Sidebar and grid both request it. |
| `GET /api/mobile/history?sessionKey=KEY&limit=100&page=1[&before=CURSOR]` | `{sessionKey,transcript,page:{revision,total,hasMore,beforeCursor}}`; invalid cursor: 409, `{ok:false,error,currentRevision}` | [history](../../src/app/api/mobile/history/route.ts). Rust serves saved `llm-chat:` records; runtime readers and lane overlays delegate to the owner. Grid also calls it without `page`: default tail 6, ceiling 100. Page ceiling 200. |
| `GET /api/v2/chat-history?tabId=ID&limit=100` | Saved record, normalized `projectId`, stable message IDs, GitHub identity, `messages` tail and `page`; invalid cursor: 409 | [context](../../src/app/api/v2/chat-history/route.ts). Native checks saved repository/backend and derives routing from model and receipts. |
| `GET /api/orchestrator/composer-queue?repoPath=PATH&threadId=ID&backend=ID` | `{items,canSteer,steerableIds}`; item: `sequence,id,repoPath,threadId,intent,payload,status,reason,createdAt,updatedAt,admittedAt` | [queue](../../src/app/api/orchestrator/composer-queue/route.ts). Target isolation, pending items plus last 40 applied steers. The owner evaluates live steering capabilities and visual receipts. |
| `GET /api/panel/ws-info` | `{wsPort,wsToken}` | [ws-info](../../src/app/api/panel/ws-info/route.ts). The owner uses the existing live-port resolver and profile credential; saved-only mode reads existing files. |
| `GET /api/orchestrator/review-state?packetId=ID` | Canonical packet/lane review, merge-gate and spoken-review evidence | Existing [review-state](../../src/app/api/orchestrator/review-state/route.ts) handler in the owner. |
| `GET /api/lanes/ID/diff?maxBytes=524288` | Bounded unified diff, files, HEAD and truncation metadata | Existing [lane diff](../../src/app/api/lanes/[id]/diff/route.ts) handler in the owner. |
| `GET /api/worktrees/diff?worktreePath=PATH[&baseBranch=BASE&file=FILE]` | Bounded unified diff, files, HEAD, revision and truncation metadata | Existing [worktree diff](../../src/app/api/worktrees/diff/route.ts) handler in the owner. |
| `POST /api/orchestrator/review` | `{packetId,reviewedHeadSha,approved,findings,clientMutationId}`; canonical review receipt or structured refusal | Existing [review](../../src/app/api/orchestrator/review/route.ts) handler in the owner, including governance and idempotency. |
| `POST /api/orchestrator/composer-queue` | Input `{repoPath,threadId,id,intent,payload:{text,wireMessage,images,routing}}`; output `{item}` | Forwarded to the existing TypeScript handler; saved-only mode returns 405. |
| `PATCH /api/orchestrator/composer-queue` | Input `{repoPath,threadId,id}`; output `{item}` | Forwarded to the existing TypeScript handler; saved-only mode returns 405. |
| `DELETE /api/orchestrator/composer-queue` | Input `{repoPath,threadId,id}`; output `{ok:true}` or 409 | Forwarded to the existing TypeScript handler; saved-only mode returns 405. |
| `GET /ws?token=CREDENTIAL` with WebSocket upgrade | 101 followed by connected/welcome, realtime batches/checkpoints and ping/pong frames; invalid credential: 401 | [WS server](../../src/ws-server.ts). Native sends `realtime-subscribe` and `ping`. The existing TypeScript WS owner produces checkpoints, replay and live events without a Next HTTP hop. |

The native transport obtains its WebSocket URL from `ws-info`, connects to
`/ws`, sends `realtime-subscribe` and `ping`, and consumes replay/checkpoint
envelopes. Those are not additional HTTP read routes. The existing delivery
slices do not provide an independent authoritative checkpoint producer.

Saved transcript entries preserve `id`, `role`, `text`, `type`, timestamp and
timestamp label, plus optional media, backend/model attribution, receipt,
tokens/cost, tool calls, sources, thinking, recalled facts, command, handoff and
compaction. The canonical definitions are in [mobile types](../../src/lib/mobile/types.ts).
Queue routing carries backend, model, effort, permission mode, wire mode and
collide selection, with optional project/service-tier/backend pins. The full
mission and packet fields are defined in [orchestrator types](../../src/lib/orchestrator/types.ts).

## Verification and measurements

`tests/o8d-next-http-real-path.test.ts` retains the original saved-read replay,
WAL, profile, byte-limit, credential and opt-in checks. Its new process test
starts the production WS entry point and o8d with an unreachable Next origin.
The headless probe compiles the actual native `Client` and models without GPUI,
then exercises discovery, context, pagination, queue and live WebSocket paths.
The suite also checks real queue mutations, credential rotation and owner
profile mismatch through HTTP.
An event-stream test holds its producer open and requires delivery of its first
event before completion.

`scripts/bench/next-owner.ts` starts the built repository standalone Next
server plus WS process, then o8d plus the opt-in WS owner after stopping that
reference cohort. Both use copies of the same owned SQLite, saved-history and
Git fixture, with two review packets and one owned runtime session/lane. The
runtime inventory and runtime transcript are nonempty. Public ports are reused
within each pair. Complete HTTP status/body pairs and native-client results
are compared without deleting fields. WebSocket comparisons include full
checkpoint and live mutation event payloads; per-process delivery envelope IDs
are covered by the existing WS parity tests. The seed is reconciled before
cloning, with canonical repaired histories and a completed worker parked at
review. Copies preserve file timestamps, and state is observed after its
inventory cache warms. A fixture clock freezes application timestamps while
leaving transport deadlines on wall time. Per-request seeded randomness makes
generated review receipt IDs comparable while preserving distinct IDs within
each request. Empty owned provider roots and a fixed fixture device identity
keep discovery independent of the test machine. Reports contain timings, RSS
and differing field paths, with small diagnostic values for fixture IDs and
state labels. Credentials and full response bodies are never recorded.

The native probe uses the production client for session discovery, history,
context, queue, diff/review reads, queue mutations, review writes and WebSocket
resolution/upgrade. Build it and the repository's production standalone Next
output before running the benchmark:

```sh
cargo build --locked --manifest-path tests/fixtures/next-client/Cargo.toml
O8_NEXT_OWNER_REFERENCE_MODE=production \
  O8_NEXT_OWNER_REPORT=work/next-owner-report.json \
  node --import=tsx scripts/bench/next-owner.ts
```

The default cohort has three paired runs, three route warmups and twenty timed
samples per successful read. RSS sums every process in each backend's process
tree, including compiler helpers, two seconds after the same activity. Native
replay operations prime lazy handlers immediately beforehand in both cohorts.
The production native client's five-second bound is unchanged. The comparative
test is opt-in with `O8_NEXT_OWNER_REFERENCE_MODE=production`; the ordinary test
run still exercises the no-Next owner, auth, persisted state and live streams.
The profiles include non-ASCII directory names; profile identity uses a digest
instead of transporting filesystem paths in headers. This is
a Linux fixture comparison against the production standalone Next server,
not a desktop measurement. Per-route p50/p95 and combined RSS
are recorded in the report and summarized in the PR. The 500 MiB target must be
assessed against those measurements; it is not inferred from o8d's RSS alone.
