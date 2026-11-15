import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Lane } from '@/lib/lane/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-remote-governed-squash-'));
const originalDataDir = process.env.CORTEX_IDE_DATA_DIR;
const originalO8DataDir = process.env.O8_DATA_DIR;
const originalCommitAttribution = process.env.O8_COMMIT_ATTRIBUTION;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_COMMIT_ATTRIBUTION = '1';

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));

const { AGENT_COMMIT_TRAILER } = await import('@/lib/lane/commit-attribution');
const { performRemoteCustomerMerge } = await import('@/lib/lane/commands-remote-merge');
const { createLane } = await import('@/lib/lane/registry');
const { CustomerWorkerTransport } = await import('@/lib/runtimes/remote/customer-worker-transport');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { addSessionRule } = await import('@/lib/db/session-rules-store');
const { withSessionRuleMutation } = await import('@/lib/orchestrator/session-merge-restriction');
const { createToken } = await import('@/lib/worker/tokens');

const roots: string[] = [];
const transport = new CustomerWorkerTransport();

function restoreEnv(
  key: 'CORTEX_IDE_DATA_DIR' | 'O8_DATA_DIR' | 'O8_COMMIT_ATTRIBUTION',
  value: string | undefined,
) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitAll(cwd: string, message: string): string {
  git(cwd, ['add', '-A']);
  git(cwd, [
    '-c', 'user.name=o8-test',
    '-c', 'user.email=o8@example.test',
    'commit', '-m', message,
  ]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

async function createFixture(label: string, conflict: boolean) {
  const root = mkdtempSync(join(os.tmpdir(), `o8-remote-governed-${label}-`));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'operator');
  const worker = join(root, 'worker');
  const remoteBranch = `packet/remote-${label}-${Date.now()}`;
  const savedBranch = `operator/${label}-${Date.now()}`;
  roots.push(root);

  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  git(repo, ['checkout', '-b', 'main']);
  git(repo, ['config', 'user.name', 'o8-test']);
  git(repo, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(repo, 'shared.txt'), 'base\n');
  const baseSha = commitAll(repo, 'chore: initialize remote fixture');
  git(repo, ['push', '-u', 'origin', 'main']);

  execFileSync('git', ['clone', origin, worker], { stdio: 'pipe' });
  git(worker, ['checkout', '-b', remoteBranch, 'origin/main']);
  git(worker, ['config', 'user.name', 'o8-test']);
  git(worker, ['config', 'user.email', 'o8@example.test']);
  if (conflict) {
    writeFileSync(join(worker, 'shared.txt'), 'remote\n');
    commitAll(worker, 'fix: change shared file remotely');
  } else {
    writeFileSync(join(worker, 'first.txt'), 'first\n');
    commitAll(worker, 'fix: add first remote change');
    writeFileSync(join(worker, 'second.txt'), 'second\n');
    commitAll(worker, 'fix: add second remote change');
  }
  git(worker, ['push', '-u', 'origin', remoteBranch]);

  if (conflict) {
    writeFileSync(join(repo, 'shared.txt'), 'local\n');
    commitAll(repo, 'fix: change shared file locally');
    git(repo, ['push', 'origin', 'main']);
  }
  const preMergeMainSha = git(repo, ['rev-parse', 'refs/heads/main']);
  git(repo, ['checkout', '-b', savedBranch]);

  const lane = createLane({
    repoPath: repo,
    branch: remoteBranch,
    baseBranch: 'main',
    runtime: 'remote-customer' as Lane['runtime'],
    packetId: `pkt-remote-${label}-${Date.now()}`,
    label: `Remote governed merge ${label}`,
  });
  const runId = `run-remote-${label}-${Date.now()}`;
  const launched = await transport.sendLaunch({
    runId,
    laneId: lane.id,
    repoUrl: origin,
    baseRef: 'main',
    remoteBranch,
    packetPrompt: 'Exercise governed remote merge history.',
  });
  expect(launched.accepted).toBe(true);

  return { baseSha, lane, origin, preMergeMainSha, repo, savedBranch };
}

beforeAll(() => {
  createToken({
    label: 'Remote merge fixture token',
    scope: 'global',
    maxWorkers: 2,
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  restoreEnv('CORTEX_IDE_DATA_DIR', originalDataDir);
  restoreEnv('O8_DATA_DIR', originalO8DataDir);
  restoreEnv('O8_COMMIT_ATTRIBUTION', originalCommitAttribution);
});

describe('remote governed squash with real repositories', () => {
  it('restores the saved checkout after a squash conflict', async () => {
    const fixture = await createFixture('conflict', true);

    const result = await performRemoteCustomerMerge(fixture.lane, {
      verb: 'merge',
      laneId: fixture.lane.id,
      commitMessage: 'fix: squash conflicting remote packet',
    }, 'user');

    expect(result).toMatchObject({ ok: false, laneId: fixture.lane.id });
    expect(result.note).toContain('Conflicting files:');
    expect(result.note).toContain('shared.txt');
    expect(git(fixture.repo, ['status', '--porcelain'])).toBe('');
    expect(git(fixture.repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(fixture.savedBranch);
    expect(git(fixture.repo, ['rev-parse', 'refs/heads/main'])).toBe(fixture.preMergeMainSha);
  }, 30_000);

  it('lands one attributed commit with the explicit message', async () => {
    const fixture = await createFixture('success', false);
    const commitMessage = 'fix: squash remote packet history';

    const result = await performRemoteCustomerMerge(fixture.lane, {
      verb: 'merge',
      laneId: fixture.lane.id,
      commitMessage,
    }, 'user');

    expect(result).toMatchObject({ ok: true, pushedToOrigin: true });
    expect(git(fixture.repo, ['status', '--porcelain'])).toBe('');
    expect(git(fixture.repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(fixture.savedBranch);
    expect(git(fixture.repo, ['rev-list', '--count', `${fixture.baseSha}..refs/heads/main`])).toBe('1');
    expect(git(fixture.repo, ['log', '-1', '--format=%s', 'refs/heads/main'])).toBe(commitMessage);
    expect(git(fixture.repo, ['log', '-1', '--format=%B', 'refs/heads/main']))
      .toContain(AGENT_COMMIT_TRAILER);
    expect(git(fixture.repo, ['ls-remote', '--heads', fixture.origin, 'main']).split(/\s+/)[0])
      .toBe(git(fixture.repo, ['rev-parse', 'refs/heads/main']));
  }, 30_000);
});

it('checks a newly persisted session restriction at the remote publication boundary', async () => {
  const fixture = await createFixture('restricted', false);
  const threadId = 'thoughts-remote-restriction';
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), repoPath: fixture.repo,
    packets: [{ id: fixture.lane.packetId!, referenceLabel: 'restricted', title: 'restricted', summary: '',
      workspaceTargetPath: fixture.repo, branchTarget: 'main', runtime: 'codex', orchestratorThreadId: threadId,
      dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued', releaseState: 'pending',
      status: 'queued', blockedReason: null, lane: null, review: null }],
  });
  await withSessionRuleMutation(threadId, () => addSessionRule(threadId, 'Keep the changes for review.', 'no_merge'));
  const result = await performRemoteCustomerMerge(fixture.lane, { verb: 'merge', laneId: fixture.lane.id,
    commitMessage: 'fix: restricted remote packet' }, 'user');
  expect(result.ok).toBe(false); expect(result.note).toContain('Merge blocked');
  expect(git(fixture.repo, ['rev-parse', 'main'])).toBe(fixture.preMergeMainSha);
  expect(git(fixture.origin, ['rev-parse', 'main'])).toBe(fixture.preMergeMainSha);
  expect(git(fixture.repo, ['status', '--porcelain'])).toBe('');
  expect(git(fixture.repo, ['branch', '--show-current'])).toBe(fixture.savedBranch);
}, 30_000);

it('runs no repository hook while it fetches, checks out, merges and pushes a remote lane', async () => {
  const fixture = await createFixture('hooks', false);
  const marker = join(fixture.repo, '..', 'hooks-ran.txt');
  const hooks = join(fixture.repo, '.githooks');
  mkdirSync(hooks);
  for (const hook of ['pre-commit', 'post-commit', 'pre-push', 'post-checkout', 'post-merge', 'post-rewrite', 'reference-transaction']) {
    writeFileSync(join(hooks, hook), `#!/bin/sh\necho ${hook} >> ${JSON.stringify(marker)}\n`);
    chmodSync(join(hooks, hook), 0o755);
  }
  writeFileSync(join(fixture.repo, '.git', 'info', 'exclude'), '.githooks/\n');
  git(fixture.repo, ['config', 'core.hooksPath', join(fixture.repo, '.githooks')]);

  const result = await performRemoteCustomerMerge(fixture.lane, {
    verb: 'merge',
    laneId: fixture.lane.id,
    commitMessage: 'fix: squash remote packet without hooks',
  }, 'user');

  expect(result).toMatchObject({ ok: true, pushedToOrigin: true });
  const ran = existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n') : [];
  expect(ran, ran.join(',')).toEqual([]);
}, 30_000);
