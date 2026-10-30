import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RepoRegistryEntry } from '@/lib/repos/types';

// Records every git subprocess the route spawns while delegating to the real
// execFile, so the restore fast path can prove it never shells out.
const gitSpawns = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const promisifiedExecFile = promisify(actual.execFile);
  const execFile = Object.assign(
    (...args: Parameters<typeof actual.execFile>) => {
      if (args[0] === 'git') gitSpawns.calls.push((args[1] as string[] | undefined) ?? []);
      return actual.execFile(...args);
    },
    {
      [promisify.custom]: (file: string, args?: readonly string[], options?: object) => {
        if (file === 'git') gitSpawns.calls.push([...(args ?? [])]);
        return promisifiedExecFile(file, args, options);
      },
    },
  );
  return { ...actual, default: { ...actual, execFile }, execFile };
});

const previousHome = process.env.HOME;
const previousDataDir = process.env.CORTEX_IDE_DATA_DIR;
const previousO8DataDir = process.env.O8_DATA_DIR;
const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-repo-list-scope-')));
const dataDir = path.join(home, '.o8-data');
const existingPath = path.join(home, 'existing-repo');
const missingPath = path.join(home, 'missing-repo');
const neverExistingPath = path.join(home, 'never-existing-repo');
const outsidePath = path.join(home, 'outside-repo');
const escapedSymlinkPath = path.join(existingPath, 'escaped-repo');
const externalWorktreePath = path.join(home, 'external-worktree');
process.env.HOME = home;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
mkdirSync(dataDir, { recursive: true });
mkdirSync(existingPath, { recursive: true });
writeFileSync(path.join(existingPath, 'README.md'), 'registered repository\n');
execFileSync('git', ['init', '-q', '-b', 'main', existingPath]);
execFileSync('git', ['-C', existingPath, 'add', 'README.md']);
execFileSync('git', [
  '-C',
  existingPath,
  '-c',
  'user.name=o8 test',
  '-c',
  'user.email=test@o8.local',
  'commit',
  '-qm',
  'test: seed repository',
]);
execFileSync('git', ['-C', existingPath, 'worktree', 'add', '-q', '-b', 'restore-fixture', externalWorktreePath]);
mkdirSync(outsidePath, { recursive: true });
symlinkSync(outsidePath, escapedSymlinkPath, 'dir');

function repo(id: string, localPath: string): RepoRegistryEntry {
  return {
    id,
    name: id,
    localPath,
    remoteUrl: null,
    defaultBranch: 'main',
    isGitRepo: true,
    addedAt: new Date(0).toISOString(),
    lastOpenedAt: null,
    storagePressureParkingDisabled: false,
    setup: {
      envMode: 'skip',
      envFiles: [],
      installCommand: null,
      installOnCreateWorkspace: false,
      buildCommand: null,
      runBuildOnCreateWorkspace: false,
      devCommand: 'npm run dev',
      defaultPort: null,
      workspaceIsolationPreference: 'auto',
    },
  };
}

writeFileSync(path.join(dataDir, 'repos.json'), JSON.stringify({
  version: 1,
  repos: [
    ...Array.from({ length: 1_000 }, (_, index) => repo(`existing-${index}`, existingPath)),
    repo('missing', missingPath),
  ],
}));

const reposRoute = await import('@/app/api/panel/repos/route');

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = previousDataDir;
  if (previousO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = previousO8DataDir;
});

async function getRepos(query = '') {
  const response = await reposRoute.GET(new Request(`http://127.0.0.1/api/panel/repos${query}`));
  const data = await response.json() as {
    repos?: RepoRegistryEntry[];
    validatedRestorePaths?: Array<{ requestedPath: string; canonicalPath: string }>;
    error?: string;
  };
  return { response, data };
}

