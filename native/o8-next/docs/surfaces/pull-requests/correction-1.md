# PR #4652 correction round 1

Both reported failures were reproduced first through headless GPUI controls and
the disposable production-route fixture. Fixture paths are canonicalized, and
the second workspace is a real linked Git worktree sharing the same repository.
The fixture uses no real account, installed application or operator-machine state.

## Red receipts

```text
pull_requests_non_comment_actions_preserve_unsent_notes
assertion `left == right` failed: draft must preserve text it did not post
  left: ""
 right: "Unsent review notes"
test result: FAILED. 0 passed; 1 failed

pull_requests_uncertain_delivery_is_shared_across_worktrees
assertion `left == right` failed: an uncertain write in worktree A must block another POST from worktree B
  left: 2
 right: 1
test result: FAILED. 0 passed; 1 failed
```

Independent review found an additional race: an acknowledgment rendered in one
window could clear a new request's hold. Its regression also ran red before the
attempt guard was added:

```text
a stale acknowledgment cannot clear a newer busy hold
test result: FAILED. 0 passed; 1 failed
```

A caret-movement case also ran red: a confirmed send did not clear an unchanged
draft because the editor revision also tracks selection. Ownership now compares
the complete original draft string, matching desktop, while the request body is
trimmed. Caret changes permit clearing; changed text or whitespace does not.

The bounded parity follow-up also started with a failing GPUI scene assertion:

```text
pull_requests_check_buckets_match_desktop
missing desktop check bucket failing
test result: FAILED. 0 passed; 1 failed
```

The caret-only case's retained red tail was:

```text
a successful send after caret movement must clear its own unchanged draft
test result: FAILED. 0 passed; 1 failed
```

## Corrections and green receipts

- Metadata actions send an empty comment field and leave unsent notes intact.
  Only a confirmed text-posting action can clear its originating, unchanged
  draft, including whitespace. Successful Convert to draft, Ready for review, auto-merge
  toggles and Close retain notes; a successful comment posts and clears them.
- Delivery holds now live in the GPUI app, keyed by case-normalized repository
  and PR number. Every workspace observes the same busy, uncertain and partial
  close state. Settlement survives destruction of the originating surface.
- Acknowledgment captures repository, PR and attempt; the handler rechecks the
  current selection, attempt, uncertainty and busy state. Old acknowledgments
  cannot release a newer busy or failed attempt. Completion cannot overwrite
  another attempt. An unrelated PR remains writable.
- Checks now use the same Failing, Running, Passed, Neutral, Skipped grouping
  and conclusion mapping as desktop. The production fixture supplies eleven
  cases, including uppercase, unknown and absent conclusions. The GPUI scene
  checks row membership and group order.

Before/after: unsent metadata-action notes go from empty to preserved; lost-response
POST count across worktrees goes from two to one. The new check-group test goes
from missing groups to all five groups with the correct rows.

```text
native PR/shell filter: 11 passed; 0 failed
desktop actions/delivery and production HTTP fixture: 3 files passed; 10 tests passed
```

The native tests are in `native/o8-next/src/surfaces/pull_requests/tests.rs`. The HTTP checks
use `tests/next-pull-requests-real-path.test.ts`; desktop comparison checks are
`src/components/desktop/pr-panel/PrPanelActions.test.ts` and
`src/components/desktop/pr-panel/PrDeliveryState.test.ts`.

TypeScript, fast typecheck, touched-file ESLint, native formatting, test
classification and scoped rule-check pass. No release, version, deployment or
publishing file changed. The existing parity table still lists the unported
controls; packet-linked merging and full desktop parity remain open.

Full `npm test` passed: 1,233 files passed, three skipped; 8,896 tests passed,
five skipped, zero failures. This resolves the initial run's scratch-enumeration
failure without changing release files.

The final full native run passed 47 tests with three explicit benchmarks ignored,
plus all seven CLI integration tests passed: 54 passed overall, zero failures.

The updated fixture scene measured 18.64 ms to first loaded-list
paint and 32.05 ms for detail selection. Twenty tab interactions
measured median 13.71 ms and p95 15.59 ms. These are headless
CPU scene callbacks, without native font shaping, GPU/compositor or physical
display measurement. See [raw samples](correction-1-timing.json).
