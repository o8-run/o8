import { getSqlite } from '@/lib/db';
import { outcomeMemoryFingerprint } from '@/lib/cortex/outcome-identity';
import type { PacketContext } from '@/lib/orchestrator/types';
import type { RuntimeTranscriptEntry } from '@/lib/runtimes/types';

/** Stable across inventory refreshes and identical transcript re-captures. */
export function completionTimestamp(entries: RuntimeTranscriptEntry[], providerFinishedAt?: string, inventoryFinishedAt?: string | null): string {
  // A managed completion has durable provider-run provenance. Otherwise prefer
  // the persisted transcript over transient inventory that can disappear later.
  if (providerFinishedAt) return providerFinishedAt;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const timestamp = entries[index]?.timestamp;
    if (timestamp instanceof Date && !Number.isNaN(timestamp.getTime())) return timestamp.toISOString();
  }
  return inventoryFinishedAt ?? new Date().toISOString();
}

export function outcomeFromPacketSelfReview(
  selfReview: PacketContext['selfReview'],
): 'succeeded' | 'failed' | 'partial' {
  if (selfReview?.passed === true) {
    if (selfReview.decision === 'finding_ready') {
      const findingComplete = Boolean(selfReview.outcome?.trim())
        && Boolean(selfReview.evidence?.some((entry) => entry.trim()))
        && Boolean(selfReview.residual?.trim());
      return findingComplete ? 'succeeded' : 'partial';
    }
    return 'succeeded';
  }
  if (selfReview?.decision === 'blocked') {
    return 'failed';
  }
  return 'partial';
}

/** Content-changing ledger writes maintain the same fingerprint contract as capture. */
export function closeOutcomeRows(input: { laneId: string | null; packetId: string | null; outcome: string; summary: string; completedAt: string }): number {
  const db = getSqlite();
  return db.transaction(() => {
    const rows = db.prepare(`SELECT id, project_id AS projectId, repo_path AS repoPath,
      packet_id AS packetId, session_key AS sessionKey FROM session_outcomes
      WHERE (@laneId IS NOT NULL AND lane_id = @laneId) OR (@packetId IS NOT NULL AND packet_id = @packetId)`)
      .all({ laneId: input.laneId, packetId: input.packetId }) as Array<{
        id: string; projectId: string | null; repoPath: string; packetId: string | null; sessionKey: string | null;
      }>;
    const update = db.prepare(`UPDATE session_outcomes SET outcome = ?, summary = ?, memory_fingerprint = ?,
      completed_at = ?, merged_clean = 0 WHERE id = ?`);
    return rows.reduce((count, row) => count + update.run(input.outcome, input.summary,
      outcomeMemoryFingerprint({ ...row, summary: input.summary }), input.completedAt, row.id).changes, 0);
  })();
}
