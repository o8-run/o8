import { describe, expect, it, vi } from 'vitest';

vi.mock('./pr-merge-membership', () => ({ prMergeMembership: vi.fn(async () => ({ packets: new Map(), unresolved: [], lanes: [] })) }));

import { assessPrMergeGate, countPrChecks } from './pr-merge-gate';

type Gate = Parameters<typeof assessPrMergeGate>;
const run = (name: string, conclusion: string | null, status = conclusion ? 'completed' : 'in_progress') => ({ name, status, conclusion, url: null });
const REQUIRED = ['Lint', 'Type Check'];

function pr(statusCheckRollup: ReturnType<typeof run>[], requiredChecks: string[] | null = REQUIRED) {
  return {
    number: 7, state: 'open', draft: false, mergedAt: null, mergeable: true, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
    baseRefName: 'main', headRefName: 'feat', headRepoFullName: 'example/workspace', githubScope: 'scope',
    githubIdentity: { repositoryId: 1, pullRequestId: 2 }, allowedMergeMethods: ['squash'], autoMergeEnabled: false,
    reviewDecision: 'APPROVED', checksUnavailable: false, statusCheckRollup, requiredChecks, mergeQueue: true,
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

  it('counts a required check that has not reported yet as pending', () => {
    expect(countPrChecks({ statusCheckRollup: [run('Lint', 'success')], requiredChecks: REQUIRED })).toMatchObject({ failedChecks: 0, pendingChecks: 1 });
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
