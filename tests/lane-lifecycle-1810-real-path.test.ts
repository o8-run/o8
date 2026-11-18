import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const explainerHarness = vi.hoisted(() => ({
  laneId: '',
  packetId: '',
  worktreePath: '',
  operatorToken: '',
  reviewResponses: [] as Array<{ status: number; payload: Record<string, unknown> }>,
}));

vi.mock('@/lib/lane/orchestrator-backends/registry', () => {
  const backend = {
    id: 'codex' as const,
    label: 'Codex',
    ensureSession: () => ({ status: 'idle' as const }),
    sendTurn: async (
      _repoPath: string,
      prompt: string,
      onEvent: (event: { type: 'text'; text: string }) => void,
    ) => {
      const { getLane } = await import('@/lib/lane/registry');
      const deadline = Date.now() + 5_000;
      while (getLane(explainerHarness.laneId)?.status !== 'merging') {
        if (Date.now() >= deadline) throw new Error('merge never entered the transient merging state');
        await new Promise((resolve) => setTimeout(resolve, 2));
      }

      const reviewRoute = await import('@/app/api/orchestrator/review/route');
      const response = await reviewRoute.POST(new NextRequest('http://localhost:3001/api/orchestrator/review', {
        method: 'POST',
        headers: {
          host: 'localhost:3001',
          authorization: `Bearer ${explainerHarness.operatorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          packetId: explainerHarness.packetId,
          clientMutationId: randomUUID(),
          approved: false,
          findings: [],
        }),
      }));
      explainerHarness.reviewResponses.push({
        status: response.status,
        payload: await response.json() as Record<string, unknown>,
      });

      const filename = prompt.match(/`(\.o8-packet-explainer-[^`]+\.html)`/)?.[1];
      if (!filename) throw new Error('explainer prompt did not name its output file');
      const quiz = JSON.stringify({
        questions: [
          { id: 'q1', prompt: 'What merged?', options: ['feature', 'nothing'], answerIndex: 0 },
          { id: 'q2', prompt: 'Where?', options: ['main', 'temp'], answerIndex: 0 },
          { id: 'q3', prompt: 'How often?', options: ['once', 'twice'], answerIndex: 0 },
        ],
      });
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(explainerHarness.worktreePath, filename),
        `<html><script type="application/json" id="o8-quiz">${quiz}</script></html>`, 'utf8');
      onEvent({ type: 'text', text: 'DONE' });
    },
  };
  return {
    getActiveReviewerBackend: () => backend,
    getOrchestratorBackend: () => backend,
  };
});

vi.mock('@/lib/worktree/safety-hooks', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/safety-hooks')>(),
  writeManagedWorkspaceSafetyHooks: vi.fn(async () => {}),
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-lane-lifecycle-1810-'));
const operatorToken = 'operator-lane-lifecycle-1810-0123456789';
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
writeFileSync(join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf8');

const approvalsRoute = await import('@/app/api/panel/approvals/route');
const reviewRoute = await import('@/app/api/orchestrator/review/route');
const reviewStateRoute = await import('@/app/api/orchestrator/review-state/route');
const { closeDb } = await import('@/lib/db');
const { listApprovalsForContext } = await import('@/lib/approvals/store');
const { dispatch } = await import('@/lib/lane/commands');
const { generatePacketExplainer } = await import('@/lib/lane/packet-explainer');
const { createLane, getLane, getLaneEvents } = await import('@/lib/lane/registry');
const { recordMission } = await import('@/lib/db/missions-store');
const { updateOperatorDefaults, resolvePacketExplainerEnabledSync } = await import('@/lib/operator/defaults');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { normalizeOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { getWorktreeManager } = await import('@/lib/worktree/launch');

const roots: string[] = [dataDir];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function operatorRequest(pathname: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost:3001${pathname}`, {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${operatorToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

afterAll(() => {
  closeDb();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('#1810 explainer isolation and merge lifecycle — real handlers', () => {
  it('keeps the approved verdict, executes one merge, and leaves the lane terminal', { timeout: 30_000 }, async () => {
    await updateOperatorDefaults({
      requireApproval: 'surface',
      packetExplainerEnabled: true,
      storageReserveRatio: 0.0001,
      storageReserveFloorGb: 0.001,
    });
    expect(resolvePacketExplainerEnabledSync()).toBe(true);

    const root = mkdtempSync(join(os.tmpdir(), 'o8-lane-lifecycle-merge-'));
    roots.push(root);
    const origin = join(root, 'origin.git');
    const repoPath = join(root, 'operator');
    execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
    execFileSync('git', ['clone', origin, repoPath], { stdio: 'pipe' });
    git(repoPath, ['checkout', '-b', 'main']);
    git(repoPath, ['config', 'user.name', 'o8-test']);
    git(repoPath, ['config', 'user.email', 'o8@example.test']);
    writeFileSync(join(repoPath, 'base.txt'), 'base\n');
    git(repoPath, ['add', 'base.txt']);
    git(repoPath, ['commit', '-m', 'base']);
    git(repoPath, ['push', '-u', 'origin', 'main']);
    const baseHead = git(repoPath, ['rev-parse', 'HEAD']);

    const packetId = 'pkt-lane-lifecycle-1810';
    const branch = 'inline/lane-lifecycle-1810';
    const worktree = await getWorktreeManager(repoPath).create({
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
    mkdirSync(join(worktree.path, 'src/lib/lane'), { recursive: true });
    writeFileSync(join(worktree.path, 'src/lib/lane/commands.ts'), 'export const mergedOnce = true;\n');
    git(worktree.path, ['add', 'src/lib/lane/commands.ts']);
    git(worktree.path, ['commit', '-m', 'fix: add reviewed feature']);
    const reviewedHeadSha = git(worktree.path, ['rev-parse', 'HEAD']);

    const lane = createLane({
      repoPath,
      worktreePath: worktree.path,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
      sessionKey: `codex:${packetId}`,
      label: 'Review lane lifecycle state',
    });
    const missionState = normalizeOrchestratorMissionState({
      version: 2,
      missionId: 'mission-lane-lifecycle-1810',
      prompt: 'Review and merge lifecycle',
      summary: 'Review and merge lifecycle',
      repoPath,
      runtime: 'codex',
      constraints: '',
      packets: [{
        id: packetId,
        referenceLabel: '#1810',
        title: 'Review lane lifecycle state',
        summary: 'Keep explainer output non-authoritative.',
        workspaceTargetPath: repoPath,
        branchTarget: branch,
        runtime: 'codex',
        dependencyLabels: [],
        dependencyPacketIds: [],
        queueState: 'held',
        releaseState: 'pending',
        status: 'running',
        blockedReason: null,
        review: null,
        lane: null,
        dispatcher: { surface: 'orchestrator', id: 'thoughts-lifecycle-1810' },
        orchestratorThreadId: 'thoughts-lifecycle-1810',
      } as OrchestratorPacket],
      updatedAt: new Date().toISOString(),
    });
    recordMission({
      id: missionState.missionId!,
      repoPath,
      runtime: 'codex',
      prompt: missionState.prompt,
      summary: missionState.summary,
      constraints: '',
      packetMeta: [{ id: packetId, title: 'Review lane lifecycle state', referenceLabel: '#1810' }],
      missionState,
      totalWaves: 1,
    });
    writeOrchestratorControlPlaneState(missionState);

    const reviewResponse = await reviewRoute.POST(operatorRequest('/api/orchestrator/review', {
      packetId,
      clientMutationId: randomUUID(),
      approved: true,
      reviewedHeadSha,
      findings: [],
    }));
    expect(reviewResponse.status).toBe(200);

    const cardResult = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });
    expect(cardResult).toMatchObject({ ok: false, approvalId: expect.any(String) });
    const approval = listApprovalsForContext({ packetId, laneId: lane.id })
      .find((candidate) => candidate.id === cardResult.approvalId);
    expect(approval).toMatchObject({ status: 'pending', continuation: { kind: 'lane', verb: 'merge' } });

    explainerHarness.laneId = lane.id;
    explainerHarness.packetId = packetId;
    explainerHarness.worktreePath = worktree.path;
    explainerHarness.operatorToken = operatorToken;
    explainerHarness.reviewResponses.length = 0;
    const explainer = generatePacketExplainer({
      lane: getLane(lane.id)!,
      packetId,
      packetTitle: 'Review lane lifecycle state',
      packetSummary: 'Keep explainer output non-authoritative.',
      diffSummary: 'src/lib/lane/commands.ts | 1 +',
      changedFileCount: 1,
      deviationsRaw: null,
      reviewContext: 'Approved with no findings.',
    });
    const approvalResponsePromise = approvalsRoute.POST(operatorRequest('/api/panel/approvals', {
      action: 'approve',
      id: approval!.id,
    }));
    const [approvalResponse] = await Promise.all([approvalResponsePromise, explainer]);

    expect(approvalResponse.status).toBe(200);
    expect(explainerHarness.reviewResponses).toHaveLength(1);
    expect(explainerHarness.reviewResponses[0]).toMatchObject({
      status: 200,
      payload: { ok: true, result: { recorded: false, ignoredReason: 'packet_explainer_non_authoritative' } },
    });
    expect(git(repoPath, ['rev-parse', 'HEAD'])).toBe(reviewedHeadSha);
    expect(git(repoPath, ['rev-parse', 'HEAD^'])).toBe(baseHead);
    expect(getLaneEvents(lane.id, 100).filter((event) => event.verb === 'merge')).toHaveLength(1);
    expect(getLane(lane.id)).toMatchObject({ status: 'completed', outcome: 'merged' });

    const storedPacket = readOrchestratorControlPlaneState().packets.find((packet) => packet.id === packetId);
    expect(storedPacket?.review).toMatchObject({ approved: true, findings: [] });
    expect(storedPacket?.explainer).toMatchObject({ status: 'ready' });
    const reviewStateResponse = await reviewStateRoute.GET(new NextRequest(
      `http://localhost:3001/api/orchestrator/review-state?packetId=${packetId}`,
      { headers: { host: 'localhost:3001', authorization: `Bearer ${operatorToken}` } },
    ));
    expect(await reviewStateResponse.json()).toMatchObject({
      orchestratorReview: { verdict: 'approved' },
      state: 'merged',
    });
  });
});
