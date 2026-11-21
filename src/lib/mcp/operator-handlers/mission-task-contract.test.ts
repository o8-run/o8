import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorRuntime, PacketTaskContract } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-mission-contract-default-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-mission-contract-repo-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
git('init', '--initial-branch=main');
git('-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test', 'commit', '--allow-empty', '-m', 'init');

const taskContract: PacketTaskContract = {
  version: 1,
  requirements: [{
    id: 'R1',
    source: 'Arm the contract explicitly.',
    expectedBehavior: 'The packet carries the contract gate.',
    productionPath: 'handleCreateMission -> createMission -> persisted packet',
    verification: 'real handler test',
  }],
  smallestRoute: [{
    path: 'src/lib/orchestrator/operator-mission-service/mission.ts',
    requirements: ['R1'],
    reason: 'Mission creation owns packet defaults.',
  }],
  exclusions: [],
};

const { handleCreateMission, MISSION_TOOLS } = await import('./mission');
const { currentMissionState } = await import('@/lib/orchestrator/operator-mission-service/shared');

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  const { closeDb } = await import('@/lib/db');
  closeDb();
});

function stubRealMissionService() {
  vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const { createMission } = await import('@/lib/orchestrator/operator-mission-service/mission');
    const result = await createMission(body as unknown as Parameters<typeof createMission>[0]);
    return Response.json({ ok: true, result }, { status: 201 });
  }));
}

async function createPacket(input: {
  runtime: OrchestratorRuntime;
  origin?: 'design-mode';
  taskContract?: 'off';
  qualitySearch?: { taskContract: PacketTaskContract };
}) {
  stubRealMissionService();
  const result = await handleCreateMission({
    repoPath,
    issues_inline: [{ title: `${input.runtime} contract ${Date.now()}` }],
    runtime: input.runtime,
    origin: input.origin,
    taskContract: input.taskContract,
    qualitySearch: input.qualitySearch,
    dispatch: false,
  });
  expect(result.isError).not.toBe(true);
  const payload = JSON.parse(result.content.find((entry) => entry.type === 'text')?.text ?? '{}') as {
    packets?: Array<{ id: string }>;
  };
  return currentMissionState().packets.find((packet) => packet.id === payload.packets?.[0]?.id);
}

describe('create_mission task contract default', () => {
  it('keeps the MCP input schema strict-mode plain and exposes the string opt-out', () => {
    const schema = MISSION_TOOLS.find((tool) => tool.name === 'create_mission')?.inputSchema;
    expect(schema).toMatchObject({
      type: 'object',
      properties: {
        origin: { type: 'string', enum: ['design-mode'] },
        taskContract: { type: 'string', enum: ['off'] },
      },
      required: ['repoPath'],
    });
    expect(schema).not.toHaveProperty('oneOf');
    expect(schema).not.toHaveProperty('anyOf');
    expect(schema).not.toHaveProperty('allOf');
  });

  it('stamps the Design Mode origin through the real MCP handler onto the persisted packet', async () => {
    expect(await createPacket({ runtime: 'codex', origin: 'design-mode' })).toMatchObject({
      origin: 'design-mode',
    });
  });

  it.each(['claude-code', 'codex'] as const)('arms %s through the real handler and persisted packet', async (runtime) => {
    expect(await createPacket({ runtime })).toMatchObject({
      taskContractRequired: true,
      taskContractSource: 'default',
    });
  });

  it('leaves other runtimes disabled by default', async () => {
    expect(await createPacket({ runtime: 'antigravity' })).toMatchObject({
      taskContractRequired: false,
      taskContractSource: 'default',
    });
  });

  it('lets the mission opt-out override the claude-code default', async () => {
    expect(await createPacket({ runtime: 'claude-code', taskContract: 'off' })).toMatchObject({
      taskContractRequired: false,
      taskContractSource: 'default',
    });
  });

  it('rejects quality search combined with the mission opt-out', async () => {
    stubRealMissionService();
    const result = await handleCreateMission({
      repoPath,
      issues_inline: [{ title: `contradictory contract ${Date.now()}` }],
      runtime: 'codex',
      taskContract: 'off',
      qualitySearch: { taskContract },
      dispatch: false,
    });

    expect(result.isError).toBe(true);
    expect(result.content.find((entry) => entry.type === 'text')?.text)
      .toContain('qualitySearch already uses a sealed contract and cannot be combined with taskContract: "off".');
  });
});