describe('GET /api/panel/repos readiness scope', () => {
  beforeEach(() => {
    gitSpawns.calls = [];
  });

  it('does not resolve icons on the restore-only path', async () => {
    const icons = await import('@/lib/repos/project-icon-settings');
    const projection = vi.spyOn(icons, 'projectIconProjection');
    try {
      const query = new URLSearchParams({ restoreValidationOnly: '1', restorePath: existingPath });
      const { response, data } = await getRepos(`?${query}`);
      expect(response.status).toBe(200);
      expect(data.repos).toBeUndefined();
      expect(data.validatedRestorePaths).toEqual([{ requestedPath: existingPath, canonicalPath: existingPath }]);
      expect(projection).not.toHaveBeenCalled();
      expect(gitSpawns.calls).toEqual([]);
    } finally {
      projection.mockRestore();
    }
  });

  it('keeps fleet discovery cheap and leaves uncached readiness unprobed', async () => {
    const { response, data } = await getRepos();

    expect(response.status).toBe(200);
    expect(data.repos).toHaveLength(1_001);
    expect(data.repos?.every((entry) => entry.readiness === undefined)).toBe(true);
    expect(data.repos?.find((entry) => entry.id === 'existing-0')).toMatchObject({ exists: true });
    expect(data.repos?.find((entry) => entry.id === 'missing')).toMatchObject({ exists: false });
    const timing = response.headers.get('Server-Timing') ?? '';
    expect(timing).toContain('readiness;dur=');
    const totalMs = Number(timing.match(/total;dur=([0-9.]+)/)?.[1]);
    expect(totalMs).toBeLessThan(1_500);
  });

  it('probes only the selected repository and reuses that result on discovery', async () => {
    await getRepos('?readiness=missing');
    const { data } = await getRepos();

    expect(data.repos?.find((entry) => entry.id === 'missing')?.readiness?.state).toBe('missing');
    expect(data.repos?.find((entry) => entry.id === 'existing-0')?.readiness).toBeUndefined();
  });

  it('refreshes the selected repository instead of trusting a stale cache entry', async () => {
    await getRepos('?readiness=missing');
    mkdirSync(missingPath, { recursive: true });

    const { data } = await getRepos('?readiness=missing');

    expect(data.repos?.find((entry) => entry.id === 'missing')?.readiness?.state).not.toBe('missing');
  });

  it('rejects an unknown readiness target', async () => {
    const { response, data } = await getRepos('?readiness=not-registered');

    expect(response.status).toBe(404);
    expect(data.error).toBe('Registered repository not found.');
  });

  it('validates restore paths without returning the fleet readiness payload', async () => {
    const query = new URLSearchParams();
    query.set('restoreValidationOnly', '1');
    query.append('restorePath', existingPath);
    query.append('restorePath', externalWorktreePath);
    query.append('restorePath', escapedSymlinkPath);
    query.append('restorePath', outsidePath);
    query.append('restorePath', neverExistingPath);

    const { response, data } = await getRepos(`?${query.toString()}`);

    expect(response.status).toBe(200);
    expect(data.repos).toBeUndefined();
    expect(response.headers.get('Server-Timing')).toContain('validation;dur=');
    expect(response.headers.get('Server-Timing')).not.toContain('readiness;dur=');
    expect(response.headers.get('Server-Timing')).not.toContain('existence;dur=');
    expect(data.validatedRestorePaths).toEqual([
      {
        requestedPath: existingPath,
        canonicalPath: realpathSync(existingPath),
      },
      {
        requestedPath: externalWorktreePath,
        canonicalPath: realpathSync(externalWorktreePath),
      },
    ]);
  });

  it('validates a registered root through the registry fast path without spawning git', async () => {
    const query = new URLSearchParams({ restoreValidationOnly: '1' });
    query.append('restorePath', existingPath);

    const { response, data } = await getRepos(`?${query.toString()}`);

    expect(response.status).toBe(200);
    expect(data.validatedRestorePaths).toEqual([
      { requestedPath: existingPath, canonicalPath: realpathSync(existingPath) },
    ]);
    expect(gitSpawns.calls).toEqual([]);
  });

  it('still resolves an external worktree through the worktree list and rejects a path that is neither', async () => {
    const worktreeQuery = new URLSearchParams({ restoreValidationOnly: '1' });
    worktreeQuery.append('restorePath', externalWorktreePath);
    const worktree = await getRepos(`?${worktreeQuery.toString()}`);

    expect(worktree.data.validatedRestorePaths).toEqual([
      { requestedPath: externalWorktreePath, canonicalPath: realpathSync(externalWorktreePath) },
    ]);
    expect(gitSpawns.calls.some((args) => args.includes('worktree') && args.includes('list'))).toBe(true);

    gitSpawns.calls = [];
    const outsideQuery = new URLSearchParams({ restoreValidationOnly: '1' });
    outsideQuery.append('restorePath', outsidePath);
    outsideQuery.append('restorePath', escapedSymlinkPath);
    const outside = await getRepos(`?${outsideQuery.toString()}`);

    expect(outside.response.status).toBe(200);
    expect(outside.data.validatedRestorePaths).toEqual([]);
    expect(gitSpawns.calls.some((args) => args.includes('worktree') && args.includes('list'))).toBe(true);
  });
});
