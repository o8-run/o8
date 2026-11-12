import { expect, it } from 'vitest';
import { normalizeOrchestratorMissionState, createEmptyOrchestratorMissionState } from '@/lib/orchestrator/store';
import { fanOutComparisonPackets } from '@/lib/orchestrator/comparison-fanout';
import { resolveWorkerRouting } from '@/lib/agents/routing';
it('loads unknown saved runtimes, continues fanout and preserves the substitution on reload', () => {
  const raw = { ...createEmptyOrchestratorMissionState(), packets: [
    { id: 'bad', runtime: 'retired-runtime', title: 'Old saved worker', status: 'queued', comparisonModels: ['model-a'], workerRouting: { requestedRuntime: 'retired-runtime' } },
    { id: 'good', runtime: 'codex', title: 'Healthy worker', status: 'queued', comparisonModels: ['model-b'] },
  ] };
  const state = normalizeOrchestratorMissionState(raw);
  expect(state.packets[0].workerRouting?.reason).toContain('retired-runtime');
  expect(state.packets[0].workerRouting?.runtimeSubstitution).toMatchObject({ requestedRuntime: 'retired-runtime' });
  const expanded = fanOutComparisonPackets(state);
  expect(expanded.packets.map(p => p.id)).toEqual(['bad-cmp-0', 'good-cmp-0']);
  expect(normalizeOrchestratorMissionState(state).packets[0].workerRouting?.reason).toContain('retired-runtime');
  expect(() => resolveWorkerRouting({ requestedRuntime: 'retired-runtime', source: 'scheduler' })).not.toThrow();
});
it('does not execute conversion hooks in malformed saved runtime data', () => {
  expect(() => resolveWorkerRouting({ requestedRuntime: { toString: 0 } })).not.toThrow();
});
