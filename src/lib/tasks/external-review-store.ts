import { randomUUID, createHash } from 'node:crypto';
import { getSqlite } from '@/lib/db';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';

export interface ExternalReviewRevision {
  id: string; taskId: string; sequence: number; predecessorId: string | null;
  headSha: string; baseSha: string; baseRef: string; intendedOutcome: string | null;
  packetId: string; adoptedAt: string; runEvidenceId: string | null;
}
interface TaskRow { id: string; repo_id: string; repo_path: string; repository_id: string; pr_number: number; pr_url: string; current_revision_id: string }
export interface ExternalReviewTask {
  taskId: string; repoId: string; repoPath: string; repositoryId: string; pullRequest: number; url: string;
  revision: ExternalReviewRevision; state: 'waiting' | 'in_review' | 'sent_back' | 'approved';
}
function project(row: TaskRow): ExternalReviewTask {
  const r = getSqlite().prepare('SELECT * FROM external_pr_review_revisions WHERE id = ?').get(row.current_revision_id) as Record<string, string | number | null>;
  const revision: ExternalReviewRevision = { id: String(r.id), taskId: row.id, sequence: Number(r.sequence), predecessorId: r.predecessor_id as string | null,
    headSha: String(r.head_sha), baseSha: String(r.base_sha), baseRef: String(r.base_ref), intendedOutcome: r.intended_outcome as string | null,
    packetId: String(r.packet_id), adoptedAt: String(r.adopted_at), runEvidenceId: r.run_evidence_id as string | null };
  const packet = readOrchestratorControlPlaneState().packets.find(p => p.id === revision.packetId);
  const review = packet?.review?.reviewedHeadSha === revision.headSha ? packet.review : null;
  return { taskId: row.id, repoId: row.repo_id, repoPath: row.repo_path, repositoryId: row.repository_id,
    pullRequest: row.pr_number, url: row.pr_url, revision,
    state: review ? review.approved ? 'approved' : 'sent_back' : packet?.lane ? 'in_review' : 'waiting' };
}
export function readExternalReview(id: string): ExternalReviewTask | null {
  const row = getSqlite().prepare('SELECT * FROM external_pr_review_tasks WHERE id = ?').get(id) as TaskRow | undefined;
  return row ? project(row) : null;
}
export function listExternalReviews(): ExternalReviewTask[] {
  return (getSqlite().prepare('SELECT * FROM external_pr_review_tasks ORDER BY rowid DESC').all() as TaskRow[]).map(project);
}
export function reserveExternalReview(input: { repoId: string; repoPath: string; repositoryId: string; pullRequest: number; url: string;
  headSha: string; baseSha: string; baseRef: string; intendedOutcome: string | null }): ExternalReviewTask {
  const db = getSqlite();
  const id = db.transaction(() => {
    let row = db.prepare('SELECT * FROM external_pr_review_tasks WHERE repo_id = ? AND repository_id = ? AND pr_number = ?')
      .get(input.repoId, input.repositoryId, input.pullRequest) as TaskRow | undefined;
    if (!row) {
      const taskId = `external-pr-${randomUUID()}`;
      db.prepare('INSERT INTO external_pr_review_tasks (id, repo_id, repo_path, repository_id, pr_number, pr_url) VALUES (?, ?, ?, ?, ?, ?)')
        .run(taskId, input.repoId, input.repoPath, input.repositoryId, input.pullRequest, input.url);
      row = { id: taskId } as TaskRow;
    }
    const current = row.current_revision_id ? db.prepare('SELECT * FROM external_pr_review_revisions WHERE id = ?').get(row.current_revision_id) as Record<string, unknown> : undefined;
    if (current?.head_sha === input.headSha && current.base_sha === input.baseSha && current.base_ref === input.baseRef && current.intended_outcome === input.intendedOutcome) return row.id;
    const revision = randomUUID();
    const packetId = `pkt-delegate-${createHash('sha256').update(revision).digest('hex').slice(0, 16)}`;
    db.prepare(`INSERT INTO external_pr_review_revisions (id, task_id, sequence, predecessor_id, head_sha, base_sha, base_ref, intended_outcome, packet_id, adopted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(revision, row.id, Number(current?.sequence ?? 0) + 1, row.current_revision_id ?? null,
      input.headSha, input.baseSha, input.baseRef, input.intendedOutcome, packetId, new Date().toISOString());
    db.prepare('UPDATE external_pr_review_tasks SET current_revision_id = ? WHERE id = ?').run(revision, row.id);
    return row.id;
  }).immediate();
  return readExternalReview(id)!;
}
