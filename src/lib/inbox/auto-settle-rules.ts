/**
 * Auto-settle rules for completed and idle threads.
 * Pure: the sweep in settlement.ts gathers the evidence and applies the
 * operator guards (pin, opt-out, needs input, running) under SQLite.
 *
 * A thread is done when the work it shipped is done:
 *  - pr-merged: every PR linked to the conversation is merged.
 *  - released:  a packet has canonical merge evidence and every owned packet
 *               is finished. Read-only release and archived lanes are finished
 *               work, but do not prove a merge or trigger a settle themselves.
 *  - idle:      after `[inbox] auto_settle_idle_days` (default 3, 0 = off) with no
 *               activity; open PRs or workers do not block it.
 * A thread with no linked PR and no worker is never settled automatically, not
 * even when idle: it may hold unfinished work.
 * Historical `cleaned` notes remain readable; cleanup is not a current trigger.
 */
import type { OrchestratorReleaseStatePayload } from '@/lib/orchestrator/types';
import { hasCanonicalReleaseEvidence } from '@/lib/orchestrator/packet-release-truth';

export type AutoSettleReason = 'pr-merged' | 'released' | 'cleaned' | 'idle';

export interface AutoSettlePr { threadId: string; mergedAt: string | null }
export interface AutoSettlePacket {
  id: string; threadId: string | null; status: string; releaseState?: string | null;
  releaseStatePayload?: OrchestratorReleaseStatePayload | null;
}
export interface AutoSettleLane {
  packetId: string | null; sessionKey: string | null; status: string; updatedAt: string;
  repoPath: string; projectId?: string | null;
}
export interface AutoSettleVerdict { reason: AutoSettleReason; evidenceAt: string }

const latest = (values: Array<string | null | undefined>): string | null => values.reduce<string | null>(
  (max, value) => value && Number.isFinite(Date.parse(value)) && (!max || Date.parse(value) > Date.parse(max)) ? value : max, null);

export function prVerdict(prs: AutoSettlePr[]): AutoSettleVerdict | null {
  if (!prs.length || prs.some(pr => !pr.mergedAt)) return null;
  const at = latest(prs.map(pr => pr.mergedAt));
  return at ? { reason: 'pr-merged', evidenceAt: at } : null;
}

/** Completion is a guard, not proof that a merge happened. */
function allPacketsFinished(packets: AutoSettlePacket[], lanes: AutoSettleLane[]): boolean {
  return packets.every(packet => {
    if (packet.releaseState === 'released' && hasCanonicalReleaseEvidence(packet)) return true;
    const own = lanes.filter(lane => lane.packetId === packet.id);
    return own.length > 0 && own.every(lane => lane.status === 'archived');
  });
}

function packetMergeAt(packet: AutoSettlePacket): string | null {
  if (packet.releaseState !== 'released' || !hasCanonicalReleaseEvidence(packet)
    || packet.releaseStatePayload?.source === 'read_only_completed') return null;
  return latest([packet.releaseStatePayload?.releasedAt]);
}

/** A merge receipt is required, and one unfinished owned packet keeps the thread. */
export function packetsVerdict(packets: AutoSettlePacket[], lanes: AutoSettleLane[]): AutoSettleVerdict | null {
  if (!packets.length || !allPacketsFinished(packets, lanes)) return null;
  const at = latest(packets.map(packetMergeAt));
  return at ? { reason: 'released', evidenceAt: at } : null;
}

/** A standalone worker needs its packet's actual merge receipt, not a lane timestamp. */
export function laneVerdict(_lane: AutoSettleLane, packet: AutoSettlePacket | undefined): AutoSettleVerdict | null {
  const at = packet ? packetMergeAt(packet) : null;
  return at ? { reason: 'released', evidenceAt: at } : null;
}

/** PR evidence wins over packet evidence: it is the one the operator linked. */
export function conversationVerdict(prs: AutoSettlePr[], packets: AutoSettlePacket[], lanes: AutoSettleLane[]): AutoSettleVerdict | null {
  const pr = prVerdict(prs);
  if (pr && !allPacketsFinished(packets, lanes)) return null;
  return pr ?? (prs.length ? null : packetsVerdict(packets, lanes));
}

const DAY_MS = 86_400_000;
/** Idle settle for a thread that has a PR or worker: last activity `days` or more ago. */
export function idleVerdict(lastActivityAt: string | null | undefined, days: number, now = Date.now()): AutoSettleVerdict | null {
  if (!(days > 0) || !lastActivityAt) return null;
  const at = Date.parse(lastActivityAt);
  return Number.isFinite(at) && now - at >= days * DAY_MS ? { reason: 'idle', evidenceAt: new Date(at).toISOString() } : null;
}

export const AUTO_SETTLE_NOTES: Record<AutoSettleReason, string> = {
  'pr-merged': 'PR merged', released: 'Merged', cleaned: 'Worktree cleaned up', idle: 'Idle',
};
