import { safeErrorText } from '@/lib/mcp/api-error';

type ControlCall = 'cortex_reconcile_shared_team' | 'cortex_finish_shared_team';
const REVIEW = 'Run cortex_shared_team_status, review the current diff, then retry with its exact review ID, HEAD and paths.';
const RECONCILE = 'Run cortex_shared_team_status, review and explicitly reconcile the preserved edits, then retry cortex_finish_shared_team.';

// These are fixed descriptions of known pre-write checkout holds. Do not echo
// arbitrary exceptions, path suffixes or subprocess output into a tool reply.
const HOLDS: Array<{ matches: RegExp; reason: string; next: string }> = [
  { matches: /^Checkout review is stale\./, reason: 'Checkout review is stale.', next: REVIEW },
  { matches: /^Pre-existing operator edits changed during this team:/,
    reason: 'Preserved operator edits changed during this team.', next: RECONCILE },
  { matches: /^Pre-existing operator edit fingerprints cannot be verified:/,
    reason: 'The original operator edit fingerprints could not be verified.', next: RECONCILE },
  { matches: /^Changes outside worker scopes need review:/,
    reason: 'Changes outside worker scopes need review.', next: RECONCILE },
  { matches: /^Team edits are still uncommitted:/,
    reason: 'Team edits are still uncommitted.', next: 'Run cortex_shared_team_status, review and commit only the team edits, then retry the control.' },
  { matches: /^Acknowledge every exact path in the reviewed checkout, without omissions or extra paths\.$/,
    reason: 'The acknowledged paths do not match the exact checkout review.', next: REVIEW },
  { matches: /^Nested repositories or special files need separate review:/,
    reason: 'Nested repositories or special files need separate review.', next: 'Run cortex_shared_team_status and review those files separately before retrying.' },
  { matches: /^Worker .+ is still active\. Wait for it to finish or interrupt it first\.$/,
    reason: 'A Shared worker is still active.', next: 'Wait for it to settle or interrupt it, then run cortex_shared_team_status before retrying.' },
  { matches: /^Worker .+ has no (?:settled launch|matching owned runtime completion) receipt\.$/,
    reason: 'A Shared worker has no verified completion receipt.', next: 'Run cortex_shared_team_status and inspect the worker outcome before retrying. Keep its edits in place.' },
  { matches: /^Shared checkout is busy; retry after its current operation\.$/,
    reason: 'Another checkout operation is still running.', next: 'Wait for it to finish, then retry the same control.' },
  { matches: /^Shared checkout lock is stale; inspect the owner before retrying\.$/,
    reason: 'The checkout operation lock is stale.', next: 'Inspect the current operation with cortex_shared_team_status before retrying. Keep the lock and edits in place.' },
  { matches: /^Reconciliation requires an explicit review summary\.$/,
    reason: 'Reconciliation requires an explicit review summary.', next: REVIEW },
  { matches: /^Finishing a Shared team requires a review summary and verification receipt\.$/,
    reason: 'Finish requires a review summary and verification receipt.', next: 'Provide both receipts, then retry cortex_finish_shared_team.' },
  { matches: /^There is no active Shared team in this checkout\.$/,
    reason: 'There is no active Shared team in this checkout.', next: 'Run cortex_shared_team_status and check the archived receipt before retrying; ownership may already be released.' },
  { matches: /^No independent checkout changes need reconciliation\./,
    reason: 'No independent checkout changes need reconciliation.', next: 'Run cortex_shared_team_status and review the team before trying cortex_finish_shared_team.' },
  { matches: /^Shared team review state disappeared\.$/,
    reason: 'The Shared team review state is no longer available.', next: 'Run cortex_shared_team_status and check whether the team already finished before retrying.' },
];

export function sharedCheckoutControlFailure(call: ControlCall, error: unknown): string {
  const hold = error instanceof Error ? HOLDS.find(entry => entry.matches.test(error.message)) : undefined;
  if (hold) return `${call} failed: ${hold.reason} ${hold.next}`;
  const detail = safeErrorText(error);
  const reason = detail === 'o8 operation failed' ? 'The cause of this checkout failure is unknown' : detail;
  return `${call} failed: ${reason}. Run cortex_shared_team_status and inspect the current outcome before deciding whether to retry; the control may already have completed.`;
}
