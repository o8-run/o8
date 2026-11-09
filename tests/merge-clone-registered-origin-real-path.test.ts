import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, it, vi } from 'vitest';

// The merge rebases a reviewed commit in a disposable clone and fetches the base
// there. The repository's own config may have been edited by its workers, so the
// clone fetches from the origin the operator registered and takes no key from
// that config that could run a command or redirect the fetch.
const root = realpathSync(mkdtempSync(join(os.tmpdir(), 'o8-merge-origin-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const registered = vi.hoisted(() => ({ repos: [] as Array<{ localPath: string; remoteUrl: string | null }> }));
vi.mock('@/lib/repos/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/repos/registry')>()),
  listReposFresh: async () => registered.repos,
}));

const { createDetachedIntegrationWorktree } = await import('@/lib/lane/worktree-merge-git');

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=o8 test',
  '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function bareWith(name: string, content: string): string {
  const seed = join(root, `${name}-seed`);
  git(root, 'init', '-q', '-b', 'main', seed);
  writeFileSync(join(seed, 'base.txt'), content);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', name);
  const bare = join(root, `${name}.git`);
  git(root, 'clone', '-q', '--bare', seed, bare);
  return bare;
}

it("fetches from the registered origin and runs nothing the repository's config names", async () => {
  const registeredOrigin = bareWith('registered', 'registered\n');
  const otherOrigin = bareWith('other', 'other\n');
  const repo = join(root, 'operator');
  git(root, 'clone', '-q', registeredOrigin, repo);
  const worktree = join(root, 'lane');
  git(repo, 'worktree', 'add', '-q', '-b', 'inline/pkt-origin', worktree, 'main');
  registered.repos = [{ localPath: repo, remoteUrl: registeredOrigin }];

  // The repository's config now names another origin and commands Git would run.
  const marker = join(root, 'command-ran');
  const command = join(root, 'upload-pack.sh');
  writeFileSync(command, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexec git-upload-pack "$@"\n`);
  chmodSync(command, 0o755);
  git(repo, 'remote', 'set-url', 'origin', otherOrigin);
  git(repo, 'config', 'remote.origin.uploadpack', command);
  git(repo, 'config', 'core.sshCommand', `${command} ssh`);
  git(repo, 'config', 'credential.helper', `!${command}`);
  git(repo, 'config', 'url.file:///nowhere/.insteadOf', registeredOrigin);
  git(repo, 'config', '--replace-all', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
  git(repo, 'config', 'http.proxy', 'http://127.0.0.1:9');
  git(repo, 'config', 'http.sslVerify', 'false');

  const integration = await createDetachedIntegrationWorktree({
    repoPath: repo,
    sourceWorktreePath: worktree,
    sourceSha: git(worktree, 'rev-parse', 'HEAD'),
  });
  try {
    expect(git(integration.path, 'config', '--local', '--get', 'remote.origin.url')).toBe(registeredOrigin);
    for (const key of ['remote.origin.uploadpack', 'core.sshCommand', 'credential.helper', 'url.file:///nowhere/.insteadOf',
      'http.proxy', 'http.sslVerify']) {
      expect(() => git(integration.path, 'config', '--local', '--get', key)).toThrow();
    }
    git(integration.path, 'fetch', '-q', 'origin', 'main');
    expect(git(integration.path, 'show', 'origin/main:base.txt')).toBe('registered');
    expect(existsSync(marker)).toBe(false);
  } finally {
    await integration.cleanup();
  }
}, 30_000);
