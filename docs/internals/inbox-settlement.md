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
