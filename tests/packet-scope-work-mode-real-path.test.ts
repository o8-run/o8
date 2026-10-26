import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { WorkerWorkMode } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-packet-scope-work-mode-'));
const repoPath = join(dataDir, 'repo');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
mkdirSync(repoPath);
execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);

vi.mock('@/lib/runtime/registry', () => ({
  getRuntimeProcessForWorktree: vi.fn(async () => null),
}));

const { createLane, getLane } = await import('@/lib/lane/registry');
const { handleGetPacketScope } = await import('@/lib/mcp/operator-handlers/mission');
const scopeRoute = await import('@/app/api/lanes/[id]/scope/route');
const { writeOrchestratorControlPlaneState } =
  await import('@/lib/orchestrator/control-plane');
const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
const { recordMission } = await import('@/lib/db/missions-store');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { closeDb, getSqlite } = await import('@/lib/db');

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

function fixture(id: string, workMode?: WorkerWorkMode) {
  const packetId = `pkt-scope-mode-${id}`;
  const lane = createLane({ repoPath, worktreePath: repoPath, packetId,
    branch: `test/scope-mode-${id}`, runtime: 'codex' });
  const mission = {
    ...createEmptyOrchestratorMissionState(),
    missionId: `mission-scope-mode-${id}`,
    repoPath,
    packets: [{
      id: packetId, referenceLabel: id, title: 'Inspect packet work mode', summary: 'Read scope',
      workspaceTargetPath: repoPath, branchTarget: lane.branch, runtime: 'codex' as const,
      dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued' as const,
      releaseState: 'pending' as const, status: 'running' as const, lane: null,
      allowedFiles: ['fixture.txt'],
      ...(workMode ? { launchContext: {
        source: 'mcp' as const, presentation: 'split' as const,
        repoContext: 'transient' as const, workMode,
      } } : {}),
    }],
  };
  return { packetId, lane, mission };
}

async function readScope(packetId: string, laneId: string, expectedMode: WorkerWorkMode | null) {
  const before = readFileSync(join(dataDir, 'orchestrator-state.json'), 'utf8');
  const registryBefore = getSqlite().prepare('SELECT id, mission_state_json FROM missions ORDER BY id').all();
  const laneBefore = getLane(laneId);
  for (const args of [{ packetId }, { laneId }]) {
    const result = await handleGetPacketScope(args);
    expect(result.isError).not.toBe(true);
    const text = result.content[0];
    expect(text?.type).toBe('text');
    const scope = JSON.parse(text.type === 'text' ? text.text : '{}');
    expect(scope).toMatchObject({ packetId, laneId, workMode: expectedMode });
    expect(scope.directives).toEqual([]);
  }
  for (const id of [packetId, laneId]) {
    const response = await scopeRoute.GET(new NextRequest(`http://localhost/api/lanes/${id}/scope`, {
      headers: { host: 'localhost', authorization: `Bearer ${mintPacketWorkerToken(packetId)}` },
    }), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toMatchObject({ packetId, laneId, workMode: expectedMode });
  }
  expect(readFileSync(join(dataDir, 'orchestrator-state.json'), 'utf8')).toBe(before);
  expect(getSqlite().prepare('SELECT id, mission_state_json FROM missions ORDER BY id').all()).toEqual(registryBefore);
  expect(getLane(laneId)).toEqual(laneBefore);
}

describe('packet scope reports the persisted work mode', () => {
  it.each(['read-only', 'edit', undefined] as const)('reports %s through MCP and HTTP after storage reopens', async (mode) => {
    const f = fixture(mode ?? 'legacy', mode);
    writeOrchestratorControlPlaneState(f.mission);
    closeDb();
    await readScope(f.packetId, f.lane.id, mode ?? 'edit');
    const result = await handleGetPacketScope({ packetId: f.packetId });
    const text = result.content[0];
    expect(JSON.parse(text.type === 'text' ? text.text : '{}').allowedPaths).toEqual(['fixture.txt']);
  });

  it('preserves a non-current mission registry read-only pin', async () => {
    const f = fixture('registered', 'read-only');
    recordMission({ id: f.mission.missionId, repoPath, runtime: 'codex', prompt: 'Inspect scope',
      summary: 'Read-only registry fixture', constraints: '', packetMeta: [], totalWaves: 1,
      missionState: f.mission });
    writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
    closeDb();
    expect(readMissionRegistryEntry(f.mission.missionId)?.mission.packets[0]?.launchContext?.workMode)
      .toBe('read-only');
    await readScope(f.packetId, f.lane.id, 'read-only');
  });

  it('reports an unknown mode when the durable packet is missing', async () => {
    const f = fixture('missing', 'read-only');
    writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
    closeDb();
    await readScope(f.packetId, f.lane.id, null);
  });

  it('refuses a lane and packet pair that refer to different packets', async () => {
    const a = fixture('mismatch-a', 'read-only');
    const b = fixture('mismatch-b', 'edit');
    writeOrchestratorControlPlaneState(b.mission);
    const result = await handleGetPacketScope({ laneId: a.lane.id, packetId: b.packetId });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'Packet scope not found' }]);
  });

  it('keeps another packet worker out of the HTTP scope response', async () => {
    const f = fixture('ownership', 'read-only');
    writeOrchestratorControlPlaneState(f.mission);
    const response = await scopeRoute.GET(new NextRequest(`http://localhost/api/lanes/${f.lane.id}/scope`, {
      headers: { host: 'localhost', authorization: `Bearer ${mintPacketWorkerToken('pkt-other-scope-worker')}` },
    }), { params: Promise.resolve({ id: f.lane.id }) });
    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty('workMode');
  });
});
