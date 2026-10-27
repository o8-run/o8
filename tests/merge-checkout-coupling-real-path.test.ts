import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-merge-checkout-coupling-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const { publishRealtimeMutation } = vi.hoisted(() => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));
const mergeFailure = vi.hoisted(() => ({ reason: null as string | null }));

vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation }));
vi.mock('@/lib/lane/worktree-merge-git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/worktree-merge-git')>();
  return {
    ...actual,
    hasPushRemote: async (...args: Parameters<typeof actual.hasPushRemote>) => {
      if (mergeFailure.reason) {
        const reason = mergeFailure.reason;
        mergeFailure.reason = null;
        throw new Error(reason);
      }
      return actual.hasPushRemote(...args);
    },
  };
});

vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed' as const,
    probePath: '/',
    availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000,
    totalBytes: 100_000_000_000,
    error: null,
  })),
}));

vi.mock('@/lib/worktree/apfs', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/apfs')>(),
  getApfsCowCapability: vi.fn(async () => ({
    macos: true,
    apfs: true,
    sameVolume: true,
    canCowClone: true,
  })),
}));

const mergeRoute = await import('@/app/api/orchestrator/merge/route');
const laneEventsRoute = await import('@/app/api/lanes/[id]/events/route');
const mergePreviewRoute = await import('@/app/api/orchestrator/merge-preview/route');
const reviewRoute = await import('@/app/api/orchestrator/review/route');
const reviewStateRoute = await import('@/app/api/orchestrator/review-state/route');
const { listApprovalsForContext, recordOrchestratorReview } = await import('@/lib/approvals/store');
const { createLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const { assessDurableApprovedReview } = await import('@/lib/lane/durable-review-approval');
const { recordMission } = await import('@/lib/db/missions-store');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { normalizeOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { __resetIdempotencyStoreForTests } = await import('@/lib/orchestrator/idempotency-store');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');

const tempDirs: string[] = [dataDir];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ['add', '-A']);
  git(cwd, [
    '-c', 'user.name=o8-test',
    '-c', 'user.email=o8@example.test',
    'commit', '-m', message,
  ]);
}

type LintFixtureMode = 'error' | 'clean' | 'no-config';

