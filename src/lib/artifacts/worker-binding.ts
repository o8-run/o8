import { listLanes } from '@/lib/lane/registry';

/** Match a PR recorded on a lane belonging to this packet. */
export function packetHasRecordedPr(packetId: string, prNumber: number, repoSlug?: string): boolean {
  return listLanes(new Set([packetId])).some(lane => {
    const match = lane.outcomeNote?.match(/^Pull request opened: https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)(?:$|\.)/);
    return Boolean(match && lane.prNumber === prNumber && Number(match[2]) === prNumber
      && (repoSlug === undefined || match[1].toLowerCase() === repoSlug.toLowerCase()));
  });
}
