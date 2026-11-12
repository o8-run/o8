import { listLanes } from '@/lib/lane/registry';

/** Match a PR recorded on a lane belonging to this packet. */
export function packetHasRecordedPr(packetId: string, prNumber: number, repoSlug?: string): boolean {
  return listLanes(new Set([packetId])).some(lane => {
    const match = lane.outcomeNote?.match(/^Pull request opened: https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)(?:$|\.)/);
    return Boolean(match && lane.prNumber === prNumber && Number(match[2]) === prNumber
      && (repoSlug === undefined || match[1].toLowerCase() === repoSlug.toLowerCase()));
  });
}

/**
 * A PR number recorded on one of this packet's lanes. Only server-side flows set
 * a lane's prNumber, so this binds an artifact to the packet's own PR even after
 * the opened note is replaced (merge settlement) or was never written (reaper).
 * Mirroring, which posts outside o8, keeps the stricter packetHasRecordedPr.
 */
export function packetOwnsPrNumber(packetId: string, prNumber: number): boolean {
  return listLanes(new Set([packetId])).some(lane => lane.prNumber === prNumber);
}