async function createFixture(
  label: string,
  approved: boolean,
  lintMode?: LintFixtureMode,
  isolationPreference: 'git-worktree' | 'apfs-cow-clone' = 'git-worktree',
) {
  const root = mkdtempSync(join(os.tmpdir(), `o8-merge-checkout-${label}-`));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'operator');
  const packetId = `pkt-merge-checkout-${label}-${Date.now()}`;
  const branch = `inline/merge-checkout-${label}-${Date.now()}`;
  tempDirs.push(root);

  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  git(repo, ['checkout', '-b', 'main']);
  git(repo, ['config', 'user.name', 'o8-test']);
  git(repo, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  if (lintMode) {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({
      private: true,
      scripts: { lint: 'eslint .' },
      devDependencies: { eslint: '^9.39.5' },
    }, null, 2));
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    if (lintMode !== 'no-config') {
      writeFileSync(join(repo, 'eslint.config.mjs'), [
        'export default [{',
        "  files: ['**/*.js'],",
        "  linterOptions: { reportUnusedDisableDirectives: 'error' },",
        '}];',
        '',
      ].join('\n'));
    }
  }
  commitAll(repo, 'base');
  git(repo, ['push', '-u', 'origin', 'main']);

  const worktree = await getWorktreeManager(repo).create({
    agentType: 'codex',
    taskName: packetId,
    branchName: branch,
    baseBranch: 'main',
    packetId,
    skipSetup: true,
    isolationPreference,
  });
  git(worktree.path, ['config', 'user.name', 'o8-test']);
  git(worktree.path, ['config', 'user.email', 'o8@example.test']);
  if (lintMode) {
    symlinkSync(join(process.cwd(), 'node_modules'), join(worktree.path, 'node_modules'), 'junction');
    mkdirSync(join(worktree.path, 'src'), { recursive: true });
    writeFileSync(
      join(worktree.path, 'src', 'packet.js'),
      lintMode === 'error'
        ? '/* eslint-disable no-console */\nexport const packetValue = 1;\n'
        : 'export const packetValue = 1;\n',
    );
  } else {
    writeFileSync(join(worktree.path, 'file.txt'), 'base\nworker\n');
  }
  commitAll(worktree.path, 'worker change');
  const reviewedHeadSha = git(worktree.path, ['rev-parse', 'HEAD']);
  const lane = createLane({
    repoPath: repo,
    worktreePath: worktree.path,
    branch,
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
    sessionKey: `codex:${packetId}`,
    label: `Merge checkout ${label}`,
  });
  if (approved) {
    recordOrchestratorReview(packetId, {
      approved: true,
      findings: [],
      reviewer: 'codex',
      reviewedHeadSha,
      requiresSecondPass: false,
    });
  }

  const packet = {
    id: packetId,
    referenceLabel: 'P1',
    title: `Merge checkout ${label}`,
    summary: `Merge checkout ${label}`,
    status: 'awaiting_review',
    queueState: 'held',
    releaseState: 'pending',
    runtime: 'codex',
    wave: 1,
    dependencyPacketIds: [],
    dependencyLabels: [],
    blockedReason: null,
    lane: null,
    review: approved ? {
      approved: true,
      findings: [],
      recordedAt: new Date().toISOString(),
      reviewedHeadSha,
      summary: 'Approved. No findings recorded.',
      auditApprovalId: null,
    } : null,
    workspaceTargetPath: repo,
    branchTarget: branch,
    typecheckAutoRetries: lintMode === 'error' ? 1 : 0,
  } as OrchestratorPacket;
  const missionState = normalizeOrchestratorMissionState({
    version: 2,
    missionId: `mission-${packetId}`,
    prompt: packet.summary,
    summary: packet.summary,
    repoPath: repo,
    runtime: 'codex',
    constraints: '',
    packets: [packet],
    updatedAt: new Date().toISOString(),
  });
  recordMission({
    id: missionState.missionId!,
    repoPath: repo,
    runtime: 'codex',
    prompt: missionState.prompt,
    summary: missionState.summary,
    constraints: '',
    packetMeta: [{ id: packetId, title: packet.title, referenceLabel: packet.referenceLabel }],
    missionState,
    totalWaves: 1,
  });
  writeOrchestratorControlPlaneState(missionState);
  return { lane, repo, origin, packetId, reviewedHeadSha, root };
}

function mergeRequest(packetId: string): NextRequest {
  return new NextRequest('http://localhost:3001/api/orchestrator/merge', {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${getOrCreateWsToken()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ packetId, idempotencyKey: randomUUID() }),
  });
}

