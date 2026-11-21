import type { RuntimeLaunchIdentity } from './identity-catalog';
import { resolveDefaultDispatchModelSync, resolveDefaultWorkerEffortSync } from '@/lib/operator/defaults';
import { assertRuntimeModelEffortPin } from '@/lib/orchestrator/effort-pin';
import type { RuntimeLaunchRequest } from './actions';

/** Check the adapter's effective selection before any workspace preparation. */
export async function assertLaunchEffortPin(payload: RuntimeLaunchRequest, repoPath: string, identity?: RuntimeLaunchIdentity): Promise<void> {
  if (payload.runtime !== 'codex') return;
  const model = payload.model ?? (resolveDefaultDispatchModelSync() || undefined);
  const effort = resolveDefaultWorkerEffortSync('codex', payload.effort, model);
  await assertRuntimeModelEffortPin(payload.runtime, model, effort, { cwd: repoPath, packetId: payload.packetId, configHome: identity?.configHomeRef, identity });
}
