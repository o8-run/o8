import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest';
import { NextRequest } from 'next/server';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-github-scope-data-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const launchPacket = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orchestrator/dispatch-packet-launch', () => ({
  launchPacketWithStorageAdmission: launchPacket,
}));
vi.mock('@/lib/runtime/registry', () => ({
  getRuntimeProcessForWorktree: vi.fn(async () => null),
}));

const tempDirs = [dataDir];

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function createRepo() {
  const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-github-scope-repo-'));
  tempDirs.push(repoPath);
  git(repoPath, 'init', '-q', '-b', 'main');
  git(repoPath, 'config', 'user.email', 'test@o8.dev');
  git(repoPath, 'config', 'user.name', 'o8 test');
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'o8.md'), '# Operator spec\n');
  writeFileSync(join(repoPath, 'src', 'worker.ts'), 'export const worker = true;\n');
  git(repoPath, 'add', '.');
  git(repoPath, 'commit', '-q', '-m', 'base');
  return repoPath;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  launchPacket.mockReset();
});

// Cold transformation of this service graph can exhaust a test's 30-second
// budget under concurrent validation. Prepare it after data-dir isolation and
// cleanup registration, before timing the real create/dispatch/readback flow.
const serviceSetupStarted = performance.now();
const { createMission, dispatchMission } = await import('@/lib/orchestrator/operator-mission-service');
console.info(`[packet-scope-fixture] mission service setup completed in ${Math.round(performance.now() - serviceSetupStarted)}ms`);