function laneEventsRequest(laneId: string): NextRequest {
  return new NextRequest(`http://localhost:3001/api/lanes/${laneId}/events`, {
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${getOrCreateWsToken()}`,
    },
  });
}

function reviewStateRequest(packetId: string): NextRequest {
  return new NextRequest(
    `http://localhost:3001/api/orchestrator/review-state?packetId=${encodeURIComponent(packetId)}&spoken=1`,
    {
      headers: {
        host: 'localhost:3001',
        authorization: `Bearer ${getOrCreateWsToken()}`,
      },
    },
  );
}

function mergePreviewRequest(packetId: string): NextRequest {
  return new NextRequest(
    `http://localhost:3001/api/orchestrator/merge-preview?packetId=${encodeURIComponent(packetId)}`,
    {
      headers: {
        host: 'localhost:3001',
        authorization: `Bearer ${getOrCreateWsToken()}`,
      },
    },
  );
}

beforeAll(async () => {
  await updateOperatorDefaults({
    productTelemetryEnabled: false,
    storageReserveRatio: 0.0001,
    storageReserveFloorGb: 0.001,
  });
});

afterEach(() => {
  __resetIdempotencyStoreForTests();
  publishRealtimeMutation.mockClear();
  mergeFailure.reason = null;
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('merge checkout coupling through real handlers', () => {
  const capturedContract = {
    version: 1 as const,
    requirements: [{ id: 'R1', source: 'Change file.txt', expectedBehavior: 'Changed content is merged',
      productionPath: 'file.txt', verification: 'Read the merged file' }],
    processConstraints: [{ id: 'P1', source: 'Review the commit', expectedBehavior: 'Review is pinned', verification: 'git show HEAD' }],
    smallestRoute: [{ path: 'file.txt', requirements: ['R1'], reason: 'One file change' }], exclusions: [],
  };
  function contractPacket(kind: 'none' | 'default-captured' | 'default-missing' | 'armed') {
    const state = readOrchestratorControlPlaneState();
    state.packets[0].taskContractRequired = kind !== 'none';
    state.packets[0].taskContractSource = kind === 'armed' ? 'explicit' : 'default';
    state.packets[0].taskContract = kind === 'default-captured' || kind === 'armed' ? capturedContract : null;
    writeOrchestratorControlPlaneState(state);
  }
  function reviewRequest(body: Record<string, unknown>) {
    return new NextRequest('http://localhost:3001/api/orchestrator/review', {
      method: 'POST', headers: { host: 'localhost:3001', authorization: `Bearer ${getOrCreateWsToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('previews contract IDs, size approval and pending second pass together without creating approval cards', async () => {
    const fixture = await createFixture('all-prerequisites', false);
    writeFileSync(join(fixture.lane.worktreePath!, 'oversized.ts'), '// fixture\n'.repeat(1_100));
    commitAll(fixture.lane.worktreePath!, 'grow fixture file');
    const head = git(fixture.lane.worktreePath!, ['rev-parse', 'HEAD']);
    contractPacket('default-captured');
    recordOrchestratorReview(fixture.packetId, { approved: true, findings: [], reviewedHeadSha: head, requiresSecondPass: true });
    const before = listApprovalsForContext({ packetId: fixture.packetId, laneId: fixture.lane.id });
    const response = await mergePreviewRoute.GET(mergePreviewRequest(fixture.packetId));
    const preview = await response.json();
    expect(response.status).toBe(200);
    expect(preview).toMatchObject({ wouldMerge: false,
      blockers: expect.arrayContaining(['file-size-approval', 'durable-review', 'contract-review']),
      reviewRequirements: { contractKind: 'default-captured', contractVersion: 1, requirementIds: ['R1'], processConstraintIds: ['P1'],
        oversizedFiles: [{ path: 'oversized.ts', lineCount: 1_100 }],
        review: { approved: false, secondPassPending: true, reason: expect.stringContaining('second pass') } },
    });
    expect(preview.reviewRequirements.actions.join('\n')).toContain('--coverage');
    expect(preview.reviewRequirements.actions.join('\n')).toContain('--process-evidence');
    expect(preview.reviewRequirements.actions.join('\n')).toContain('Override file size limit');
    expect(listApprovalsForContext({ packetId: fixture.packetId, laneId: fixture.lane.id })).toEqual(before);
    expect(getLane(fixture.lane.id)?.status).toBe(fixture.lane.status);
    expect(git(fixture.lane.worktreePath!, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it.each(['none', 'default-missing', 'armed'] as const)('reports %s contract kind before attempting review', async kind => {
    const fixture = await createFixture(`contract-${kind}`, false);
    contractPacket(kind);
    const preview = await (await mergePreviewRoute.GET(mergePreviewRequest(fixture.packetId))).json();
    expect(preview.reviewRequirements).toMatchObject({ contractKind: kind,
      requirementIds: kind === 'armed' ? ['R1'] : [], processConstraintIds: kind === 'armed' ? ['P1'] : [] });
    if (kind === 'default-missing') expect(preview.reviewRequirements.actions.join('\n')).toContain('--waive-missing-contract');
  });

  it('returns and replays a typed 422 when a missing-contract waiver targets a captured contract', async () => {
    const fixture = await createFixture('invalid-captured-waiver', false);
    contractPacket('default-captured');
    const input = { packetId: fixture.packetId, approved: true, findings: [], reviewedHeadSha: fixture.reviewedHeadSha,
      missingContractWaiverReason: 'Explicit fixture request', clientMutationId: randomUUID() };
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await reviewRoute.POST(reviewRequest(input));
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'invalid_missing_contract_waiver', message: expect.stringContaining('missing runtime-default contract') } });
      if (attempt) expect(response.headers.get('x-o8-idempotency-replayed')).toBe('1');
    }
    expect(listApprovalsForContext({ packetId: fixture.packetId, laneId: fixture.lane.id })).toEqual([]);
  });

  it('walks captured-contract preview, review and a local fixture merge without retrying unknown gates', async () => {
    const fixture = await createFixture('captured-one-pass', false);
    await updateOperatorDefaults({ requireApproval: 'never' });
    contractPacket('default-captured');
    const before = await (await mergePreviewRoute.GET(mergePreviewRequest(fixture.packetId))).json();
    expect(before.reviewRequirements).toMatchObject({ contractKind: 'default-captured', requirementIds: ['R1'], processConstraintIds: ['P1'] });
    const response = await reviewRoute.POST(reviewRequest({ packetId: fixture.packetId, approved: true, findings: [],
      reviewedHeadSha: fixture.reviewedHeadSha, clientMutationId: randomUUID(), contractCoverageEvidence: {
        contractVersion: 1, headSha: fixture.reviewedHeadSha, entries: [{ requirementId: 'R1', productionPath: 'file.txt' }],
        processEntries: [{ constraintId: 'P1', source: 'command', reference: `git show ${fixture.reviewedHeadSha}` }],
      } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, result: { recorded: true } });
    const after = await (await mergePreviewRoute.GET(mergePreviewRequest(fixture.packetId))).json();
    expect(after).toMatchObject({ wouldMerge: true, blockers: [], reviewRequirements: { review: { approved: true } } });
    const merged = await (await mergeRoute.POST(mergeRequest(fixture.packetId))).json();
    expect(merged).toMatchObject({ ok: true, result: { merged: true } });
    expect(readFileSync(join(fixture.repo, 'file.txt'), 'utf8')).toContain('worker');
  });

  it.each(['git-worktree', 'apfs-cow-clone'] as const)(
    'keeps an approved %s packet mergeable after a dirty checkout blocks the late fast-forward',
    async (isolationPreference) => {
      const fixture = await createFixture(
        `approval-survives-failure-${isolationPreference}`,
        true,
        undefined,
        isolationPreference,
      );
      if (isolationPreference === 'apfs-cow-clone') {
        expect(() => git(fixture.repo, [
          'cat-file', '-e', `${fixture.reviewedHeadSha}^{commit}`,
        ])).toThrow();
      }
      writeFileSync(join(fixture.repo, 'base-advance.txt'), 'new base work\n');
      commitAll(fixture.repo, 'advance base after review');
      git(fixture.repo, ['remote', 'remove', 'origin']);
      writeFileSync(join(fixture.repo, 'file.txt'), 'base\noperator work\n');
      setLaneStatus(fixture.lane.id, 'reviewing', 'system', 'review_ready');

      const blockedResponse = await mergeRoute.POST(mergeRequest(fixture.packetId));
      const blockedPayload = await blockedResponse.json();
      const reviewApproval = listApprovalsForContext({
        packetId: fixture.packetId,
        laneId: fixture.lane.id,
        sessionKey: fixture.lane.sessionKey ?? undefined,
      }).find((approval) => approval.toolName === 'orchestrator_review');

      expect(blockedResponse.status).toBe(200);
      expect(blockedPayload).toMatchObject({ ok: true, result: { merged: false } });
      expect(reviewApproval).toMatchObject({
        status: 'approved',
        args: { approved: true, reviewedHeadSha: fixture.reviewedHeadSha },
      });
      expect(await assessDurableApprovedReview(fixture.lane)).toMatchObject({ approved: true });
      expect(git(fixture.lane.worktreePath!, ['rev-parse', 'HEAD'])).toBe(fixture.reviewedHeadSha);

      writeFileSync(join(fixture.repo, 'file.txt'), 'base\n');
      expect(git(fixture.repo, ['status', '--porcelain'])).toBe('');

      const retryResponse = await mergeRoute.POST(mergeRequest(fixture.packetId));
      const retryPayload = await retryResponse.json();

      expect(retryResponse.status).toBe(200);
      expect(retryPayload).toMatchObject({ ok: true, result: { merged: true } });
      expect(git(fixture.repo, ['show', 'refs/heads/main:file.txt'])).toBe('base\nworker');
    }, 60_000,
  );

  it('persists an unexpected merge failure reason and correlated server log', async () => {
    const fixture = await createFixture('merge-error-reason', true);
    const failureReason = 'synthetic late merge failure';
    setLaneStatus(fixture.lane.id, 'reviewing', 'system', 'review_ready');
    mergeFailure.reason = failureReason;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const mergeResponse = await mergeRoute.POST(mergeRequest(fixture.packetId));
      const mergePayload = await mergeResponse.json();
      const eventsResponse = await laneEventsRoute.GET(
        laneEventsRequest(fixture.lane.id),
        { params: Promise.resolve({ id: fixture.lane.id }) },
      );
      const eventsPayload = await eventsResponse.json();
      const mergeError = eventsPayload.events.find((event: {
        laneId?: string;
        verb?: string;
        payload?: Record<string, unknown>;
      }) => event.laneId === fixture.lane.id
        && event.verb === 'status_change'
        && event.payload?.eventLabel === 'merge_error');

      expect(mergeResponse.status).toBe(200);
      expect(mergePayload).toMatchObject({ ok: true, result: { merged: false } });
      expect(eventsResponse.status).toBe(200);
      expect(mergeError?.payload).toMatchObject({
        status: 'reviewing',
        eventLabel: 'merge_error',
        reason: failureReason,
      });
      expect(getLane(fixture.lane.id)).toMatchObject({
        status: 'reviewing',
        lastEventLabel: 'merge_error',
      });
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
        `[lane-merge] Merge failed for lane ${fixture.lane.id} (packet ${fixture.packetId}):`,
      ));
    } finally {
      consoleError.mockRestore();
    }
  }, 30_000);

  it('refuses lint errors and reports the changed-file diagnostic through preview and approve_and_merge', async () => {
    const fixture = await createFixture('lint-error', true, 'error');
    const baseHead = git(fixture.repo, ['rev-parse', 'refs/heads/main']);

    const previewResponse = await mergePreviewRoute.GET(mergePreviewRequest(fixture.packetId));
    const preview = await previewResponse.json();
    const previewLint = preview.checks.find((check: { name: string }) => check.name === 'lint');
    const previewTypecheck = preview.checks.find((check: { name: string }) => check.name === 'typecheck');

    expect(previewResponse.status).toBe(200);
    expect(preview).toMatchObject({ wouldMerge: false, blockers: ['lint'] });
    expect(previewTypecheck).toMatchObject({ name: 'typecheck', verdict: 'skipped' });
    expect(previewLint).toMatchObject({ name: 'lint', verdict: 'fail' });
    expect(previewLint.detail).toContain('src/packet.js:1:unused-disable');

    const mergeResponse = await mergeRoute.POST(mergeRequest(fixture.packetId));
    const payload = await mergeResponse.json();
    const lintCheck = payload.result.checks.find((check: { name: string }) => check.name === 'lint');

    expect(mergeResponse.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      result: {
        merged: false,
        blockers: ['lint'],
      },
    });
    expect(lintCheck).toMatchObject({ name: 'lint', verdict: 'fail' });
    expect(lintCheck.detail).toContain('src/packet.js:1:unused-disable');
    expect(payload.result.note).toContain('src/packet.js:1:unused-disable');
    expect(git(fixture.repo, ['rev-parse', 'refs/heads/main'])).toBe(baseHead);
  }, 60_000);

  it('merges a clean linted packet with a passing receipt', async () => {
    const clean = await createFixture('lint-clean', true, 'clean');
    const cleanResponse = await mergeRoute.POST(mergeRequest(clean.packetId));
    const cleanPayload = await cleanResponse.json();
    const cleanLint = cleanPayload.result.checks.find((check: { name: string }) => check.name === 'lint');

    expect(cleanResponse.status).toBe(200);
    expect(cleanPayload).toMatchObject({ ok: true, result: { merged: true } });
    expect(cleanLint).toMatchObject({ name: 'lint', verdict: 'pass' });
  }, 60_000);

  it('merges with a skipped lint receipt when config is absent', async () => {
    const noConfig = await createFixture('lint-no-config', true, 'no-config');
    const noConfigResponse = await mergeRoute.POST(mergeRequest(noConfig.packetId));
    const noConfigPayload = await noConfigResponse.json();
    const skippedLint = noConfigPayload.result.checks.find((check: { name: string }) => check.name === 'lint');

    expect(noConfigResponse.status).toBe(200);
    expect(noConfigPayload).toMatchObject({ ok: true, result: { merged: true } });
    expect(skippedLint).toMatchObject({ name: 'lint', verdict: 'skipped' });
    expect(skippedLint.detail).toContain('no ESLint config');
  }, 60_000);

  it('refuses before advancing a base branch held by another worktree', async () => {
    const fixture = await createFixture('base-held-elsewhere', true);
    git(fixture.repo, ['checkout', '-b', 'operator/wip']);
    const baseWorktree = join(fixture.root, 'base-holder');
    git(fixture.repo, ['worktree', 'add', baseWorktree, 'main']);
    const baseShaBefore = git(fixture.repo, ['rev-parse', 'refs/heads/main']);
    const baseIndexBefore = git(baseWorktree, ['write-tree']);
    const baseStatusBefore = git(baseWorktree, ['status', '--porcelain']);
    const baseFileBefore = readFileSync(join(baseWorktree, 'file.txt'), 'utf8');

    const response = await mergeRoute.POST(mergeRequest(fixture.packetId));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      result: { merged: false },
    });
    expect(payload.result.approvalId).toEqual(expect.any(String));
    expect(git(fixture.repo, ['rev-parse', 'refs/heads/main'])).toBe(baseShaBefore);
    expect(git(baseWorktree, ['rev-parse', 'HEAD'])).toBe(baseShaBefore);
    expect(git(baseWorktree, ['write-tree'])).toBe(baseIndexBefore);
    expect(git(baseWorktree, ['status', '--porcelain'])).toBe(baseStatusBefore);
    expect(readFileSync(join(baseWorktree, 'file.txt'), 'utf8')).toBe(baseFileBefore);
  }, 30_000);

  it('lands the base ref while leaving an unrelated dirty operator checkout untouched', async () => {
    const fixture = await createFixture('unrelated-dirty', true);
    git(fixture.repo, ['checkout', '-b', 'operator/wip']);
    writeFileSync(join(fixture.repo, 'file.txt'), 'base\noperator wip\n');
    writeFileSync(join(fixture.repo, 'operator-notes.txt'), 'do not touch\n');
    const branchBefore = git(fixture.repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const headBefore = git(fixture.repo, ['rev-parse', 'HEAD']);
    const statusBefore = git(fixture.repo, ['status', '--porcelain']);
    const stashBefore = git(fixture.repo, ['stash', 'list']);

    const response = await mergeRoute.POST(mergeRequest(fixture.packetId));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, result: { merged: true } });
    expect(git(fixture.repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(branchBefore);
    expect(git(fixture.repo, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(git(fixture.repo, ['status', '--porcelain'])).toBe(statusBefore);
    expect(readFileSync(join(fixture.repo, 'file.txt'), 'utf8')).toBe('base\noperator wip\n');
    expect(readFileSync(join(fixture.repo, 'operator-notes.txt'), 'utf8')).toBe('do not touch\n');
    expect(git(fixture.repo, ['stash', 'list'])).toBe(stashBefore);
    expect(git(fixture.repo, ['show', 'refs/heads/main:file.txt'])).toBe('base\nworker');
    expect(git(fixture.repo, ['rev-parse', 'refs/heads/main'])).toBe(payload.result.mergeSha);
    expect(git(fixture.repo, ['ls-remote', '--heads', fixture.origin, 'main']).split(/\s+/)[0])
      .toBe(payload.result.mergeSha);
  }, 30_000);

  it('surfaces a conflicting local-only dirty base checkout in the review state with both branch names', async () => {
    const fixture = await createFixture('base-dirty-review', false);
    git(fixture.repo, ['remote', 'remove', 'origin']);
    writeFileSync(join(fixture.repo, 'file.txt'), 'base\noperator wip\n');

    const response = await reviewStateRoute.GET(reviewStateRequest(fixture.packetId));
    const payload = await response.json();
    const cleanCheck = payload.spokenReview?.mergeGate?.checks?.find((check: { name: string }) => (
      check.name === 'clean-worktree'
    ));

    expect(response.status).toBe(200);
    expect(payload.state).toBe('needs-revision');
    expect(payload.spokenReview.mergeGate.verdict).toBe('failing');
    expect(cleanCheck).toMatchObject({ name: 'clean-worktree', verdict: 'fail' });
    expect(cleanCheck.detail).toContain('found operator checkout branch "main"');
    expect(cleanCheck.detail).toContain('needs base branch "main"');
    expect(cleanCheck.detail).toContain('file.txt');
    expect(git(fixture.repo, ['stash', 'list'])).toBe('');
    expect(git(fixture.repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(readFileSync(join(fixture.repo, 'file.txt'), 'utf8')).toBe('base\noperator wip\n');
  }, 30_000);
});
