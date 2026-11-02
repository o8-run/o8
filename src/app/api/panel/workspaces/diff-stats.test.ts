import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseShortstat, readLocalDiffStats, resetDiffStatsForTest } from './diff-stats';

describe('readLocalDiffStats', () => {
  beforeEach(() => resetDiffStatsForTest());

  it('coalesces concurrent reads for one cwd into one git run per diff', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const git = vi.fn(async () => { await gate; return ' 2 files changed, 5 insertions(+), 1 deletion(-)'; });
    const a = readLocalDiffStats('/repo', true, git);
    const b = readLocalDiffStats('/repo', true, git);
    expect(a).toBe(b);
    release();
    await expect(a).resolves.toEqual({ additions: 5, deletions: 1, changedFiles: 2 });
    expect(git).toHaveBeenCalledTimes(1);
  });

  it('serves the TTL cache, then reads again after it expires', async () => {
    let clock = 1_000;
    const git = vi.fn(async () => ' 1 file changed, 1 insertion(+)');
    await readLocalDiffStats('/repo', true, git, () => clock);
    await readLocalDiffStats('/repo', true, git, () => clock);
    expect(git).toHaveBeenCalledTimes(1);
    clock += 31_000;
    await readLocalDiffStats('/repo', true, git, () => clock);
    expect(git).toHaveBeenCalledTimes(2);
  });

  it('sums branch and working-tree diffs for a workspace', async () => {
    const git = vi.fn(async (args: string[]) => args.includes('origin/main..HEAD')
      ? ' 3 files changed, 10 insertions(+), 2 deletions(-)'
      : ' 1 file changed, 1 deletion(-)');
    await expect(readLocalDiffStats('/ws', false, git)).resolves.toEqual({ additions: 10, deletions: 3, changedFiles: 4 });
  });

  it('keeps the old null shape for clean trees and git failures', async () => {
    expect(parseShortstat('')).toBeNull();
    await expect(readLocalDiffStats('/x', true, async () => { throw new Error('boom'); })).resolves.toBeNull();
  });
});
