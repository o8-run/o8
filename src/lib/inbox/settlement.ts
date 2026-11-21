import { withInboxComposerQueueGuard } from './composer-queue-guard';
import { startSettledWorkspaceParking } from './workspace-parking';
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
import type { InboxSubject } from './settlement-state';
import { recurring } from '@/lib/background-work/ledger';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { getDataDir } from '@/lib/data-dir-migration';
import { statSync } from 'node:fs';
import { join } from 'node:path';

export { emptySettlement, hasQueuedTurnStart, QUEUED_TURN_START_GRACE_MS, transitionSettlement } from './settlement-state';
export type { InboxSettlement, InboxSubject } from './settlement-state';

const SWEEP_MS = 60_000;
const DAY_MS = 86_400_000;
let timer: ReturnType<typeof setInterval> | null = null;
/** What the last timed sweep read, while it left nothing to retry; null forces the next sweep. */
let lastInputs: string | null = null;
/** The earliest moment a subject the last sweep saw can age into an idle settle. */
let nextIdleAt = Infinity;

interface Candidate { subject: InboxSubject; verdict: AutoSettleVerdict; legacyPinned: boolean }

function eligibleVerdict(subject: InboxSubject, merged: AutoSettleVerdict | null, lastActivityAt: string | undefined,
  days: number, now: number, legacyPinned = false, idle?: { nextAt: number }): AutoSettleVerdict | null {
  const state = readInboxState(subject);
  if (merged && autoSettleEligible(state, merged.evidenceAt, legacyPinned)) return merged;
  // New work can make an old merge stale. It can still age into an idle settle.
  if (!(days > 0)) return null;
  // A normal ready event follows the last message. Count that completion as
  // activity while retaining its timestamp as the mutation's freshness fence.
  const latest = Math.max(...[lastActivityAt, state.runAt, state.observedRunAt]
    .map(at => at ? Date.parse(at) : NaN).filter(Number.isFinite));
  const verdict = idleVerdict(Number.isFinite(latest) ? new Date(latest).toISOString() : null, days, now);
  if (!verdict && idle && Number.isFinite(latest)) idle.nextAt = Math.min(idle.nextAt, latest + days * DAY_MS);
  return verdict;
}

function linkedPrs(): Map<string, AutoSettlePr[]> {
  const rows = getSqlite().prepare(`SELECT c.thread_id AS threadId, p.merged_at AS mergedAt FROM conversation_pr_context c
    LEFT JOIN github_pull_requests p ON p.pull_request_id = c.pull_request_id
      AND p.repository_id = c.repository_id AND p.number = c.number`).all() as AutoSettlePr[];
  const byThread = new Map<string, AutoSettlePr[]>();
  for (const row of rows) byThread.set(row.threadId, [...(byThread.get(row.threadId) ?? []), row]);
  return byThread;
}

