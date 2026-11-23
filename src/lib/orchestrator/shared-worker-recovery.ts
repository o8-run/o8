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
  try { const stat = statSync(path); return `${stat.ino}:${stat.size}:${stat.mtimeMs}`; }
  catch { return '-'; }
}

/** Startup and the existing supervisor heartbeat share the same owned-index repair. */
export async function settleSharedCheckoutTeams(dataDir = getDataDir(), now = Date.now): Promise<void> {
  const directory = join(dataDir, 'shared-checkout-teams');
  let files: string[];
  try { files = readdirSync(directory).filter(file => /^[a-f0-9]{24}\.json$/.test(file)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const key of heldRepairs.keys()) {
    if (!key.startsWith(`${directory}/`) || !files.includes(key.slice(directory.length + 1))) heldRepairs.delete(key);
  }
  for (const file of files) {
    const key = join(directory, file);
    // A stale lock or unreadable liveness holds the repair until someone acts on it.
    // Retrying every heartbeat (5 s) changed nothing and logged 12 lines a minute.
    const stamp = `${pathStamp(key)}|${pathStamp(key.replace(/\.json$/, '.lock'))}`;
    const held = heldRepairs.get(key);
    if (held && held.stamp === stamp && now() < held.retryAt) continue;
    try {
      const team = JSON.parse(readFileSync(key, 'utf8')) as SharedCheckoutTeam;
      await settleSharedCheckoutTeam({ repoPath: team.path, parentThreadId: team.parentThreadId, dataDir });
      heldRepairs.delete(key);
    } catch (error) {
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
