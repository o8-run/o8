# How o8 works

o8 is a local control plane for running AI coding agents with visible scope, isolated workspaces, review gates, and an audit trail.

## The operating model

You can start work from the desktop app, the `o8` CLI, or an MCP client. All three surfaces reach the same control plane and apply the same governance rules.

The core objects are:

- A **mission** is the goal the operator wants completed.
- A **packet** is one scoped unit of work within that goal.
- A **lane** is a particular execution attempt for a packet.
- A **runtime** is the adapter for an installed agent CLI.
- A **review** records findings against the resulting diff.
- An **approval** authorizes a consequential action such as integration.

The full terminology is in the [vocabulary](vocabulary.md).

## What happens during a run

1. The operator or orchestrator defines a goal and creates one or more packets.
2. o8 gives each dispatched packet an isolated git workspace and a bounded brief.
3. The selected runtime launches the worker and streams lifecycle events, output, and artifacts into its lane.
4. The operator can watch, steer, interrupt, retry, or rerun the work without leaving the control plane.
5. When work is ready, o8 presents the diff and review evidence.
6. An authorized operator approves, rejects, or returns the packet for another pass.
7. The completed outcome enters the audit ledger and can inform future work through Cortex.

The [canonical workflow](canonical-workflow.md) describes the loop in operational detail.

## Process boundaries

The Tauri desktop shell runs a local Next.js API and a separate WebSocket bridge. Runtime adapters launch installed agent CLIs; worktrees contain their file changes; SQLite and files under `~/.o8` hold control-plane state. The UI never needs to know a provider’s private session format because adapters normalize it.

The active orchestrator and the dispatched worker runtime are separate choices. Claude, Codex, OpenClaw, or another registered backend may plan a turn while a different runtime performs a packet.

## Safety and recovery

Workers use a documented [environment allowlist](./worker-environment.md). API access is default-deny, workers cannot silently bypass review, and merge authority depends on the caller’s principal. Persistent state lets o8 recover lanes and transcripts after process restarts, while explicit stop, retry, and rerun actions keep failures visible instead of guessing that work completed.

For the day-to-day operating loop, continue with the [orchestration playbook](orchestration-playbook.md).

## The loop in one picture

A mission is a goal. Each packet is a scoped unit of work, and each lane is the worker session that carries a packet through execution and review.

```
   you (or your orchestrator)
              │
        create mission ──▶ packets dispatched to workers
              │                 │  each in an isolated git worktree
              │                 ▼
              │            worker codes, reports, heartbeats
              │                 │
              ▼                 ▼
        review the diff ◀── work lands for review
              │
     approve ─┴─ reject / steer / rerun
              │
            merge  ──▶  audit trail, session ledger, memory
```

![One ask, three workers: the orchestrator splits the task into packets, each worker builds its page in its own worktree, and the plan and every tile report as they go](./assets/three-workers.gif)

*The canvas — a spatial view of the same fleet. Two agents done and waiting at the gate, one still working, and a browser card previewing the page they just built.*

Merges that fail don't silently die — a five-layer escalation chain (auto-retry → orchestrator escalation → steer the warm session → fresh redispatch → human card) means a lane always has a defined next step. Approvals can route to your phone. The whole loop is drivable three ways: **the app**, **the `o8` CLI**, or **MCP tools** from any MCP client — same verbs, same gates.
