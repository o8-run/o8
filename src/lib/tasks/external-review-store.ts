import { listLanes } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { listMissionRegistryEntries } from '@/lib/orchestrator/mission-registry';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { randomUUID, createHash } from 'node:crypto';
import { getSqlite } from '@/lib/db';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { ExternalReviewError } from './external-review-error';

export interface ExternalReviewRevision {
  id: string; taskId: string; sequence: number; predecessorId: string | null;
  headSha: string; baseSha: string; baseRef: string; intendedOutcome: string | null;
  packetId: string; adoptedAt: string; runEvidenceId: string | null; draft: boolean | null;
}
interface TaskRow { id: string; repo_id: string; repo_path: string; repository_id: string; pr_number: number; pr_url: string; current_revision_id: string | null }
interface RevisionRow {
  id: string; task_id: string; sequence: number; predecessor_id: string | null; head_sha: string; base_sha: string; base_ref: string;
  intended_outcome: string | null; packet_id: string; adopted_at: string; run_evidence_id: string | null; draft: number | null;
}
type ProjectionRow = TaskRow & Omit<RevisionRow, 'id'> & { revision_id: string | null };
export interface ExternalReviewTask {
  taskId: string; repoId: string; repoPath: string; repositoryId: string; pullRequest: number; url: string;
  revision: ExternalReviewRevision; state: 'waiting' | 'in_review' | 'sent_back' | 'approved';
}
interface ProjectionOptions {
  packets?: OrchestratorPacket[];
  lanes?: Lane[];
  historyPackets?: () => OrchestratorPacket[];
}
const joinedTasks = `SELECT t.*, r.id AS revision_id, r.task_id, r.sequence, r.predecessor_id, r.head_sha, r.base_sha, r.base_ref,
  r.intended_outcome, r.packet_id, r.adopted_at, r.run_evidence_id, r.draft
  FROM external_pr_review_tasks t LEFT JOIN external_pr_review_revisions r ON r.id = t.current_revision_id AND r.task_id = t.id`;
function projectRows(rows: ProjectionRow[], options: ProjectionOptions): ExternalReviewTask[] {
  if (!rows.length) return [];
  const packets = new Map((options.packets ?? readOrchestratorControlPlaneState().packets).map(packet => [packet.id, packet]));
  const lanePackets = new Set((options.lanes ?? listLanes()).map(lane => lane.packetId));
  let history: Map<string, OrchestratorPacket> | undefined;
  return rows.flatMap(row => {
    // A damaged pointer must not make every other task unavailable.
    if (!row.revision_id) return [];
    const revision: ExternalReviewRevision = { id: row.revision_id, taskId: row.id, sequence: row.sequence, predecessorId: row.predecessor_id,
      headSha: row.head_sha, baseSha: row.base_sha, baseRef: row.base_ref, intendedOutcome: row.intended_outcome,
      packetId: row.packet_id, adoptedAt: row.adopted_at, runEvidenceId: row.run_evidence_id, draft: row.draft === null ? null : row.draft === 1 };
    let packet = packets.get(revision.packetId);
    if (!packet) {
      history ??= new Map((options.historyPackets?.() ?? listMissionRegistryEntries({ includeArchived: true }).flatMap(entry => entry.mission.packets)).map(p => [p.id, p]));
      packet = history.get(revision.packetId);
    }
    const review = packet?.review?.reviewedHeadSha === revision.headSha ? packet.review : null;
    return [{ taskId: row.id, repoId: row.repo_id, repoPath: row.repo_path, repositoryId: row.repository_id,
      pullRequest: row.pr_number, url: row.pr_url, revision,
      state: review ? review.approved ? 'approved' as const : 'sent_back' as const : lanePackets.has(revision.packetId) ? 'in_review' as const : 'waiting' as const }];
  });
}
export function readExternalReview(id: string): ExternalReviewTask | null {
  const rows = getSqlite().prepare(`${joinedTasks} WHERE t.id = ?`).all(id) as ProjectionRow[];
  return projectRows(rows, {})[0] ?? null;
}
/** Bounded overview; direct task reads remain available outside the overview page. */
export function listExternalReviews(options: ProjectionOptions & { taskId?: string; limit?: number } = {}): ExternalReviewTask[] {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(100, Math.floor(options.limit!))) : 100;
  const rows = options.taskId
    ? getSqlite().prepare(`${joinedTasks} WHERE t.id = ? LIMIT 1`).all(options.taskId)
    : getSqlite().prepare(`${joinedTasks} ORDER BY t.rowid DESC LIMIT ?`).all(limit);
  return projectRows(rows as ProjectionRow[], options);
}
export function reserveExternalReview(input: { repoId: string; repoPath: string; repositoryId: string; pullRequest: number; url: string;
  headSha: string; baseSha: string; baseRef: string; intendedOutcome?: string | null; draft: boolean; expectedRevisionId: string | null }): ExternalReviewTask {
  const db = getSqlite();
  const id = db.transaction(() => {
    let row = db.prepare('SELECT * FROM external_pr_review_tasks WHERE repo_id = ? AND repository_id = ? AND pr_number = ?')
      .get(input.repoId, input.repositoryId, input.pullRequest) as TaskRow | undefined;
    const current = row?.current_revision_id ? db.prepare('SELECT * FROM external_pr_review_revisions WHERE id = ? AND task_id = ?').get(row.current_revision_id, row.id) as RevisionRow | undefined : undefined;
    const outcome = input.intendedOutcome === undefined && current?.head_sha === input.headSha ? current.intended_outcome : input.intendedOutcome ?? null;
    // A concurrent identical request can replay, but cannot move the pointer.
    if (current?.head_sha === input.headSha && current.base_sha === input.baseSha && current.base_ref === input.baseRef
      && current.intended_outcome === outcome && current.draft === Number(input.draft)) return row!.id;
    if ((row?.current_revision_id ?? null) !== input.expectedRevisionId || (row?.current_revision_id && !current)) {
      throw new ExternalReviewError('Review input changed during adoption. Re-adopt the PR.', 409);
    }
    if (!row) {
      const taskId = `external-pr-${randomUUID()}`;
      db.prepare('INSERT INTO external_pr_review_tasks (id, repo_id, repo_path, repository_id, pr_number, pr_url) VALUES (?, ?, ?, ?, ?, ?)')
        .run(taskId, input.repoId, input.repoPath, input.repositoryId, input.pullRequest, input.url);
      row = { id: taskId, current_revision_id: null } as TaskRow;
    }
    const revision = randomUUID();
    const packetId = `pkt-pr-review-${createHash('sha256').update(revision).digest('hex').slice(0, 16)}`;
    db.prepare(`INSERT INTO external_pr_review_revisions (id, task_id, sequence, predecessor_id, head_sha, base_sha, base_ref, intended_outcome, packet_id, adopted_at, draft)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(revision, row.id, Number(current?.sequence ?? 0) + 1, row.current_revision_id,
      input.headSha, input.baseSha, input.baseRef, outcome, packetId, new Date().toISOString(), Number(input.draft));
    db.prepare('UPDATE external_pr_review_tasks SET current_revision_id = ? WHERE id = ?').run(revision, row.id);
    return row.id;
  }).immediate();
  return readExternalReview(id)!;
}
