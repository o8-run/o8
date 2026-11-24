import { withLockedState } from '@/lib/orchestrator/control-plane';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

/**
 * Shallow-merge a patch onto a single mission packet under the cross-process
 * control-plane lock.
 * Returns false when the packet is not in mission state — an orphan/lane-only
 * packet is a no-op, mirroring submitPacketReview's missionPacket guard.
 *
 * Used by the review pipeline to stamp packet-scoped review artifacts
 * (deviations #1490) that the surfaces read back.
 */
export async function patchMissionPacket(
  packetId: string,
  patch: Partial<OrchestratorPacket>,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  const { result } = await withLockedState((state) => {
    if (!isCurrent()) return false;
    const index = state.packets.findIndex((candidate) => candidate.id === packetId);
    if (index === -1) return false;
    state.packets[index] = { ...state.packets[index], ...patch };
    return true;
  });
  return result;
}
