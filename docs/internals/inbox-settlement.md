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

These listings expose the same logical flat fields:

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

The example above is the full PATCH response shape (with `ok: true` on success)
and the mobile-thread listing shape. `/api/runtime/inventory` and
`/api/v2/chat-history/list` omit `parentInboxSubject`, `settledOverride`,
`settledAt` and `unsettledAt` when their value is null. An absent field means
null. Non-null values remain present. `inboxSubject` is always present on every
row: its presence is the native sidebar's inbox capability flag and settle guard.
Nested subject fields retain their existing nullable shape. PATCH responses keep
all four nullable fields explicitly, including null values.

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
rows build their added fields once without per-row spreads or temporary projection
objects. Preference fields are materialized only when non-null, so default
rows avoid unused property slots and JSON traversal; null inbox fields are omitted
during JSON encoding. No row-projection or
serialized-fragment cache is used.

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

Before each benchmark, `uptime` is recorded. The harness waits until the 1-minute
load is below 20 before warming and before taking each endpoint's measured
samples. It records load immediately before and after each measured cohort;
waiting for load is outside the handler timer. Acceptance requires both
percentiles of both endpoints to stay within budget in both complete runs.

## Pins, manual order and per-thread auto-settle preference (B02)

The same PATCH route accepts `pin`, `unpin`, `pin-reorder`, `active-reorder`
and `auto-settle`. These actions require `inboxRevision`, a nonnegative integer
from the latest listing (an absent revision means zero). Revision checks and
eligibility checks run inside the SQLite write transaction. A stale revision is
409, including a reorder raced by unpin, settlement or a newly observed run.
Existing settle/unsettle callers retain their B01 request shape.

```json
{ "tabId": "thoughts-example", "inboxAction": "pin", "inboxRevision": 0, "orderKey": "n" }
```

Pin accepts an optional `orderKey`; both reorder actions require it. A key is
null (clear manual order) or 1 to 256 lowercase ASCII letters with no trailing
`a`, using the upstream fractional-key alphabet. Keys compare lexically. Clients
construct keys between neighbors and apply section sorting; listing transport
order remains the existing server order. Reordering never changes transcript
`savedAt`, message timestamps or the activity anchor. Auto-settle preference uses
`{ "inboxAction": "auto-settle", "inboxRevision": 1, "enabled": false }` with
one target; false records `autoSettleDisabledAt`, true clears it. This is durable
preference storage, not an automatic settlement worker.

All three listings add `pinnedAt`, `pinOrderKey`, `activeOrderKey`,
`autoSettleDisabledAt` and `inboxRevision`. The two compact GET listings omit null
preference fields along with the B01 null fields. PATCH and mobile projections
return explicit null preference fields. An absent revision is zero; every actual
inbox write advances it. Repeated pin/disable preserves the original timestamp
and revision. Pinning a settled row promotes it to explicit active and clears
`settledAt`; unpin clears the pin order. Settle clears pin, pin order and active
order. Pin reorder requires a pin; active reorder rejects pinned or settled rows.
Archived histories reject these new preference actions. Snooze transitions are
not introduced by B02; conflicting snooze clearing belongs with B04's state.

Existing boolean pins without an inbox pin record project a fixed epoch
`pinnedAt` (`1970-01-01T00:00:00.000Z`). Their true pin time is unknown. This
migration is deterministic across restarts and transcript saves and performs no
listing writes. The next preference mutation persists it; new pins use the
server event time. Existing boolean pin PATCH callers also update inbox metadata.
An explicit inbox pin or unpin takes precedence over a stale transcript boolean.
Conversation child rows project their parent's preference fields and cannot be
independently pinned or reordered. Runtime observation and authentic WS activity
preserve pins, manual order and the per-thread opt-out.
