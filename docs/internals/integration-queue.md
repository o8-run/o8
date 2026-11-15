# Integration queue preparation

The server slice of #5819 stores one operator-invoked queue per registered
repository. It prepares evidence for an operator decision. It does not drain
in the background, dispatch corrections or invoke a publication operation.
Existing review, merge, approval, coordination and publication gates still run
through their owning paths.

## Entry points

- `GET /api/repos/:id/integration-queue` reads the saved queue and projects fresh
  eligibility and evidence validity without writing, fetching or checking code.
- `POST /api/repos/:id/integration-queue` saves a specification, prepares an
  isolated candidate and runs its explicitly declared required checks.
- `o8 integration-queue read --repo-id <id>` reads the same route.
- `o8 integration-queue prepare --repo-id <id> --spec queue.json` prepares it.
- MCP `o8_integration_queue` takes `repoId`, `action` (`read` or `prepare`), and,
  for preparation, `targetRef`, `changes` and `checks`.

All entry points require the existing operator credential. Worker credentials
cannot read or prepare this state. A client timeout is an unknown request
outcome: read the queue before explicitly requesting another preparation. MCP
preparation disables automatic HTTP retries.

Example specification:

```json
{
  "targetRef": "refs/heads/main",
  "changes": [
    { "id": "parent-packet" },
    { "id": "dependent-packet", "dependsOn": ["parent-packet"] },
    { "id": "independent-packet" }
  ],
  "checks": [
    {
      "name": "required-behavior",
      "command": "node",
      "args": ["scripts/check-behavior.mjs"],
      "timeoutMs": 120000
    }
  ]
}
```

IDs can name lanes, packets or adopted external review tasks. Repeated aliases
for one task are refused. Check names and task IDs must be unique. At least one
required check is mandatory; no saved default or existing test-replay setting
is changed. Commands run as argv in the owned checkout through the existing
confined-process runner. The receipt reports when that runner fell back to an
unconfined process. Check output is not copied into queue state; it may contain
credentials or filesystem details. Receipts retain the check name, exit code
and confinement result.

The operator declares the required check set. Dependencies are not installed,
environment files are not copied, services are not started, and checks do not
borrow another checkout's branch-green status. Missing tooling or a check that
cannot complete leaves a failure for an operator to inspect. Passing this set
does not establish that the publication path's other controls passed.

## Ordering and eligibility

Every entry consumes `readEffectivePolicy` at its current source HEAD. Its
`nextAction=human` reason holds the entry. `approval_required` permits preparing
evidence but grants no approval. The complete effective policy, including the
publication mode and unevaluated controls, remains readable in the plan. In
particular, the current effective-policy contract conservatively holds adopted
PR lanes with an existing PR; queue preparation does not reinterpret that hold.

Declared dependencies combine the specification and canonical packet
`dependencyPacketIds`. Git ancestry detects dependencies between selected heads.
The existing file-overlap detector and merge-order recommendation couple only
overlapping predecessors. Explicit dependencies take precedence over ordering
preferences. Unknown dependencies and cycles have entry blockers. Unreadable
changed paths make overlap safety unknown for the whole proposed combination.
Shallow or unreadable ancestry, or a source history exceeding the bounded
100,000-commit scan, also requires operator inspection. An independent eligible entry can proceed while unrelated entries are held.

An unselected dependency is satisfied only with canonical, same-repository,
HEAD-pinned release evidence whose merge commit is an ancestor of this target.
A live dependency checkout must still match the released HEAD. The saved
receipt identity participates in the input hash. A release flag alone is not
completion proof. Peer holds, branch retargeting and deletion remain with their
existing coordination owners; preparation changes none of them.

## Evidence and recovery

The existing cross-process `repo-tree` resource lease gives one repository
integration owner admission at a time, composing with governed repository
publication actions. Concurrent preparation returns busy immediately.

Preparation clones into a private, detached workspace, integrates eligible
source SHAs in the saved order, then runs checks on that combined tree. It never
moves the target or any source ref. Tracked modifications or a changed HEAD
from a check invalidate its result. Candidate checkouts are removed afterwards;
source heads, target SHA, candidate commit/tree identity, order, full declared
inputs and check receipts remain durable.

Versioned records live beneath the configured data directory in
`integration-queue`. Writes sync a private temporary file and atomically rename
it. No database migration is required. Failed and blocked attempts remain in
history. A record that would exceed the 8 MiB read bound is refused before
replacing the readable record; archiving requires an operator decision.
Malformed records are held for recovery and never silently replaced.

Reads compare the full fresh declared input hash, excluding observation time,
with the saved attempt. Moved target/source heads, adopted revisions, repaired
work, changed dependencies, policy/holds or check definitions make the evidence
stale. Preparation always reruns checks; results are never cached across
preparations. If inputs move during verification, the original execution
outcome and reason remain under `execution` while `status` becomes `stale`.
The hash is an observation boundary, not a lease or publication authority.

A fresh process can read the same receipts. After reacquiring ownership, another
explicit preparation marks an unfinished attempt interrupted and builds a new
candidate. Every attempt records `publication=not_requested`; this slice has no
merge receipt to replay and cannot repeat a merge. Conflicts and failed combined
checks produce one candidate-scoped operator decision with all participating
source identities. Matching error text never establishes a shared root cause
or creates duplicate author corrections.

## Remaining slices

Native UI needs a repository queue list with source/target revisions, declared,
detected and satisfied dependencies, overlap reasons, policy holds, candidate
identity, check results, invalidation and preserved attempt history. It needs
explicit prepare/busy/retry controls, immediate feedback, retained context on
failure, stable background refresh, keyboard access, hidden scrollbars,
light/dark and compact/wide layouts, and reduced-motion evidence. No native UI
ships here.

The existing governed publication owner must later consume freshly validated
candidate evidence and reconcile its own publication receipts without replay.
Established common-cause correction ownership must compose with #5818; this
slice leaves failures with an operator and never infers a root cause. Installed
acceptance on concurrent real tasks and release inclusion remain separate from
these source and fixture receipts. #5819 and #5815 remain open.
