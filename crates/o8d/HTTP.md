# Experimental saved HTTP reads

## Native shell transport with Next stopped

Shell work for #4547: `O8_NEXT_O8D=1 O8_WS_O8D=1` on the existing WS entry
point exposes the registered native surfaces through o8d's authenticated
TypeScript backhaul. Build o8d with `experimental-ws` and select it with
`O8D_BINARY` as described in [README.md](README.md). Point the native client's
explicit `--server` at the resolved WS origin, with `O8_NEXT_API_TOKEN` for that
profile. Stop Next after the WS listener is ready. Native startup, saved reads,
surface writes and the WS checkpoint producers use that listener. The native
CLI's default API-origin selection is unchanged.
WS producer requests select this listener only when their path and method are
registered. Unregistered conflict reads, Symon turns and other methods retain
the existing Next origin when Next is available.

This mode reuses production route handlers and `panelGateMiddleware`; it does
not reimplement their stores, account checks, profile filtering or response
shapes. The HTTP relay's original peer is unverified, so local-only producer
reads also require a bearer; public peer/address headers cannot grant local
authority. After the middleware gate admits a lane-diff GET, an authoritative
packet-worker token lookup restores that handler's local-worker admission;
the handler then rechecks the bearer against the requested packet. Unknown,
revoked and foreign-packet workers remain refused. Dynamic route parameters
are decoded per request; queries, account headers, HTTP status,
cooldowns and response headers reach the original handlers. Brain SSE is passed
incrementally with backpressure, and a disconnected consumer cancels its reader.
That cancellation does not claim to stop inference inside the existing handler.
Uploads are bounded at 16 MiB; the native client's existing 16 MiB read ceiling
and each handler's validation remain in effect.

The flag is off by default. The existing WS listener, default API origin and
standalone saved-read mode below retain their behavior. Rust's existing
TypeScript fallback also exposes the same registered routes during a bridge
restart. This requires the WS TypeScript process; it does not claim a Rust-only
application backend.

The transport inventory is maintained in
[native-http-registry.ts](../../src/lib/ws-server/native-http-registry.ts) and its
[named handlers](../../src/lib/ws-server/native-http-handlers.ts). Request and
response contracts are the existing handlers linked there. The
[HTTP adapter](../../src/lib/ws-server/native-http-routes.ts) and WS producer
fetcher select routes from that same registry:

| Surface | Requests | Request / response contract |
| --- | --- | --- |
| Session / Grid | GET threads, state, inventory, history, chat-history, composer-queue, ws-info; POST/PATCH/DELETE composer-queue | Existing session/transcript/queue projections below; queue writes keep their original routing, receipts and target isolation. |
| Settings | GET/POST operator-defaults; GET/POST/PATCH/DELETE keys | Native defaults projection and provider-key metadata; account headers and handler validation retained. |
| Setup | GET/POST setup config; GET/POST chat-history; existing defaults and repository requests | Existing first-run configuration, selected coding tools and saved conversation creation. |
| Projects | GET projects and panel projects; POST projects, repos and active project; PATCH/DELETE project and member routes | Project/repository ledgers; IDs, canonical workspace paths and original mutation bodies. |
| Issues | GET repos, issues and issue number; POST create and enhance | Repository selection, issue pages/details, creation/enhancement request and response. |
| Inbox | GET supervisor-inbox and approvals; POST approvals | Existing inbox projection and approval ID/action decision. |
| Brain | POST cortex/ask | Question/conversation/workspace body; original SSE event stream or validation refusal. |
| Customize | GET inventory, directives, MCP servers and prompt library; GET/POST/PATCH/DELETE prompt entries | Existing inventories and saved-prompt revision checks; no new configuration writes. |
| Diff | GET review-state, lane diff and worktree diff; POST review | Existing packet/workspace query and decision receipt. |
| Activity | GET commits, CI/list/detail, PR details, issues and state; PATCH state; POST stop-mission | Existing activity projections and mission mutation receipts. |
| Pull Requests | GET PR list/detail, GitHub status and merge-preview; POST PR detail | Existing pagination, review/merge gates and action receipts. |
| Terminal | Existing WebSocket transport | No separate native terminal HTTP route. |

`tests/o8d-next-surfaces-real-path.test.ts` walks `register_surfaces!`, requires
a transport entry for every surface, checks production handler methods and
literal native endpoints, and exercises every registered method's auth through
the public o8d socket with the fixture Next listener closed. It also checks
saved history, native session checkpoints, canonical paths, stream disconnects,
concurrent prompt revisions, upload bounds and flag-off behavior.
`tests/server-bundles-packaged-layout-real-path.test.ts` runs the generated
WS entry with the packaged platform-specific addon layout and no Next listener.
The [review round 1 receipt](evidence/next-surfaces-review-round-1.txt) records
the origin-selection and packet-worker regressions, their fixes, and the
first-run Setup registrations required after rebasing on current main.

