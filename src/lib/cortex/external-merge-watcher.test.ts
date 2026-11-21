import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  dataDir: '',
  repos: [] as Array<{ localPath: string; defaultBranch: string }>,
  commands: [] as string[][],
  append: vi.fn(() => ['fixture-directive']),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => fixture.dataDir }));
vi.mock('@/lib/repos/registry', () => ({ listRepos: async () => fixture.repos }));
vi.mock('@/lib/cortex/directive-merges', () => ({ appendDirectiveTrailer: fixture.append }));
vi.mock('@/lib/lane/outstanding-review', () => ({ hasOutstandingReview: () => false }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const tracked = (...args: Parameters<typeof actual.execFile>) => actual.execFile(...args);
  Object.defineProperty(tracked, Symbol.for('nodejs.util.promisify.custom'), {
    value: (file: string, args: string[], options: import('node:child_process').ExecFileOptions) => {
      fixture.commands.push([file, ...args]);
      return new Promise((resolve, reject) => {
        actual.execFile(file, args, options, (error, stdout, stderr) => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        });
      });
    },
  });
  return { ...actual, execFile: tracked };
});

import { ingestExternalMerges } from './external-merge-watcher';

let root: string;
let repo: string;
const git = (args: string[], folder = repo) => execFileSync('git', [
  '-C', folder, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
  '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(root, 'empty-hooks')}`, ...args,
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const cursor = (folder = repo) => JSON.parse(readFileSync(join(fixture.dataDir, 'external-merge-state.json'), 'utf8')).cursors[folder];
const commit = (message: string) => {
  git(['commit', '--allow-empty', '-m', message]);
  return git(['rev-parse', 'HEAD']);
};
const resetCalls = () => {
  fixture.commands.length = 0;
  fixture.append.mockClear();
};

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_')) vi.stubEnv(key, undefined);
  }
  root = mkdtempSync(join(tmpdir(), 'external-merge-watcher-'));
  repo = join(root, 'repo');
  fixture.dataDir = join(root, 'state');
  mkdirSync(repo);
  mkdirSync(fixture.dataDir);
  git(['init', '--initial-branch=main']);
  commit('Initial history');
  fixture.repos = [{ localPath: repo, defaultBranch: 'main' }];
  resetCalls();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('external merge ingestion through persisted cursors', () => {
  it('seeds through Git, skips unchanged tips, then ingests a new commit once', async () => {
    expect(await ingestExternalMerges()).toEqual({ scannedRepos: 1, newCommits: 0, updatedDirectives: 0 });
    expect(fixture.commands).toHaveLength(2);
    expect(cursor()).toBe(git(['rev-parse', 'HEAD']));
    expect(fixture.append).not.toHaveBeenCalled();

    resetCalls();
    await ingestExternalMerges();
    expect(fixture.commands).toEqual([]);
    const sha = commit('Improve handling (#12)\n\nSpec-Update: fixture-directive');
    expect(await ingestExternalMerges()).toEqual({ scannedRepos: 1, newCommits: 1, updatedDirectives: 1 });
    expect(fixture.commands).toHaveLength(2);
    expect(cursor()).toBe(sha);
    expect(fixture.append).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ title: 'Improve handling', issueNumber: 12 }),
      commitMessage: expect.stringContaining('Spec-Update: fixture-directive'),
    }));
    resetCalls();
    await ingestExternalMerges();
    expect(fixture.commands).toEqual([]);
    expect(fixture.append).not.toHaveBeenCalled();
  });

  it('keeps origin precedence and detects a fetched tip despite unchanged local history', async () => {
    const initial = git(['rev-parse', 'HEAD']);
    git(['update-ref', 'refs/remotes/origin/main', initial]);
    await ingestExternalMerges();
    const newer = commit('Next change');
    git(['tag', 'origin/main', initial]);
    resetCalls();
    await ingestExternalMerges();
    expect(fixture.commands).toEqual([]);
    expect(cursor()).toBe(initial);
    git(['update-ref', 'refs/remotes/origin/main', newer]);
    expect((await ingestExternalMerges()).newCommits).toBe(1);
    expect(cursor()).toBe(newer);
    expect(fixture.commands.at(-1)).toContain('refs/remotes/origin/main');
  });

  it('supports packed refs and their later loose-ref override', async () => {
    git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD'])]);
    await ingestExternalMerges();
    git(['pack-refs', '--all', '--prune']);
    resetCalls();
    await ingestExternalMerges();
    expect(fixture.commands).toEqual([]);
    const newer = commit('New packed-branch change');
    git(['update-ref', 'refs/remotes/origin/main', newer]);
    expect((await ingestExternalMerges()).newCommits).toBe(1);
    expect(cursor()).toBe(newer);
  });

  it('resolves a linked worktree through its pointer and common directory', async () => {
    const linked = join(root, 'linked');
    git(['worktree', 'add', '-b', 'linked', linked]);
    fixture.repos = [{ localPath: linked, defaultBranch: 'main' }];
    await ingestExternalMerges();
    resetCalls();
    await ingestExternalMerges();
    expect(fixture.commands).toEqual([]);
    const newer = commit('Main advanced');
    expect((await ingestExternalMerges()).newCommits).toBe(1);
    expect(cursor(linked)).toBe(newer);
  });

  it('falls back for a symbolic remote ref and does not mistake it for remote absence', async () => {
    git(['update-ref', 'refs/remotes/origin/target', git(['rev-parse', 'HEAD'])]);
    git(['symbolic-ref', 'refs/remotes/origin/main', 'refs/remotes/origin/target']);
    await ingestExternalMerges();
    const newer = commit('Remote-only update');
    git(['update-ref', 'refs/remotes/origin/target', newer]);
    resetCalls();
    expect((await ingestExternalMerges()).newCommits).toBe(1);
    expect(fixture.commands).toHaveLength(2);
    expect(cursor()).toBe(newer);
  });

  it('uses Git when packed metadata is symlinked instead of guessing local precedence', async () => {
    git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD'])]);
    git(['pack-refs', '--all', '--prune']);
    await ingestExternalMerges();
    const packed = join(repo, '.git', 'packed-refs');
    const target = join(root, 'packed');
    writeFileSync(target, readFileSync(packed));
    rmSync(packed);
    symlinkSync(target, packed);
    resetCalls();
    await ingestExternalMerges();
    expect(fixture.commands).toHaveLength(2);
  });

  it('does not retain a negative result across repository initialization', async () => {
    const fresh = join(root, 'fresh');
    mkdirSync(fresh);
    fixture.repos = [{ localPath: fresh, defaultBranch: 'main' }];
    await ingestExternalMerges();
    git(['init', '--initial-branch=main'], fresh);
    await ingestExternalMerges();
    git(['commit', '--allow-empty', '-m', 'New repo'], fresh);
    await ingestExternalMerges();
    expect(cursor(fresh)).toBe(git(['rev-parse', 'HEAD'], fresh));
    resetCalls();
    await ingestExternalMerges();
    expect(fixture.commands).toEqual([]);
  });

  it('keeps explicit Git environment overrides authoritative', async () => {
    await ingestExternalMerges();
    vi.stubEnv('GIT_DIR', join(repo, '.git'));
    resetCalls();
    await ingestExternalMerges();
    expect(fixture.commands).toHaveLength(2);
  });

  it('leaves oversized metadata to Git and resumes the shortcut after repair', async () => {
    await ingestExternalMerges();
    const configPath = join(repo, '.git', 'config');
    const config = readFileSync(configPath, 'utf8');
    writeFileSync(configPath, `${config}\n#${'x'.repeat(70_000)}\n`);
    resetCalls();
    await ingestExternalMerges();
    expect(fixture.commands).toHaveLength(2);
    writeFileSync(configPath, config);
    resetCalls();
    await ingestExternalMerges();
    expect(fixture.commands).toEqual([]);
  });
});
