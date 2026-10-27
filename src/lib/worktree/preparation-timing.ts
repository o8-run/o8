import type { CreateWorktreeOptions } from './types';
import { withDependencyPreparationTiming } from '@/lib/workspace/dependency-install-timing';

/** Monotonic stage timings on the same lane that records session_launched. */
export async function timeWorktreePreparation<T>(
  launch: Pick<CreateWorktreeOptions, 'laneId' | 'packetId'> | undefined,
  stage: 'clone' | 'checkout' | 'asset_hydration' | 'dependency_materialization',
  operation: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  let completed = false;
  try {
    const result = await (stage === 'dependency_materialization'
      ? withDependencyPreparationTiming(launch, operation) : operation());
    completed = true;
    return result;
  } finally {
    if (launch?.laneId) {
      const { appendEvent } = await import('@/lib/lane/registry');
      appendEvent(launch.laneId, 'worktree_preparation_timing', 'system', {
        packetId: launch.packetId,
        stage,
        durationMs: Math.round(performance.now() - started),
        completed,
      });
    }
  }
}

/** Persist selection before the chosen dependency operation can stall. */
export async function recordDependencySelection(
  launch: Pick<CreateWorktreeOptions, 'laneId' | 'packetId'> | undefined,
  selection: import('@/lib/workspace/dependency-directory-clone').DependencySelection,
): Promise<void> {
  if (!launch?.laneId) return;
  const { appendEvent } = await import('@/lib/lane/registry');
  appendEvent(launch.laneId, 'worktree_preparation_timing', 'system', {
    packetId: launch.packetId, stage: 'dependency_selection', ...selection,
  });
}
