import { getLane } from '@/lib/lane/registry';
import type { ManagedRunRecord } from './types';

/** Optional telemetry must not fail a run transition or infer packet authority from cwd. */
export function managedRunRepoPath(run: ManagedRunRecord): string | null {
  try {
    const lane = run.laneId ? getLane(run.laneId) : null;
    if (lane) return lane.repoPath;
  } catch {
    // Missing lane storage leaves the event unattributed.
    return null;
  }
  return run.laneId || run.packetId ? null : run.cwd;
}
