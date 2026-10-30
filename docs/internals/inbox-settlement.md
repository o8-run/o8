# Inbox settlement server contract

Slice B01 of #5090 exposes persisted inbox metadata for the native sidebar.

`PATCH /api/v2/chat-history` accepts exactly one target and an action:

```json
{ "tabId": "thoughts-example", "inboxAction": "settle" }
```

A standalone runtime uses `sessionKey` instead of `tabId`. Actions are `settle`
and `unsettle`. Existing route authorization and optional `?workspace=` apply.
Malformed requests return 400, missing or out-of-workspace targets 404, and
running/request/queued blockers or child-worker targets 409. Unknown targets
never create chat history. Success returns `ok: true` plus the projection below.

These listings expose the same flat fields:

- `/api/mobile/orchestrator/threads`: each `threads[]` row.
- `/api/runtime/inventory`: each `agents[]` row.
- `/api/v2/chat-history/list`: each `conversations[]` row.

```json
{
  "inboxSubject": {
    "kind": "conversation",
    "id": "thoughts-example",
    "workspace": "/recorded/workspace",
    "projectId": null
  },
  "parentInboxSubject": null,
  "settledOverride": null,
  "settledAt": null,
  "unsettledAt": null
}
```

A conversation owns its worker packets. A child worker projects the parent's
`inboxSubject`, settlement fields, and a non-null `parentInboxSubject` equal to
that parent identity. Consumers can suppress duplicate child rows using this
lineage. A parentless worker has `kind: runtime`, its qualified session key as
`id`, and null `parentInboxSubject`. The newest lane binding owns reused sessions.
The persisted key uses kind, recorded canonical workspace and id; adding project
metadata later does not reset settlement.

Settlement is independent of archive and transcript storage. SQLite `app_state`
serializes inbox metadata; chat validation and pin clearing also hold the
canonical history lock. Settle never archives/deletes a conversation, stops a
worker, touches a worktree, or changes release state. Repeat settle preserves
`settledAt` unless the row was repinned. Repeat unsettle preserves `unsettledAt`.

An explicit active override remains until actual run activity. Conversation runs
record their busy/terminal events at the WS broadcast seam. Runtime runs use
lifecycle start markers or authentic provider transcript activity timestamps;
display timestamps, mtimes and metadata-only writes cannot clear an override.
Missing provider activity evidence retains the override. Runtime adapters may
expose `RuntimeTranscriptEntry.activityAt` when the timestamp is authoritative.

T3 Code provenance is recorded in the adapted sources, NOTICE.md and
licenses/t3code-MIT.txt. Exported server sidecars include the notice and license.
Native rendering, automatic settlement and later inbox state fields are separate
slices.

## Polling cost

Inventory checks SQLite `total_changes()` and `data_version` once per GET.
It reuses the newest lane identity per session only while both revisions match;
local writes, external commits and reopened database connections invalidate it.
Settlement guards continue to read fresh full lane records inside the mutation.
Listings read inbox metadata with one indexed `app_state` key-prefix query.
Canonical workspace paths share a module-level cache across reads and mutations,
bounded to 256 entries with a 30-second TTL; a request-local map avoids repeated
lookups within a listing. Subject keys are built once per subject object. History
rows use fixed-shape literals and look up state without temporary projection objects.

An unchanged runtime observation opens no write transaction and writes no
`app_state` rows. A newer observation rechecks persisted state inside the write
transaction before updating it. Inbox state snapshots are discarded after the
response; prepared read statements are reused per SQLite connection.

`node scripts/bench-inbox-listings.mjs origin/main` compares bundled Node 22 GET
handlers against the selected baseline's full source dependency graph. The
provider-discovery boundary returns the same fixed 40-agent snapshot to both
versions; 200 lanes, 500 saved conversations and runtime inbox metadata use real
temporary SQLite/filesystem storage. Each version receives 20 warmups and 200
measured requests, interleaved request by request, with alternating pair order.
The timer covers handler execution through response creation; status, row-count
validation and client JSON decoding occur afterward. This measures server handler
latency, excluding HTTP transport and provider discovery. Each percentile must be
within the baseline plus the larger of 10 percent or 5 ms.
