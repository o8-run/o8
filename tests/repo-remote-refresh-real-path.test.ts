import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

vi.mock('@/lib/cortex/spec-ingest', () => ({ ingestRepoSpecs: async () => ({ scannedFiles: 0, writtenDirectives: 0, deletedStaleDirectives: 0 }), purgeOrphanedSpecDirectives: () => ({ purged: 0 }) }));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: async () => {} }));
const root = mkdtempSync(path.join(os.tmpdir(), 'o8-remote-refresh-'));
process.env.CORTEX_IDE_DATA_DIR = path.join(root, 'data');
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;
const { addRepo, listRepos, findRepoByLocalPath, getRepoRegistryPath } = await import('@/lib/repos/registry');
afterAll(() => rmSync(root, { recursive: true, force: true }));

it('refreshes and persists a changed origin through registry listing and path lookup', async () => {
  const repoPath = path.join(root, 'repo');
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q', '-b', 'main', repoPath);
  git('-C', repoPath, 'remote', 'add', 'origin', 'https://github.com/personal/widgets.git');
  const entry = await addRepo(repoPath);
  expect(entry.remoteUrl).toBe('https://github.com/personal/widgets.git');
  git('-C', repoPath, 'remote', 'set-url', 'origin', 'git@github.com:organization/widgets.git');
  expect((await listRepos()).find(repo => repo.id === entry.id)?.remoteUrl).toBe('git@github.com:organization/widgets.git');
  expect((await findRepoByLocalPath(entry.localPath))?.remoteUrl).toBe('git@github.com:organization/widgets.git');
  const saved = JSON.parse(readFileSync(getRepoRegistryPath(), 'utf8'));
  expect(saved.repos.find((repo: { id: string }) => repo.id === entry.id).remoteUrl).toBe('git@github.com:organization/widgets.git');
});
