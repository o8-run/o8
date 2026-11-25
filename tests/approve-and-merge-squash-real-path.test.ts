import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const lifecycle = vi.hoisted(() => ({ afterMerge: null as (() => void) | null }));
vi.mock('@/lib/lane/commands', async (original) => {
  const actual = await original<typeof import('@/lib/lane/commands')>();
  return { ...actual, dispatch: async (...args: Parameters<typeof actual.dispatch>) => {
    const result = await actual.dispatch(...args);
    if (args[0].verb === 'merge' && result.ok) lifecycle.afterMerge?.();
    return result;
  } };
});

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-governed-squash-'));
const originalDataDir = process.env.CORTEX_IDE_DATA_DIR;
const originalO8DataDir = process.env.O8_DATA_DIR;
const originalSkipTypecheck = process.env.O8_SKIP_PRELAUNCH_TYPECHECK;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));

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

const mergeRoute = await import('@/app/api/orchestrator/merge/route');
const { recordOrchestratorReview } = await import('@/lib/approvals/store');
const { AGENT_COMMIT_TRAILER } = await import('@/lib/lane/commit-attribution');
const { createLane } = await import('@/lib/lane/registry');
const { getMissionStatus } = await import('@/lib/orchestrator/operator-mission-service');
const { recordMission } = await import('@/lib/db/missions-store');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const {
  createEmptyOrchestratorMissionState,
  normalizeOrchestratorMissionState,
} = await import('@/lib/orchestrator/store');
const { __resetIdempotencyStoreForTests } = await import('@/lib/orchestrator/idempotency-store');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');

const roots: string[] = [];

