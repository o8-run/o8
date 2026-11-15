import { readReviewSchedulingService } from '@/lib/lane/review-scheduling-state';
import { reviewQueueTime } from '@/lib/lane/review-queue-time';
import 'server-only';
import { getSqlite } from '@/lib/db';
import { activeReviewClaimCount, REVIEW_CONCURRENCY_LIMIT } from '@/lib/lane/review-concurrency';
import type { OrchestratorPacket } from './types';

const KEY = 'review_backpressure/v1';
export const BACKPRESSURE_PREFIX = 'Review backlog:';

/** Explicit opt-in only. No saved default or routing choice is changed. */
export function reviewBackpressurePolicy() {
  const raw = process.env.O8_REVIEW_BACKPRESSURE;
  if (raw === undefined) return { enabled: false, valid: true, high: null, low: null };
  try {
    const p = JSON.parse(raw) as { high: number; low: number };
    if (!p || !Number.isInteger(p.high) || !Number.isInteger(p.low) || p.low < 0 || p.high <= p.low || p.high > 1000) throw new Error('bounds');
    return { enabled: true, valid: true, high: p.high, low: p.low };
  } catch { return { enabled: true, valid: false, high: null, low: null }; }
}

function readLatch(): boolean {
  const row = getSqlite().prepare('SELECT value FROM app_state WHERE key = ?').get(KEY) as { value: string } | undefined;
  if (!row) return false;
  const state = JSON.parse(row.value) as { held: boolean };
  if (typeof state.held !== 'boolean') throw new Error('state');
  return state.held;
}

function backlog() {
  // A lane counts once. Finished reviews waiting for PR preparation/integration
  // stay downstream work; archived PR-only lanes have already left this queue.
  return getSqlite().prepare(`SELECT q.lane_id AS id, MAX(q.updated_at) AS updated_at,
    'review' AS stage, MIN(q.created_at) AS queued_at, l.id IS NULL AS missing_lane
    FROM review_queue q LEFT JOIN lanes l ON l.id = q.lane_id
    WHERE q.status IN ('pending', 'in_progress') GROUP BY q.lane_id
    UNION ALL
    SELECT l.id, l.updated_at, 'integration', NULL, 0 FROM lanes l
    WHERE l.status IN ('reviewing', 'merging') AND NOT EXISTS
      (SELECT 1 FROM review_queue q WHERE q.lane_id = l.id AND q.status IN ('pending', 'in_progress'))`)
    .all() as Array<{ id: string; updated_at: string; stage: 'review' | 'integration'; queued_at: string | null; missing_lane: number }>;

}

export function readReviewBackpressure() {
  const policy = reviewBackpressurePolicy();
  const base = { schema: 'o8/review-backpressure/v1' as const, ...policy, source: 'API server O8_REVIEW_BACKPRESSURE',
    reviewerLimit: REVIEW_CONCURRENCY_LIMIT, activeReviews: activeReviewClaimCount(),
    availableReviewCapacity: null, capacityStatus: 'unknown' as const,
    capacityReason: 'The slot limit is a ceiling; route and runtime capacity are checked by the existing reviewer launch path.' };
  if (!policy.enabled) return { ...base, state: 'disabled' as const, depth: null, reviewDepth: null, integrationDepth: null, oldestWaitMs: null, reason: null };
  try {
    if (!policy.valid) throw new Error('configuration');
    readReviewSchedulingService();
    const rows = backlog();
    if (rows.some(row => row.missing_lane)) throw new Error('orphaned review');
    const latched = readLatch();
    const held = rows.length > policy.high! || (latched && rows.length > policy.low!);
    const active = getSqlite().prepare("SELECT COUNT(*) AS count FROM review_queue WHERE status = 'in_progress'").get() as { count: number };
    const dates = rows.map(row => reviewQueueTime(row.queued_at ?? row.updated_at)).filter(Number.isFinite);
    return { ...base, activeReviews: active.count, localActiveReviews: activeReviewClaimCount(), state: held ? 'held' as const : 'open' as const, depth: rows.length,
      reviewDepth: rows.filter(row => row.stage === 'review').length,
      integrationDepth: rows.filter(row => row.stage === 'integration').length,
      oldestWaitMs: dates.length ? Math.max(0, Date.now() - Math.min(...dates)) : null,
      reason: held ? `${BACKPRESSURE_PREFIX} ${rows.length} review/integration lanes exceed the admission bound; new implementation waits until depth is at most ${policy.low} (high ${policy.high}).` : null };
  } catch {
    return { ...base, state: 'unknown' as const, depth: null, reviewDepth: null, integrationDepth: null, oldestWaitMs: null,
      reason: `${BACKPRESSURE_PREFIX} policy or backlog state is unreadable; operator inspection is required (configure integers 0 <= low < high <= 1000).` };
  }
}

