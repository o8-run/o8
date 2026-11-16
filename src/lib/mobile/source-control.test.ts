import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertPushBranch, mutateSourceControl, parsePorcelainStatus, readSourceControlStatus, sourceControlResponse, validateSourceControlPaths } from './source-control';

const registry = vi.hoisted(() => ({ findLaneBySession: vi.fn() }));
vi.mock('@/lib/lane/registry', () => registry);
const roots: string[] = [];
async function repo() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'mobile-source-control-'));
  roots.push(cwd);
  git(cwd, ['init', '-b', 'feature']);
  git(cwd, ['config', 'user.name', 'Test']);
  git(cwd, ['config', 'user.email', 'test@example.invalid']);
  return cwd;
}
function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
afterEach(async () => { registry.findLaneBySession.mockReset(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('porcelain v2', () => {
  it('reads staged, unstaged, untracked, renames, conflict and branch tracking records', () => {
    const result = parsePorcelainStatus([
      '# branch.head feature', '# branch.upstream origin/feature', '# branch.ab +3 -2',
      '1 M. N... 100644 100644 100644 a b staged.txt',
      '1 .M N... 100644 100644 100644 a b work tree.txt',
      '? new\nfile.txt', '2 RM N... 100644 100644 100644 a b R100 renamed file.txt', 'old file.txt',
      'u UU N... 100644 100644 100644 100644 a b c conflict.txt', '',
    ].join('\0'));
    expect(result).toMatchObject({ branch: 'feature', upstream: 'origin/feature', ahead: 3, behind: 2 });
    expect(result.files).toEqual([
      { path: 'staged.txt', index: 'M', worktree: '.', staged: true, unstaged: false, untracked: false },
      { path: 'work tree.txt', index: '.', worktree: 'M', staged: false, unstaged: true, untracked: false },
      { path: 'new\nfile.txt', index: '?', worktree: '?', staged: false, unstaged: false, untracked: true },
      { path: 'renamed file.txt', originalPath: 'old file.txt', index: 'R', worktree: 'M', staged: true, unstaged: true, untracked: false },
      { path: 'conflict.txt', index: 'U', worktree: 'U', staged: true, unstaged: true, untracked: false },
    ]);
  });
  it('handles no upstream, unborn and detached heads', () => {
    expect(parsePorcelainStatus('# branch.oid (initial)\0# branch.head feature\0')).toEqual({ branch: 'feature', upstream: null, ahead: 0, behind: 0, files: [] });
    expect(parsePorcelainStatus('# branch.head (detached)\0').branch).toBeNull();
  });
});

it.each(['../file', 'a/../b', '/tmp/file', 'C:\\file', '-option', 'a\\b', 'a\0b', '.', 'a//b'])('refuses unsafe path %j', value => {
  expect(() => validateSourceControlPaths([value])).toThrow();
});
it.each([[], null, 'all', [3], Array(1001).fill('a')])('refuses invalid path list %j', value => {
  expect(() => validateSourceControlPaths(value)).toThrow();
});
it('accepts literal pathspec syntax as a filename', () => { expect(validateSourceControlPaths([':(glob)*', 'a b'])).toEqual([':(glob)*', 'a b']); });
it.each(['main', 'master', 'trunk', null])('refuses protected or detached push %j', branch => {
  expect(() => assertPushBranch(branch, 'trunk')).toThrow();
});
it('permits a feature branch', () => { expect(() => assertPushBranch('feature', 'trunk')).not.toThrow(); });

it('stages literal files, unstages, commits only the index and reads status through route functions', async () => {
  const cwd = await repo();
  registry.findLaneBySession.mockReturnValue({ worktreePath: cwd, repoPath: '/unused' });
  await writeFile(path.join(cwd, 'a.txt'), 'first');
  await writeFile(path.join(cwd, 'b.txt'), 'other');
  const { POST: stage } = await import('@/app/api/mobile/source-control/stage/route');
  const { POST: commit } = await import('@/app/api/mobile/source-control/commit/route');
  const { GET: status } = await import('@/app/api/mobile/source-control/status/route');
  const request = (body: object) => new Request('http://localhost/api/mobile/source-control/stage', { method: 'POST', body: JSON.stringify({ sessionKey: 'thread-session', ...body }) });
  expect((await stage(request({ paths: ['a.txt'] }))).status).toBe(200);
  await writeFile(path.join(cwd, 'a.txt'), 'modified after staging');
  await mutateSourceControl(cwd, 'unstage', { all: true });
  expect(await readFile(path.join(cwd, 'a.txt'), 'utf8')).toBe('modified after staging');
  expect((await readSourceControlStatus(cwd)).files.every(file => file.untracked)).toBe(true);
  await stage(request({ paths: ['a.txt'] }));
  expect((await commit(request({ message: '  Initial change  ' }))).status).toBe(200);
  expect(git(cwd, ['log', '-1', '--format=%s']).trim()).toBe('Initial change');
  expect(git(cwd, ['ls-tree', '--name-only', 'HEAD']).trim()).toBe('a.txt');
  await writeFile(path.join(cwd, 'a.txt'), 'second');
  const response = await status(new Request('http://localhost/api/mobile/source-control/status?sessionKey=thread-session'));
  expect(await response.json()).toMatchObject({ ok: true, status: { branch: 'feature', upstream: null, files: [{ path: 'a.txt', unstaged: true }, { path: 'b.txt', untracked: true }] } });
  expect(registry.findLaneBySession).toHaveBeenCalledWith('thread-session');
  await mutateSourceControl(cwd, 'stage', { paths: ['b.txt'] });
  await mutateSourceControl(cwd, 'unstage', { paths: ['b.txt'] });
  expect((await readSourceControlStatus(cwd)).files.find(file => file.path === 'b.txt')?.untracked).toBe(true);
  await writeFile(path.join(cwd, '*.txt'), 'literal');
  await mutateSourceControl(cwd, 'stage', { paths: ['*.txt'] });
  expect((await readSourceControlStatus(cwd)).files.filter(file => file.staged).map(file => file.path)).toEqual(['*.txt']);
});

it('validates mutation requests and preserves hooks', async () => {
  const cwd = await repo();
  for (const message of ['', '  ', 'x'.repeat(4097), 'x\0y', 1]) await expect(mutateSourceControl(cwd, 'commit', { message })).rejects.toMatchObject({ code: 'invalid_message' });
  await expect(mutateSourceControl(cwd, 'commit', { message: 'valid' })).rejects.toMatchObject({ code: 'nothing_staged' });
  await expect(mutateSourceControl(cwd, 'stage', { all: 'yes' })).rejects.toThrow('all must be a boolean.');
  await expect(mutateSourceControl(cwd, 'stage', { all: true, paths: ['a'] })).rejects.toThrow('Provide paths or all, not both.');
  await writeFile(path.join(cwd, 'a'), 'a');
  await mutateSourceControl(cwd, 'stage', { all: true });
  await writeFile(path.join(cwd, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await expect(mutateSourceControl(cwd, 'commit', { message: 'blocked' })).rejects.toThrow();
  expect((await readSourceControlStatus(cwd)).files[0].staged).toBe(true);
});

it('returns 404 for unresolved checkouts, rejects malformed bodies and never exposes git errors', async () => {
  const response = await sourceControlResponse(new Request('http://localhost/?sessionKey=missing'), 'status');
  expect(response.status).toBe(404);
  expect((await sourceControlResponse(new Request('http://localhost/'), 'status')).status).toBe(400);
  expect((await sourceControlResponse(new Request('http://localhost/', { method: 'POST', body: '[]' }), 'stage')).status).toBe(400);
  registry.findLaneBySession.mockReturnValue({ worktreePath: '/missing-checkout' });
  expect((await sourceControlResponse(new Request('http://localhost/?sessionKey=x'), 'status')).status).toBe(404);
  const cwd = await repo();
  registry.findLaneBySession.mockReturnValue({ repoPath: cwd });
  const error = await sourceControlResponse(new Request('http://localhost/', { method: 'POST', body: JSON.stringify({ sessionKey: 'x', paths: ['absent'] }) }), 'stage');
  expect(await error.json()).toEqual({ ok: false, code: 'git_failed', error: 'Git operation failed. Check repository state and remote access, then retry.' });
});

it('publishes with upstream, refuses the real default branch and preserves a divergent pull', async () => {
  const cwd = await repo();
  await writeFile(path.join(cwd, 'a'), 'a');
  await mutateSourceControl(cwd, 'stage', { all: true });
  await mutateSourceControl(cwd, 'commit', { message: 'initial' });
  const remote = await repo();
  git(remote, ['checkout', '-b', 'trunk']);
  git(remote, ['config', 'receive.denyCurrentBranch', 'ignore']);
  git(cwd, ['remote', 'add', 'origin', remote]);
  git(cwd, ['push', 'origin', 'HEAD:trunk']);
  await mutateSourceControl(cwd, 'push', {});
  expect((await readSourceControlStatus(cwd)).upstream).toBe('origin/feature');
  git(cwd, ['checkout', '-b', 'trunk']);
  await expect(mutateSourceControl(cwd, 'push', {})).rejects.toMatchObject({ code: 'protected_branch' });
  git(cwd, ['checkout', 'feature']);
  git(remote, ['checkout', 'feature']);
  await writeFile(path.join(remote, 'remote'), 'remote');
  git(remote, ['add', '--', 'remote']); git(remote, ['commit', '-m', 'remote']);
  // Keep the remote default at trunk while advancing the feature branch.
  git(remote, ['checkout', 'trunk']);
  await mutateSourceControl(cwd, 'pull', {});
  expect(await readFile(path.join(cwd, 'remote'), 'utf8')).toBe('remote');
  await writeFile(path.join(cwd, 'local'), 'local');
  await mutateSourceControl(cwd, 'stage', { all: true }); await mutateSourceControl(cwd, 'commit', { message: 'local' });
  git(remote, ['checkout', 'feature']);
  await writeFile(path.join(remote, 'remote'), 'diverged');
  git(remote, ['add', '--', 'remote']); git(remote, ['commit', '-m', 'diverged']); git(remote, ['checkout', 'trunk']);
  const before = git(cwd, ['rev-parse', 'HEAD']);
  await expect(mutateSourceControl(cwd, 'pull', {})).rejects.toMatchObject({ code: 'pull_failed' });
  await expect(mutateSourceControl(cwd, 'push', {})).rejects.toThrow();
  expect(git(remote, ['show', 'feature:remote']).trim()).toBe('diverged');
  expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(before);
  expect(await readFile(path.join(cwd, 'remote'), 'utf8')).toBe('remote');
});


it('refuses an unknown default branch and invalid named remote', async () => {
  const cwd = await repo();
  await writeFile(path.join(cwd, 'a'), 'a');
  await mutateSourceControl(cwd, 'stage', { all: true });
  await mutateSourceControl(cwd, 'commit', { message: 'initial' });
  await expect(mutateSourceControl(cwd, 'push', {})).rejects.toMatchObject({ code: 'default_branch_unknown' });
  const remote = await repo();
  git(cwd, ['remote', 'add', 'origin', remote]);
  // An unborn remote advertises no default HEAD.
  await expect(mutateSourceControl(cwd, 'push', {})).rejects.toMatchObject({ code: 'default_branch_unknown' });
  git(cwd, ['config', 'branch.feature.remote', '.']);
  git(cwd, ['config', 'branch.feature.merge', 'refs/heads/feature']);
  await expect(mutateSourceControl(cwd, 'push', {})).rejects.toMatchObject({ code: 'invalid_remote' });
});