function restoreEnv(key: 'CORTEX_IDE_DATA_DIR' | 'O8_DATA_DIR' | 'O8_SKIP_PRELAUNCH_TYPECHECK', value: string | undefined) {
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

async function createFixture(
  label: string,
  workingSubjects = [
    'fix: add first packet change',
    'wip: preserve intermediate packet state',
    'fix: finalize packet state',
  ],
) {
  const root = mkdtempSync(join(os.tmpdir(), `o8-governed-squash-${label}-`));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'operator');
  const packetId = `pkt-governed-squash-${label}-${Date.now()}`;
  const branch = `inline/governed-squash-${label}-${Date.now()}`;
  roots.push(root);

  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  git(repo, ['checkout', '-b', 'main']);
  git(repo, ['config', 'user.name', 'o8-test']);
  git(repo, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  const baseSha = commitAll(repo, 'chore: initialize fixture');
  git(repo, ['push', '-u', 'origin', 'main']);

  const worktree = await getWorktreeManager(repo).create({
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
  writeFileSync(join(worktree.path, 'first.txt'), 'first\n');
  commitAll(worktree.path, workingSubjects[0]!);
  writeFileSync(join(worktree.path, 'intermediate.txt'), 'intermediate\n');
  commitAll(worktree.path, workingSubjects[1]!);
  writeFileSync(join(worktree.path, 'final.txt'), 'final\n');
  const reviewedHeadSha = commitAll(worktree.path, workingSubjects[2]!);

  createLane({
    repoPath: repo,
    worktreePath: worktree.path,
    branch,
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
    sessionKey: `codex:${packetId}`,
    label: `Governed squash ${label}`,
  });
  recordOrchestratorReview(packetId, {
    approved: true,
    findings: [],
    reviewer: 'codex',
    reviewedHeadSha,
    requiresSecondPass: false,
  });

  const packet = {
    id: packetId,
    referenceLabel: 'P1',
    title: `Governed squash ${label}`,
    summary: `Governed squash ${label}`,
    status: 'awaiting_review',
    queueState: 'held',
    releaseState: 'pending',
    runtime: 'codex',
    wave: 1,
    dependencyPacketIds: [],
    dependencyLabels: [],
    blockedReason: null,
    lane: null,
    review: {
      approved: true,
      findings: [],
      recordedAt: new Date().toISOString(),
      reviewedHeadSha,
      summary: 'Approved. No findings recorded.',
      auditApprovalId: null,
    },
    workspaceTargetPath: repo,
    branchTarget: branch,
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
  return { baseSha, origin, packetId, repo, reviewedHeadSha, workingSubjects };
}

function mergeRequest(packetId: string, commitMessage?: string): NextRequest {
  return new NextRequest('http://localhost:3001/api/orchestrator/merge', {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${getOrCreateWsToken()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ packetId, commitMessage, idempotencyKey: randomUUID() }),
  });
}

function baseSubjects(repo: string): string[] {
  return git(repo, ['log', '--format=%s', 'refs/heads/main']).split('\n');
}

beforeAll(async () => {
  await updateOperatorDefaults({
    commitAttributionEnabled: true,
    storageReserveRatio: 0.0001,
    storageReserveFloorGb: 0.001,
  });
});

afterEach(() => {
  lifecycle.afterMerge = null;
  writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
  __resetIdempotencyStoreForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  restoreEnv('CORTEX_IDE_DATA_DIR', originalDataDir);
  restoreEnv('O8_DATA_DIR', originalO8DataDir);
  restoreEnv('O8_SKIP_PRELAUNCH_TYPECHECK', originalSkipTypecheck);
});

describe('approve_and_merge governed squash through the route handler', () => {
  it('reports a successful local merge when the canonical repository has no push remote', async () => {
    const fixture = await createFixture('local-only');
    git(fixture.repo, ['remote', 'remove', 'origin']);
    expect(git(fixture.repo, ['remote'])).toBe('');

    const response = await mergeRoute.POST(mergeRequest(fixture.packetId));
    const payload = await response.json();
    const status = await getMissionStatus({ includeCost: false });
    const packet = status.packets.find((candidate) => candidate.id === fixture.packetId);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, result: { merged: true } });
    expect(payload.result.note).toContain('No push remote is configured');
    expect(payload.result.note).not.toMatch(/push(?: to origin)? failed|fatal:/i);
    expect(git(fixture.repo, ['rev-parse', 'refs/heads/main'])).toBe(payload.result.mergeSha);
    expect(packet).toMatchObject({ status: 'released', releaseState: 'released' });
  }, 60_000);

  it('does not attach a landed merge to a successor attempt that arrived before release persistence', async () => {
    const fixture = await createFixture('successor-attempt');
    lifecycle.afterMerge = () => {
      const state = readOrchestratorControlPlaneState();
      // Inner lane merge persists its proved release before returning. A new
      // attempt clears that receipt, as resetPacketFields does in a real rerun.
      expect(state.packets[0]).toMatchObject({
        releaseState: 'released',
        releaseStatePayload: {
          source: 'approve_and_merge', evidenceKind: 'merge_command',
          mergeCommit: expect.stringMatching(/^[a-f0-9]{40}$/),
          headSha: fixture.reviewedHeadSha,
        },
      });
      state.packets[0].releaseState = 'pending';
      state.packets[0].releaseStatePayload = null;
      state.packets[0].attemptCount = (state.packets[0].attemptCount ?? 0) + 1;
      state.packets[0].operatorStopped = true;
      writeOrchestratorControlPlaneState(state);
    };
    const response = await mergeRoute.POST(mergeRequest(fixture.packetId));
    expect(response.status).toBe(200);
    expect(git(fixture.repo, ['rev-list', '--count', `${fixture.baseSha}..refs/heads/main`])).toBe('1');
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({ operatorStopped: true, releaseState: 'pending' });
  }, 60_000);

  it('lands one attributed commit with the explicit message', async () => {
    const fixture = await createFixture('explicit-message');
    const commitMessage = 'fix: land the reviewed packet as one commit';

    const response = await mergeRoute.POST(mergeRequest(fixture.packetId, commitMessage));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, result: { merged: true } });
    expect(git(fixture.repo, ['rev-list', '--count', `${fixture.baseSha}..refs/heads/main`])).toBe('1');
    expect(git(fixture.repo, ['log', '-1', '--format=%s', 'refs/heads/main'])).toBe(commitMessage);
    expect(git(fixture.repo, ['log', '-1', '--format=%B', 'refs/heads/main'])).toContain(AGENT_COMMIT_TRAILER);
    expect(baseSubjects(fixture.repo)).not.toEqual(expect.arrayContaining(fixture.workingSubjects));
    expect(git(fixture.repo, ['ls-remote', '--heads', fixture.origin, 'main']).split(/\s+/)[0])
      .toBe(payload.result.mergeSha);
  }, 60_000);

  it('squashes wip history to the final non-wip subject when no message is supplied', async () => {
    const fixture = await createFixture('implicit-message');

    const response = await mergeRoute.POST(mergeRequest(fixture.packetId));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, result: { merged: true } });
    expect(git(fixture.repo, ['rev-list', '--count', `${fixture.baseSha}..refs/heads/main`])).toBe('1');
    expect(git(fixture.repo, ['log', '-1', '--format=%s', 'refs/heads/main']))
      .toBe('fix: finalize packet state');
    expect(baseSubjects(fixture.repo)).not.toEqual(expect.arrayContaining(fixture.workingSubjects));
  }, 60_000);

  it('preserves clean multi-commit history when no message is supplied', async () => {
    const workingSubjects = [
      'fix: add preserved packet change',
      'chore: refine preserved packet change',
      'fix: finalize preserved packet change',
    ];
    const fixture = await createFixture('preserve-history', workingSubjects);

    const response = await mergeRoute.POST(mergeRequest(fixture.packetId));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, result: { merged: true } });
    expect(git(fixture.repo, ['rev-list', '--count', `${fixture.baseSha}..refs/heads/main`])).toBe('3');
    expect(baseSubjects(fixture.repo)).toEqual(expect.arrayContaining(workingSubjects));
  }, 60_000);
});
