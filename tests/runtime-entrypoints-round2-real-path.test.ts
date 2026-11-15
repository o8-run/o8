import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const h = vi.hoisted(() => ({ create: vi.fn(async (_input: unknown) => ({ missionId: 'routing-fixture', packets: [{ id: 'routing-packet', title: 'Fixture' }] })) }));
vi.mock('@/lib/orchestrator/operator-mission-service', async original => ({ ...await original<typeof import('@/lib/orchestrator/operator-mission-service')>(), createMission: h.create, dispatchMission: async () => ({ ok: true }) }));
vi.mock('@/lib/mcp/operator-mission-tools', () => ({ createMission: h.create, createMissionInline: h.create, dispatchMission: async () => ({ ok: true }) }));
vi.mock('@/lib/runtimes/shared/auth-detect', async original => ({ ...await original<typeof import('@/lib/runtimes/shared/auth-detect')>(), assertRuntimeDispatchable: async () => {} }));
vi.mock('@/lib/orchestrator/effort-pin', async original => ({ ...await original<typeof import('@/lib/orchestrator/effort-pin')>(), resolveRuntimeEffortPin: async () => ({ ok: true }) }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: async () => {} }));
const root = mkdtempSync(join(tmpdir(), 'o8-runtime-admission-'));
const repo = join(root, 'repo');
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
const defaults = await import('@/lib/operator/defaults');
await defaults.updateOperatorDefaults({ defaultDispatchRuntime: 'claude-code', subscriptionProfile: 'both', workerExecutionCarrier: null });
const { closeDb } = await import('@/lib/db');
afterAll(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });
let sequence = 0;
for (const entry of ['create-mission', 'spawn-prompt', 'mcp-create-mission'] as const) {
  it.each(['typo-runtime', undefined])('%s runtime selection through '+entry, async runtime => {
    h.create.mockClear();
    const body = { repoPath: repo, runtime, requestedRuntime: runtime, dispatch: false, task: 'Inspect fixture', issues: [{ number: 90131, title: 'Routing fixture', body: '', url: '' }], clientMutationId: `runtime-${++sequence}` };
    if (entry === 'mcp-create-mission') {
      const { handleCreateMission } = await import('@/lib/mcp/operator-handlers/mission-create');
      const result = await handleCreateMission({ ...body, issues: ['90131'] });
      if (runtime) { expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain(runtime); }
      else { expect(result.isError).not.toBe(true); expect(h.create.mock.lastCall?.[0]).toMatchObject({ runtime: 'claude-code' }); }
      return;
    }
    const route = entry === 'spawn-prompt' ? await import('@/app/api/orchestrator/spawn-prompt/route') : await import('@/app/api/orchestrator/create-mission/route');
    const response = await route.POST(new NextRequest('http://localhost/api/orchestrator/'+entry, { method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify(body) }));
    if (runtime) { expect(response.status).toBe(400); expect(JSON.stringify(await response.json())).toContain(runtime); expect(h.create).not.toHaveBeenCalled(); }
    else { expect(response.status).toBe(201); expect(h.create.mock.lastCall?.[0]).toMatchObject({ runtime: 'claude-code' }); }
  });
}

it('admits comparison candidates through real fan-out with the saved default and explicit runtime', async () => {
  const { normalizeOrchestratorMissionState, createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
  const { fanOutComparisonPackets } = await import('@/lib/orchestrator/comparison-fanout');
  h.create.mockClear();
  const state = normalizeOrchestratorMissionState({ ...createEmptyOrchestratorMissionState(), packets: [{
    id: 'comparison-seed', title: 'Compare real candidates', runtime: defaults.resolveDefaultDispatchRuntimeSync(),
    comparisonModels: ['model-a', 'codex'], status: 'queued', queueState: 'queued', releaseState: 'pending',
  }] });
  const result = fanOutComparisonPackets(state);
  expect(result.packets.map(packet => packet.runtime)).toEqual(['claude-code', 'codex']);
  expect(result.packets.map(packet => packet.dispatchRuntimePin)).toEqual(['claude-code', 'codex']);
  expect(result.packets.map(packet => packet.workerRouting?.selectedRuntime)).toEqual(['claude-code', 'codex']);
  expect(h.create).not.toHaveBeenCalled();
});
