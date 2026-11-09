import { resolveMergeTestReplayEnabledSync } from '@/lib/operator/defaults';
import { lintPreviewCheck, withCheckNote, type MergeCheckResult } from './preview-merge';
import { runLaneRebaseLint } from './rebase-lint';
import { runLaneRebaseTests, UNCONFINED_TESTS_NOTE } from './rebase-tests';
import { runLaneRebaseTypecheck } from './rebase-typecheck';

export type LaneRebaseVerifyResult =
  | { ok: true; checks: MergeCheckResult[] }
  | { ok: false; kind: 'typecheck' | 'lint' | 'tests'; output: string; checks: MergeCheckResult[] };

/**
 * The full post-rebase merge gate: typecheck, changed-file lint, then an
 * opt-in test replay against the rebased merged state. Returns a discriminated failure so the
 * caller can route to the layered escalation with the right kind label while
 * sharing the same 1-extra-turn retry budget.
 *
 * Test replay is gated on `mergeTestReplayEnabled` (default off) so existing
 * merges are unchanged until an operator opts in.
 */
export async function runLaneRebaseVerify(input: {
  cwd: string;
  /** The repository whose ESLint install lints the merge; never the lane's checkout. */
  installRoot?: string;
  baseRef: string;
  actualBranch: string;
  logPrefix: string;
}): Promise<LaneRebaseVerifyResult> {
  const typecheck = await runLaneRebaseTypecheck(input);
  if (!typecheck.ok) {
    return {
      ok: false,
      kind: 'typecheck',
      output: typecheck.output,
      checks: [
        { name: 'typecheck', verdict: 'fail', detail: typecheck.output },
        { name: 'lint', verdict: 'skipped', detail: 'Not run because typecheck failed.' },
      ],
    };
  }
  const checks: MergeCheckResult[] = [{
    name: 'typecheck',
    verdict: typecheck.skipped ? 'skipped' : 'pass',
    ...(typecheck.skipped ? { detail: typecheck.skipped } : {}),
  }];

  const lint = await runLaneRebaseLint(input);
  const lintCheck = lintPreviewCheck(lint);
  checks.push(lintCheck);
  if (!lint.ok) {
    return { ok: false, kind: 'lint', output: lintCheck.detail ?? lint.output, checks };
  }

  if (!mergeTestReplayEnabled()) {
    return { ok: true, checks };
  }

  const tests = await runLaneRebaseTests(input);
  // Test replay has no row of its own on the merge card, so an unconfined run
  // is said on the verification row beside it.
  if (tests.unconfined) lintCheck.detail = withCheckNote(lintCheck.detail, UNCONFINED_TESTS_NOTE);
  if (!tests.ok) {
    return { ok: false, kind: 'tests', output: withCheckNote(tests.output, tests.unconfined && UNCONFINED_TESTS_NOTE)!, checks };
  }

  return { ok: true, checks };
}

function mergeTestReplayEnabled(): boolean {
  try {
    return resolveMergeTestReplayEnabledSync();
  } catch {
    // Never let a settings read failure change merge behavior — default off.
    return false;
  }
}
