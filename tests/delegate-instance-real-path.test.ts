import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ dispatch: vi.fn() }));
const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-delegate-effort-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

vi.mock('@/lib/lane/commands', () => ({ dispatch: h.dispatch }));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ assertRuntimeDispatchable: vi.fn(async () => {}) }));
vi.mock('@/lib/codex/service-tier-catalogue', () => ({
  getCodexSpeedCatalogue: async () => ({ models: { 'gpt-5.6-terra': [] },
    reasoningEfforts: { 'gpt-5.6-terra': ['low', 'high'] } }),
}));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));
vi.mock('@/lib/dispatch/edge-case-surfacer', () => ({ surfaceEdgeCases: () => ({ sites: [] }) }));
vi.mock('@/lib/dispatch/read-budget', () => ({ computeReadBudget: () => null, resolveModelTier: () => 'frontier' }));
vi.mock('@/lib/orchestrator/preservation-envelope', () => ({ computePredictedFiles: () => [] }));
vi.mock('@/lib/operator/defaults', () => ({
  getOperatorDefaultsSync: () => ({ values: {
    subscriptionProfile: 'both', workerRuntimes: ['codex'], defaultDispatchRuntime: 'codex',
    codexWorkerEffort: 'adaptive', workerStartMode: 'immediate',
  }, sources: { workerRuntimes: 'file' } }),
}));
vi.mock('@/lib/projects/context', () => ({
  getProjectContext: vi.fn(async () => ({ id: null, repoInProject: false })),
  buildProjectTaskBrief: () => ({}),
}));
vi.mock('@/lib/prompts/v1', () => ({ buildProjectBriefPromptV1: (_brief: unknown, prompt: string) => prompt }));

const { POST } = await import('@/app/api/orchestrator/delegate/route');
const { closeDb, getSqlite } = await import('@/lib/db');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/orchestrator/delegate', {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'Inspect the fixture.', repoPath: dataDir,
      runtime: 'codex', model: 'gpt-5.6-terra', ...body }),
  });
}

beforeEach(() => {
  h.dispatch.mockReset();
  h.dispatch.mockImplementation(async (command: { verb: string }) => command.verb === 'open_lane'
    ? { ok: true, laneId: 'fixture-effort-lane' }
    : { ok: true, lane: { sessionKey: 'codex-owned:fixture-effort', worktreePath: null } });
  writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
  getSqlite().prepare('DELETE FROM idempotency_keys').run();
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('delegate provider instance through the route', () => {
  it('dispatches with the saved instance configuration', async () => {
    writeFileSync(join(dataDir, 'provider-instances.json'), JSON.stringify({ version: 1,
      instances: [{ id: 'codex-fixture', runtime: 'codex', name: 'fixture', enabled: true,
        binaryPath: '/fixture/bin/worker', homeDir: '/fixture/config' }, { id: 'other-instance', runtime: 'codex', name: 'other', enabled: true }], threads: {} }));
    const { activeProviderInstance } = await import('@/lib/providers/instance-context');
    let launched: unknown;
    h.dispatch.mockImplementation(async (command: { verb: string }) => {
      if (command.verb === 'open_lane') return { ok: true, laneId: 'fixture-instance-lane' };
      launched = activeProviderInstance('codex');
      return { ok: true, lane: { sessionKey: 'codex-owned:fixture-instance' } };
    });
    const response = await POST(request({ clientMutationId: 'named-instance', instanceId: 'codex-fixture' }));
    expect(response.status).toBe(200);
    expect(launched).toMatchObject({ id: 'codex-fixture', binaryPath: '/fixture/bin/worker',
      home: { CODEX_HOME: '/fixture/config' } });
    expect(h.dispatch).toHaveBeenCalledWith(expect.objectContaining({ verb: 'launch_session', instanceId: 'codex-fixture' }));
    const conflict = await POST(request({ clientMutationId: 'named-instance', instanceId: 'other-instance' }));
    expect(conflict.status).toBe(409);
    const replay = await POST(request({ clientMutationId: 'named-instance', instanceId: 'codex-fixture' }));
    expect(await replay.json()).toMatchObject({ ok: true, replayed: true });
    expect(readOrchestratorControlPlaneState().packets[0].instanceId).toBe('codex-fixture');
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });

  it('forwards a pin through the MCP delegate handler and real route', async () => {
    writeFileSync(join(dataDir, 'provider-instances.json'), JSON.stringify({ version: 1,
      instances: [{ id: 'codex-mcp', runtime: 'codex', name: 'fixture', enabled: true }], threads: {} }));
    const { createCortexDelegationHandlers } = await import('@/lib/mcp/cortex-delegation-handlers');
    const { CORTEX_WORKER_TOOLS } = await import('@/lib/mcp/cortex-worker-tools');
    expect(CORTEX_WORKER_TOOLS.find(tool => tool.name === 'cortex_launch_agent')?.inputSchema.properties).toHaveProperty('instanceId');
    const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).endsWith('/api/orchestrator/delegate')) return POST(request(JSON.parse(String(init?.body))));
      return new Response('{}');
    });
    try {
      const handlers = createCortexDelegationHandlers({ apiFetch: async () => ({}), apiBase: 'http://localhost',
        repoPath: dataDir, parentThreadId: '', fastCapability: '', wsToken: '' });
      const result = await handlers.handleLaunchAgent({ prompt: 'Inspect the fixture.', runtime: 'codex', model: 'gpt-5.6-terra', instanceId: 'codex-mcp' });
      expect(result.isError).not.toBe(true);
      expect(h.dispatch).toHaveBeenCalledWith(expect.objectContaining({ verb: 'launch_session', instanceId: 'codex-mcp' }));
    } finally { transport.mockRestore(); }
  });

  it.each(['missing-instance', '', 42])('refuses an invalid instance before starting anything: %j', async instanceId => {
    const response = await POST(request({ clientMutationId: 'invalid-instance', instanceId }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: 'invalid_instance' });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(readOrchestratorControlPlaneState().packets).toEqual([]);
    expect(getSqlite().prepare('SELECT COUNT(*) AS count FROM idempotency_keys').get()).toEqual({ count: 0 });
  });

  it('refuses a disabled or mismatched instance', async () => {
    writeFileSync(join(dataDir, 'provider-instances.json'), JSON.stringify({ version: 1,
      instances: [{ id: 'disabled', runtime: 'codex', name: 'fixture', enabled: false },
        { id: 'different', runtime: 'gemini', name: 'fixture', enabled: true }], threads: {} }));
    for (const instanceId of ['disabled', 'different']) {
      const response = await POST(request({ clientMutationId: instanceId, instanceId }));
      expect(response.status).toBe(400);
    }
    expect(h.dispatch).not.toHaveBeenCalled();
  });
});
