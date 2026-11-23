import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { readActiveSharedCheckoutTeam, settleSharedCheckoutTeam, type SharedCheckoutTeam } from './shared-checkout-team';
import { registerSharedWorkerParent } from './shared-worker-returns';
import { resolveChatTurnOrigin } from './review-continuation-origin';
import type { WorkerLaunchContext } from './types';

const HELD_RETRY_MIN_MS = 60_000;
const HELD_RETRY_MAX_MS = 30 * 60_000;
/** A held repair waits for its receipt or lock to change, or for its backoff. */
const heldRepairs = new Map<string, { stamp: string; reason: string; retryAt: number; delayMs: number }>();

/** Test seam: the held repairs and when each retries. */
export function heldSharedCheckoutRepairs(): Array<{ file: string; reason: string; retryAt: number; delayMs: number }> {
  return [...heldRepairs].map(([file, held]) => ({ file, reason: held.reason, retryAt: held.retryAt, delayMs: held.delayMs }));
}

function pathStamp(path: string): string {
  try { const stat = statSync(path); return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
  catch { return '-'; }
}

/**
 * A settled repair reads only its team receipt, its lock and the owned
 * session records. While none of them changed it is skipped: each repair
 * reads every live and archived session record (about 90 ms with 400 of them),
 * and the heartbeat runs every 5 s. A member still inside its launch grace
 * window is rechecked when that window ends.
 */
const settledRepairs = new Map<string, { stamp: string; recheckAt: number }>();
const LAUNCH_GRACE_MS = 15 * 60_000;
const TERMINAL_MEMBER_STATES = new Set(['failed', 'interrupted', 'completed', 'exited', 'settled', 'lost']);

/** Live roots change in place; an archived record changes only by moving in or out. */
async function ownedEvidenceStamp(): Promise<string> {
  const { ownedRoots } = await import('@/lib/runtimes/shared/owned-session-index');
  const { archiveRootForOwnedSessionRoot } = await import('@/lib/runtimes/shared/owned-session/archive');
  const parts: string[] = [];
  for (const { root } of ownedRoots()) {
    parts.push(pathStamp(root), pathStamp(archiveRootForOwnedSessionRoot(root)));
    let entries: string[] = [];
    try { entries = readdirSync(root).sort(); } catch { /* absent root: its stamp says so */ }
    for (const entry of entries) parts.push(`${entry}=${pathStamp(join(root, entry, 'session.json'))}`);
  }
  return parts.join(',');
}

function graceRecheckAt(team: SharedCheckoutTeam, at0: number): number {
  let at = Infinity;
  for (const member of team.members) {
    if (TERMINAL_MEMBER_STATES.has(member.state)) continue;
    const ends = Date.parse(member.launchedAt) + LAUNCH_GRACE_MS;
    if (Number.isFinite(ends) && ends > at0) at = Math.min(at, ends);
  }
  return at;
}

/** Startup and the existing supervisor heartbeat share the same owned-index repair. */
export async function settleSharedCheckoutTeams(dataDir = getDataDir(), now = Date.now): Promise<void> {
  const directory = join(dataDir, 'shared-checkout-teams');
  let files: string[];
  try { files = readdirSync(directory).filter(file => /^[a-f0-9]{24}\.json$/.test(file)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const repairs of [heldRepairs, settledRepairs]) {
    for (const key of repairs.keys()) {
      if (!key.startsWith(`${directory}/`) || !files.includes(key.slice(directory.length + 1))) repairs.delete(key);
    }
  }
  // Read before the repairs, so a change made while they run is seen next time.
  const evidence = files.length ? await ownedEvidenceStamp() : '';
  for (const file of files) {
    const key = join(directory, file);
    // A stale lock or unreadable liveness holds the repair until someone acts on it.
    // Retrying every heartbeat (5 s) changed nothing and logged 12 lines a minute.
    const stamp = `${pathStamp(key)}|${pathStamp(key.replace(/\.json$/, '.lock'))}`;
    const held = heldRepairs.get(key);
    if (held && held.stamp === stamp && now() < held.retryAt) continue;
    const settled = settledRepairs.get(key);
    if (settled && settled.stamp === `${stamp}|${evidence}` && now() < settled.recheckAt) continue;
    try {
      const team = JSON.parse(readFileSync(key, 'utf8')) as SharedCheckoutTeam;
      await settleSharedCheckoutTeam({ repoPath: team.path, parentThreadId: team.parentThreadId, dataDir });
      heldRepairs.delete(key);
      // The repair may rewrite the receipt; the next heartbeat repeats once and then settles.
      settledRepairs.set(key, { stamp: `${stamp}|${evidence}`, recheckAt: graceRecheckAt(team, now()) });
    } catch (error) {
      settledRepairs.delete(key);
      // Preserve uncertain ownership and continue repairing independent teams.
      const reason = error instanceof Error ? error.message : String(error);
      if (held?.reason !== reason) console.warn('[shared-checkout] Membership repair held:', file, reason);
      const delayMs = held?.stamp === stamp ? Math.min(held.delayMs * 2, HELD_RETRY_MAX_MS) : HELD_RETRY_MIN_MS;
      heldRepairs.set(key, { stamp, reason, retryAt: now() + delayMs, delayMs });
    }
  }
}

export function sharedWorkerLaunchContext(repoPath: string, surfaceId: string): WorkerLaunchContext | undefined {
  try {
    const team = readActiveSharedCheckoutTeam(repoPath);
    if (!team?.members.some(member => member.surfaceId === surfaceId)) return;
    return { source: 'agent', caller: 'orchestrator', presentation: 'split',
      repoContext: 'transient', checkoutMode: 'shared', parentThreadId: team.parentThreadId };
  } catch { return; }
}

/** Repair a crash between saving membership and saving its delivery binding. */
export function recoverSharedWorkerParentBindings(): void {
  const directory = join(getDataDir(), 'shared-checkout-teams');
  let files: string[];
  try { files = readdirSync(directory).filter(file => /^[a-f0-9]{24}\.json$/.test(file)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const file of files) {
    try {
      const team = JSON.parse(readFileSync(join(directory, file), 'utf8')) as SharedCheckoutTeam;
      for (const member of team.members) {
        if (!member.surfaceId || !member.parentTurnId) continue;
        const resolved = resolveChatTurnOrigin({ repoPath: team.path, threadId: team.parentThreadId, turnId: member.parentTurnId });
        if (resolved.kind === 'bound' && resolved.origin.permissionMode) {
          registerSharedWorkerParent({ repoPath: team.path, surfaceId: member.surfaceId, origin: resolved.origin });
        }
      }
    } catch (error) {
      // Preserve the conflicting receipt; one invalid team cannot prevent other
      // exact parents from recovering or the control plane from starting.
      console.warn('[worker-return] Parent recovery held:', file, error);
    }
  }
}
