import type { OrchestratorRuntime } from '@/lib/orchestrator/types';

// #2048 — the headless loop is a long-lived process that re-runs the recovery
// gate every tick (10s). A packet blocked on a condition only the operator can
// clear ("runtime is not pinned") is re-evaluated forever, and logging every
// evaluation flooded serve.log with 38,008 identical lines in 27 hours. Remember
// the last blocker we PRINTED per packet, fingerprinted by reason + pinned
// runtime: the same reason under the same runtime stays silent, and a changed
// runtime (or a different blocker) prints once more.
//
// The headless tick dispatches the current mission and then each registry
// mission, and each pass pruned the memo to its own packets, so every full
// tick forgot the other missions' skips and printed them again. Entries now
// carry the mission that logged them and are pruned only by that mission.
const loggedRecoverySkips = new Map<string, { fingerprint: string; missionId: string }>();
const MAX_REMEMBERED_SKIPS = 2_000;

function recoverySkipFingerprint(reason: string, pinnedRuntime: OrchestratorRuntime | null): string {
  return `${reason}::${pinnedRuntime ?? 'unpinned'}`;
}

/** True the first time this packet is skipped for this reason+runtime pair. */
export function shouldLogRecoverySkip(
  packetId: string,
  reason: string,
  pinnedRuntime: OrchestratorRuntime | null,
  missionId = '',
): boolean {
  const fingerprint = recoverySkipFingerprint(reason, pinnedRuntime);
  if (loggedRecoverySkips.get(packetId)?.fingerprint === fingerprint) return false;
  loggedRecoverySkips.delete(packetId);
  loggedRecoverySkips.set(packetId, { fingerprint, missionId });
  // A mission that is gone never prunes its own entries; drop the oldest.
  if (loggedRecoverySkips.size > MAX_REMEMBERED_SKIPS) {
    loggedRecoverySkips.delete(loggedRecoverySkips.keys().next().value!);
  }
  return true;
}

/** Forget a packet's memoized skip so its next block logs again. */
export function forgetRecoverySkip(packetId: string): void {
  loggedRecoverySkips.delete(packetId);
}

/** Test seam — drop every memoized skip. */
export function resetRecoverySkipMemo(): void {
  loggedRecoverySkips.clear();
}

/** Keep one mission's memo bounded by its live packet set — a daemon runs for weeks. */
export function pruneRecoverySkipMemo(livePacketIds: Set<string>, missionId = ''): void {
  for (const [packetId, entry] of loggedRecoverySkips) {
    if (entry.missionId === missionId && !livePacketIds.has(packetId)) loggedRecoverySkips.delete(packetId);
  }
}
