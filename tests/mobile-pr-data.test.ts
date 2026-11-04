import { QueryClient } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { mergeMobilePullRequest, mobileMergeAvailable, type MobilePullRequestDetail } from '@/lib/mobile/pull-requests';

const pr: MobilePullRequestDetail = { number: 7, title: 'Fixture', state: 'open', headSha: 'a'.repeat(40), changedFiles: 2,
  mergeable: true, reviewDecision: null, statusCheckRollup: [], allowedMergeMethods: ['rebase'],
  mergeGate: { allowed: true, snapshot: 'b'.repeat(64), checks: [] } };
const context = { beforeRead: vi.fn(), headers: {}, client: new QueryClient(), epoch: 1 };
it('refuses an unapproved merge in the data layer before any route call', async () => {
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
  try {
    await expect(mergeMobilePullRequest(context, 'example/project', pr)).rejects.toThrow('Confirm merge');
    expect(fetchMock).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
it('requires an open mergeable head, a server gate, and an allowed merge method', () => {
  expect(mobileMergeAvailable(pr)).toBe(true);
  for (const patch of [{ state: 'closed' }, { draft: true }, { mergeable: false }, { headSha: '' },
    { mergeGate: undefined }, { mergeGate: { ...pr.mergeGate!, allowed: false } }, { allowedMergeMethods: [] }]) {
    expect(mobileMergeAvailable({ ...pr, ...patch })).toBe(false);
  }
});
