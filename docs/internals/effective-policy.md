# Effective policy read

`EffectivePolicy` in `src/lib/lane/effective-policy.ts` is the exported
`o8/effective-policy/v1` contract. The API is `GET /api/lanes/:id/policy`
(lane or packet ID), registered on both Next and the native HTTP transport. CLI `o8 packet policy [id]` and MCP `get_effective_policy`
use that operator-only API. A missing lane returns 404. Reads do not cache,
fetch Git refs, populate the attribution fetch memo, dispatch work or publish.

The assumed execution actor is **orchestrator**, explicitly returned as `actor`.
`createPrApproval` comes from the same
`evaluatePolicy(buildLanePolicyContext(lane, 'create_pr', 'orchestrator', ...))`
call as execution. It describes an approval requirement, not a recorded grant.
The review-mode override is `O8_REVIEW_MODE` in the **API server environment**.

`nextAction.value` is a closed set:

- `human`: inspect the listed holds or uncertainty. This conservative projection
  surfaces any hold, including holds that concern merge or correction only.
- `approval_required`: obtain the existing create-PR approval card. This read
  never creates or approves the card. The result carries exactly one hold, with
  source `approval-posture`; any other hold yields `human` instead. Consumers
  must branch on `nextAction.value`, not on whether `holds` is empty.
- `prepare_pull_request`: preparation may proceed. Execute through the existing
  governed route, which must still check every unevaluated control.

Every hold has a closed `PolicyHoldSource`, a reason and `blocks` identifying
`create_pr`, `merge`, `correction` or automatic `review`. For example, `correction-bounds` blocks
sending another author correction, while `merge-hold` and `session-restriction`
block merging. The other sources are `unknown-state`, `review-mode`,
`review-risk`, `review-risk-uncertain`, `durable-review`, `packet-hold`,
`dogfood-guard`, `lane-state`, `missing-worktree`, `existing-pull-request`,
`scope-expansion`, `protected-test-change` and `approval-posture`.

`unevaluatedControls` is a closed list, currently `runMergeGate`,
`file-size-limit`, `contract-coverage`, `run-preflight`, `spoken-review-evidence`,
`publication-transaction` and `test-removals`. Protected test-control paths use
CI's existing `isProtectedPath` classifier on both sides of renames. General test assertion deletion or
weakening still belongs to CI's test-removal evaluation. Absence of a hold is
never clearance for an unevaluated control. Required but unevaluated contract
coverage also withholds durable approval in this projection.

Review risk comes from the latest persisted `review_risk_classified` event,
pinned to the exact HEAD and containing the review's diff-base provenance.
Legacy events without that identity, missing events, fallback bases and warnings
require human inspection. New warning provenance is a boolean, without raw Git
stderr. `comparisonRef` reports the comparison actually used
by the review summary (merge-base when available); the read never refreshes it.
Scope expansion reads the complete per-lane expansion ledger and packet markers,
without the recent-event display limit; its
acknowledgement is a maintainer decision.

Controls carry `value`, `source` and `precedence`: file maps to `saved`, env to
`run-effective`, and profile/default to `inherited`. Computed facts use `derived`.
`correctionBounds.maximum` uses `constant`; `used` is a derived persisted count.
`mergeMode` reports only the PR-only safety wall. **`direct` is not permission to
merge**, and `completion` remains `pull_request`.

`readAt` is observation time, not an authorization lease. Consumers must ignore
null `headSha`, compare a non-null `headSha` with the HEAD they act on, and refresh
after any policy, hold or revision change. Even an unchanged HEAD does not freeze
policy. Native UI, Inbox and future execution consumers must retain all current
authorization, review and publication gates.
