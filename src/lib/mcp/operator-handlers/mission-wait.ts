export interface MinimalMissionPacket {
  id?: string;
  status?: string;
  releaseState?: string;
  blockedReason?: string | null;
  blockedBy?: unknown;
  lane?: {
    status?: string;
  } | null;
}

export interface MinimalMissionStatusShape {
  packets?: MinimalMissionPacket[];
  leadsUnavailable?: boolean;
  leads?: Array<{ id: string; status: string; reason?: string | null;
    latestTurn?: { id: string; outcome?: { kind: string } | null } | null }>;
  currentWave?: number;
  totalWaves?: number;
}

// Packets in these states need caller attention unless authoritative lane
// evidence says a rerun is still active.
const PACKET_ATTENTION_STATUSES = new Set(['awaiting_review', 'released', 'failed', 'archived', 'blocked']);

export function missionPacketSignature(packets: MinimalMissionPacket[] | undefined, leads: MinimalMissionStatusShape['leads'] = []): string {
  const packetSignature = (Array.isArray(packets) ? packets : [])
    .map((packet) => `${packet.id ?? ''}:${packet.status ?? ''}:${packet.releaseState ?? ''}:${packet.blockedReason ?? ''}:${packet.lane?.status ?? ''}`)
    .sort()
    .join(',');
  return packetSignature + (leads.length ? `|${leads.map(lead =>
    `${lead.id}:${lead.status}:${lead.reason ?? ''}:${lead.latestTurn?.id ?? ''}:${lead.latestTurn?.outcome?.kind ?? ''}`
  ).sort().join(',')}` : '');
}

export function findMissionAttention(status: MinimalMissionStatusShape, packetIdFilter: string | null) {
  if (status.leadsUnavailable) return { terminalPacketId: null, leadsUnavailable: true };
  // Packet-scoped waits retain their own review/return semantics.
  const lead = !packetIdFilter && status.leads?.find(item =>
    ['unreported', 'completed', 'blocked', 'needs_approval', 'failed', 'stopped'].includes(item.status));
  if (lead) return { terminalPacketId: null, terminalLeadId: lead.id };
  const packet = findMissionAttentionPacket(status, packetIdFilter);
  return packet ? { terminalPacketId: packet.id ?? null } : null;
}

function packetIsActive(packet: MinimalMissionPacket): boolean {
  return packet.blockedReason === 'rerun_in_progress'
    || packet.lane?.status === 'running';
}

export function findMissionAttentionPacket(
  status: MinimalMissionStatusShape,
  packetIdFilter: string | null,
): MinimalMissionPacket | null {
  for (const packet of status.packets ?? []) {
    if (packetIdFilter && packet.id !== packetIdFilter) continue;
    if (packetIsActive(packet)) continue;
    if (typeof packet.status === 'string' && PACKET_ATTENTION_STATUSES.has(packet.status)) {
      return packet;
    }
  }
  return null;
}
