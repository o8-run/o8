import { expect, it, vi } from 'vitest';
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

it('keeps the saved substitution receipt identical across two loads', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const raw = { ...createEmptyOrchestratorMissionState(), packets: [{ id: 'old', runtime: 'retired-runtime', title: 'Saved worker' }] };
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const first = normalizeOrchestratorMissionState(raw).packets[0].workerRouting;
    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));
    expect(normalizeOrchestratorMissionState(raw).packets[0].workerRouting).toEqual(first);
    expect(normalizeOrchestratorMissionState({ ...raw, packets: [{ ...raw.packets[0], workerRouting: first }] }).packets[0].workerRouting).toEqual(first);
    const dated = { ...first, decidedAt: '2025-12-01T00:00:00.000Z' };
    expect(normalizeOrchestratorMissionState({ ...raw, packets: [{ ...raw.packets[0], workerRouting: dated }] }).packets[0].workerRouting?.decidedAt).toBe(dated.decidedAt);
  } finally { vi.useRealTimers(); }
});
