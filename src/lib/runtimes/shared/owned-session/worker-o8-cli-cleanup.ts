import { readFile, rm, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getSqlite } from '@/lib/db';
import { withOwnedArtifactRootLock } from './artifact-admission';
import { pinWorkerCliFiles } from './worker-o8-cli-integrity';
import { workerO8CliOwner, workerO8CliRoot, workerO8CliSlot } from './worker-o8-cli-paths';
import { workerCliReferences } from './worker-o8-cli-cache';
import { probeOwnedRunMarker } from './run-process-proof';
import type { OwnedSessionRecord } from './types';

async function ownerIsClear(slot: string, packetId: string, runId: string, platform: NodeJS.Platform): Promise<boolean> {
  // Temporary session metadata cannot supply process or termination authority.
  const lease = getSqlite().prepare(`SELECT lease_process_pid AS pid, lease_process_group_id AS pgid
    FROM worker_tokens WHERE scope = 'local-packet' AND packet_id = ? AND lease_process_marker = ? LIMIT 1`)
    .get(packetId, runId) as { pid: number | null; pgid: number | null } | undefined;
  if (!lease?.pid) return false;
  if (platform === 'win32') {
    try {
      const file = path.join(slot, 'owners', `${runId}.stopped`); const proof = pinWorkerCliFiles([file]);
      const receipt = JSON.parse(await readFile(file, 'utf8')) as { pid: number; runId: string };
      proof.assertCurrent(); return receipt.pid === lease.pid && receipt.runId === runId;
    } catch { return false; }
  }
  if (!lease.pgid) return false;
  try { process.kill(-lease.pgid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
  return await probeOwnedRunMarker(runId) === 'clear';
}

/** Called only after the owned Stop boundary confirms the complete tree dead. */
export async function recordWorkerO8CliStop(root: string, session: OwnedSessionRecord, runId: string, pid: number): Promise<void> {
  return withOwnedArtifactRootLock(root, async () => {
    const slot = workerO8CliSlot(session.surfaceId);
    const reference = (await workerCliReferences(slot, session.surfaceId)).find(owner => owner.runId === runId);
    if (!reference) return;
    reference.proof.assertCurrent();
    await writeFile(path.join(slot, 'owners', `${runId}.stopped`), JSON.stringify({ pid, runId }), { mode: 0o600, flag: 'wx' });
  });
}

/** Unknown owners remain accounted; cleanup never requires free budget. */
export async function cleanupWorkerO8Cli(root: string, session: OwnedSessionRecord, expectedRunId?: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  return withOwnedArtifactRootLock(root, async () => {
    const slot = workerO8CliSlot(session.surfaceId); let cleared = true;
    const remove = async (directory: string, legacyRunId?: string) => {
      if (!await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) return;
      try {
        const marker = path.join(directory, legacyRunId ? 'verification.json' : 'owner.json');
        const proof = pinWorkerCliFiles([marker]);
        const owner = JSON.parse(await readFile(marker, 'utf8')) as { owner?: string; verified?: boolean };
        if (legacyRunId ? owner.verified !== true : owner.owner !== workerO8CliOwner(session.surfaceId)) { cleared = false; return; }
        const references = legacyRunId ? [{ runId: legacyRunId, packetId: session.packetId!, proof }]
          : await workerCliReferences(directory, session.surfaceId);
        if ((expectedRunId && !references.some(ref => ref.runId === expectedRunId))
          || !(await Promise.all(references.map(ref => ownerIsClear(directory, ref.packetId, ref.runId, platform)))).every(Boolean)) { cleared = false; return; }
        proof.assertCurrent(); for (const ref of references) ref.proof.assertCurrent();
        await rm(directory, { recursive: true });
      } catch { cleared = false; }
    };
    await remove(slot);
    for (const run of session.recentRuns) {
      if (!/^[a-zA-Z0-9_-]+$/.test(run.id) || (expectedRunId && expectedRunId !== run.id)) continue;
      await remove(path.join(workerO8CliRoot(), run.id), run.id);
    }
    return cleared;
  });
}
