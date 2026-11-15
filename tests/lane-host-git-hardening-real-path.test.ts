import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Keep the command's persisted transition real without starting a review worker.
vi.mock('@/lib/lane/review-queue', () => ({ enqueueLaneReview: vi.fn() }));

const root = mkdtempSync(path.join(tmpdir(), 'o8-lane-host-git-'));
process.env.CORTEX_IDE_DATA_DIR = path.join(root, 'data');
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;
const { dispatch } = await import('@/lib/lane/commands');
const { createLane, getLane } = await import('@/lib/lane/registry');
const { buildPreviewForLane } = await import('@/lib/lane/preview-merge');
const { runMergeGate } = await import('@/lib/lane/merge-gate');
const hostGit = await import('@/lib/lane/lane-git');
const { closeDb } = await import('@/lib/db');

function git(cwd: string, args: string[]): string {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fixture(kind: 'linked' | 'clone', operation: string) {
  const directory = path.join(root, kind + '-' + operation);
  const repoPath = path.join(directory, 'repo');
  const worktreePath = path.join(directory, 'lane');
  const markers = path.join(directory, 'markers');
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(markers);
  git(repoPath, ['init', '-q', '-b', 'main']);
  git(repoPath, ['config', 'user.name', 'Test Author']);
  git(repoPath, ['config', 'user.email', 'test@example.test']);
  writeFileSync(path.join(repoPath, 'source.txt'), 'base\n');
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-qm', 'base']);
  const baseCommit = git(repoPath, ['rev-parse', 'HEAD']);
  const branch = 'packet/' + operation;
  // These are the Git layouts used by WorktreeManager's linked and CoW paths.
  if (kind === 'linked') {
    git(repoPath, ['worktree', 'add', '-q', '-b', branch, worktreePath]);
    git(repoPath, ['config', 'extensions.worktreeConfig', 'true']);
  } else {
    git(repoPath, ['clone', '--local', '--no-checkout', repoPath, worktreePath]);
    git(worktreePath, ['checkout', '-q', '-b', branch]);
    git(worktreePath, ['config', 'user.name', 'Test Author']);
    git(worktreePath, ['config', 'user.email', 'test@example.test']);
  }
  const admin = git(worktreePath, ['rev-parse', '--absolute-git-dir']);
  const lane = createLane({ repoPath, worktreePath, branch, baseBranch: 'main', baseCommit,
    runtime: 'codex', packetId: kind + '-' + operation });
  const config = (key: string, value: string) => git(worktreePath,
    ['config', kind === 'linked' ? '--worktree' : '--local', key, value]);
  const script = (name: string, filter = false) => {
    const file = path.join(directory, name + '.sh');
    const marker = path.join(markers, name);
    writeFileSync(file, '#!/bin/sh\n: > ' + JSON.stringify(marker) + '\n' + (filter ? 'cat\n' : ''), { mode: 0o755 });
    return file;
  };
  const plant = () => {
    config('core.fsmonitor', script('monitor'));
    config('filter.marker.clean', script('clean', true));
    config('filter.marker.smudge', script('smudge', true));
    config('filter.marker.required', 'true');
    config('diff.external', script('external'));
    config('diff.marker.textconv', script('textconv'));
    const hooks = path.join(directory, 'hooks');
    mkdirSync(hooks);
    writeFileSync(path.join(hooks, 'pre-commit'), readFileSync(script('hook')), { mode: 0o755 });
    config('core.hooksPath', hooks);
    writeFileSync(path.join(worktreePath, '.gitattributes'), 'source.txt filter=marker diff=marker\n');
  };
  return { lane, repoPath, worktreePath, admin, markers, directory, plant };
}

afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

describe('host Git through lane command and merge entry points', () => {
  for (const kind of ['linked', 'clone'] as const) {
    it(kind + ' request_review commits unchanged source without executing configured programs', async () => {
      const f = fixture(kind, 'review');
      f.plant();
      writeFileSync(path.join(f.worktreePath, 'source.txt'), 'review content\n');
      const result = await dispatch({ verb: 'request_review', laneId: f.lane.id, actor: 'system' });
      expect(result.ok).toBe(true);
      expect(getLane(f.lane.id)?.status).toBe('reviewing');
      expect(readdirSync(f.markers)).toEqual([]);
      expect(git(f.worktreePath, ['show', '--no-ext-diff', '--no-textconv', 'HEAD:source.txt'])).toBe('review content');
      expect(git(f.worktreePath, ['log', '-1', '--format=%an <%ae>'])).toBe('Test Author <test@example.test>');
    });

    for (const operation of ['preview', 'gate']) {
      it(kind + ' ' + operation + ' reads the actual diff without executing configured programs', async () => {
        const f = fixture(kind, operation);
        writeFileSync(path.join(f.worktreePath, 'source.txt'), 'committed content\n');
        writeFileSync(path.join(f.worktreePath, 'unsafe.ts'), 'export const unsafe = eval("1");\n');
        git(f.worktreePath, ['add', '.']);
        git(f.worktreePath, ['commit', '-qm', 'work']);
        f.plant();
        if (operation === 'preview') {
          const preview = await buildPreviewForLane(f.lane, f.lane.packetId!, { orchestratorApproved: true });
          expect(preview.blockers).toContain('security-patterns');
          expect(preview.blockers).toContain('clean-worktree');
        } else {
          const gate = await runMergeGate(f.lane, undefined, true);
          expect(gate.violations.some((entry) => entry.category === 'security')).toBe(true);
        }
        expect(readdirSync(f.markers)).toEqual([]);
      });
    }
  }

  it('rejects a linked lane whose commondir was redirected before any lane Git executes', async () => {
    const f = fixture('linked', 'redirect');
    f.plant();
    const redirected = path.join(f.directory, 'redirected.git');
    git(f.repoPath, ['clone', '--bare', f.repoPath, redirected]);
    writeFileSync(path.join(f.admin, 'commondir'), redirected + '\n');
    writeFileSync(path.join(f.worktreePath, 'source.txt'), 'must not commit\n');
    const result = await dispatch({ verb: 'request_review', laneId: f.lane.id, actor: 'system' });
    expect(result.ok).toBe(false);
    await expect(runMergeGate(f.lane)).rejects.toThrow(/Git metadata/i);
    await expect(buildPreviewForLane(f.lane, f.lane.packetId!)).rejects.toThrow(/Git metadata/i);
    expect(readdirSync(f.markers)).toEqual([]);
    expect(existsSync(path.join(redirected, 'refs', 'heads', 'packet', 'redirect'))).toBe(false);
  });

  it('rejects a linked lane pointer that disagrees with the host backlink', async () => {
    const f = fixture('linked', 'pointer');
    f.plant();
    writeFileSync(path.join(f.worktreePath, '.git'), 'gitdir: ' + path.join(f.repoPath, '.git') + '\n');
    expect((await dispatch({ verb: 'request_review', laneId: f.lane.id, actor: 'system' })).ok).toBe(false);
    await expect(runMergeGate(f.lane)).rejects.toThrow(/Git metadata/i);
    expect(readdirSync(f.markers)).toEqual([]);
  });

  it('rejects a clone with a symlinked Git directory', async () => {
    const f = fixture('clone', 'symlink');
    rmSync(path.join(f.worktreePath, '.git'), { recursive: true });
    symlinkSync(path.join(f.repoPath, '.git'), path.join(f.worktreePath, '.git'), 'dir');
    expect((await dispatch({ verb: 'request_review', laneId: f.lane.id, actor: 'system' })).ok).toBe(false);
    await expect(runMergeGate(f.lane)).rejects.toThrow(/Git metadata/i);
  });

  it('fails closed when linked metadata changes between real merge-gate probes', async () => {
    const f = fixture('linked', 'mid-gate');
    git(f.repoPath, ['checkout', '-qb', 'operator']);
    const original = hostGit.laneGit;
    let redirected = false;
    const spy = vi.spyOn(hostGit, 'laneGit').mockImplementation(async (worktree, repo, args, options) => {
      const result = await original(worktree, repo, args, options);
      if (!redirected && args[0] === 'diff' && args.includes('--name-only')) {
        redirected = true;
        writeFileSync(path.join(f.admin, 'commondir'), f.directory + '\n');
      }
      return result;
    });
    try {
      await expect(runMergeGate(f.lane)).rejects.toThrow(/Git metadata/i);
      expect(redirected).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('disables a configured process filter and signing without losing committed content', async () => {
    const f = fixture('clone', 'process-filter');
    f.plant();
    const script = path.join(f.directory, 'process.sh');
    writeFileSync(script, '#!/bin/sh\n: > ' + JSON.stringify(path.join(f.markers, 'process')) + '\n', { mode: 0o755 });
    git(f.worktreePath, ['config', 'filter.marker.process', script]);
    git(f.worktreePath, ['config', 'commit.gpgSign', 'true']);
    git(f.worktreePath, ['config', 'gpg.program', script]);
    writeFileSync(path.join(f.worktreePath, 'source.txt'), 'process content\n');
    expect((await dispatch({ verb: 'request_review', laneId: f.lane.id, actor: 'system' })).ok).toBe(true);
    expect(readdirSync(f.markers)).toEqual([]);
    expect(git(f.worktreePath, ['show', '--no-ext-diff', '--no-textconv', 'HEAD:source.txt'])).toBe('process content');
  });

  it('ignores inherited Git routing and config injection while a stale sibling remains registered', async () => {
    const f = fixture('linked', 'environment');
    const sibling = path.join(f.directory, 'stale');
    git(f.repoPath, ['worktree', 'add', '-q', '-b', 'packet/stale', sibling]);
    rmSync(sibling, { recursive: true });
    f.plant();
    writeFileSync(path.join(f.worktreePath, 'source.txt'), 'environment content\n');
    const injection = path.join(f.directory, 'inherited.sh');
    writeFileSync(injection, '#!/bin/sh\n: > ' + JSON.stringify(path.join(f.markers, 'inherited')) + '\n', { mode: 0o755 });
    const changes = { GIT_DIR: path.join(f.repoPath, '.git'), GIT_COMMON_DIR: path.join(f.repoPath, '.git'),
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'filter.marker.clean', GIT_CONFIG_VALUE_0: injection,
      GIT_EXTERNAL_DIFF: injection, GIT_INDEX_FILE: path.join(f.directory, 'injected-index') };
    const prior = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
    try {
      Object.assign(process.env, changes);
      expect((await dispatch({ verb: 'request_review', laneId: f.lane.id, actor: 'system' })).ok).toBe(true);
      expect(readdirSync(f.markers)).toEqual([]);
      expect(git(f.worktreePath, ['show', '--no-ext-diff', '--no-textconv', 'HEAD:source.txt'])).toBe('environment content');
      expect(existsSync(changes.GIT_INDEX_FILE)).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});
