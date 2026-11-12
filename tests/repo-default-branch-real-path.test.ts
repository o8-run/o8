import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { GitProbeError, resolveDefaultBranch } from '@/lib/repos/registry';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-default-branch-')));
let seq = 0;
function repo(branch: string, options: { commit?: boolean } = {}) {
  const directory = join(root, `repo-${++seq}`);
  execFileSync('git', ['init', '--quiet', `--initial-branch=${branch}`, directory]);
  if (options.commit !== false) {
    execFileSync('git', ['-C', directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '--allow-empty', '-m', 'fixture']);
  }
  return directory;
}

afterEach(() => { vi.unstubAllEnvs(); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('resolveDefaultBranch', () => {
  it('falls through absent refs to the branch that exists', async () => {
    expect(await resolveDefaultBranch(repo('master'))).toBe('master');
    expect(await resolveDefaultBranch(repo('main'))).toBe('main');
    expect(await resolveDefaultBranch(repo('trunk'))).toBe('trunk');
  });

  it('prefers the remote HEAD when origin names one', async () => {
    const directory = repo('trunk');
    execFileSync('git', ['-C', directory, 'update-ref', 'refs/remotes/origin/release', 'HEAD']);
    execFileSync('git', ['-C', directory, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release']);
    expect(await resolveDefaultBranch(directory)).toBe('release');
  });

  it('answers main only when every probe ran and found nothing', async () => {
    expect(await resolveDefaultBranch(repo('trunk', { commit: false }))).toBe('main');
    expect(await resolveDefaultBranch(join(root, 'not-a-repo'), false)).toBe('main');
  });

  it('surfaces a repository git cannot read instead of answering main', async () => {
    const directory = join(root, 'broken');
    mkdirSync(directory);
    writeFileSync(join(directory, '.git'), `gitdir: ${join(root, 'missing-git-dir')}\n`);
    const result = resolveDefaultBranch(directory);
    await expect(result).rejects.toBeInstanceOf(GitProbeError);
    // Git's wording varies by version; the error names the probe and carries git's own fatal message.
    await expect(resolveDefaultBranch(directory)).rejects.toThrow(/git symbolic-ref --quiet refs\/remotes\/origin\/HEAD failed: fatal: /);
  });

  it('surfaces a git binary that cannot be started instead of answering main', async () => {
    const directory = repo('master');
    const emptyPath = join(root, 'empty-path');
    mkdirSync(emptyPath, { recursive: true });
    vi.stubEnv('PATH', emptyPath);
    await expect(resolveDefaultBranch(directory)).rejects.toBeInstanceOf(GitProbeError);
  });
});
