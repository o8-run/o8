import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

vi.mock('@/lib/providers/child-process', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/providers/child-process')>(),
  runPushChild: vi.fn(() => { throw new Error('Next must not launch the push helper'); }),
}));

it('pushes in-process through Next with the native transport unset', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'review-push-next-'));
  const repo = join(directory, 'repo');
  const remote = join(directory, 'remote.git');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'file'), 'initial\n');
  git('add', 'file');
  git('commit', '-qm', 'initial');
  git('init', '--bare', remote);
  git('remote', 'add', 'origin', remote);
  vi.stubEnv('O8_NEXT_O8D', undefined);
  const { runPushChild } = await import('@/lib/providers/child-process');
  try {
    const { POST } = await import('@/app/api/review/push/route');
    const response = await POST(new Request('http://fixture.invalid/api/review/push', {
      method: 'POST', body: JSON.stringify({ workspace: repo }),
    }));
    expect([response.status, await response.json()]).toEqual([200, {
      ok: true, branch: 'main', upstream: 'origin/main', message: 'Pushed main to origin/main',
    }]);
    expect(runPushChild).not.toHaveBeenCalled();
    expect(git('rev-parse', 'HEAD')).toBe(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim());
  } finally {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
