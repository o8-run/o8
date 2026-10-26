import { correctionStopVersion } from '@/lib/db/worker-correction-fences';
import { getLane } from '@/lib/lane/registry';
import { packetAutomaticRecoveryHoldReason } from '@/lib/lane/packet-stop-hold';
import type { Lane } from '@/lib/lane/types';

/** Capture operator intent before asynchronous handoff evidence collection. */
export function workerFallbackGuard(lane: Lane, surfaceId: string, owned: boolean, toRuntime: string, expectedStopVersion?: number) {
  const stopVersion = expectedStopVersion ?? correctionStopVersion(`worker:${surfaceId}`);
  return (launching = false) => {
    if (!owned) return;
    const current = getLane(lane.id);
    if (!current || current.sessionKey !== (launching ? null : surfaceId)
      || current.status !== (launching ? 'launching' : 'running')
      || current.runtime !== (launching ? toRuntime : lane.runtime)
      || current.worktreePath !== lane.worktreePath || current.repoPath !== lane.repoPath
      || current.packetId !== lane.packetId || current.branch !== lane.branch
      || correctionStopVersion(`worker:${surfaceId}`) !== stopVersion
      || (lane.packetId && packetAutomaticRecoveryHoldReason(lane.packetId))) {
      throw new Error('Worker handoff cancelled because the source worker or lane changed.');
    }
  };
}
