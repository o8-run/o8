import { expect, it, vi } from 'vitest';
import { createEmptyOrchestratorMissionState, normalizeOrchestratorMissionState } from '@/lib/orchestrator/store';
import { preparePacketsForExplicitDispatch } from '@/lib/orchestrator/operator-mission-service/dispatch-runtime-override';
const h = vi.hoisted(() => ({ dispatch: vi.fn(async (_input: unknown) => ({ ok: true })) }));
vi.mock('@/lib/mcp/operator-mission-tools', () => ({ dispatchMission: h.dispatch }));
const { handleDispatchMission } = await import('@/lib/mcp/operator-handlers/mission');
function state() {
  return normalizeOrchestratorMissionState({ ...createEmptyOrchestratorMissionState(), packets: [{ id: 'runtime-override', runtime: 'claude-code', title: 'Prepared runtime', queueState: 'queued', releaseState: 'pending', status: 'queued', lane: null }] });
}
it('normalizes the claude alias before stamping a mission runtime override', () => {
  const mission = state();
  preparePacketsForExplicitDispatch(mission, 'claude' as never);
  expect(mission.packets[0]).toMatchObject({ runtime: 'claude-code', dispatchRuntimePin: 'claude-code' });
});
it('refuses a mission runtime typo without changing prepared packets', () => {
  const mission = state();
  const before = structuredClone(mission);
  expect(() => preparePacketsForExplicitDispatch(mission, 'typo-runtime' as never)).toThrow(/typo-runtime/);
  expect(mission).toEqual(before);
});
it('preserves prepared routing when the dispatch override is omitted', () => {
  const mission = state();
  preparePacketsForExplicitDispatch(mission);
  expect(mission.packets[0].runtime).toBe('claude-code');
});
it.each(['claude', undefined])('passes the shared-validator runtime through MCP dispatch_mission (%s)', async runtime => {
  h.dispatch.mockClear();
  const refused = await handleDispatchMission({ missionId: 'fixture', runtime: 'typo-runtime' });
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused)).toContain('typo-runtime');
  expect(h.dispatch).not.toHaveBeenCalled();
  const result = await handleDispatchMission({ missionId: 'fixture', runtime });
  expect(result.isError).not.toBe(true);
  expect(h.dispatch).toHaveBeenCalledWith(expect.objectContaining({ missionId: 'fixture', runtime: runtime ? 'claude-code' : undefined }));
});
it('refuses a typo through the dispatch HTTP admission route with its reason', async () => {
  const { NextRequest } = await import('next/server');
  const { POST } = await import('@/app/api/orchestrator/dispatch/route');
  const response = await POST(new NextRequest('http://localhost/api/orchestrator/dispatch', { method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify({ runtime: 'typo-runtime' }) }));
  expect(response.status).toBe(400);
  expect(JSON.stringify(await response.json())).toContain('typo-runtime');
});