function readCompletionEvidence() {
  const packets = inboxPackets();
  const lanes = listLanes();
  const prs = linkedPrs();
  const owned = new Map<string, AutoSettlePacket[]>();
  const byId = new Map<string, AutoSettlePacket>();
  for (const packet of packets) {
    const threadId = packet.orchestratorThreadId || packet.launchContext?.parentThreadId || null;
    const row: AutoSettlePacket = { id: packet.id, threadId, status: packet.status, releaseState: packet.releaseState,
      releaseStatePayload: packet.releaseStatePayload ?? null };
    byId.set(packet.id, row);
    if (threadId) owned.set(threadId, [...(owned.get(threadId) ?? []), row]);
  }
  const laneRows: AutoSettleLane[] = lanes.map(lane => ({ packetId: lane.packetId ?? null, sessionKey: lane.sessionKey ?? null,
    status: lane.status, updatedAt: lane.updatedAt, repoPath: lane.repoPath, projectId: lane.projectId ?? null }));
  // Standalone workers: the newest lane per session decides.
  const newest = new Map<string, AutoSettleLane>();
  for (const lane of [...laneRows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    if (lane.sessionKey && !newest.has(lane.sessionKey)) newest.set(lane.sessionKey, lane);
  }
  return { packets, lanes, prs, owned, byId, laneRows, newest };
}

/** Called synchronously under the final SQLite write lock, after inventory. */
function assertCompletionEvidenceCurrent(subject: InboxSubject, captured: AutoSettleVerdict): void {
  if (captured.reason === 'idle') return;
  const { packets, lanes, prs, owned, byId, laneRows, newest } = readCompletionEvidence();
  let current: AutoSettleVerdict | null = null;
  if (subject.kind === 'conversation') {
    current = conversationVerdict(prs.get(subject.id) ?? [], owned.get(subject.id) ?? [], laneRows);
  } else {
    const lane = newest.get(subject.id);
    if (lane) {
      const identity = runtimeInboxIdentity({ sessionKey: subject.id, workspace: lane.repoPath }, packets, lanes);
      if (!identity.parentInboxSubject && identity.inboxSubject.workspace === subject.workspace) {
        current = laneVerdict(lane, lane.packetId ? byId.get(lane.packetId) : undefined);
      }
    }
  }
  // Keep the captured reason and freshness fence; changed evidence waits for
  // the next sweep rather than becoming an idle settle inside this commit.
  if (!current || current.reason !== captured.reason || current.evidenceAt !== captured.evidenceAt) {
    throw new Error('Completion evidence changed during inventory refresh.');
  }
}

export function collectAutoSettleCandidates(idleDays = 0, now = Date.now(), idle?: { nextAt: number }): Candidate[] {
  const { packets, lanes, prs, owned, byId, laneRows, newest } = readCompletionEvidence();
  const out: Candidate[] = [];
  const activity = idleDays > 0
    ? new Map(listMobileOrchestratorThreads({ limit: 100_000 }).map(t => [t.id, t.lastMessageAt] as const))
    : new Map<string, string>();
  for (const threadId of new Set([...prs.keys(), ...owned.keys()])) {
    const record = readPersistedLlmChat(threadId)?.history as { repoPath?: string; projectId?: string; pinned?: boolean; archivedAt?: string | null } | undefined;
    if (!record || record.archivedAt) continue;
    const subject = inboxSubject('conversation', threadId, record.repoPath, record.projectId);
    const legacyPinned = legacyInboxPin(record) !== null;
    const verdict = eligibleVerdict(subject, conversationVerdict(prs.get(threadId) ?? [], owned.get(threadId) ?? [], laneRows),
      activity.get(threadId), idleDays, now, legacyPinned, idle);
    if (verdict) out.push({ subject, verdict, legacyPinned });
  }
  for (const [sessionKey, lane] of newest) {
    const identity = runtimeInboxIdentity({ sessionKey, workspace: lane.repoPath }, packets, lanes);
    if (identity.parentInboxSubject) continue;
    const verdict = eligibleVerdict(identity.inboxSubject, laneVerdict(lane, lane.packetId ? byId.get(lane.packetId) : undefined),
      lane.updatedAt, idleDays, now, false, idle);
    if (verdict) out.push({ subject: identity.inboxSubject, verdict, legacyPinned: false });
  }
  return out;
}

export async function runInboxAutoSettleSweep(options: { force?: boolean; agents?: AgentSummary[]; idleDays?: number; now?: number } = {}): Promise<string[]> {
  const defaults = getOperatorDefaultsSync().values;
  if (!options.force && !defaults.autoSettleEnabled) return [];
  const idle = { nextAt: Infinity };
  const candidates = collectAutoSettleCandidates(options.idleDays ?? defaults.autoSettleIdleDays ?? 0, options.now, idle)
    .filter(c => autoSettleEligible(readInboxState(c.subject), c.verdict.evidenceAt, c.legacyPinned));
  nextIdleAt = idle.nextAt;
  lastSweepLeftWork = candidates.length > 0;
  if (!candidates.length) return [];
  let agents = options.agents;
  if (!agents) {
    const { getRuntimeInventorySnapshot } = await import('@/lib/runtime/inventory');
    agents = (await getRuntimeInventorySnapshot({ fresh: true })).agents;
  }
  const settled: string[] = [];
  for (const { subject, verdict, legacyPinned } of candidates) {
    try {
      if (await withInboxComposerQueueGuard(subject, () => mutateInboxAutoSettle(subject, verdict.reason, verdict.evidenceAt, () => {
        assertCompletionEvidenceCurrent(subject, verdict);
        assertInboxCanSettle(subject, agents!);
      }, legacyPinned))) {
        startSettledWorkspaceParking(subject);
        settled.push(subject.id);
        console.log(`[inbox] auto-settled ${subject.kind} ${subject.id} (${verdict.reason})`);
      }
    } catch { /* Evidence changed, needs input, running or queued: try again next sweep. */ }
  }
  lastSweepLeftWork = settled.length < candidates.length;
  return settled;
}

let lastSweepLeftWork = true;
let inputsStatement: { get(): unknown } | null = null;

/**
 * Everything a sweep reads, cheaply. Each table it reads contributes its row
 * count and newest write; the orchestrator state file contributes only the
 * packet fields the verdicts use, because it is rewritten every minute whether
 * or not they changed. The chat history folder and the two operator defaults
 * complete it.
 */
function sweepInputs(): string {
  inputsStatement ??= getSqlite().prepare(`SELECT
    (SELECT count(*) || ':' || ifnull(max(updated_at), '') FROM lanes) AS lanes,
    (SELECT count(*) || ':' || ifnull(max(updated_at), '') FROM missions) AS missions,
    (SELECT count(*) || ':' || ifnull(max(id), '') FROM conversation_pr_context) AS links,
    (SELECT count(*) || ':' || ifnull(max(updated_at), '') FROM github_pull_requests) AS pulls,
    (SELECT count(*) || ':' || ifnull(max(updated_at), '') FROM app_state WHERE key LIKE 'inbox:%') AS inbox`);
  const tables = Object.values(inputsStatement.get() as Record<string, string>).join('|');
  const packets = readOrchestratorControlPlaneState().packets.map(packet => [packet.id, packet.status, packet.releaseState, packet.releaseStatePayload ?? null,
    packet.orchestratorThreadId ?? packet.launchContext?.parentThreadId ?? null]);
  let chats = '';
  try { chats = String(statSync(join(getDataDir(), 'chat-history')).mtimeMs); } catch { /* no chats yet */ }
  const { autoSettleEnabled, autoSettleIdleDays } = getOperatorDefaultsSync().values;
  return JSON.stringify([tables, packets, chats, autoSettleEnabled, autoSettleIdleDays]);
}

/**
 * The timed sweep. It runs only when something it reads changed, the last
 * sweep left a candidate to retry, or a subject has aged into an idle settle;
 * otherwise a pass would read every packet, lane and chat to find nothing.
 */
export async function runInboxAutoSettleSweepIfDue(now = Date.now()): Promise<string[] | null> {
  const inputs = sweepInputs();
  if (inputs === lastInputs && !lastSweepLeftWork && now < nextIdleAt) return null;
  lastInputs = null;
  const settled = await runInboxAutoSettleSweep({ now });
  // Settling writes; read the inputs after the pass so its own writes do not force another.
  if (!lastSweepLeftWork) lastInputs = sweepInputs();
  return settled;
}

/** For tests: forget what the last timed sweep read. */
export function resetInboxAutoSettleSweepState(): void {
  lastInputs = null;
  lastSweepLeftWork = true;
  nextIdleAt = Infinity;
}

export function startInboxAutoSettle(): void {
  if (timer) return;
  timer = recurring('inbox-auto-settle', () => { void runInboxAutoSettleSweepIfDue().catch(err => console.warn('[inbox] auto-settle sweep failed:', err)); }, SWEEP_MS);
  timer.unref?.();
}
export function stopInboxAutoSettle(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
