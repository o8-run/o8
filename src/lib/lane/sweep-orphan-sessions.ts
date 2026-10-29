import { listActiveLanes } from '@/lib/lane/registry';
import { listRunningSharedCheckoutSurfaceIds } from '@/lib/orchestrator/shared-checkout-team';

/**
 * #1292 — on startup, archive owned-session dirs that are NOT bound to an active
 * lane (orphans). Fleet discovery (`computeFleetAdditions`) has no retirement
 * gate, so an orphaned session dir re-spawns a phantom lane on every launch — the
 * "multiply". `reset` already archives its OWN session dir (the dominant root);
 * this is the self-healing belt-and-suspenders for orphans from OTHER paths
 * (supervisor relaunch, crashes, force-quits). Each store guards internally:
 * skips active-lane sessions, sessions with a live run, and dirs active within
 * the in-flight window. Fire-and-forget on startup; best-effort.
 */
const IN_FLIGHT_GUARD_MS = 10 * 60 * 1000; // don't touch a dir active in the last 10 min

export async function sweepOrphanedOwnedSessions(): Promise<number> {
  try {
    const activeSurfaceIds = new Set(
      listActiveLanes()
        .map((lane) => lane.sessionKey?.trim())
        .filter((key): key is string => Boolean(key)),
    );
    // Workers a chat launched into its shared checkout have no lane; never stop their live runs.
    const chatOwnedSurfaceIds = listRunningSharedCheckoutSurfaceIds();

    const sweeps: Array<Promise<number>> = [];
    try {
      const { sweepOrphanedCodexSessions } = await import('@/lib/codex/owned');
      sweeps.push(sweepOrphanedCodexSessions(activeSurfaceIds, IN_FLIGHT_GUARD_MS, chatOwnedSurfaceIds));
    } catch { /* runtime module unavailable — skip */ }
    try {
      const { sweepOrphanedClaudeCodeSessions } = await import('@/lib/claude-code/owned');
      sweeps.push(sweepOrphanedClaudeCodeSessions(activeSurfaceIds, IN_FLIGHT_GUARD_MS, chatOwnedSurfaceIds));
    } catch { /* runtime module unavailable — skip */ }
    try {
      const { sweepOrphanedGeminiSessions } = await import('@/lib/gemini/owned');
      sweeps.push(sweepOrphanedGeminiSessions(activeSurfaceIds, IN_FLIGHT_GUARD_MS, chatOwnedSurfaceIds));
    } catch { /* skip */ }
    try {
      const { sweepOrphanedOpencodeSessions } = await import('@/lib/opencode/owned');
      sweeps.push(sweepOrphanedOpencodeSessions(activeSurfaceIds, IN_FLIGHT_GUARD_MS));
    } catch { /* skip */ }

    const total = (await Promise.all(sweeps)).reduce((sum, n) => sum + n, 0);
    if (total > 0) {
      console.log(`[sweep-orphan-sessions] archived ${total} orphaned owned-session dir(s) on startup (#1292)`);
    }
    return total;
  } catch (err) {
    console.warn('[sweep-orphan-sessions] failed:', err instanceof Error ? err.message : err);
    return 0;
  }
}
