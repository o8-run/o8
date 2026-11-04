import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

vi.mock('@/lib/cortex/spec-ingest', () => ({ ingestRepoSpecs: async () => ({ scannedFiles: 0, writtenDirectives: 0, deletedStaleDirectives: 0 }), purgeOrphanedSpecDirectives: vi.fn(() => ({ purged: 0 })) }));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: async () => {} }));
const root = mkdtempSync(path.join(os.tmpdir(), 'o8-remote-refresh-'));
process.env.CORTEX_IDE_DATA_DIR = path.join(root, 'data');
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;
const { addRepo, listRepos, listReposFresh, repairRepoRemotes, findRepoByLocalPath, getRepoRegistryPath } = await import('@/lib/repos/registry');
afterAll(() => rmSync(root, { recursive: true, force: true }));

it('returns the moved origin on a GET-path listRepos without changing registry bytes or mtime', async () => {
  const repoPath = path.join(root, 'read-only-repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
  const remoteUrl = 'https://github.com/organization/read-only.git';
  execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', remoteUrl]);
  const registryPath = getRepoRegistryPath();
  mkdirSync(path.dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({ version: 1, repos: [{
    id: 'read-only', name: 'read-only-repo', localPath: repoPath, isGitRepo: true,
    remoteUrl: 'https://github.com/previous/read-only.git', addedAt: new Date().toISOString(),
  }] }));
  const earlier = new Date(Date.now() - 60_000);
  utimesSync(registryPath, earlier, earlier);
  await listReposFresh();
  const before = readFileSync(registryPath);
  const mtime = statSync(registryPath, { bigint: true }).mtimeNs;
  const files = readdirSync(path.dirname(registryPath));

  expect((await listRepos()).find(repo => repo.id === 'read-only')?.remoteUrl).toBe(remoteUrl);
  expect((await findRepoByLocalPath(repoPath))?.remoteUrl).toBe(remoteUrl);
  expect(readFileSync(registryPath)).toEqual(before);
  expect(statSync(registryPath, { bigint: true }).mtimeNs).toBe(mtime);
  expect(readdirSync(path.dirname(registryPath))).toEqual(files);
});

it('persists a changed origin through explicit remote repair', async () => {
  const repoPath = path.join(root, 'repo');
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q', '-b', 'main', repoPath);
  git('-C', repoPath, 'remote', 'add', 'origin', 'https://github.com/personal/widgets.git');
  const entry = await addRepo(repoPath);
  const { purgeOrphanedSpecDirectives } = await import('@/lib/cortex/spec-ingest');
  await vi.waitFor(() => expect(purgeOrphanedSpecDirectives).toHaveBeenCalled());
  expect(entry.remoteUrl).toBe('https://github.com/personal/widgets.git');
  const before = JSON.parse(readFileSync(getRepoRegistryPath(), 'utf8')).repos.find((repo: { id: string }) => repo.id === entry.id);
  git('-C', repoPath, 'remote', 'set-url', 'origin', 'git@github.com:organization/widgets.git');
  expect((await listRepos()).find(repo => repo.id === entry.id)?.remoteUrl).toBe('git@github.com:organization/widgets.git');
  expect((await findRepoByLocalPath(entry.localPath))?.remoteUrl).toBe('git@github.com:organization/widgets.git');
  expect(JSON.parse(readFileSync(getRepoRegistryPath(), 'utf8')).repos.find((repo: { id: string }) => repo.id === entry.id)).toEqual(before);
  expect((await repairRepoRemotes()).find(repo => repo.id === entry.id)?.remoteUrl).toBe('git@github.com:organization/widgets.git');
  const saved = JSON.parse(readFileSync(getRepoRegistryPath(), 'utf8'));
  expect(saved.repos.find((repo: { id: string }) => repo.id === entry.id)).toEqual({ ...before, remoteUrl: 'git@github.com:organization/widgets.git' });
});

it('repairs moved remotes during the existing add maintenance writes', async () => {
  const repoPath = path.join(root, 'maintenance-repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
  const remoteUrl = 'https://github.com/organization/maintained.git';
  execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', remoteUrl]);
  writeFileSync(getRepoRegistryPath(), JSON.stringify({ version: 1, repos: [{
    id: 'maintenance', name: 'maintenance-repo', localPath: repoPath, isGitRepo: true,
    remoteUrl: 'https://github.com/previous/maintained.git',
  }] }));
  await listReposFresh();
  const addedPath = path.join(root, 'added');
  mkdirSync(addedPath);
  await addRepo(addedPath);
  await vi.waitFor(() => {
    const saved = JSON.parse(readFileSync(getRepoRegistryPath(), 'utf8'));
    expect(saved.repos.find((repo: { localPath: string }) => repo.localPath === repoPath).remoteUrl).toBe(remoteUrl);
  });
});

it('projects a linked worktree origin without creating state or erasing an offline remote', async () => {
  const repoPath = path.join(root, 'linked-repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
  const worktreePath = path.join(root, 'linked');
  execFileSync('git', ['-C', repoPath, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  execFileSync('git', ['-C', repoPath, 'worktree', 'add', '--detach', '-q', worktreePath]);
  const registryPath = getRepoRegistryPath();
  const remoteUrl = 'https://github.com/organization/linked.git';
  execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', remoteUrl]);
  const savedRemote = 'https://github.com/previous/linked.git';
  mkdirSync(path.dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({ version: 1, repos: [
    { id: 'linked', name: 'linked', localPath: worktreePath, isGitRepo: true, remoteUrl: savedRemote },
    { id: 'offline', name: 'offline', localPath: path.join(root, 'absent'), isGitRepo: true, remoteUrl: savedRemote },
  ] }));
  await listReposFresh();
  const before = readFileSync(registryPath);
  const repos = await listRepos();
  expect(repos.find(repo => repo.id === 'linked')?.remoteUrl).toBe(remoteUrl);
  expect(repos.find(repo => repo.id === 'offline')?.remoteUrl).toBe(savedRemote);
  expect(readFileSync(registryPath)).toEqual(before);
});
