import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const routingMock = vi.hoisted(() => ({
  recommendRuntime: vi.fn(),
}));

vi.mock('@/lib/dispatch/routing', () => ({
  recommendRuntime: routingMock.recommendRuntime,
}));

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-mission-routing-lifecycle-'));

const { createMission } = await import('./mission');

function createRepo() {
  const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-mission-routing-repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  git('-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test', 'commit', '--allow-empty', '-m', 'init');
  return repoPath;
}

describe('createMission routing recommendation lifecycle', () => {
  it('does not resolve while recommendation logging is still pending', async () => {
    let releaseRecommendation: (() => void) | undefined;
    routingMock.recommendRuntime.mockImplementationOnce(() => new Promise((resolve) => {
      releaseRecommendation = () => resolve({ runtime: null, score: 0, evidence: {} });
    }));

    let missionSettled = false;
    const missionPromise = createMission({
      issues: [{ number: 90100, title: 'Await routing recommendation logging', body: '', url: '' }],
      repoPath: createRepo(),
      runtime: 'codex',
      constraints: '',
    }).then((result) => {
      missionSettled = true;
      return result;
    });

    await vi.waitFor(() => {
      expect(routingMock.recommendRuntime).toHaveBeenCalledOnce();
      expect(releaseRecommendation).toBeTypeOf('function');
    });

    try {
      expect(missionSettled).toBe(false);
    } finally {
      releaseRecommendation?.();
      await missionPromise;
    }
  });
});
it.each(['typo-runtime', 42, false])('refuses invalid per-issue runtime %j through createMission', async runtime => {
  const calls = routingMock.recommendRuntime.mock.calls.length;
  await expect(createMission({
    issues: [{ number: 90101, title: 'Validate issue runtime', body: '', url: '', runtime: runtime as never }],
    repoPath: createRepo(), runtime: 'codex', constraints: '',
  })).rejects.toThrow(/Unknown requested runtime/);
  expect(routingMock.recommendRuntime).toHaveBeenCalledTimes(calls);
});
