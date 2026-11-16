# Mobile Control Service Contract

Issue: #17

## Purpose

This contract keeps the phone surface speaking to **Cortex IDE**, not directly to any one runtime.

The mobile app should never need to know whether the backing run is:
- OpenClaw
- ACP
- Codex
- Claude Code
- something else later

That translation belongs in the desktop/server-side control plane.

## Design rule

**Desktop is the heavy execution surface.**  
**Mobile is the remote operator surface.**

So the mobile contract optimizes for:
- inspect
- approve / deny
- steer
- pause / resume / stop
- review-ready awareness
- run-watch summaries
- deep-link to desktop when needed

## Core entities

### Session handle
A stable reference to an operator-visible runtime session.

```ts
interface MobileSessionHandle {
  id: string;
  sessionKey: string;
  runtime: string;
  title: string;
  status: 'idle' | 'running' | 'blocked' | 'reviewing' | 'waiting' | 'failed';
  currentTask: string;
  isPrimary?: boolean;
  isCurrentSession?: boolean;
}
```

### Inbox item
A mobile-optimized unit of attention.

```ts
interface MobileInboxItem {
  id: string;
  kind: 'alert' | 'approval' | 'review' | 'run_watch';
  severity: 'info' | 'success' | 'warning' | 'critical';
  title: string;
  detail: string;
  sessionKey?: string;
  timestampLabel?: string;
  actions: MobileControlAction[];
}
```

### Action
A provider-agnostic operator action.

```ts
interface MobileControlAction {
  kind:
    | 'inspect'
    | 'steer'
    | 'approve'
    | 'deny'
    | 'pause'
    | 'resume'
    | 'stop'
    | 'open_review'
    | 'open_desktop';
  label: string;
  sessionKey?: string;
  href?: string;
  destructive?: boolean;
  available: boolean;
  reasonUnavailable?: string;
}
```

## Required control-service endpoints

### 1. Inbox snapshot
Returns the current mobile-safe operator view.

```ts
GET /api/mobile/inbox
```

Returns:
- primary mirrored session
- visible sessions
- inbox items
- summary counts
- provider-safe note about what is live vs unavailable

### 2. Inspect history
Returns a concise session transcript / event tail.

```ts
GET /api/mobile/history?sessionKey=...
```

### 3. Action dispatch
Handles provider mapping centrally.

```ts
POST /api/mobile/action
{
  action: 'steer' | 'stop' | 'approve' | 'deny' | 'pause' | 'resume',
  sessionKey: string,
  payload?: object
}
```

## Adapter mapping rule

The control service owns provider translation.

Examples:
- OpenClaw `steer` -> `chat.send`
- OpenClaw `stop` -> `chat.abort`
- OpenClaw approval actions -> unsupported until a truthful approval primitive exists
- Review-ready item -> maps to repo/worktree/PR review snapshot, not runtime transport directly

## Truthfulness rule

The contract must distinguish between:
- **available now**
- **planned but not wired**

No fake actions.
No demo buttons pretending to work.

## First backing adapter

### OpenClaw-backed v1
The first real adapter should provide:
- inspect current mirrored sessions
- steer session
- stop active run
- review-ready summary from Git / GitHub / worktree lane
- live mirrored-session-first behavior

That is enough to make mobile real without pretending it already has full approval orchestration.

## Non-goals for v1

- full repo editing on phone
- giant file tree navigation
- branch surgery as a primary job
- runtime-specific UI branching in the mobile client

## Product outcome

If this contract is right, the phone becomes:
- a real operator inbox
- a blocker/approval surface
- a run-watch remote
- a lightweight review monitor

And the desktop remains:
- execution-heavy
- context-heavy
- review-heavy

## Paired phone read projections

These additions use the existing active device bearer gate, including relay
requests. Only GET is granted for the two new routes; operator APIs retain their
existing restrictions. Revocation removes the bearer from the active-token file.
There are currently no per-device repository grants in the device registry or
principal. The PR selector enumerates the paired desktop's visible thread history
(including the separately listed backend bucket) and follows durable PR associations only.
Query parameters cannot select another repository. Symon conversation scope grants
are specific to that conversation's tools and are not device repository grants.

- `GET /api/mobile/pull-requests` returns `{ pullRequests, updatedAt }`. Each open
  linked PR has `repository`, `number`, `title`, `state`, `draft`, optional
  `mergeQueueState` (boolean queue membership when known), `threadId`, `updatedAt`,
  and `checks: { passing, failing, pending, failingNames }`. Multiple associations
  for the same thread and PR collapse to one row. Rows sort by repository, PR
  number, then thread id. The provider detail reader supplies checks and draft
  facts; raw payloads, files and credentials are never returned. Failed reads
  return a generic 503, rather than presenting an empty successful snapshot.
- `GET /api/mobile/usage` returns `{ accounts, updatedAt }`. Each account has an
  opaque `id`, `runtime`, and `windows: [{ label, percentUsed, resetsAt }]`.
  Optional `account` fields are `organization`, `resetsLeft`,
  `credits: { amount, currency }`, and
  `extraUsage: { used: { amount, currency }, limit?: { amount, currency } }`.
  Unknown usage remains null. The shared capacity service supplies the snapshot;
  optional provider facts are omitted until available. Row ids remain stable for
  the server process lifetime and change on restart; underlying identity ids,
  configuration references, emails and credential-derived hashes are withheld.
- `GET /api/mobile/orchestrator/threads` adds `machineDisplayName` (the registered
  local display label), optional active `runStartedAt`, `pullRequestNumber`,
  `pullRequestState`, and `changeCount` (the linked PR's changed-file count).
  When multiple PRs are associated, the first in repository/number order supplies
  the compact row. Missing PR data omits those fields and cannot hide the thread.
  The response also carries `updatedAt` from thread and linked PR observations.
  Packet state stays on `/api/mobile/orchestrator/packets`: each agent now adds
  optional `orchestratorThreadId`, `packetStatus`, `rejected`, optional
  `outcome: 'merged'`, `workerLabel`, and `updatedAt`; the envelope adds
  `updatedAt`. This preserves multiple workers per thread and lets the phone use
  the desktop sidebar's attention rank, working-state and event-time selection
  instead of overwriting the existing thread status. Existing packet repo-path
  filtering and worktree diff counts still apply. Archived packets are excluded
  from the sidebar join, as on desktop.

The two new responses use private 15-second HTTP caches; thread and packet reads
use private 5-second caches. All retain stable ordering from their source or
explicit sort. These fields are additive; existing phones may ignore them.
