import { listActiveLanes } from '@/lib/lane/registry';
import { resolveParallelCapSync } from '@/lib/operator/defaults';
import type { OrchestratorRuntime } from './types';

export const RUNTIME_PARALLEL_CAP: Partial<Record<OrchestratorRuntime, number>> = {
  gemini: 3,
};
export interface DispatchLaunchBudget {
  maxLaunches: number;
  perRuntime?: Partial<Record<OrchestratorRuntime, number>>;
}

export function buildRemainingLaunchBudget(): DispatchLaunchBudget {
  const parallelCap = resolveParallelCapSync();
  const activeLanes = listActiveLanes().filter((lane) => lane.status === 'launching' || lane.status === 'running');
  const perRuntime: Partial<Record<OrchestratorRuntime, number>> = {};
  for (const runtime of Object.keys(RUNTIME_PARALLEL_CAP) as OrchestratorRuntime[]) {
    const cap = RUNTIME_PARALLEL_CAP[runtime];
    if (cap === undefined) continue;
    const active = activeLanes.filter((lane) => lane.runtime === runtime).length;
    perRuntime[runtime] = Math.max(0, cap - active);
  }
  return {
    maxLaunches: Math.max(0, parallelCap - activeLanes.length),
    perRuntime,
  };
}
