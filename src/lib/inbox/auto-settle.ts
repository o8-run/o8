/**
 * The auto-settle sweep (rules in auto-settle-rules.ts). Server-side, so the
 * web app, mobile and the native sidebar all read the same settlement; a
 * listing shows `autoSettledReason` while that automatic settle is current,
 * and the ordinary `unsettle` action undoes it (and keeps it un-settled).
 * Toggle: operator default `autoSettleEnabled` ([inbox] auto_settle); idle
 * settle after `autoSettleIdleDays` ([inbox] auto_settle_idle_days, 0 = off).
 */
import { getSqlite } from '@/lib/db';
import { listLanes } from '@/lib/lane/registry';
import { readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import type { AgentSummary } from '@/lib/fleet/types';
import { listMobileOrchestratorThreads } from '@/lib/mobile/orchestrator-thread-history';
import { conversationVerdict, idleVerdict, laneVerdict, type AutoSettleLane, type AutoSettlePacket, type AutoSettlePr, type AutoSettleVerdict } from './auto-settle-rules';
import { legacyInboxPin } from './preferences';
import { autoSettleEligible, inboxSubject, mutateInboxAutoSettle, readInboxState } from './store';
import { assertInboxCanSettle, inboxPackets, runtimeInboxIdentity } from './subjects';
import type { InboxSubject } from './settlement';

const SWEEP_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;

interface Candidate { subject: InboxSubject; verdict: AutoSettleVerdict; legacyPinned: boolean }

function idleCandidateVerdict(subject: InboxSubject, lastActivityAt: string | undefined, days: number, now: number): AutoSettleVerdict | null {
  if (!(days > 0)) return null;
  const state = readInboxState(subject);
  // A normal ready event follows the last message. Count that completion as
  // activity while retaining its timestamp as the mutation's freshness fence.
  const latest = Math.max(...[lastActivityAt, state.runAt, state.observedRunAt]
    .map(at => at ? Date.parse(at) : NaN).filter(Number.isFinite));
  return idleVerdict(Number.isFinite(latest) ? new Date(latest).toISOString() : null, days, now);
}

function linkedPrs(): Map<string, AutoSettlePr[]> {
  const rows = getSqlite().prepare(`SELECT c.thread_id AS threadId, p.merged_at AS mergedAt FROM conversation_pr_context c
    LEFT JOIN github_pull_requests p ON p.pull_request_id = c.pull_request_id
      AND p.repository_id = c.repository_id AND p.number = c.number`).all() as AutoSettlePr[];
  const byThread = new Map<string, AutoSettlePr[]>();
  for (const row of rows) byThread.set(row.threadId, [...(byThread.get(row.threadId) ?? []), row]);
  return byThread;
}

export function collectAutoSettleCandidates(idleDays = 0, now = Date.now()): Candidate[] {
  const packets = inboxPackets();
  const lanes = listLanes();
  const prs = linkedPrs();
  const owned = new Map<string, AutoSettlePacket[]>();
  const byId = new Map<string, AutoSettlePacket>();
  for (const packet of packets) {
    const threadId = packet.orchestratorThreadId || packet.launchContext?.parentThreadId || null;
    const row: AutoSettlePacket = { id: packet.id, threadId, status: packet.status, releaseState: packet.releaseState,
      releasedAt: packet.releaseStatePayload?.releasedAt ?? null, archivedAt: packet.archivedAt ?? null };
    byId.set(packet.id, row);
    if (threadId) owned.set(threadId, [...(owned.get(threadId) ?? []), row]);
  }
  const laneRows: AutoSettleLane[] = lanes.map(lane => ({ packetId: lane.packetId ?? null, sessionKey: lane.sessionKey ?? null,
    status: lane.status, updatedAt: lane.updatedAt, repoPath: lane.repoPath, projectId: lane.projectId ?? null }));
  const out: Candidate[] = [];
  const activity = idleDays > 0
    ? new Map(listMobileOrchestratorThreads({ limit: 100_000 }).map(t => [t.id, t.lastMessageAt] as const))
    : new Map<string, string>();
  for (const threadId of new Set([...prs.keys(), ...owned.keys()])) {
    const record = readPersistedLlmChat(threadId)?.history as { repoPath?: string; projectId?: string; pinned?: boolean; archivedAt?: string | null } | undefined;
    if (!record || record.archivedAt) continue;
    const subject = inboxSubject('conversation', threadId, record.repoPath, record.projectId);
    const verdict = conversationVerdict(prs.get(threadId) ?? [], owned.get(threadId) ?? [], laneRows)
      ?? idleCandidateVerdict(subject, activity.get(threadId), idleDays, now);
    if (verdict) out.push({ subject, verdict, legacyPinned: legacyInboxPin(record) !== null });
  }
  // Standalone workers: the newest lane per session decides.
  const newest = new Map<string, AutoSettleLane>();
  for (const lane of [...laneRows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    if (lane.sessionKey && !newest.has(lane.sessionKey)) newest.set(lane.sessionKey, lane);
  }
  for (const [sessionKey, lane] of newest) {
    const identity = runtimeInboxIdentity({ sessionKey, workspace: lane.repoPath }, packets, lanes);
    if (identity.parentInboxSubject) continue;
    const verdict = laneVerdict(lane, lane.packetId ? byId.get(lane.packetId) : undefined)
      ?? idleCandidateVerdict(identity.inboxSubject, lane.updatedAt, idleDays, now);
    if (verdict) out.push({ subject: identity.inboxSubject, verdict, legacyPinned: false });
  }
  return out;
}

export async function runInboxAutoSettleSweep(options: { force?: boolean; agents?: AgentSummary[]; idleDays?: number; now?: number } = {}): Promise<string[]> {
  const defaults = getOperatorDefaultsSync().values;
  if (!options.force && !defaults.autoSettleEnabled) return [];
  const candidates = collectAutoSettleCandidates(options.idleDays ?? defaults.autoSettleIdleDays ?? 0, options.now)
    .filter(c => autoSettleEligible(readInboxState(c.subject), c.verdict.evidenceAt, c.legacyPinned));
  if (!candidates.length) return [];
  let agents = options.agents;
  if (!agents) {
    const { getRuntimeInventorySnapshot } = await import('@/lib/runtime/inventory');
    agents = (await getRuntimeInventorySnapshot({ fresh: true })).agents;
  }
  const settled: string[] = [];
  for (const { subject, verdict, legacyPinned } of candidates) {
    try {
      if (mutateInboxAutoSettle(subject, verdict.reason, verdict.evidenceAt, () => assertInboxCanSettle(subject, agents!), legacyPinned)) {
        settled.push(subject.id);
        console.log(`[inbox] auto-settled ${subject.kind} ${subject.id} (${verdict.reason})`);
      }
    } catch { /* Needs input, running or queued: try again next sweep. */ }
  }
  return settled;
}

export function startInboxAutoSettle(): void {
  if (timer) return;
  timer = setInterval(() => { void runInboxAutoSettleSweep().catch(err => console.warn('[inbox] auto-settle sweep failed:', err)); }, SWEEP_MS);
  timer.unref?.();
}
export function stopInboxAutoSettle(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
