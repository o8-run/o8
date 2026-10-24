import type { OrchestratorPacket } from './types';

/** A standing session spans packets; its live task wins over earlier receipts. */
export function workerPacketForSession(packets: OrchestratorPacket[], sessionKey: string): OrchestratorPacket | null {
  const matches = packets.filter(packet => packet.lane?.sessionKey === sessionKey);
  return matches.findLast(packet => packet.standingLaneId && packet.status !== 'archived')
    ?? matches.findLast(packet => packet.standingLaneId) ?? matches[0] ?? null;
}