/** Read and latch under one SQLite transaction, shared by concurrent coordinators.
 * The latch owns only admission, never packet queueState, Stop or lane claims. */
export function admitReviewBackpressure() {
  if (!reviewBackpressurePolicy().enabled) return readReviewBackpressure();
  return getSqlite().transaction(() => {
    const snapshot = readReviewBackpressure();
    if (snapshot.state === 'held' || snapshot.state === 'open') {
      getSqlite().prepare(`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(KEY, JSON.stringify({ held: snapshot.state === 'held', high: snapshot.high, low: snapshot.low, reason: snapshot.reason }), Date.now());
    }
    return snapshot;
  }).immediate();
}

export function isNewImplementation(packet: OrchestratorPacket) {
  return packet.status === 'queued' && packet.queueState === 'queued' && !packet.operatorStopped && !packet.archivedAt
    && !['reserved', 'committed', 'quarantined'].includes(packet.storageAdmission?.state ?? '')
    && packet.packetType !== 'decompose' && packet.launchContext?.workMode !== 'read-only'
    && !packet.lane?.laneId && !packet.lane?.sessionKey && !packet.reviewSource && !packet.repairSource;
}

/** Operator read projection. Policy facts come only from the effective read;
 * a human result is explanatory, never permission to publish or clear a hold. */
export async function reviewBackpressureStatus() {
  const snapshot = readReviewBackpressure();
  if (!snapshot.enabled) return snapshot;
  try {
    const { readEffectivePolicy } = await import('@/lib/lane/effective-policy-read');
    const rows = backlog();
    const waiting: Array<{ laneId: string; stage: string; nextAction: string; reason: string }> = [];
    // Status polling must not fan out one Git/policy read per backlog item.
    const sample = rows.sort((a, b) => reviewQueueTime(a.queued_at ?? a.updated_at) - reviewQueueTime(b.queued_at ?? b.updated_at)
      || a.id.localeCompare(b.id)).slice(0, 8);
    for (let i = 0; i < sample.length; i += 2) {
      waiting.push(...await Promise.all(sample.slice(i, i + 2).map(async row => {
        const policy = await readEffectivePolicy(row.id);
        return { laneId: row.id, stage: row.stage, nextAction: policy?.nextAction.value ?? 'human',
          reason: policy?.nextAction.reason ?? 'Lane policy is unavailable; operator inspection is required.' };
      })));
    }
    const accepted = getSqlite().prepare("SELECT COUNT(*) AS count FROM lanes WHERE outcome = 'merged'").get() as { count: number };
    const interventions = getSqlite().prepare("SELECT COUNT(*) AS count FROM lane_events WHERE actor = 'user' AND verb IN ('update', 'status_change') AND json_extract(payload_json, '$.eventLabel') IN ('interrupted', 'operator_stopped')").get() as { count: number };
    const queueWait = getSqlite().prepare(`SELECT COUNT(*) AS samples, AVG(json_extract(payload_json, '$.reviewScheduling.queueWaitMs')) AS meanMs
      FROM lane_events WHERE json_extract(payload_json, '$.reviewScheduling.queueWaitMs') IS NOT NULL`).get() as { samples: number; meanMs: number | null };
    return { ...snapshot, waiting, waitingTotal: rows.length, waitingTruncated: rows.length > sample.length,
      waitingPolicyPath: '/api/lanes/:id/policy', measurements: { acceptedCompletions: accepted.count, observedOperatorInterventions: interventions.count,
      interventionScope: 'Persisted user interrupted/operator_stopped status receipts only; other interventions are unmeasured.', queueWait } };
  } catch {
    return { ...snapshot, waiting: null, measurements: null, observationReason: 'Policy or measurement state is unreadable; operator inspection is required.' };
  }
}

export class ReviewBackpressureHeldError extends Error {}
export function assertReviewBackpressure(packet: OrchestratorPacket) {
  if (!isNewImplementation(packet)) return;
  const snapshot = admitReviewBackpressure();
  if (snapshot.reason) throw new ReviewBackpressureHeldError(snapshot.reason);
}

export function applyReviewBackpressure(packets: OrchestratorPacket[], pressure: ReturnType<typeof readReviewBackpressure>) {
  return packets.map(packet => {
    if (!isNewImplementation(packet)) return packet;
    if (pressure.reason) return { ...packet, blockedReason: pressure.reason, lastEventLabel: 'review_backpressure_held' };
    return packet.blockedReason?.startsWith(BACKPRESSURE_PREFIX) ? { ...packet, blockedReason: null } : packet;
  });
}
