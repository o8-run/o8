# Review outcome reuse

Review submission and the automatic verdict writer save a bounded
`reusableOutcome` snapshot inside the existing review approval's `args_json`.
There is no separate service, database or completion outcome. The source review,
its findings, correction receipt and acceptance remain the audit trail.

The existing packet context builder retrieves observations only for the same
captured project and repository and an explicitly mentioned file or directory.
For a review covering several areas, only matching observations enter the brief.
Each entry includes its evidence revision, decision, source and finding
references, correction receipt when applicable, and retrieval reason.

Verification means an explicit operator decision, a completed independent review
turn bound to the reviewed revision, or structured reviewer-reported execution
evidence. These are distinct labels. A completed code review does not claim that
tests ran. Unattributed model verdicts cannot supply verified lessons.

Recall checks the current persisted review again. Superseded, failed, unresolved,
excluded, pending-second-pass and older-than-30-day verdicts are withheld with
reasons in the operator memory inventory. Age is measured from the verdict, even
when the automatic writer reuses an older approval row. Overlapping observations
from different sources are exposed as potential conflicts. All recalled material
is historical evidence requiring revalidation against current code and project
instructions; it never becomes a project rule or merge authorization.

The existing outcome inventory (`GET /api/cortex/recent-outcomes?inventory=1`)
adds `reviewOutcomes` and `reviewHasMore`, using the existing repository, project,
query, offset and limit parameters. Optional `packetBody` shows area applicability.
Inventory pagination is independent of the bounded contextual scan. Existing
approval surfaces inspect each source. Deleting a `review:<approval-id>` through
the existing outcome memory route records exclusion in the existing correction
exclusion ledger and advances the memory revision, preserving review history.

Repeated findings and explicit operator decisions are observations within the
bounded retained read window. Unknown interventions remain unknown. A retrieval
does not demonstrate reduced repeated work or a causal improvement. Suggested
checks and rules still need explicit approval and the normal reviewed change
workflow. This feature changes no instructions, permissions, provider defaults,
workers, publication gates or release state.
