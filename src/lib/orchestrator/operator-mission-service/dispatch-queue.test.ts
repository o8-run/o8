import { expect, it, vi } from 'vitest';
import type { OrchestratorMissionState } from '../types';
const mocks = vi.hoisted(() => ({ lanes: vi.fn(() => [{ status: 'running', runtime: 'codex' }]), load: vi.fn(() => 'Machine busy: current') }));
vi.mock('@/lib/lane/registry', () => ({ listActiveLanes: mocks.lanes }));
vi.mock('@/lib/operator/defaults', () => ({ resolveParallelCapSync: () => 5 }));
vi.mock('@/lib/orchestrator/machine-load', () => ({ machineLoadBlocker: mocks.load }));
vi.mock('@/lib/orchestrator/dag', () => ({ getDispatchableWave: (packets: unknown) => packets }));
vi.mock('@/lib/orchestrator/dispatch', () => ({ RUNTIME_PARALLEL_CAP: {} }));
vi.mock('@/lib/runtime/fetch-unreachable-recovery', () => ({ fetchUnreachableCooldownRetrySeconds: () => null }));
import { missionDispatchQueue } from './dispatch-queue';
it('preserves specific reasons and samples machine capacity once for multiple packets', () => {
  const state = { packets: [
    { id: 'specific', runtime: 'codex', blockedReason: 'Waiting for dependency receipt' },
    { id: 'load', runtime: 'codex' },
  ] } as OrchestratorMissionState;
  const queue = missionDispatchQueue(state);
  expect(queue[0].detail).toBe('Waiting for dependency receipt');
  expect(queue[1].detail).toBe('Machine busy: current');
  expect(mocks.load).toHaveBeenCalledTimes(1);
  expect(mocks.lanes).toHaveBeenCalledTimes(1);
});
