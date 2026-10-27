import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'o8-approved-remote-merge-'));
vi.stubEnv('CORTEX_IDE_DATA_DIR', join(root, 'data'));
vi.stubEnv('O8_DATA_DIR', join(root, 'data'));
vi.stubEnv('O8_SKIP_PRELAUNCH_TYPECHECK', '1');

const { createLane } = await import('@/lib/lane/registry');
const { dispatch } = await import('@/lib/lane/commands');
const { previewPacketMerge } = await import('@/lib/lane/preview-merge');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
const { recordOrchestratorReview } = await import('@/lib/approvals/store');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(cwd: string, message: string) {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', message);
}

beforeAll(async () => {
  await updateOperatorDefaults({ requireApproval: 'never', productTelemetryEnabled: false,
    storageReserveRatio: 0.0001, storageReserveFloorGb: 0.001 });
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it.each(['unrelated', 'overlap', 'rejected', 'clean'] as const)(
  'publishes an approved packet with a %s operator checkout', async (state) => {
    const origin = join(root, `${state}.git`);
    const repo = join(root, state);
    execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
    execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
    git(repo, 'checkout', '-b', 'main');
    git(repo, 'config', 'user.name', 'o8-test');
    git(repo, 'config', 'user.email', 'o8@example.test');
    writeFileSync(join(repo, 'packet.txt'), 'base\n');
    writeFileSync(join(repo, 'local.txt'), 'local base\n');
    commit(repo, 'base');
    git(repo, 'push', '-u', 'origin', 'main');

    const packetId = `pkt-dirty-merge-${state}`;
    const branch = `inline/${packetId}`;
    const worktree = await getWorktreeManager(repo).create({ agentType: 'codex', taskName: packetId,
      branchName: branch, baseBranch: 'main', packetId, skipSetup: true, isolationPreference: 'git-worktree' });
    writeFileSync(join(worktree.path, 'packet.txt'), 'approved packet\n');
    commit(worktree.path, 'approved packet change');
    const reviewedHeadSha = git(worktree.path, 'rev-parse', 'HEAD');
    const lane = createLane({ repoPath: repo, worktreePath: worktree.path, branch,
      baseBranch: 'main', runtime: 'codex', packetId, sessionKey: `codex:${packetId}` });
    recordOrchestratorReview(packetId, { approved: true, findings: [], reviewer: 'codex',
      reviewedHeadSha, requiresSecondPass: false });

    if (state !== 'clean') {
      writeFileSync(join(repo, 'local.txt'), 'staged local edit\n');
      git(repo, 'add', 'local.txt');
      writeFileSync(join(repo, 'local.txt'), 'unstaged local edit\n');
      writeFileSync(join(repo, 'untracked.txt'), 'untracked bytes\0\n');
      if (state === 'overlap') writeFileSync(join(repo, 'packet.txt'), 'local packet edit\n');
    }
    const snapshot = () => ({
      head: git(repo, 'rev-parse', 'HEAD'),
      branch: git(repo, 'symbolic-ref', 'HEAD'),
      index: readFileSync(join(repo, '.git', 'index')),
      packet: readFileSync(join(repo, 'packet.txt')),
      local: readFileSync(join(repo, 'local.txt')),
      ...(state === 'clean' ? {} : { untracked: readFileSync(join(repo, 'untracked.txt')) }),
    });
    const before = snapshot();
    if (state === 'rejected') {
      const hook = join(origin, 'hooks', 'pre-receive');
      writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = refs/heads/main ]; then exit 1; fi\ndone\n');
      chmodSync(hook, 0o755);
    }
    const preview = await previewPacketMerge(packetId);
    expect(preview.checks.find(check => check.name === 'clean-worktree')).toMatchObject({ verdict: 'pass' });
    const result = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'system',
      orchestratorReviewed: true, expectedHeadSha: reviewedHeadSha });
    if (state === 'rejected') {
      expect(result).toMatchObject({ ok: false });
      expect(snapshot()).toEqual(before);
      expect(git(origin, 'rev-parse', 'main')).toBe(before.head);
      return;
    }
    expect(result, result.note).toMatchObject({ ok: true, pushedToOrigin: true });
    expect(git(origin, 'show', 'main:packet.txt')).toBe('approved packet');
    expect(git(origin, 'rev-parse', 'main')).toBe(result.mergeSha);
    if (state === 'clean') {
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(result.mergeSha);
      expect(readFileSync(join(repo, 'packet.txt'), 'utf8')).toBe('approved packet\n');
      expect(git(repo, 'status', '--porcelain')).toBe('');
    } else {
      expect(snapshot()).toEqual(before);
      expect(result.note).toMatch(/local checkout.*(?:unchanged|deferred)/i);
      expect(result.note).toContain('local.txt');
    }
    expect(git(repo, 'stash', 'list')).toBe('');
  }, 30_000,
);
