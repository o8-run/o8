import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { readActiveSharedCheckoutTeam, settleSharedCheckoutTeam, type SharedCheckoutTeam } from './shared-checkout-team';
import { registerSharedWorkerParent } from './shared-worker-returns';
import { resolveChatTurnOrigin } from './review-continuation-origin';
import type { WorkerLaunchContext } from './types';

/** Startup and the existing supervisor heartbeat share the same owned-index repair. */
export async function settleSharedCheckoutTeams(dataDir = getDataDir()): Promise<void> {
  const directory = join(dataDir, 'shared-checkout-teams');
  let files: string[];
  try { files = readdirSync(directory).filter(file => /^[a-f0-9]{24}\.json$/.test(file)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const file of files) {
    try {
      const team = JSON.parse(readFileSync(join(directory, file), 'utf8')) as SharedCheckoutTeam;
      await settleSharedCheckoutTeam({ repoPath: team.path, parentThreadId: team.parentThreadId, dataDir });
    } catch {
      // Preserve uncertain ownership and continue repairing independent teams.
      console.warn('[shared-checkout] Membership repair held:', file);
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
