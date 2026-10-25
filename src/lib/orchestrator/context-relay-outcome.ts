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