The [fixture measurement receipt](evidence/next-surfaces-metrics.json) records
252.29 MiB / 1.50% CPU with Next stopped and 969.18 MiB / 1.50% with a warmed
development Next server running. These are backend process-tree sums after
20 seconds of settling, measured over 10 seconds, with one core equal to 100%.
Per-route latency uses 10 warmups and 100 alternating samples per server.
The native binary builds, but cannot open a GPUI window in this executor without
DISPLAY or Wayland. The receipt excludes that exited process. Production/native
combined memory and CPU, macOS evidence, the 500 MB target and full-surface
request replay remain unverified; fixture/backend figures do not meet those
acceptance items.

## Standalone persisted-read mode

This is a partial slice of [#4547](https://github.com/o8-run/o8/issues/4547).
It does **not** replace the Next server for the current native startup path.
Runtime discovery, mission reconciliation and live streams still need their
TypeScript owners. Saved history is exercised through the same native client
and GPUI test context used by the composer tests.

Build with `cargo build --locked --manifest-path crates/o8d/Cargo.toml
--features experimental-http --bin o8d`. Select the profile explicitly:

```sh
crates/o8d/target/debug/o8d --experimental-http \
  --listen 127.0.0.1:0 --data-dir "$O8D_PROFILE_DIR"
```

The first stdout line reports the ephemeral listener. Both the Cargo feature
and runtime flag are required. Existing launches and ports are unchanged. This
mode has no upstream, credential creation, migration, reconciliation or writer.

The existing profile's `ws-token` authorizes each request, including rotation.
Invalid operator credentials are refused; `o8ro_` callers retain their 403
refusal. Other principal capabilities are not implemented here. The selected
directory bounds history and database reads, including symlink targets. These
HTTP handlers have no MCP profile parameter: `x-o8-mcp-profile` selects MCP tools,
not native HTTP data. Neither that header nor a query can widen the data profile.

SQLite opens with `READ_ONLY`, without `CREATE`, journal changes or `immutable`.
Each request reopens the database so WAL commits and replacements are visible.
SQLite may use normal shared-memory locking; database and WAL bytes remain
unchanged. JSON files are never repaired or rewritten. The response ceiling is
the native client's 16 MiB, with a 413 refusal above it. A separate 64 MiB input
record guard bounds parsing; the TypeScript file reader has no such guard.

## Native route inventory

Derived from [client.rs](../../native/o8-next/src/client.rs),
[grid_sessions.rs](../../native/o8-next/src/grid_sessions.rs),
[composer.rs](../../native/o8-next/src/composer.rs) and their handlers at main
revision `40c8ab24e`. Seven JSON HTTP paths, three write methods and a WebSocket
upgrade are called.
Packets and diffs arrive inside responses or WebSocket envelopes; the current
client calls no separate packet, diff or terminal HTTP endpoint.

| Native request | Response | Handler and o8d support |
| --- | --- | --- |
| `GET /api/mobile/orchestrator/threads?limit=500` | `{threads:[{id,title,runtime,status,messageCount,lastMessageAt,projectId,repoPath,repoName,repoBranch,githubOwner,githubRepo,backend,agent,pinned}]}` | [threads](../../src/app/api/mobile/orchestrator/threads/route.ts). Saved JSON, backend/archive filtering, default 20, ceiling 500. |
| `GET /api/orchestrator/state` | `{mission,dag:{currentWave,totalWaves,waves},agents}` | [state](../../src/app/api/orchestrator/state/route.ts). Persisted empty missions with no lanes only; otherwise 503. |
| `GET /api/runtime/inventory?fresh=1` | `{generatedAt,meta,squads,agents,events,artifacts}` | [inventory](../../src/app/api/runtime/inventory/route.ts). 503: live discovery has no canonical persisted snapshot. Sidebar and grid both request it. |
| `GET /api/mobile/history?sessionKey=KEY&limit=100&page=1[&before=CURSOR]` | `{sessionKey,transcript,page:{revision,total,hasMore,beforeCursor}}`; invalid cursor: 409, `{ok:false,error,currentRevision}` | [history](../../src/app/api/mobile/history/route.ts). Saved `llm-chat:` records without lane overlays. Grid also calls it without `page`: default tail 6, ceiling 100. Page ceiling 200. |
| `GET /api/v2/chat-history?tabId=ID&limit=100` | Saved record, normalized `projectId`, stable message IDs, GitHub identity, `messages` tail and `page`; invalid cursor: 409 | [context](../../src/app/api/v2/chat-history/route.ts). Native checks saved repository/backend and derives routing from model and receipts. |
| `GET /api/orchestrator/composer-queue?repoPath=PATH&threadId=ID&backend=ID` | `{items,canSteer,steerableIds}`; item: `sequence,id,repoPath,threadId,intent,payload,status,reason,createdAt,updatedAt,admittedAt` | [queue](../../src/app/api/orchestrator/composer-queue/route.ts). Target isolation, pending items plus last 40 applied steers. Dynamic Codex/Pi capability returns 503. |
| `GET /api/panel/ws-info` | `{wsPort,wsToken}` | [ws-info](../../src/app/api/panel/ws-info/route.ts). Existing profile files only. No live port probe, credential generation or environment/default-port fallback. No WebSocket bridge starts. |
| `POST /api/orchestrator/composer-queue` | Input `{repoPath,threadId,id,intent,payload:{text,wireMessage,images,routing}}`; output `{item}` | TypeScript owns writes. o8d returns 405. |
| `PATCH /api/orchestrator/composer-queue` | Input `{repoPath,threadId,id}`; output `{item}` | TypeScript owns writes. o8d returns 405. |
| `DELETE /api/orchestrator/composer-queue` | Input `{repoPath,threadId,id}`; output `{ok:true}` or 409 | TypeScript owns writes. o8d returns 405. |
| `GET /ws?token=CREDENTIAL` with WebSocket upgrade | 101 followed by connected/welcome, realtime batches/checkpoints and ping/pong frames; invalid credential: 401 | [WS server](../../src/ws-server.ts). Native sends `realtime-subscribe` and `ping`. The HTTP mode does not bridge the existing delivery mode to authoritative producers. |

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

## Verification and replay

`tests/o8d-next-http-real-path.test.ts` uses production middleware, handlers
and stores. Only external runtime observation and the Clerk wrapper are fixture
replacements. It replays `tests/fixtures/next-http/requests.json` against both
listeners, comparing complete status/body pairs. No timing fields are removed.
Recordings contain no credentials. For URL-based replay, supply the credential
through `O8_NEXT_API_TOKEN` and run:

```sh
node --import=tsx scripts/next-http-parity.ts --reference=ORIGIN \
  --candidate=ORIGIN --recording=FILE --fixture-repo=PATH
```

The Rust `saved_history_surface_with_only_o8d` test uses the production client
and `Surface::select`, reads a saved list, loads the 100-message page/context/
queue and paints in GPUI TestAppContext. Its Node seeder exits before o8d starts;
no TypeScript HTTP process remains. It bypasses full sidebar discovery and does
not establish ordinary CLI startup parity.

Set `O8_NEXT_HTTP_BENCH_REPORT` to an owned output file while running the HTTP
suite to measure six supported projections: 10 warmups and 100 alternating-order
samples per server. The reference is an HTTP adapter using real Next handlers,
**not** a running Next server. The report includes timings and o8d RSS, never
credentials or bodies. Run the benchmark test alone after building, without
simultaneous checks. These measurements do not establish combined system RSS.

Recorded Linux cloud run, Node 22.23.4, Rust 1.99.1, optimized o8d: **5,880 KiB
(5.74 MiB) backend RSS**. The fixture has 3 sessions, 132 saved messages, an empty
mission, no lanes and one queued send. Each cell is **p50 / p95 milliseconds**,
from 100 samples after 10 warmups. Server order alternates; compilation, type
checking and other test suites finished before this cohort. The TypeScript
reference has its normal warm caches; Rust reopens files and SQLite and resolves
Git metadata per request. This small-fixture run shows mixed latency results.

| Route projection | TypeScript adapter before selection | o8d after selection |
| --- | ---: | ---: |
| Sidebar | 1.36 / 3.07 | 8.73 / 17.83 |
| Empty mission | 2.17 / 3.23 | 3.06 / 5.44 |
| Paged transcript | 9.07 / 12.57 | 4.26 / 12.86 |
| Context | 1.10 / 2.03 | 2.75 / 3.72 |
| Queue | 1.31 / 2.60 | 3.16 / 4.07 |
| WS information | 1.19 / 2.37 | 0.68 / 1.15 |

Regenerate with `O8D_HTTP_TEST_BINARY` pointing to the optimized binary and
`O8_NEXT_HTTP_BENCH_REPORT` pointing to an owned scratch file, then run
`npx vitest run tests/o8d-next-http-real-path.test.ts -t 'measures per-route'`.
The raw report is generated locally; no credentials or payloads are retained.

## Remaining acceptance

- Full native startup, including fresh runtime inventory and grid workers.
- Nonempty/active mission normalization, lane/status evidence and DAG parity.
- Durable huddle/steer overlays and runtime-owned/discovered transcript readers.
- Dynamic steering capability parity, non-operator principals and ws-info live
  probe/fallback behavior.
- Full Next-server/native versus o8d/native idle RSS and per-route measurements.
  GPUI TestAppContext and the HTTP adapter are not substitutes for those numbers.

These gaps keep #4547 open. No 500 MB system-memory target is claimed.
