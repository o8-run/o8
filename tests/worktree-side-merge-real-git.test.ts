import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, relative } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { setRepoActionLeaseMaxWaitMsForTests } from '@/lib/lane/lane-route-test-seams';

const originalEnv = {
  HOME: process.env.HOME,
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  O8_PROXY_URL: process.env.O8_PROXY_URL,
  O8_SKIP_PRELAUNCH_TYPECHECK: process.env.O8_SKIP_PRELAUNCH_TYPECHECK,
};

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-merge-real-data-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const { getLane, getLaneEvents, createLane } = await import('@/lib/lane/registry');
const { performWorktreeSideMerge } = await import('@/lib/lane/worktree-side-merge');
const { writeOrchestratorControlPlaneState, readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
const { steerPacket } = await import('@/lib/orchestrator/operator-mission-service/steer');
const typecheckAvailability = await import('@/lib/lane/typecheck-availability');
const runtimeActions = await import('@/lib/runtime/actions');
const { createApproval, getApproval, listApprovalsForContext, recordOrchestratorReview, toMobileApprovalCard } = await import('@/lib/approvals/store');
const { claimApprovalResolution } = await import('@/lib/approvals/resolution');
const { currentSpokenReviewGovernanceFingerprint } = await import('@/lib/approvals/spoken-review-guard');
const { createLaneActionApproval } = await import('@/lib/lane/commands-approval');
const { getLaneSpokenDiffFacts } = await import('@/lib/lane/lane-diff-facts');
const { createDetachedIntegrationWorktree } = await import('@/lib/lane/worktree-merge-git');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { getSqlite } = await import('@/lib/db');
const {
  getResourceLeaseStore,
} = await import('@/lib/leases/resource-lease-service');
const { observeResourceLeaseParticipant } = await import('@/lib/leases/resource-lease-participant');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const lanesRoute = await import('@/app/api/lanes/route');
const { __resetIdempotencyStoreForTests } = await import('@/lib/orchestrator/idempotency-store');

const tempDirs: string[] = [dataDir];

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitAll(cwd: string, message: string) {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-m', message]);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('Timed out waiting for merge fixture state.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function makeRepo(name: string) {
  const root = mkdtempSync(join(os.tmpdir(), `${name}-root-`));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'operator');
  tempDirs.push(root);

  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  git(repo, ['checkout', '-b', 'main']);
  git(repo, ['config', 'user.name', 'o8-test']);
  git(repo, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  commitAll(repo, 'base');
  git(repo, ['push', '-u', 'origin', 'main']);
  return { root: realpathSync(root), origin: realpathSync(origin), repo: realpathSync(repo) };
}

async function makeWorktree(repo: string, packetId: string, branch: string) {
  const manager = getWorktreeManager(repo);
  const worktree = await manager.create({
    agentType: 'codex',
    taskName: packetId,
    branchName: branch,
    baseBranch: 'main',
    packetId,
    skipSetup: true,
    isolationPreference: 'git-worktree',
  });
  git(worktree.path, ['config', 'user.name', 'o8-test']);
  git(worktree.path, ['config', 'user.email', 'o8@example.test']);
  return worktree;
}

function mergeCommand(laneId: string) {
  return {
    verb: 'merge' as const,
    laneId,
    actor: 'system' as const,
    orchestratorReviewed: true,
  };
}

async function mergeLane(
  lane: ReturnType<typeof createLane>,
  repoActionLeaseMaxWaitMs?: number,
) {
  const approvals: Array<{ policyRuleId: string; note: string; metadata?: Record<string, string> }> = [];
  const result = await performWorktreeSideMerge({
    lane,
    command: mergeCommand(lane.id),
    actor: 'system',
    gateResult: { passed: true, violations: [] },
    repoActionLeaseMaxWaitMs,
    createLaneActionApproval: async (_lane, _actor, input) => {
      approvals.push({
        policyRuleId: input.policyRuleId,
        note: input.note,
        metadata: input.metadata,
      });
      return { ok: false, laneId: lane.id, note: input.note };
    },
  });
  return { result, approvals };
}

async function spokenMergeCommand(lane: ReturnType<typeof createLane>) {
  const reviewedHeadSha = git(lane.worktreePath!, ['rev-parse', 'HEAD']);
  recordOrchestratorReview(lane.packetId!, {
    approved: true,
    findings: [],
    reviewer: 'codex',
    reviewedHeadSha,
    requiresSecondPass: false,
  });
  const approval = createApproval({
    source: 'runtime',
    runtime: 'codex',
    agent: 'worker',
    sessionKey: lane.sessionKey!,
    title: 'Merge reviewed packet',
    description: 'Merge reviewed packet',
    summary: 'Merge reviewed packet',
    risk: 'high',
    policyRuleId: 'lane-merge',
    continuation: { kind: 'lane', laneId: lane.id, verb: 'merge' },
  });
  const reviewed = await getLaneSpokenDiffFacts(lane);
  const expectedGovernanceFingerprint = await currentSpokenReviewGovernanceFingerprint(approval, lane);
  const spokenReviewLaneStatus = getLane(lane.id)!.status;
  const claim = claimApprovalResolution(approval.id, 'approve', 'desktop', undefined, approval.updatedAt);
  return {
    reviewedHeadSha,
    approval,
    command: {
      verb: 'merge' as const,
      laneId: lane.id,
      actor: 'user' as const,
      expectedHeadSha: reviewedHeadSha,
      expectedDiffFingerprint: reviewed.fingerprint,
      expectedGovernanceFingerprint,
      spokenReviewApprovalId: approval.id,
      spokenReviewClaimId: claim.claimId,
      spokenReviewUpdatedAt: approval.updatedAt,
      spokenReviewLaneStatus,
    },
  };
}

function packetFixture(
  id: string,
  repoPath: string,
  retries = 0,
  leaseWaitRetries = 0,
): OrchestratorPacket {
  return {
    id,
    referenceLabel: id,
    title: 'Typecheck packet',
    summary: 'Breaks tsc',
    status: 'running',
    queueState: 'held',
    releaseState: 'pending',
    blockedReason: null,
    lane: null,
    review: null,
    runtime: 'codex',
    dependencyPacketIds: [],
    dependencyLabels: [],
    attemptCount: 0,
    lastEventAt: null,
    lastEventLabel: null,
    recoveryCount: 0,
    typecheckAutoRetries: retries,
    leaseWaitAutoRetries: leaseWaitRetries,
    workspaceTargetPath: repoPath,
    branchTarget: `inline/${id}`,
  } as OrchestratorPacket;
}

beforeAll(async () => {
  // The storage governor is not under test here; keep its reserve out of the way so
  // these merge-path assertions do not depend on the host's free disk.
  await updateOperatorDefaults({
    productTelemetryEnabled: false,
    storageReserveRatio: 0.0001,
    storageReserveFloorGb: 0.001,
  });
});

afterEach(async () => {
  try {
    await updateOperatorDefaults({ productTelemetryEnabled: false });
    writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
    __resetIdempotencyStoreForTests();
  } finally {
    for (const dir of tempDirs.splice(1)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

afterAll(async () => {
  try {
    await updateOperatorDefaults({ productTelemetryEnabled: false });
  } finally {
    restoreEnv();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('worktree-side merge with real git repos', () => {
  it('defers an empty branch probe without misreporting a detached worktree', async () => {
    const { repo } = makeRepo('o8-merge-empty-branch-probe');
    const worktree = await makeWorktree(
      repo,
      'pkt-empty-branch-probe',
      'inline/empty-branch-probe',
    );
    writeFileSync(join(worktree.path, 'worker.txt'), 'worker\n');
    commitAll(worktree.path, 'worker change');
    const lane = createLane({
      repoPath: repo,
      worktreePath: worktree.path,
      branch: 'inline/empty-branch-probe',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-empty-branch-probe',
    });

    const result = await performWorktreeSideMerge({
      lane,
      command: mergeCommand(lane.id),
      actor: 'system',
      gateResult: { passed: true, violations: [] },
      branchResolver: async () => ({
        state: 'unknown',
        evidence: 'The branch probe exited successfully but returned no branch name.',
      }),
      createLaneActionApproval: async () => {
        throw new Error('An inconclusive branch probe must not route a human approval.');
      },
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'branch_probe_unknown',
      note: expect.stringContaining('not classified as detached'),
    });
    expect(result.note).not.toContain('Cannot merge detached');
    expect(getLane(lane.id)?.status).toBe('reviewing');
    expect(getLaneEvents(lane.id).some((event) => (
      event.verb === 'update'
      && event.payload.event === 'merge_branch_probe_unknown'
    ))).toBe(true);
    expect(git(worktree.path, ['symbolic-ref', '--short', 'HEAD']))
      .toBe('inline/empty-branch-probe');
    expect(git(repo, ['show', 'HEAD:file.txt'])).toBe('base');
  }, 20_000);

  it('preserves local transport config and resolves relative remotes in the disposable clone', async () => {
    const { repo, origin } = makeRepo('o8-merge-transport-config');
    const worktree = await makeWorktree(repo, 'pkt-transport-config', 'inline/transport-config');
    const sshCommand = 'ssh -F /tmp/o8-test-ssh-config';
    git(worktree.path, ['config', 'core.sshCommand', sshCommand]);
    git(worktree.path, ['config', 'credential.helper', 'o8-test-helper']);
    git(worktree.path, ['remote', 'set-url', 'origin', relative(worktree.path, origin)]);
    git(worktree.path, ['remote', 'set-url', '--add', '--push', 'origin', 'test-host:repo.git']);

    const integration = await createDetachedIntegrationWorktree({
      repoPath: repo,
      sourceWorktreePath: worktree.path,
      sourceSha: git(worktree.path, ['rev-parse', 'HEAD']),
    });
    try {
      expect(git(integration.path, ['config', '--get', 'core.sshCommand'])).toBe(sshCommand);
      expect(git(integration.path, ['config', '--get', 'credential.helper'])).toBe('o8-test-helper');
      expect(git(integration.path, ['remote', 'get-url', 'origin'])).toBe(origin);
      expect(git(integration.path, ['remote', 'get-url', '--push', 'origin'])).toBe('test-host:repo.git');
      expect(() => git(integration.path, ['fetch', 'origin', 'main', '--quiet'])).not.toThrow();
    } finally {
      await integration.cleanup();
    }
    expect(existsSync(integration.path)).toBe(false);
  }, 20_000);

  it('publishes the rebased spoken-review SHA to the remote worker branch', async () => {
    const { repo, origin, root } = makeRepo('o8-spoken-rebased-worker-branch');
    const worktree = await makeWorktree(repo, 'pkt-spoken-rebased', 'inline/spoken-rebased');
    writeFileSync(join(worktree.path, 'worker.txt'), 'worker\n');
    commitAll(worktree.path, 'worker change');
    const lane = createLane({
      repoPath: repo,
      worktreePath: worktree.path,
      branch: 'inline/spoken-rebased',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-spoken-rebased',
      sessionKey: 'codex:pkt-spoken-rebased',
    });
    const spoken = await spokenMergeCommand(lane);

    const upstream = join(root, 'upstream');
    execFileSync('git', ['clone', origin, upstream], { stdio: 'pipe' });
    git(upstream, ['checkout', 'main']);
    writeFileSync(join(upstream, 'upstream.txt'), 'upstream\n');
    commitAll(upstream, 'upstream change');
    git(upstream, ['push', 'origin', 'main']);

    const result = await performWorktreeSideMerge({
      lane,
      command: spoken.command,
      actor: 'user',
      gateResult: { passed: true, violations: [] },
      createLaneActionApproval,
    });

    expect(result.ok).toBe(true);
    const remoteMain = git(repo, ['ls-remote', '--heads', 'origin', 'main']).split(/\s+/)[0];
    const remoteWorker = git(repo, ['ls-remote', '--heads', 'origin', lane.branch]).split(/\s+/)[0];
    expect(remoteWorker).toBe(remoteMain);
    expect(remoteWorker).not.toBe(spoken.reviewedHeadSha);
    expect(() => git(repo, [
      'rev-parse',
      '--verify',
      'refs/heads/preserved/packet-pkt-spoken-rebased',
    ])).toThrow();
  }, 30_000);

  it('fast-forwards the operator checkout from the worker worktree without checkout/stash detours', async () => {
    const { repo } = makeRepo('o8-merge-ff');
    const worktree = await makeWorktree(repo, 'pkt-ff', 'inline/ff');
    const { bindOwnedPacketSession } = await import('./helpers/managed-packet-worktree');
    const sessionKey = await bindOwnedPacketSession(repo, worktree, { packetId: 'pkt-ff', branch: 'inline/ff' });
    writeFileSync(join(worktree.path, 'file.txt'), 'base\nworker\n');
    commitAll(worktree.path, 'worker change');

    const lane = createLane({
      repoPath: repo,
      worktreePath: worktree.path,
      branch: 'inline/ff',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-ff',
      sessionKey,
    });

    const { result, approvals } = await mergeLane(lane);

    expect(result.ok).toBe(true);
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(git(repo, ['status', '--porcelain', '--untracked-files=no'])).toBe('');
    expect(git(repo, ['stash', 'list'])).toBe('');
    expect(git(repo, ['show', 'HEAD:file.txt'])).toContain('worker');
    expect(getLane(lane.id)?.status).toBe('archived');
    expect(approvals).toEqual([]);
    expect(getSqlite().prepare(`
      SELECT verb FROM resource_lease_events
      WHERE resource = ?
      ORDER BY sequence ASC
    `).all(`repo-tree:${repo}`)).toEqual([
      { verb: 'acquired' },
      { verb: 'released' },
    ]);
    expect(existsSync(worktree.path)).toBe(false);
  }, 20_000);

  it('refuses a merge within its lease deadline when a live external holder is stuck', async () => {
    const { repo } = makeRepo('o8-merge-lease-timeout');
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      repoPath: repo,
      packets: [packetFixture('pkt-lease-timeout', repo)],
    });
    const worktree = await makeWorktree(repo, 'pkt-lease-timeout', 'inline/lease-timeout');
    writeFileSync(join(worktree.path, 'file.txt'), 'base\nworker\n');
    commitAll(worktree.path, 'worker change');
    const lane = createLane({
      repoPath: repo,
      worktreePath: worktree.path,
      branch: 'inline/lease-timeout',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-lease-timeout',
    });
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    expect(holder.pid).toBeTypeOf('number');
    const participant = await observeResourceLeaseParticipant({
      owner: { id: 'stuck-holder', label: 'stuck-holder', pid: holder.pid! },
      actor: 'operator',
      claimToken: 'stuck-holder-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    });
    await getResourceLeaseStore().acquire({
      resource: `repo-tree:${repo}`,
      participant,
      ttlMs: 60_000,
    });

    try {
      const attempt = mergeLane(lane, 100);
      const observed = await Promise.race([
        attempt,
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 1_000)),
      ]);
      const completed = observed === 'timed-out' ? await attempt : observed;

      expect(observed).not.toBe('timed-out');
      expect(completed.result).toMatchObject({
        ok: false,
        reason: 'repo_action_lease_wait_timeout',
      });
      expect(completed.result.note).toContain('stuck-holder');
      expect(getLane(lane.id)?.status).toBe('awaiting_orchestrator');
      expect(readOrchestratorControlPlaneState().packets[0]?.leaseWaitAutoRetries).toBe(1);
      expect(existsSync(worktree.path)).toBe(true);
      expect(await getResourceLeaseStore().status(`repo-tree:${repo}`)).toMatchObject({
        holder: { owner: { id: 'stuck-holder' } },
        waiters: [],
      });
      expect(getSqlite().prepare(`
        SELECT verb, actor FROM resource_lease_events
        WHERE resource = ?
        ORDER BY sequence ASC
      `).all(`repo-tree:${repo}`)).toEqual([
        { verb: 'acquired', actor: 'operator' },
        { verb: 'wait_enqueued', actor: 'system:repo-action' },
        { verb: 'wait_timed_out', actor: 'system:repo-action' },
        { verb: 'wait_enqueued', actor: 'system:repo-action' },
        { verb: 'wait_timed_out', actor: 'system:repo-action' },
      ]);
      const events = getLaneEvents(lane.id);
      expect(events.filter((event) => event.verb === 'lease_wait_timeout')).toMatchObject([
        {
          payload: {
            holder: { owner: { id: 'stuck-holder' } },
            waitedMs: expect.any(Number),
            retryCount: 0,
            willRetry: true,
          },
        },
        {
          payload: {
            holder: { owner: { id: 'stuck-holder' } },
            waitedMs: expect.any(Number),
            retryCount: 1,
            willRetry: false,
          },
        },
      ]);
      expect(events.some((event) =>
        event.verb === 'status_change'
        && event.payload.status === 'recovering'
      )).toBe(true);
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) {
        const exited = once(holder, 'exit');
        holder.kill('SIGKILL');
        await exited;
      }
    }
  }, 10_000);

  it('deduplicates concurrent create_pr route recovery behind one persisted lane key', async () => {
    const { repo, root } = makeRepo('o8-create-pr-idempotent-recovery');
    const worktree = await makeWorktree(repo, 'pkt-create-pr-idempotent', 'inline/create-pr-idempotent');
    writeFileSync(join(worktree.path, 'worker.txt'), 'worker\n');
    commitAll(worktree.path, 'worker change');
    const lane = createLane({
      repoPath: repo,
      worktreePath: worktree.path,
      branch: 'inline/create-pr-idempotent',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'Idempotent PR recovery',
    });

    const binDir = join(root, 'bin');
    const ghMarker = join(root, 'gh-invocations');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'gh'), [
      '#!/bin/sh',
      `marker=${JSON.stringify(ghMarker)}`,
      'if [ -e "$marker" ]; then',
      '  echo "duplicate create_pr execution" >&2',
      '  exit 9',
      'fi',
      'printf "1\\n" > "$marker"',
      'printf "https://example.test/pull/314\\n"',
      '',
    ].join('\n'));
    chmodSync(join(binDir, 'gh'), 0o755);

    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    expect(holder.pid).toBeTypeOf('number');
    const participant = await observeResourceLeaseParticipant({
      owner: { id: 'slow-create-pr-holder', label: 'slow-create-pr-holder', pid: holder.pid! },
      actor: 'operator',
      claimToken: 'slow-create-pr-holder-ffffffffffffffffffffffffff',
    });
    await getResourceLeaseStore().acquire({
      resource: `repo-tree:${repo}`,
      participant,
      ttlMs: 60_000,
    });

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;
    const makeRequest = () => new Request('http://o8.test/api/lanes', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${getOrCreateWsToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ verb: 'create_pr', laneId: lane.id, actor: 'user' }),
    }) as import('next/server').NextRequest;

    try {
      setRepoActionLeaseMaxWaitMsForTests(200);
      const firstResponse = lanesRoute.POST(makeRequest());
      await waitFor(() => {
        const row = getSqlite().prepare(`
          SELECT COUNT(*) AS count FROM resource_lease_events
          WHERE resource = ? AND verb = 'wait_enqueued' AND actor = 'system:repo-action'
        `).get(`repo-tree:${repo}`) as { count: number };
        return row.count === 1;
      });
      const secondResponse = lanesRoute.POST(makeRequest());

      await waitFor(() => getLaneEvents(lane.id).some((event) => event.verb === 'lease_wait_timeout'));
      const exited = once(holder, 'exit');
      holder.kill('SIGKILL');
      await exited;

      const [first, second] = await Promise.all([firstResponse, secondResponse]);
      const [firstBody, secondBody] = await Promise.all([first.json(), second.json()]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(secondBody).toEqual(firstBody);
      expect(firstBody).toMatchObject({
        ok: true,
        laneId: lane.id,
        note: 'PR created: https://example.test/pull/314',
      });
      expect(readFileSync(ghMarker, 'utf8')).toBe('1\n');

      const leaseEvents = getSqlite().prepare(`
        SELECT verb FROM resource_lease_events
        WHERE resource = ? AND actor = 'system:repo-action'
        ORDER BY sequence ASC
      `).all(`repo-tree:${repo}`) as Array<{ verb: string }>;
      const waiterEvents = leaseEvents.filter((event) => event.verb === 'wait_enqueued');
      expect(waiterEvents.length).toBeGreaterThanOrEqual(1);
      expect(waiterEvents.length).toBeLessThanOrEqual(2);
      expect(leaseEvents.filter((event) => event.verb === 'wait_timed_out')).toHaveLength(1);
      expect(leaseEvents.filter((event) => event.verb === 'acquired')).toHaveLength(1);
      expect(leaseEvents.filter((event) => event.verb === 'released')).toHaveLength(1);

      const laneEvents = getLaneEvents(lane.id);
      expect(laneEvents.filter((event) => event.verb === 'lease_wait_timeout')).toMatchObject([
        { payload: { retryCount: 0, willRetry: true } },
      ]);
      expect(laneEvents.filter((event) =>
        event.verb === 'status_change' && event.payload.status === 'recovering'
      )).toHaveLength(1);
      expect(laneEvents.filter((event) =>
        event.verb === 'status_change' && event.payload.status === 'reviewing'
      )).toHaveLength(1);
      expect(laneEvents.some((event) =>
        event.verb === 'status_change' && event.payload.status === 'awaiting_orchestrator'
      )).toBe(false);
    } finally {
      setRepoActionLeaseMaxWaitMsForTests(undefined);
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (holder.exitCode === null && holder.signalCode === null) {
        const exited = once(holder, 'exit');
        holder.kill('SIGKILL');
        await exited;
      }
    }
  }, 20_000);

  it('lets a second real merge wait beyond five seconds for the repo-tree lease', async () => {
    const { repo } = makeRepo('o8-merge-lease-long-wait');
    const firstWorktree = await makeWorktree(repo, 'pkt-lease-first', 'inline/lease-first');
    writeFileSync(join(firstWorktree.path, 'first.txt'), 'first\n');
    commitAll(firstWorktree.path, 'first merge');
    const firstLane = createLane({
      repoPath: repo,
      worktreePath: firstWorktree.path,
      branch: 'inline/lease-first',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-lease-first',
    });
    const secondWorktree = await makeWorktree(repo, 'pkt-lease-second', 'inline/lease-second');
    writeFileSync(join(secondWorktree.path, 'second.txt'), 'second\n');
    commitAll(secondWorktree.path, 'second merge');
    const secondLane = createLane({
      repoPath: repo,
      worktreePath: secondWorktree.path,
      branch: 'inline/lease-second',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-lease-second',
    });
    const hookPath = join(repo, '.git', 'hooks', 'pre-push');
    writeFileSync(hookPath, [
      '#!/bin/sh',
      'marker="$(git rev-parse --git-common-dir)/o8-test-slow-push"',
      'if [ ! -f "$marker" ]; then',
      '  : > "$marker"',
      '  sleep 7',
      'fi',
      '',
    ].join('\n'));
    chmodSync(hookPath, 0o755);

    const resultPath = join(repo, '.git', 'o8-test-first-merge-result.json');
    const child = spawn(process.execPath, [
      './node_modules/vitest/vitest.mjs', 'run',
      'tests/fixtures/worktree-side-merge-child.test.ts', '--reporter=dot',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CORTEX_IDE_DATA_DIR: dataDir,
        O8_DATA_DIR: dataDir,
        O8_TEST_DATA_DIR_PINNED: dataDir,
        O8_SKIP_PRELAUNCH_TYPECHECK: '1',
        O8_TEST_MERGE_LANE_ID: firstLane.id,
        O8_TEST_MERGE_RESULT_PATH: resultPath,
      },
      stdio: 'pipe',
    });
    let childOutput = '';
    child.stdout.on('data', (chunk) => { childOutput += String(chunk); });
    child.stderr.on('data', (chunk) => { childOutput += String(chunk); });
    const childDone = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => code === 0
        ? resolve()
        : reject(new Error(`Merge child exited ${code}.\n${childOutput}`)));
    });

    try {
      await Promise.race([
        waitFor(async () => {
          const snapshot = await getResourceLeaseStore().status(`repo-tree:${repo}`);
          return snapshot.holder?.owner.id.startsWith('repo-action:') === true;
        }),
        childDone.then(() => {
          throw new Error(`Merge child exited before acquiring the repo-tree lease.\n${childOutput}`);
        }),
      ]);
      const startedAt = Date.now();
      const second = await mergeLane(secondLane);
      const waitedMs = Date.now() - startedAt;
      await childDone;

      expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toMatchObject({ ok: true });
      expect(second.result).toMatchObject({ ok: true });
      expect(waitedMs).toBeGreaterThanOrEqual(5_000);
      expect(getLaneEvents(secondLane.id).filter((event) => event.verb === 'lease_wait_timeout'))
        .toHaveLength(0);
      expect(git(repo, ['show', 'HEAD:first.txt'])).toBe('first');
      expect(git(repo, ['show', 'HEAD:second.txt'])).toBe('second');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
  }, 45_000);

  it('escalates a dirty operator checkout instead of stashing or force-merging it', async () => {
    const { repo } = makeRepo('o8-merge-dirty');
    const worktree = await makeWorktree(repo, 'pkt-dirty', 'inline/dirty');
    writeFileSync(join(worktree.path, 'file.txt'), 'base\nworker\n');
    commitAll(worktree.path, 'worker change');
    writeFileSync(join(repo, 'file.txt'), 'base\noperator wip\n');

    const lane = createLane({
      repoPath: repo,
      worktreePath: worktree.path,
      branch: 'inline/dirty',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-dirty',
    });

    const { result, approvals } = await mergeLane(lane);

    expect(result.ok).toBe(false);
    expect(approvals[0]?.policyRuleId).toBe('fast_forward_failure_escalation');
    expect(approvals[0]?.metadata?.FailureCategory).toBe('dirty-working-tree');
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(git(repo, ['status', '--porcelain'])).toContain('M file.txt');
    expect(git(repo, ['stash', 'list'])).toBe('');
    expect(git(repo, ['show', 'HEAD:file.txt'])).toBe('base');
    expect(getLane(lane.id)?.status).not.toBe('completed');
  }, 20_000);

  it('auto-rebases once when origin/main moves between rebase and final fast-forward', async () => {
    const { repo, origin, root } = makeRepo('o8-merge-base-moved');
    const worktree = await makeWorktree(repo, 'pkt-base-moved', 'inline/base-moved');
    writeFileSync(join(worktree.path, 'worker.txt'), 'worker\n');
    commitAll(worktree.path, 'worker change');

    const hookFlag = join(root, 'base-moved-once');
    const hook = join(repo, '.git', 'hooks', 'pre-push');
    writeFileSync(hook, [
      '#!/bin/sh',
      'unset $(git rev-parse --local-env-vars)',
      `if [ ! -f "${hookFlag}" ]; then`,
      `  touch "${hookFlag}"`,
      '  tmp="$(mktemp -d)"',
      `  git clone "${origin}" "$tmp/repo" >/dev/null 2>&1`,
      '  cd "$tmp/repo" || exit 1',
      '  git checkout main >/dev/null 2>&1',
      '  git config user.name o8-test',
      '  git config user.email o8@example.test',
      '  printf "upstream\\n" > upstream.txt',
      '  git add upstream.txt',
      '  git commit -m "upstream moved" >/dev/null 2>&1',
      '  git push origin main >/dev/null 2>&1',
      'fi',
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(hook, 0o755);

    const lane = createLane({
      repoPath: repo,
      worktreePath: worktree.path,
      branch: 'inline/base-moved',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-base-moved',
    });

    const { result, approvals } = await mergeLane(lane);

    expect(result.ok).toBe(true);
    expect(approvals).toEqual([]);
    expect(git(repo, ['show', 'HEAD:worker.txt'])).toBe('worker');
    expect(git(repo, ['show', 'HEAD:upstream.txt'])).toBe('upstream');
    expect(git(repo, ['merge-base', '--is-ancestor', 'origin/main', 'HEAD'])).toBe('');
  }, 20_000);

  async function escalateBaseMovedMerge(name: string, workerPath: string) {
    const { repo, origin, root } = makeRepo(name);
    const worktree = await makeWorktree(repo, `pkt-${name}`, `inline/${name}`);
    mkdirSync(join(worktree.path, workerPath, '..'), { recursive: true });
    writeFileSync(join(worktree.path, workerPath), 'worker\n');
    commitAll(worktree.path, 'worker change');

    // Each time a rebased candidate lands on the operator checkout's merge ref,
    // origin/main moves again, so the auto-rebase retries run out and the
    // merge escalates as a base-moved fast-forward failure.
    const moveOrigin = [
      'unset $(git rev-parse --local-env-vars)',
      'tmp="$(mktemp -d)"',
      `git clone "${origin}" "$tmp/repo" >/dev/null 2>&1`,
      'cd "$tmp/repo" || exit 0',
      'git checkout main >/dev/null 2>&1',
      'git config user.name o8-test',
      'git config user.email o8@example.test',
      'mkdir -p docs',
      'n="$(ls docs | wc -l | tr -d " ")"',
      'printf "upstream\\n" > "docs/upstream-$n.md"',
      'git add docs',
      'git commit -m "upstream moved" >/dev/null 2>&1',
      'git push origin main >/dev/null 2>&1',
      `touch "${join(root, 'base-moved')}"`,
    ];
    const hooks = join(repo, '.git', 'hooks');
    writeFileSync(join(hooks, 'reference-transaction'), [
      '#!/bin/sh',
      '[ "$1" = committed ] || exit 0',
      'grep -v "^[0-9a-f]* 0\\{40\\} " | grep -q " refs/o8/merge/" || exit 0',
      ...moveOrigin,
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(join(hooks, 'reference-transaction'), 0o755);

    const lane = createLane({
      repoPath: repo,
      worktreePath: worktree.path,
      branch: `inline/${name}`,
      baseBranch: 'main',
      runtime: 'codex',
      packetId: `pkt-${name}`,
      sessionKey: `codex:pkt-${name}`,
    });
    const result = await performWorktreeSideMerge({
      lane,
      command: mergeCommand(lane.id),
      actor: 'system',
      gateResult: { passed: true, violations: [] },
      createLaneActionApproval,
    });
    expect(existsSync(join(root, 'base-moved'))).toBe(true);
    expect(result.ok).toBe(false);
    const approval = getApproval(result.approvalId!);
    expect(approval?.policyRuleId).toBe('fast_forward_failure_escalation');
    expect(approval?.metadata?.FailureCategory).toBe('non-fast-forward');
    expect(approval?.title).toContain('(base moved)');
    return approval!;
  }

  it('rates a base-moved escalation of a docs-only diff as low risk', async () => {
    const approval = await escalateBaseMovedMerge('o8-merge-base-moved-docs', 'docs/worker-notes.md');

    expect(approval.risk).toBe('low');
    expect(approval.gateResult).toMatchObject({ passed: true, violations: [] });
    expect(toMobileApprovalCard(approval).severity).not.toBe('critical');
  }, 60_000);

  it('keeps high risk on a base-moved escalation that touches code', async () => {
    const approval = await escalateBaseMovedMerge('o8-merge-base-moved-code', 'src/worker.ts');

    expect(approval.risk).toBe('high');
    expect(toMobileApprovalCard(approval).severity).toBe('critical');
  }, 60_000);

  it('does not recreate a remotely deleted base branch from a stale reviewed candidate', async () => {
    const { repo, origin } = makeRepo('o8-merge-base-deleted');
    const worktree = await makeWorktree(repo, 'pkt-base-deleted', 'inline/base-deleted');
    writeFileSync(join(worktree.path, 'worker.txt'), 'worker\n');
    commitAll(worktree.path, 'worker change');
    const hook = join(repo, '.git', 'hooks', 'pre-push');
    writeFileSync(hook, [
      '#!/bin/sh',
      'unset $(git rev-parse --local-env-vars)',
      'while read local_ref local_sha remote_ref remote_sha; do',
      '  if [ "$remote_ref" = "refs/heads/main" ]; then',
      `    git --git-dir="${origin}" update-ref -d refs/heads/main`,
      '  fi',
      'done',
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(hook, 0o755);
    const lane = createLane({
      repoPath: repo,
      worktreePath: worktree.path,
      branch: 'inline/base-deleted',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-base-deleted',
    });

    const { result } = await mergeLane(lane);

    expect(result).toMatchObject({ ok: true, pushedToOrigin: false });
    expect(git(repo, ['show', 'HEAD:worker.txt'])).toBe('worker');
    expect(git(repo, ['ls-remote', '--heads', 'origin', 'main'])).toBe('');
  }, 20_000);

  it('keeps the reviewed packet worktree recoverable when a spoken retry conflicts', async () => {
    const { repo, origin, root } = makeRepo('o8-spoken-retry-conflict');
    const worktree = await makeWorktree(repo, 'pkt-spoken-retry-conflict', 'inline/spoken-retry-conflict');
    writeFileSync(join(worktree.path, 'file.txt'), 'worker\n');
    commitAll(worktree.path, 'worker conflict change');
    const reviewedHeadSha = git(worktree.path, ['rev-parse', 'HEAD']);
    const lane = createLane({
      repoPath: repo,
      worktreePath: worktree.path,
      branch: 'inline/spoken-retry-conflict',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-spoken-retry-conflict',
      sessionKey: 'codex:pkt-spoken-retry-conflict',
    });
    recordOrchestratorReview(lane.packetId!, {
      approved: true,
      findings: [],
      reviewer: 'codex',
      reviewedHeadSha,
      requiresSecondPass: false,
    });
    const approval = createApproval({
      source: 'runtime',
      runtime: 'codex',
      agent: 'worker',
      sessionKey: lane.sessionKey!,
      title: 'Merge reviewed packet',
      description: 'Merge reviewed packet',
      summary: 'Merge reviewed packet',
      risk: 'high',
      policyRuleId: 'lane-merge',
      continuation: { kind: 'lane', laneId: lane.id, verb: 'merge' },
    });
    const reviewed = await getLaneSpokenDiffFacts(lane);
    const governanceFingerprint = await currentSpokenReviewGovernanceFingerprint(approval, lane);
    const reviewedLaneStatus = getLane(lane.id)!.status;
    const claim = claimApprovalResolution(approval.id, 'approve', 'desktop', undefined, approval.updatedAt);

    const hookFlag = join(root, 'spoken-base-moved-once');
    const hook = join(repo, '.git', 'hooks', 'pre-push');
    writeFileSync(hook, [
      '#!/bin/sh',
      'unset $(git rev-parse --local-env-vars)',
      `if [ ! -f "${hookFlag}" ]; then`,
      `  touch "${hookFlag}"`,
      '  tmp="$(mktemp -d)"',
      `  git clone "${origin}" "$tmp/repo" >/dev/null 2>&1`,
      '  cd "$tmp/repo" || exit 1',
      '  git checkout main >/dev/null 2>&1',
      '  git config user.name o8-test',
      '  git config user.email o8@example.test',
      '  printf "upstream\\n" > file.txt',
      '  git add file.txt',
      '  git commit -m "upstream conflict" >/dev/null 2>&1',
      '  git push origin main >/dev/null 2>&1',
      'fi',
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(hook, 0o755);

    const result = await performWorktreeSideMerge({
      lane,
      command: {
        verb: 'merge',
        laneId: lane.id,
        actor: 'user',
        expectedHeadSha: reviewedHeadSha,
        expectedDiffFingerprint: reviewed.fingerprint,
        expectedGovernanceFingerprint: governanceFingerprint,
        spokenReviewApprovalId: approval.id,
        spokenReviewClaimId: claim.claimId,
        spokenReviewUpdatedAt: approval.updatedAt,
        spokenReviewLaneStatus: reviewedLaneStatus,
      },
      actor: 'user',
      gateResult: { passed: true, violations: [] },
      createLaneActionApproval,
    });

    expect(result.ok).toBe(false);
    const conflictApproval = listApprovalsForContext({ laneId: lane.id })
      .find((candidate) => candidate.policyRuleId === 'rebase_conflict_escalation');
    expect(conflictApproval?.description).toContain(worktree.path);
    expect(conflictApproval?.description).toContain('isolated integration checkout was discarded');
    expect(conflictApproval?.description).not.toContain('o8-reviewed-integration-');
    expect(existsSync(worktree.path)).toBe(true);
    expect(git(worktree.path, ['rev-parse', 'HEAD'])).toBe(reviewedHeadSha);
    expect(git(worktree.path, ['status', '--porcelain'])).toBe('');
    expect(conflictApproval?.args?.preservedRef).toEqual(expect.any(String));
    expect(git(repo, ['rev-parse', String(conflictApproval?.args?.preservedRef)])).toBe(reviewedHeadSha);
  }, 30_000);

  it('merge approval emits nothing while product telemetry is off and once while on', async () => {
    const previousProxyUrl = process.env.O8_PROXY_URL;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const mergeOnce = async (suffix: string) => {
      const { repo } = makeRepo(`o8-merge-telemetry-${suffix}`);
      const worktree = await makeWorktree(repo, `pkt-telemetry-${suffix}`, `inline/telemetry-${suffix}`);
      writeFileSync(join(worktree.path, `${suffix}.txt`), `${suffix}\n`);
      commitAll(worktree.path, `${suffix} change`);
      const lane = createLane({
        repoPath: repo,
        worktreePath: worktree.path,
        branch: `inline/telemetry-${suffix}`,
        baseBranch: 'main',
        runtime: 'codex',
        packetId: `pkt-telemetry-${suffix}`,
      });
      expect((await mergeLane(lane)).result.ok).toBe(true);
    };

    try {
      writeFileSync(join(dataDir, 'entitlement.json'), JSON.stringify({ licenseKey: 'header.payload.signature' }));
      process.env.O8_PROXY_URL = 'https://telemetry.example.test';
      fetchSpy.mockResolvedValue(Response.json({ ok: true }));
      await updateOperatorDefaults({ productTelemetryEnabled: false });
      await mergeOnce('off');
      expect(fetchSpy.mock.calls.filter(([input]) => String(input).endsWith('/v1/telemetry'))).toHaveLength(0);

      await updateOperatorDefaults({
        productTelemetryEnabled: true, crashReportsEnabled: false, telemetryConsentAnswered: true,
      });
      await mergeOnce('on');
      const telemetry = fetchSpy.mock.calls.filter(([input]) => String(input).endsWith('/v1/telemetry'));
      expect(telemetry).toHaveLength(1);
      expect(telemetry[0]?.[1]).toMatchObject({
        body: JSON.stringify({ event: 'merge.approved', props: { runtime: 'codex', pushed: true } }),
      });
    } finally {
      try {
        await updateOperatorDefaults({ productTelemetryEnabled: false });
      } finally {
        if (previousProxyUrl === undefined) delete process.env.O8_PROXY_URL;
        else process.env.O8_PROXY_URL = previousProxyUrl;
        fetchSpy.mockRestore();
      }
    }
  }, 30_000);
});

describe('typecheck escalation counters through real merge attempts', () => {
  async function makeTypecheckFailureLane(packetId: string, retries: number) {
    const { repo } = makeRepo(`o8-merge-ts-${packetId}`);
    writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true },
      include: ['src/**/*.ts'],
    }, null, 2));
    execFileSync('mkdir', ['-p', join(repo, 'src')]);
    writeFileSync(join(repo, 'src', 'index.ts'), 'export const ok: string = "base";\n');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    commitAll(repo, 'add ts project');
    git(repo, ['push', 'origin', 'main']);

    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      repoPath: repo,
      packets: [packetFixture(packetId, repo, retries)],
    });

    const worktree = await makeWorktree(repo, packetId, `inline/${packetId}`);
    const binDir = join(worktree.path, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    const tscPath = join(binDir, 'tsc');
    writeFileSync(tscPath, [
      '#!/bin/sh',
      "echo \"src/broken.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.\"",
      'exit 2',
      '',
    ].join('\n'));
    chmodSync(tscPath, 0o755);
    writeFileSync(join(worktree.path, 'src', 'broken.ts'), 'export const broken: string = 123;\n');
    commitAll(worktree.path, 'break typecheck');

    const lane = createLane({
      repoPath: repo,
      worktreePath: worktree.path,
      branch: `inline/${packetId}`,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
      sessionKey: `codex-owned:${packetId}`,
    });
    return { repo, lane };
  }

  it('supersedes the durable review on layer-1 retry and bails when reset_packet has held the packet', async () => {
    const { lane } = await makeTypecheckFailureLane('pkt-typecheck-held', 0);
    recordOrchestratorReview('pkt-typecheck-held', {
      approved: true,
      findings: [],
      reviewedHeadSha: git(lane.worktreePath!, ['rev-parse', 'HEAD']),
    });
    const { result } = await mergeLane(lane);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const packet = readOrchestratorControlPlaneState().packets.find((p) => p.id === 'pkt-typecheck-held');
    const events = getLaneEvents(lane.id);
    expect(result.ok).toBe(false);
    expect(result.note).toContain('Auto-rerun dispatched');
    expect(packet?.queueState).toBe('held');
    expect(packet?.typecheckAutoRetries).toBe(1);
    expect(events.filter((event) => event.verb === 'typecheck_auto_retry')).toHaveLength(1);
    expect(getLane(lane.id)?.status).toBe('reviewing');
    expect(listApprovalsForContext({ packetId: 'pkt-typecheck-held', laneId: lane.id })
      .find((approval) => approval.toolName === 'orchestrator_review')?.args)
      .toMatchObject({
        reviewSuperseded: true,
        reviewSupersededReason: 'Superseded by typecheck auto-rerun.',
      });
  }, 20_000);

  it('caps layer-1 at one retry and escalates the next failing merge to awaiting_orchestrator', async () => {
    const { lane } = await makeTypecheckFailureLane('pkt-typecheck-cap', 1);
    const { result } = await mergeLane(lane);
    const packet = readOrchestratorControlPlaneState().packets.find((p) => p.id === 'pkt-typecheck-cap');
    const events = getLaneEvents(lane.id);

    expect(result.ok).toBe(false);
    expect(result.note).toContain('Typecheck failed after 1 auto-retry');
    expect(packet?.typecheckAutoRetries).toBe(1);
    expect(getLane(lane.id)?.status).toBe('awaiting_orchestrator');
    expect(events.some((event) =>
      event.verb === 'typecheck_escalation'
      && event.payload.reason === 'retry_exhausted'
    )).toBe(true);
  }, 20_000);
});

describe('retry budget and escalation branch invariants', () => {
  it('steers a warm parked packet, while packets without a session must fresh-redispatch', async () => {
    const performSpy = vi.spyOn(runtimeActions, 'performRuntimeAction').mockResolvedValue({
      ok: true,
      action: 'steer',
      surfaceId: 'codex-owned:warm-branch',
      sessionKey: 'codex-owned:warm-branch',
      runtime: 'codex',
      status: 'completed',
      note: 'steered',
    });

    try {
      const repo = mkdtempSync(join(os.tmpdir(), 'o8-steer-branch-repo-'));
      tempDirs.push(repo);
      git(repo, ['init', '-b', 'main']);
      writeOrchestratorControlPlaneState({
        ...createEmptyOrchestratorMissionState(),
        repoPath: repo,
        packets: [packetFixture('pkt-warm-branch', repo, 1)],
      });
      const warmLane = createLane({
        repoPath: repo,
        worktreePath: repo,
        branch: 'inline/warm-branch',
        baseBranch: 'main',
        runtime: 'codex',
        packetId: 'pkt-warm-branch',
        sessionKey: 'codex-owned:warm-branch',
      });

      await expect(steerPacket({
        packetId: 'pkt-warm-branch',
        message: 'fix the typecheck errors and proceed',
      })).resolves.toMatchObject({
        laneId: warmLane.id,
        note: 'Steered packet via warm session.',
      });

      const coldLane = createLane({
        repoPath: repo,
        branch: 'inline/cold-branch',
        baseBranch: 'main',
        runtime: 'codex',
        packetId: 'pkt-cold-branch',
      });
      writeOrchestratorControlPlaneState({
        ...readOrchestratorControlPlaneState(),
        packets: [
          ...readOrchestratorControlPlaneState().packets,
          packetFixture('pkt-cold-branch', repo, 1),
        ],
      });

      await expect(steerPacket({
        packetId: 'pkt-cold-branch',
        message: 'try warm steer',
      })).rejects.toThrow('use rerun_with_feedback instead');
      expect(getLane(warmLane.id)?.status).toBe('running');
      expect(getLane(coldLane.id)?.status).not.toBe('running');
    } finally {
      performSpy.mockRestore();
    }
  }, 20_000);

  it('never mocks the typecheck skip seam while allowing tests to assert it was reached', async () => {
    const repo = mkdtempSync(join(os.tmpdir(), 'o8-typecheck-skip-repo-'));
    tempDirs.push(repo);
    git(repo, ['init', '-b', 'main']);
    expect(await typecheckAvailability.detectTypecheckSkip(repo)).toEqual({
      skip: true,
      reason: 'no tsconfig.json (not a TypeScript project)',
    });
  });
});
