import { readReviewSchedulingService, REVIEW_SCHEDULING_KEY } from './review-scheduling-state';
import { reviewQueueTime } from './review-queue-time';
import { getSqlite } from '@/lib/db';
import { listMissionRegistryEntries } from '@/lib/orchestrator/mission-registry';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { reviewBackpressurePolicy } from '@/lib/orchestrator/review-backpressure';
import { REVIEW_CONCURRENCY_LIMIT } from './review-concurrency';
import { recordLaneEvent } from './events';

const AGING_MS = 5 * 60_000;
interface Candidate { id: string; lane_id: string; project: string; packet_id: string | null; created_at: string; updated_at: string }

/** Runs inside claimNextReview's transaction. Round-robin across projects;
 * within a project, five-minute aging outranks dependency-unblocking priority.
 * Retried work ages from its last attempt, so it cannot monopolize a project. */
export function nextFairReview(): string | null | undefined {
  const policy = reviewBackpressurePolicy();
  if (!policy.enabled) return undefined; // preserve the existing default
  if (!policy.valid) return null;
  const db = getSqlite();
  const active = db.prepare("SELECT COUNT(*) AS count FROM review_queue WHERE status = 'in_progress'").get() as { count: number };
  if (active.count >= REVIEW_CONCURRENCY_LIMIT) return null;
  const rows = db.prepare(`SELECT q.id, q.lane_id, q.created_at, q.updated_at, l.packet_id,
    COALESCE(l.project_id, l.repo_path) AS project FROM review_queue q JOIN lanes l ON l.id = q.lane_id
    WHERE q.status = 'pending' AND l.status = 'reviewing'
    AND NOT EXISTS (SELECT 1 FROM review_queue live WHERE live.lane_id = q.lane_id AND live.status = 'in_progress')`).all() as Candidate[];
  if (!rows.length) return null;
  const service = readReviewSchedulingService();
  const packets = [...listMissionRegistryEntries({ strict: true }).flatMap(entry => entry.mission.packets), ...readOrchestratorControlPlaneState().packets];
  const unblocks = (row: Candidate) => new Set(packets.filter(p => !p.operatorStopped && !p.archivedAt && p.releaseState !== 'released'
    && p.dependencyPacketIds.includes(row.packet_id ?? '')).map(p => p.id)).size;
  const now = Date.now();
  const wait = (row: Candidate) => now - reviewQueueTime(row.updated_at);
  rows.sort((a, b) => (service.projects[a.project] ?? 0) - (service.projects[b.project] ?? 0)
    || a.project.localeCompare(b.project));
  const project = rows[0]?.project;
  const candidates = rows.filter(row => row.project === project);
  candidates.sort((a, b) => Number(wait(b) >= AGING_MS) - Number(wait(a) >= AGING_MS)
    || (wait(a) >= AGING_MS && wait(b) >= AGING_MS ? wait(b) - wait(a) : unblocks(b) - unblocks(a))
    || wait(b) - wait(a) || reviewQueueTime(a.created_at) - reviewQueueTime(b.created_at) || a.id.localeCompare(b.id));
  return candidates[0]?.id ?? null;
}

export function recordFairReviewClaim(review: { id: string; lane_id: string; updated_at?: string }) {
  if (!reviewBackpressurePolicy().enabled) return;
  const db = getSqlite();
  const row = db.prepare(`SELECT COALESCE(l.project_id, l.repo_path) AS project, q.created_at FROM lanes l
    JOIN review_queue q ON q.lane_id = l.id WHERE q.id = ?`).get(review.id) as { project: string; created_at: string };
  const service = readReviewSchedulingService();
  service.sequence++;
  service.projects[row.project] = service.sequence;
  // Retain only projects with queued/active work, bounding the cursor by the queue.
  const projects = db.prepare(`SELECT DISTINCT COALESCE(l.project_id, l.repo_path) AS project FROM review_queue q
    JOIN lanes l ON l.id = q.lane_id WHERE q.status IN ('pending', 'in_progress')`).all() as Array<{ project: string }>;
  service.projects = Object.fromEntries(projects.map(p => [p.project, service.projects[p.project] ?? 0]));
  db.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(REVIEW_SCHEDULING_KEY, JSON.stringify(service), Date.now());
  const queueWaitMs = Date.now() - reviewQueueTime(review.updated_at ?? row.created_at);
  recordLaneEvent(review.lane_id, 'update', 'system', { reviewScheduling: {
    reviewId: review.id, sequence: service.sequence, queueWaitMs: Number.isFinite(queueWaitMs) ? Math.max(0, queueWaitMs) : null,
    reason: 'Project round-robin; five-minute aging, then dependency-unblocking priority, then queue order.' } });
}
