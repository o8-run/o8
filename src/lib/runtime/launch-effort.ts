import { resolveDefaultDispatchModelSync, resolveDefaultWorkerEffortSync } from '@/lib/operator/defaults';
import { assertRuntimeEffortPin } from '@/lib/orchestrator/effort-pin';
import type { RuntimeLaunchRequest } from './actions';

/** Check the adapter's effective selection before any workspace preparation. */
export async function assertLaunchEffortPin(payload: RuntimeLaunchRequest, repoPath: string): Promise<void> {
  if (payload.runtime !== 'muse' && payload.runtime !== 'codex') return;
  const model = payload.model ?? (payload.runtime === 'codex' ? resolveDefaultDispatchModelSync() || undefined : undefined);
  const effort = payload.runtime === 'codex' ? resolveDefaultWorkerEffortSync('codex', payload.effort, model) : payload.effort;
  await assertRuntimeEffortPin(payload.runtime, model, effort, { cwd: repoPath, packetId: payload.packetId });
}
