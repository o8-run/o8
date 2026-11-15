# Review backlog admission

Part of #5820 and #5815. This server slice does not enable automation or change
saved defaults. It consumes the effective policy read from #6183; that read
remains the source for review mode, holds and what may happen next on a lane.

The API server can opt in with `O8_REVIEW_BACKPRESSURE='{"high":6,"low":3}'`.
Both integers are required, with `0 <= low < high <= 1000`. There is no inferred
capacity or inherited threshold. Leaving the variable unset preserves dispatch
and review scheduling behavior. Invalid configuration or unreadable latch/backlog
state holds new implementation for operator inspection with a concrete reason.

The rule is: hold new implementation above high, and keep holding until the
review/integration backlog is at most low. A lane counts once: pending or active
review jobs, plus lanes still reviewing or merging after their review job has
settled. The latter are reported as integration depth, including PR preparation
and human decisions still waiting after review. These are existing lane states,
not a new integration queue. Pending jobs on paused or held lanes still count.
An orphaned job makes the observation unknown and requires inspection.

Admission runs at the existing scheduler and again before storage reservation
after asynchronous launch preflight. The SQLite `app_state` latch is updated in
an immediate transaction. It survives coordinator restart and is separate from
packet queue holds and Stop. Held tasks remain queued, carry a `Review backlog:`
reason, and are reconsidered on the next existing dispatch tick. Storage/load
guards, launch idempotency and lease ownership still apply. `force` does not
bypass this guard. Running or already reserved work, recovery, external review,
bounded correction, decomposition and read-only work are not new implementation.
This policy never cancels a running worker or starts a reviewer/merge loop.

When opted in, review claims use project round-robin (repository identity when
no project is saved). Within the selected project, work waiting five minutes
since its last attempt goes first, then work unblocking dependencies, then queue
order and stable ID. Retries restart that attempt's aging clock. The durable
project cursor and claim update share one immediate transaction. Two continuously
eligible projects alternate even when one keeps retrying. The fixed three-slot
ceiling also counts durable active claims across coordinators. Existing recovery
reclaims abandoned leases. Review execution consults effective policy for controls
that block review; a publication or correction hold does not become review authority.
Existing route readiness, session contention and runtime checks remain in force;
this scheduler neither selects a provider/model nor changes effort or machine.

`GET /api/orchestrator/status`, `o8 mission status --mission <id>` (JSON), and MCP
`get_mission_status` expose `backpressure`: bounds, source, latch state, depth,
oldest wait, durable active reviews, and up to eight per-lane effective-policy waiting reasons (two reads at a time).
`waitingTotal` and `waitingTruncated` identify incomplete samples; use the existing
per-lane policy read for the remaining items.
`availableReviewCapacity` is null and `capacityStatus` is unknown: unused slots
are not proof of available route/runtime resources. Measurements count retained
merged lane outcomes, observed user interrupt/stop events, and persisted
per-claim queue waits. Other operator interventions remain unmeasured. No savings
or throughput improvement is inferred from worker counts. Reads do not latch,
claim, launch, publish or clear holds. The existing access boundaries are unchanged.

No schema migration is needed. The two namespaced `app_state` rows hold the
admission latch and bounded project cursor; queue-wait receipts use lane events.

The native UI slice remains: show these bounds and source, backlog depth/age,
unknown capacity and the held task reason with its human recovery path. Preserve
selection, drafts, keyboard focus and scroll position during refresh, give busy
feedback for existing mutations, and supply native light/dark, compact/wide,
keyboard and reduced-motion evidence. Configuration currently uses the server
environment; an editable native policy surface remains separate work. Installed
acceptance, composed integration-queue acceptance after #5819, and release
inclusion have not been claimed by this source change.
