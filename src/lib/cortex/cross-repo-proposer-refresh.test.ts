import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const listRepos = vi.hoisted(() => vi.fn(async () => []));
const recurring = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('@/lib/repos/registry', () => ({ listRepos }));
vi.mock('@/lib/background-work/ledger', () => ({ recurring }));

beforeEach(() => { vi.resetModules(); listRepos.mockClear(); recurring.mockClear(); });
afterEach(() => { vi.useRealTimers(); });

it('computes at boot without starting a timer', async () => {
  const { ensureCrossRepoProposerBootTick } = await import('./cross-repo-proposer');
  ensureCrossRepoProposerBootTick();
  await new Promise((done) => setImmediate(done));
  await vi.waitFor(() => expect(listRepos).toHaveBeenCalledTimes(1));
  expect(recurring).not.toHaveBeenCalled();
});

it('serves a fresh snapshot from cache and refreshes a stale one in the background', async () => {
  const { readCachedCrossRepoProposals } = await import('./cross-repo-proposer');
  const first = await readCachedCrossRepoProposals();
  expect(listRepos).toHaveBeenCalledTimes(1);

  await readCachedCrossRepoProposals({ now: first.computedAt + 60_000 });
  expect(listRepos).toHaveBeenCalledTimes(1);

  const stale = await readCachedCrossRepoProposals({ now: first.computedAt + 5 * 60_000 });
  expect(stale.computedAt).toBe(first.computedAt);
  await vi.waitFor(() => expect(listRepos).toHaveBeenCalledTimes(2));
});

it('recomputes inline when forced or after the cache is cleared', async () => {
  const { invalidateCrossRepoProposerCache, readCachedCrossRepoProposals } = await import('./cross-repo-proposer');
  await readCachedCrossRepoProposals();
  await readCachedCrossRepoProposals({ force: true });
  expect(listRepos).toHaveBeenCalledTimes(2);
  invalidateCrossRepoProposerCache();
  await readCachedCrossRepoProposals();
  expect(listRepos).toHaveBeenCalledTimes(3);
});
