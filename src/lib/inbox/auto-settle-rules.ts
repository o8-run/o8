/**
 * Auto-settle rules, after T3 Code's "settle when merged" (no code shared).
 * Pure: the sweep in auto-settle.ts gathers the evidence and applies the
 * operator guards (pin, opt-out, needs input, running) under SQLite.
 *
 * A thread is done when the work it shipped is done:
 *  - pr-merged: every PR linked to the conversation is merged.
 *  - released:  every worker packet the thread owns is released (an
 *               approve-and-merge, GitHub auto-merge, heal-bot auto-release or
 *               merged-by-ancestry all mint the same release receipt).
 *  - cleaned:   the rest of its worker lanes were archived by auto-clean (the
 *               worktree reaper) or by hand, so nothing is left to look at.
 *  - idle:      after `[inbox] auto_settle_idle_days` (default 3, 0 = off) with no
 *               activity, as T3's idle settle; open PRs or workers do not block it.
 * A thread with no linked PR and no worker is never settled automatically, not
 * even when idle: it may hold unfinished work (Q, 2026-10-31).
 */
export type AutoSettleReason = 'pr-merged' | 'released' | 'cleaned' | 'idle';

export interface AutoSettlePr { threadId: string; mergedAt: string | null }
export interface AutoSettlePacket {
  id: string; threadId: string | null; status: string; releaseState?: string | null;
  releasedAt?: string | null; archivedAt?: string | null;
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

/** Every owned packet must be released or have its lane archived; one open packet keeps the thread. */
export function packetsVerdict(packets: AutoSettlePacket[], lanes: AutoSettleLane[]): AutoSettleVerdict | null {
  if (!packets.length) return null;
  let released = false;
  const times: Array<string | null | undefined> = [];
  for (const packet of packets) {
    if (packet.releaseState === 'released') { released = true; times.push(packet.releasedAt); continue; }
    const own = lanes.filter(lane => lane.packetId === packet.id);
    if (!own.length || own.some(lane => lane.status !== 'archived')) return null;
    times.push(...own.map(lane => lane.updatedAt), packet.archivedAt);
  }
  const at = latest(times);
  return at ? { reason: released ? 'released' : 'cleaned', evidenceAt: at } : null;
}

/** A standalone worker: its newest lane was released or archived. */
export function laneVerdict(lane: AutoSettleLane, packet: AutoSettlePacket | undefined): AutoSettleVerdict | null {
  if (packet?.releaseState === 'released') return { reason: 'released', evidenceAt: latest([packet.releasedAt, lane.updatedAt]) ?? lane.updatedAt };
  return lane.status === 'archived' ? { reason: 'cleaned', evidenceAt: lane.updatedAt } : null;
}

/** PR evidence wins over packet evidence: it is the one the operator linked. */
export function conversationVerdict(prs: AutoSettlePr[], packets: AutoSettlePacket[], lanes: AutoSettleLane[]): AutoSettleVerdict | null {
  const pr = prVerdict(prs);
  if (pr && packets.length && !packetsVerdict(packets, lanes)) return null;
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
