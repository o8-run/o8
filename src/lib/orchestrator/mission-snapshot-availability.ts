import { normalizeReviewerPrSource } from './reviewer-pr-source-types';

/** Safety reads must distinguish an empty mission from a lost packet snapshot. */
export function assertMissionSnapshotAvailable(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Array.isArray((value as { packets?: unknown }).packets)) throw new Error('Stored packet snapshot is unavailable.');
  const seen = new Set<string>();
  for (const packet of (value as { packets: unknown[] }).packets) {
    if (!packet || typeof packet !== 'object' || Array.isArray(packet)) throw new Error('Stored packet snapshot is unavailable.');
    const p = packet as Record<string, unknown>;
    if (typeof p.id !== 'string' || !p.id.trim() || seen.has(p.id.trim())
      || typeof p.branchTarget !== 'string'
      || (p.workspaceTargetPath != null && typeof p.workspaceTargetPath !== 'string')
      || (p.mergeHold !== undefined && typeof p.mergeHold !== 'boolean')) throw new Error('Stored packet snapshot is unavailable.');
    for (const source of [p.reviewSource, p.repairSource]) if (source != null && !normalizeReviewerPrSource(source)) throw new Error('Stored PR source is unavailable.');
    seen.add(p.id.trim());
  }
}
