import { findLatestLaneByPacket, getLaneEvents } from '@/lib/lane/registry';
import { readLaneTerminalReason } from '@/lib/lane/terminal-reason';
import { currentLaneMergePolicy } from '@/lib/lane/dogfood-guard';
import { recoveryInfoFromLaneEvents } from '@/lib/lane/recovery-info';

/**
 * Build a lite mission status snapshot from the SQLite archive + live lanes.
 *
 * Used by `getMissionStatus` when the requested mission isn't the current
 * file-based active mission. Packet wave grouping, queue/release states, and
 * review results aren't reconstructed (we don't archive that depth) — just
 * the lane lifecycle (status, branch, last event), which is the answer to
 * "is my parallel mission done yet?"
 */
export function buildHistoricalMissionStatus(record: import('@/lib/db/missions-store').MissionRecord) {
  const lanesByPacket = new Map<string, ReturnType<typeof findLatestLaneByPacket>>();
  for (const meta of record.packetMeta) {
    lanesByPacket.set(meta.id, findLatestLaneByPacket(meta.id));
  }

  const inferPacketStatus = (lane: ReturnType<typeof findLatestLaneByPacket>): string => {
    if (!lane) return 'unknown';
    switch (lane.status) {
      case 'completed':
      case 'archived':
        return 'completed';
      case 'reviewing':
        return 'awaiting_review';
      case 'merging':
        return 'merging';
      case 'failed':
      case 'recovering':
        return 'failed';
      case 'launching':
      case 'running':
        return 'running';
      case 'awaiting_input':
      case 'awaiting_orchestrator':
      case 'awaiting_human':
        return 'blocked';
      case 'idle':
      case 'paused':
        return lane.status;
      default:
        return 'unknown';
    }
  };

  const inferReleaseState = (lane: ReturnType<typeof findLatestLaneByPacket>) => (
    lane?.status === 'completed' ? 'released' : 'pending'
  );

  const packets = record.packetMeta.map((meta) => {
    const lane = lanesByPacket.get(meta.id) ?? null;
    const mergePolicy = currentLaneMergePolicy(lane?.projectId ?? null);
    const recovery = lane?.outcome === 'merged' ? null : lane ? recoveryInfoFromLaneEvents(getLaneEvents(lane.id, 100)) : null;
    return {
      id: meta.id,
      referenceLabel: meta.referenceLabel,
      title: meta.title,
      wave: 1,
      status: inferPacketStatus(lane), runtime: lane?.runtime ?? null, model: lane?.model ?? null,
      queueState: lane ? 'released' : 'unknown',
      releaseState: inferReleaseState(lane),
      blockedBy: [] as string[],
      blockedReason: null,
      terminalReason: readLaneTerminalReason(lane),
      summary: null,
      recovery,
      lane: lane ? {
        laneId: lane.id,
        sessionKey: lane.sessionKey,
        runtime: lane.runtime, model: lane.model,
        status: lane.status,
        branch: lane.branch,
        repoPath: lane.worktreePath ?? lane.repoPath,
        lastEventAt: lane.lastEventAt,
        lastLifecycleEventAt: lane.lastEventAt,
        lastTranscriptAt: null,
        lastActivityAt: lane.lastEventAt,
        lastActivityLabel: lane.lastEventLabel,
        transcriptUnsupportedReason: null,
        lastEventLabel: lane.lastEventLabel,
        terminalReason: readLaneTerminalReason(lane),
        mergeMode: mergePolicy.mode,
        mergeModeNote: mergePolicy.note,
      } : null,
      review: null,
    };
  });

  const agents = record.packetMeta
    .map((meta) => {
      const lane = lanesByPacket.get(meta.id) ?? null;
      if (!lane) return null;
      return {
        packetId: meta.id,
        laneId: lane.id,
        sessionKey: lane.sessionKey,
        label: lane.label,
        runtime: lane.runtime, model: lane.model,
        status: lane.status,
        branch: lane.branch,
        repoPath: lane.worktreePath ?? lane.repoPath,
        lastEventAt: lane.lastEventAt,
        lastLifecycleEventAt: lane.lastEventAt,
        lastTranscriptAt: null,
        lastActivityAt: lane.lastEventAt,
        lastActivityLabel: lane.lastEventLabel,
        transcriptUnsupportedReason: null,
        lastEventLabel: lane.lastEventLabel,
        terminalReason: readLaneTerminalReason(lane),
      };
    })
    .filter((agent): agent is NonNullable<typeof agent> => agent !== null);

  return {
    missionId: record.id,
    prompt: record.prompt,
    summary: record.summary,
    repoPath: record.repoPath,
    runtime: record.runtime,
    constraints: record.constraints,
    currentWave: 1,
    totalWaves: record.totalWaves,
    packets,
    agents,
    blockers: [] as Array<{ packetId: string; blockedBy: string[]; reason: string | null }>,
    historical: true,
  };
}
