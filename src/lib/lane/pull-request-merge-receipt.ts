import { createHash } from 'node:crypto';
import { getSqlite } from '@/lib/db';
import { readMergeActorEvidence } from '@/lib/github-broker/merge-actor-evidence';
import type { GitHubPullRequestSnapshot } from '@/lib/github-broker/store';
import type { ApprovalAuditEvent } from '@/lib/approvals/types';
import type { Lane } from './types';

/** Called only by merged-pull reconciliation, before release/archival decisions. */
export async function recordPullRequestMergeReceipt(lane: Lane, pull: GitHubPullRequestSnapshot): Promise<void> {
  if (!pull.mergedAt || !Number.isFinite(Date.parse(pull.mergedAt))) return;
  const db = getSqlite();
  const id = `pr-merge-${createHash('sha256').update(JSON.stringify([lane.id, pull.repoFullName.toLowerCase(), pull.number])).digest('hex')}`;
  if (db.prepare('SELECT 1 FROM lane_events WHERE id=?').get(id)) return;
  const reviews = (db.prepare(`SELECT id,audit_json,args_json FROM approvals WHERE tool_name='orchestrator_review'
    AND (lane_id=? OR (? IS NOT NULL AND packet_id=?))`).all(lane.id, lane.packetId, lane.packetId) as Array<{ id: string; audit_json: string; args_json: string | null }>).flatMap(row => {
    try {
      if (JSON.parse(row.args_json ?? '{}').reviewTurnOutcome !== 'completed') return [];
      const audit = JSON.parse(row.audit_json) as ApprovalAuditEvent[];
      return audit.filter(event => event.type === 'orchestrator_review' && !event.parseWarning
        && typeof event.approved === 'boolean' && event.timestamp <= Date.parse(pull.mergedAt!))
        .map(event => ({ ...event, approvalId: row.id }));
    } catch { return []; }
  }).sort((a, b) => a.timestamp - b.timestamp);
  const verdict = reviews.at(-1);
  const evidence = await readMergeActorEvidence(pull, verdict?.timestamp ?? null);
  const payload = { repoFullName: pull.repoFullName, prNumber: pull.number,
    reviewedHeadSha: verdict?.reviewedHeadSha ?? null, approvalId: verdict?.approvalId ?? null,
    mergedHeadSha: pull.headSha ?? null, mergeSha: pull.mergeCommit ?? null, mergedAt: pull.mergedAt,
    observedAt: new Date().toISOString(), humanIntervention: evidence.humanIntervention,
    actorEvidence: evidence };
  // A concurrent observer or restart cannot duplicate or rewrite the evidence.
  db.prepare(`INSERT INTO lane_events (id,lane_id,verb,actor,payload_json,timestamp)
    VALUES (?,?,'pull_request_merged','system',?,?) ON CONFLICT(id) DO NOTHING`)
    .run(id, lane.id, JSON.stringify(payload), pull.mergedAt);
}
