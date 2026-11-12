import { machineLoadBlocker } from '@/lib/orchestrator/machine-load';
import { listActiveLanes } from '@/lib/lane/registry';
import { resolveParallelCapSync } from '@/lib/operator/defaults';
import { getDispatchableWave } from '@/lib/orchestrator/dag';
import { RUNTIME_PARALLEL_CAP } from '@/lib/orchestrator/dispatch';
import type { OrchestratorMissionState } from '@/lib/orchestrator/types';
import { fetchUnreachableCooldownRetrySeconds } from '@/lib/runtime/fetch-unreachable-recovery';

export interface DispatchQueueEntry {
  packetId: string;
  reason: 'concurrency-limit' | 'runtime-concurrency-limit' | 'fetch-unreachable' | 'storage-admission' | 'scheduler-deferred';
  detail: string;
  limit: number;
  running: number;
  position: number;
  positionScope: 'mission';
  retryInSeconds?: number;
}

/** Project current capacity instead of persisting a blocker that goes stale as workers finish. */
export function missionDispatchQueue(state: OrchestratorMissionState): DispatchQueueEntry[] {
  const active = listActiveLanes().filter((lane) => lane.status === 'launching' || lane.status === 'running');
  const limit = resolveParallelCapSync();
  return getDispatchableWave(state.packets)
    .filter((packet) => !packet.archivedAt && !packet.operatorStopped)
    .map<DispatchQueueEntry>((packet, index) => {
      const base = { packetId: packet.id, limit, running: active.length, position: index + 1, positionScope: 'mission' as const };
      const retryInSeconds = fetchUnreachableCooldownRetrySeconds(packet.workspaceTargetPath!, {
        packetId: packet.id, stage: 'pre_lane_receipt',
      });
      if (retryInSeconds != null) {
        return { ...base, reason: 'fetch-unreachable', retryInSeconds,
          detail: `Queued behind a fetch_unreachable network cooldown; retry in ${retryInSeconds}s.` };
      }
      if (packet.storageAdmission?.state === 'held') {
        return { ...base, reason: 'storage-admission', detail: packet.blockedReason ?? 'Queued behind storage admission.' };
      }
      if (active.length >= limit) {
        return { ...base, reason: 'concurrency-limit',
          detail: `Queued behind the concurrency limit (${active.length}/${limit} running or launching); mission queue position ${index + 1}.` };
      }
      const runtime = packet.workerRouting?.selectedRuntime ?? packet.runtime;
      const runtimeLimit = RUNTIME_PARALLEL_CAP[runtime];
      const runtimeRunning = active.filter((lane) => lane.runtime === runtime).length;
      if (runtimeLimit !== undefined && runtimeRunning >= runtimeLimit) {
        return { ...base, limit: runtimeLimit, running: runtimeRunning, reason: 'runtime-concurrency-limit',
          detail: `Queued behind the ${runtime} concurrency limit (${runtimeRunning}/${runtimeLimit}); mission queue position ${index + 1}.` };
      }
      return { ...base, reason: 'scheduler-deferred', detail: machineLoadBlocker() ?? packet.blockedReason
        ?? `Queued for a scheduler launch; mission queue position ${index + 1}.` };
    });
}
