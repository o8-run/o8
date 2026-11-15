# Inbox decisions

`GET /api/panel/inbox/decisions` is an operator-only, uncached read on both
HTTP transports. `o8 inbox decisions` and MCP `get_inbox_decisions` consume the
same API. This supplies the native Inbox's future decision view; it adds no
browser pages, event store, notification pipeline or execution authority.

The projection joins durable lanes, review queue attempts, saved packet reviews,
correction delivery receipts and the existing effective policy read. A task has
at most one unresolved row for its current revision, including after replacement
lanes. An uncertain correction delivery keeps that task unresolved even after
terminal state until its existing delivery receipt is reconciled. Ordinary
running work and queued reviews are progress, rather than fresh decisions.

IDs derive from durable task identity and current HEAD. `revisionToken` also
changes with policy holds, saved findings and delivery outcomes. Routine events
and read timestamps do not change it. Null HEAD is uncertainty. Neither an ID,
token nor `readAt` is an authorization lease or an approval argument.

Rows expose task, opaque repository identity, phase, responsible runtime/session,
policy blockers, attempt totals and bounded receipt identities, saved review
identity, evidence links and one primary next step. Repository identity is an
opaque digest of the registered lane checkout identity; consumers should use
project/task context for display rather than treating it as a registry ID.
`human`, `approval_required` and `prepare_pull_request` come from effective
policy; an uncertain delivery conservatively requires human inspection.
Primary actions are GET handoffs to current policy, required approvals or
correction inspection. Evidence links open the existing lane diff/activity,
review-state and correction availability routes. A read creates no approval,
model turn, correction, verification or publication. Native mutation controls
must use the existing correction/verification/publication production routes,
re-read state and retain their exact revision and authority checks. Old rows
have no primary action and cannot submit approval for a newer revision.

Query parameters (also exposed by CLI/MCP):

- `state`: `unresolved` (default), `history` or `all`.
- `projectId`: exact project ID (`--project` in CLI).
- `limit`: 1 through 100 task candidates per page, default 25. Candidates are
  paged before state filtering to bound policy reads; an empty filtered page can
  still have a next cursor.
- `cursor`: the last lane ID returned in `nextCursor`. Continue until null.

History derives from terminal task state and distinct prior review HEADs,
including completed supersession receipts and manually recorded review events. It is a current projection of saved
receipts, rather than a reconstructed policy snapshot. Earlier revisions omit
current policy, review verdict and responsible agent. Evidence links still open
current task context; receipt IDs and HEAD identify the earlier attempt.
Each task exposes at most ten earlier revision summaries and fifty review and
correction receipt identities. `historyTruncated` signals additional activity;
open the existing activity trace to inspect it. No new history is persisted.

Source verification uses `tests/inbox-decisions-real-path.test.ts` through the
native HTTP registration and authenticated route with real Git and reopened
SQLite state, including CLI and registered MCP calls. Native drawing,
selection/focus/draft retention and installed interaction acceptance belong to
the later native UI task. Source completion is separate from installed
acceptance and release inclusion.
