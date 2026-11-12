# Persistent lead handoff

The lead handoff surface lets an authenticated terminal or external liaison start one durable o8 lead, send later instructions to that same lead, and wait for compact lifecycle receipts without paying for a new model turn just to ask for status.

This document describes the source contract. It is available only in builds that include issue #2541; a merged pull request is not proof that an installed app has been updated.

## Start a lead

Create a JSON brief with all six fields:

```json
{
  "objective": "Implement and verify the bounded change.",
  "scope": ["The named repository and issue."],
  "doneTests": ["The real entry point passes."],
  "nonGoals": ["No release or production deployment."],
  "budgets": ["One correction round."],
  "escalationCriteria": ["Operator approval or a genuinely blocked gate."]
}
```

Then admit the initial turn with explicit routing and an idempotency key:

```sh
o8 lead start \
  --repo /path/to/repo \
  --backend codex \
  --model gpt-5.6-sol \
  --effort high \
  --brief /path/to/brief.json \
  --idempotency-key issue-2541-start
```

The receipt returns a `lead.id`, a canonical `thoughts-*` thread, the fixed backend/model/effort selection, status, cursor, and latest turn. The lead uses the ordinary orchestrator backend and operator tools; it is not a mission or worker packet.

## Continue and reattach

```sh
o8 lead send <lead-id> \
  --message "Review the worker return and run the completion gates." \
  --idempotency-key issue-2541-review-1

o8 lead status <lead-id> --after 0
o8 lead wait <lead-id> --turn <admitted-turn-id> --after 0 --timeout 10m
```

Every send key is durable. Retrying the same key and message returns the admitted turn instead of launching twice. Different simultaneous sends queue in ordinal order. Omitted routing on follow-ups retains the original pins; explicit repo, thread, backend, model, or effort values must match the stored binding or the request fails before turn persistence or process launch.

The thoughts composer shares this admission only after its thread is bound to a persistent lead; ordinary unbound thoughts chats retain the legacy writer. A bound turn stores the full model-facing message separately from the cleaned user bubble, preserves Full versus Plan permission mode, and emits persisted queued and terminal status receipts. Image attachments are admitted only when the selected persistent backend supports them; unsupported attachments fail before the turn is stored or launched.

`status` and `wait` read SQLite receipts only and never call the lead model. `wait --turn` follows the admitted turn through any worker-review continuation rooted in that turn, so it returns that task's reviewed handback rather than remaining on its earlier `waiting_workers` receipt. A later, unrelated queued turn cannot replace that result. It long-polls in bounded 30-second slices and can resume from its cursor. Full conversation content remains in the normal thoughts transcript; compact receipts return only a bounded result preview.

## Worker review and terminal states

Workers dispatched by the lead carry the lead's thread and turn IDs. Review, failure, and context-needed returns are admitted as deduplicated turns on the same lead with the same provider session and routing pins. The lead must record a structured outcome with `o8 lead report`; completion requires a `completed` outcome with evidence plus no authoritative pending worker, review, or approval obligation. Process success, freeform prose, and the absence of workers are never completion proof.

A turn that exits without a structured report and has no outstanding worker obligation becomes
`unreported`, with reason `turn ended without an outcome report`. This is terminal for that turn,
not a completed handback. `o8 lead wait` prints the JSON receipt (including the turn id, status,
and reason) and exits immediately with code **7** (`lead_unreported`). The turn's `error` remains
null. Late reports are not supported after the provider exits; send new work or stop the lead.
Scripts that previously received `blocked` with exit 0 for this case now receive `unreported`
with exit 7. Failed workers, approval obligations, and active workers retain their respective
`blocked`, `needs_approval`, and `waiting_workers` states ahead of missing-report classification.

Human approval remains separate. A lead can surface `needs_approval`, but it cannot approve a card, grant itself merge authority, or bypass the existing governance inbox.

## Stop and recovery

```sh
o8 lead stop <lead-id> --reason "Operator stopped this bounded run."
```

Stop is persisted before the live lead process is interrupted. Queued, running, `waiting_workers`, and `unreported` lead turns become `stopped`, new sends are refused, and restart recovery cannot relaunch the lead. Stop does not implicitly kill already dispatched child workers; their later returns are consumed without waking the stopped lead. If a process dies during a turn without a stop, o8 preserves that turn as `interrupted`, marks the lead `blocked`, and requires an explicit new `lead send` to recover; it never guesses whether the interrupted provider caused side effects.

Only the operator principal can use this route. Worker, paired-device, spectator, and anonymous credentials are denied by the default-deny middleware.

## Offline verification

Run the deterministic no-network acceptance probe:

```sh
node scripts/verify-lead-handoff.mjs
```

It builds the CLI, starts an isolated authenticated route fixture, uses a fake finite provider executable, and verifies persisted launch/resume arguments, replay safety, concurrency, reattachment, worker-review return, stop recovery, and middleware authorization. It never calls a model API.
