# Fleet State Model

This doc is the first implementation pass for issue **#8**.

## Principle

The product is centered on **agents, runs, and squads**, not on the file explorer.
That means status semantics have to be explicit and shared across desktop, mobile, and runtime adapters.

## Agent statuses

### `idle`
The agent is attached or available, but not actively executing a task.

### `running`
The agent is actively executing work.

### `waiting`
The agent is paused on an expected dependency that is not yet a failure:
- missing input
- queued follow-up
- scheduled later step

### `reviewing`
The agent is not blocked, but the current bottleneck is review/approval rather than execution.

### `blocked`
The run cannot continue without intervention:
- missing permission
- runtime error
- missing contract
- broken environment

### `failed`
The run ended unsuccessfully and is no longer making progress.

## Squad statuses

### `healthy`
No material blockers; throughput is normal.

### `watching`
The squad is moving, but there are enough warnings or pending approvals that it needs operator attention soon.

### `degraded`
The squad is producing output, but quality, speed, or reliability is impaired.

### `blocked`
The squad cannot currently make forward progress.

## Why this matters

Karpathy’s thread makes legibility a requirement.
The operator must be able to glance at the system and answer:
- who is moving
- who is idle
- who is blocked
- which squad needs attention
- whether the bottleneck is execution, review, or missing context

## Implementation note

These statuses are encoded in:
- `src/lib/fleet/types.ts`
