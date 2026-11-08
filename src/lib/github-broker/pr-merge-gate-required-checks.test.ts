import { describe, expect, it, vi } from 'vitest';

vi.mock('./pr-merge-membership', () => ({ prMergeMembership: vi.fn(async () => ({ packets: new Map(), unresolved: [], lanes: [] })) }));

import { assessPrMergeGate, countPrChecks } from './pr-merge-gate';

type Gate = Parameters<typeof assessPrMergeGate>;
const run = (name: string, conclusion: string | null, status = conclusion ? 'completed' : 'in_progress') => ({ name, status, conclusion, url: null });
const REQUIRED = ['Lint', 'Type Check'];

function pr(statusCheckRollup: ReturnType<typeof run>[], requiredChecks: string[] | null = REQUIRED, requiredStatuses: Array<{ context: string; state: string }> = []) {
  return {
    number: 7, state: 'open', draft: false, mergedAt: null, mergeable: true, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
    baseRefName: 'main', headRefName: 'feat', headRepoFullName: 'example/workspace', githubScope: 'scope',
    githubIdentity: { repositoryId: 1, pullRequestId: 2 }, allowedMergeMethods: ['squash'], autoMergeEnabled: false,
    reviewDecision: 'APPROVED', checksUnavailable: false, statusCheckRollup, requiredChecks, requiredStatuses, mergeQueue: true,
  } as unknown as Gate[1];
}
const discussion = { githubScope: 'scope', reviews: [], reviewsIncomplete: false } as unknown as Gate[2];
const gate = (p: Gate[1]) => assessPrMergeGate('example/workspace', p, discussion);

describe('merge gate counts only the checks GitHub requires', () => {
  it('lets a PR merge while an optional scanner fails, and says so', async () => {
    const result = await gate(pr([run('Lint', 'success'), run('Type Check', 'success'), run('Secret Findings (optional)', 'failure')]));
    expect(result.allowed).toBe(true);
    expect(result.checks.find(c => c.name === 'pr-optional-checks')).toMatchObject({ verdict: 'skipped', detail: expect.stringContaining('Secret Findings (optional)') });
  });

  it('refuses when a required check fails, for merge and for the queue', async () => {
    const result = await gate(pr([run('Lint', 'failure'), run('Type Check', 'success')]));
    expect(result.allowed).toBe(false);
    expect(result.autoMergeAllowed).toBe(false);
  });

  it('allows the queue but not a direct merge while required checks run', async () => {
    const result = await gate(pr([run('Lint', 'success'), run('Type Check', null)]));
    expect(result.allowed).toBe(false);
    expect(result.autoMergeAllowed).toBe(true);
  });

  it('does not list skipped or neutral optional runs as failing', () => {
    expect(countPrChecks({ statusCheckRollup: [run('Lint', 'success'), run('Type Check', 'success'), run('Weekly', 'skipped'), run('Info', 'neutral')], requiredChecks: REQUIRED }))
      .toEqual({ failedChecks: 0, pendingChecks: 0, optionalFailures: [] });
  });

  it('keeps refusing a required check that ends neutral or skipped', () => {
    expect(countPrChecks({ statusCheckRollup: [run('Lint', 'neutral'), run('Type Check', 'skipped')], requiredChecks: REQUIRED }).failedChecks).toBe(2);
  });

  it('enforces required commit statuses, which the check-run read does not carry', async () => {
    const runs = [run('Lint', 'success'), run('Type Check', 'success')];
    expect((await gate(pr(runs, REQUIRED, [{ context: 'ci/legacy', state: 'SUCCESS' }]))).allowed).toBe(true);
    const pending = await gate(pr(runs, REQUIRED, [{ context: 'ci/legacy', state: 'PENDING' }]));
    expect([pending.allowed, pending.autoMergeAllowed]).toEqual([false, true]);
    const failed = await gate(pr(runs, REQUIRED, [{ context: 'ci/legacy', state: 'ERROR' }]));
    expect([failed.allowed, failed.autoMergeAllowed]).toEqual([false, false]);
  });

  it('treats every check as required when GitHub did not name them', async () => {
    const result = await gate(pr([run('Lint', 'success'), run('Secret Findings (optional)', 'failure')], null));
    expect(result.allowed).toBe(false);
    expect(result.autoMergeAllowed).toBe(false);
  });

  it('keeps the queue closed for anything other than running checks', async () => {
    const draft = { ...(pr([run('Lint', 'success'), run('Type Check', null)]) as object), draft: true } as Gate[1];
    expect((await gate(draft)).autoMergeAllowed).toBe(false);
  });
});