describe('GitHub issue packet scope real path', () => {
  it('keeps only repo paths when an issue body also contains a Git range and event field', async () => {
    const repoPath = createRepo();
    writeFileSync(join(repoPath, 'src', 'scope-support.ts'), 'export const scopeSupport = true;\n');
    const { resolvePacketScope } = await import('@/lib/orchestrator/packet-scope-policy');
    const resolution = resolvePacketScope({
      title: 'Constrain packet scope prediction',
      summary: 'Seal the packet to paths stated in the issue.',
      issue: {
        number: 20_050,
        body: 'Compare ead1b7a15..HEAD with open_lane.baseCommit, then update src/worker.ts.',
        url: 'https://example.test/issues/20050',
      },
      workspaceTargetPath: repoPath,
    }, ['src/worker.ts', 'src/scope-support.ts', 'ead1b7a15..HEAD', 'open_lane.baseCommit']);

    expect(resolution.allowedPaths).toEqual(['src/worker.ts', 'src/scope-support.ts']);
    expect(resolution.allowedPaths).not.toContain('ead1b7a15..HEAD');
    expect(resolution.allowedPaths).not.toContain('open_lane.baseCommit');
  });

  it('lets a packet-bound worker expand its own lane through middleware and the route only', async () => {
    const repoPath = createRepo();
    const packetA = 'pkt-scope-authz-a';
    const packetB = 'pkt-scope-authz-b';
    const { createLane } = await import('@/lib/lane/registry');
    const laneA = createLane({
      repoPath,
      worktreePath: repoPath,
      branch: 'issue/scope-authz-a',
      runtime: 'codex',
      packetId: packetA,
    });
    const laneB = createLane({
      repoPath,
      worktreePath: repoPath,
      branch: 'issue/scope-authz-b',
      runtime: 'codex',
      packetId: packetB,
    });
    const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
    const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const packet = (id: string, branchTarget: string) => ({
      id,
      referenceLabel: id,
      title: 'Expand bounded scope',
      summary: 'Edit src/worker.ts.',
      workspaceTargetPath: repoPath,
      branchTarget,
      runtime: 'codex' as const,
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'queued' as const,
      releaseState: 'pending' as const,
      status: 'running' as const,
      lane: null,
      predictedFiles: ['src/worker.ts'],
      allowedFiles: ['src/worker.ts'],
    });
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-scope-authz',
      repoPath,
      packets: [packet(packetA, laneA.branch), packet(packetB, laneB.branch)],
    });

    const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
    const { panelGateMiddleware } = await import('@/middleware');
    const scopeRoute = await import('@/app/api/lanes/[id]/scope/route');
    const bearer = mintPacketWorkerToken(packetA);
    const scopeRequest = (laneId: string, path: string) => new NextRequest(
      `http://localhost:3001/api/lanes/${laneId}/scope`,
      {
        method: 'POST',
        headers: { host: 'localhost:3001', authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ paths: [path], reason: 'Cover the real route regression.' }),
      },
    );

    const ownRequest = scopeRequest(laneA.id, 'tests/scope-regression.test.ts');
    expect(panelGateMiddleware(ownRequest).status).toBe(200);
    const ownResponse = await scopeRoute.POST(ownRequest, { params: Promise.resolve({ id: laneA.id }) });
    expect(ownResponse.status).toBe(200);
    await expect(ownResponse.json()).resolves.toMatchObject({
      ok: true,
      expanded: true,
      allowedPaths: ['src/worker.ts', 'tests/scope-regression.test.ts'],
    });
    expect(readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === packetA)?.allowedFiles)
      .toEqual(['src/worker.ts', 'tests/scope-regression.test.ts']);

    const otherRequest = scopeRequest(laneB.id, 'tests/other-packet.test.ts');
    expect(panelGateMiddleware(otherRequest).status).toBe(200);
    const otherResponse = await scopeRoute.POST(otherRequest, { params: Promise.resolve({ id: laneB.id }) });
    expect(otherResponse.status).toBe(403);
    await expect(otherResponse.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'worker_packet_mismatch' },
    });
    expect(readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === packetB)?.allowedFiles)
      .toEqual(['src/worker.ts']);
  });

  it('never launches a packet whose only predicted file is forbidden by its task brief', async () => {
    let stage = 'repository creation';
    const started = performance.now();
    const enterStage = (next: string) => {
      console.info(`[packet-scope-fixture] ${stage} finished after ${Math.round(performance.now() - started)}ms`);
      stage = next;
    };
    onTestFailed(() => {
      console.error(`[packet-scope-fixture] incomplete stage: ${stage}`);
    });
    const repoPath = createRepo();

    const { createLane } = await import('@/lib/lane/registry');
    launchPacket.mockImplementation(async ({ packet, workerRouting }) => {
      const lane = createLane({
        repoPath,
        worktreePath: repoPath,
        branch: packet.branchTarget,
        runtime: packet.runtime,
        packetId: packet.id,
        sessionKey: `codex-owned:${packet.id}`,
      });
      return {
        laneId: lane.id,
        sessionKey: lane.sessionKey,
        workerRouting,
        storageAdmission: {
          state: 'admitted',
          recordedAt: Date.now(),
          ownerGeneration: 1,
        },
        dependencyMaterializationMode: null,
      };
    });

    enterStage('mission creation');
    const created = await createMission({
      issues: [{
        number: 18_360,
        title: 'Repair packet dispatch scope',
        body: 'The file prediction points at `o8.md`. Never touch o8.md at the repo root.',
        url: 'https://example.test/issues/18360',
      }],
      repoPath,
      runtime: 'codex',
      constraints: 'Keep the worker inside a useful packet scope.',
    });
    const packetId = created.packets[0]!.id;
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const createdPacket = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === packetId)!;
    expect(createdPacket.predictedFiles).toEqual(['o8.md']);
    expect(createdPacket.allowedFiles).toEqual(['**/*']);

    enterStage('mission dispatch');
    await dispatchMission({ missionId: created.missionId });
    enterStage('persisted scope readback');

    const { getPacketScope } = await import('@/lib/lanes/scope');
    const state = readOrchestratorControlPlaneState();
    const packet = state.packets.find((candidate) => candidate.id === packetId)!;
    const scope = await getPacketScope({ packetId });
    expect(launchPacket).toHaveBeenCalledTimes(1);
    expect(packet.predictedFiles).toEqual(['o8.md']);
    expect(packet.allowedFiles).toEqual(['**/*']);
    expect(scope?.allowedPaths).toEqual(['**/*']);
    enterStage('complete');
  });

  it('records a bounded worker scope expansion reason on the packet lane', async () => {
    const repoPath = createRepo();
    const packetId = 'pkt-bounded-scope-expansion';
    const { createLane, getLaneEvents } = await import('@/lib/lane/registry');
    const lane = createLane({
      repoPath,
      worktreePath: repoPath,
      branch: 'issue/18360-bounded-expansion',
      runtime: 'codex',
      packetId,
    });
    const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
    const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-bounded-scope-expansion',
      repoPath,
      packets: [{
        id: packetId,
        referenceLabel: 'P1',
        title: 'Repair the worker',
        summary: 'Edit src/worker.ts.',
        workspaceTargetPath: repoPath,
        branchTarget: lane.branch,
        runtime: 'codex',
        dependencyLabels: [],
        dependencyPacketIds: [],
        queueState: 'queued',
        releaseState: 'pending',
        status: 'running',
        lane: null,
        predictedFiles: ['src/worker.ts'],
        allowedFiles: ['src/worker.ts'],
        issue: { number: 18_361, body: 'Edit src/worker.ts.', url: 'https://example.test/issues/18361' },
      }],
    });

    const { requestPacketScopeExpansion } = await import('@/lib/orchestrator/packet-scope-expansion');
    const result = await requestPacketScopeExpansion({
      packetId,
      paths: ['tests/scope/**'],
      reason: 'The real-path regression belongs in this test directory.',
    });

    const packet = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === packetId)!;
    const event = getLaneEvents(lane.id).find((candidate) => candidate.verb === 'scope_expansion_requested');
    expect(result).toMatchObject({ expanded: true, allowedPaths: ['src/worker.ts', 'tests/scope/**'] });
    expect(packet.allowedFiles).toEqual(['src/worker.ts', 'tests/scope/**']);
    expect(event?.payload).toMatchObject({
      requestedPaths: ['tests/scope/**'],
      reason: 'The real-path regression belongs in this test directory.',
      expanded: true,
    });
    await expect(requestPacketScopeExpansion({
      packetId,
      paths: ['**/*'],
      reason: 'A repository-wide request must remain rejected.',
    })).rejects.toThrow(/not bounded/i);
  });

  it('refuses dispatch with a clear reason when an explicit allowlist is entirely forbidden', async () => {
    const repoPath = createRepo();
    const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
    const state = {
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-unsatisfiable-explicit-scope',
      repoPath,
      packets: [{
        id: 'pkt-unsatisfiable-explicit-scope',
        referenceLabel: 'P1',
        title: 'Respect the operator spec',
        summary: 'Never touch o8.md at the repo root.',
        workspaceTargetPath: repoPath,
        branchTarget: 'issue/18362-unsatisfiable-explicit-scope',
        runtime: 'codex' as const,
        dependencyLabels: [],
        dependencyPacketIds: [],
        queueState: 'queued' as const,
        releaseState: 'pending' as const,
        status: 'queued' as const,
        lane: null,
        predictedFiles: ['o8.md'],
        allowedFiles: ['o8.md'],
        issue: { number: 18_362, body: 'Never touch o8.md at the repo root.', url: 'https://example.test/issues/18362' },
      }],
    };

    const { runDispatchTick } = await import('@/lib/orchestrator/dispatch');
    const result = await runDispatchTick(state);
    expect(launchPacket).not.toHaveBeenCalled();
    expect(result.packets[0]).toMatchObject({
      queueState: 'held',
      status: 'blocked',
      lastEventLabel: 'scope_unsatisfiable',
      blockedReason: expect.stringMatching(/unsatisfiable packet scope.*o8\.md/i),
    });
  });
});
