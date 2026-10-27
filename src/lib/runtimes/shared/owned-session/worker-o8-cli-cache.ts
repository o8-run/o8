import { readFile, readdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pinWorkerCliFiles, ensureWorkerCliDirectory } from './worker-o8-cli-integrity';
import { workerO8CliOwner } from './worker-o8-cli-paths';

/** Existing code is reused in place only after a fresh build proves identical bytes. */
export function assertReusableWorkerCli(slot: string, candidate: string, entryName: string): ReturnType<typeof pinWorkerCliFiles> {
  const existing = pinWorkerCliFiles([path.join(slot, 'o8.mjs'), path.join(slot, entryName), path.join(slot, 'owner.json'), path.join(slot, 'verification.json')]);
  const fresh = pinWorkerCliFiles([path.join(candidate, 'o8.mjs'), path.join(candidate, entryName)]);
  if (existing.sha256[0] !== fresh.sha256[0] || existing.sha256[1] !== fresh.sha256[1]) {
    throw new Error('Previous CLI code remains in use and differs from this checkout.');
  }
  existing.assertCurrent(); fresh.assertCurrent();
  return existing;
}

export async function addWorkerCliReference(slot: string, surfaceId: string, runId: string, packetId: string): Promise<ReturnType<typeof pinWorkerCliFiles>> {
  const directory = path.join(slot, 'owners');
  ensureWorkerCliDirectory(directory);
  const file = path.join(directory, `${runId}.json`);
  await writeFile(file, JSON.stringify({ owner: workerO8CliOwner(surfaceId), runId, packetId }), { mode: 0o600, flag: 'wx' });
  return pinWorkerCliFiles([file]);
}

export async function workerCliReferences(slot: string, surfaceId: string): Promise<Array<{ runId: string; packetId: string; proof: ReturnType<typeof pinWorkerCliFiles> }>> {
  const names = (await readdir(path.join(slot, 'owners'))).filter(name => !name.endsWith('.stopped'));
  if (!names.length || names.length > 10_000) throw new Error('Unproved CLI owners.');
  return Promise.all(names.map(async name => {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) throw new Error('Invalid CLI owner.');
    const file = path.join(slot, 'owners', name); const proof = pinWorkerCliFiles([file]);
    const owner = JSON.parse(await readFile(file, 'utf8')) as { owner: string; runId: string; packetId: string };
    if (owner.owner !== workerO8CliOwner(surfaceId) || `${owner.runId}.json` !== name || typeof owner.packetId !== 'string') throw new Error('Changed CLI owner.');
    proof.assertCurrent();
    return { runId: owner.runId, packetId: owner.packetId, proof };
  }));
}

export async function removeUnstartedWorkerCli(slot: string, runId: string, proof: ReturnType<typeof pinWorkerCliFiles>): Promise<void> {
  proof.assertCurrent();
  const owners = await readdir(path.join(slot, 'owners'));
  if (owners.length === 1 && owners[0] === `${runId}.json`) await rm(slot, { recursive: true });
  else await rm(path.join(slot, 'owners', `${runId}.json`));
}
