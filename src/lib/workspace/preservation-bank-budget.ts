import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import { getSqlite } from '@/lib/db';
import { withPacketLifecycleMutationLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { assertWorktreeMaterializationIdentity, captureWorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { readExactChildFile, retireExactChildFile, writeExactChildFile } from './exact-parent-operation';

// Admission only: never expire or remove recovery evidence. A conservative full
// capture reservation includes source, packed verifier, publication copy,
// manifest and filesystem overhead. Small captures release unused capacity.
export const PRESERVATION_BANK_POLICY = {
  maxBytes: 4 * 1024 ** 3,
  maxEntries: 10_000,
  captureBytes: 2 * 1024 ** 3,
  captureEntries: 128,
  bundleBytes: 512 * 1024 ** 2,
  manifestBytes: 64 * 1024 ** 2,
  gitOutputBytes: 32 * 1024 ** 2,
} as const;

const STORE = '.bank-store';
const RESERVATION = '.bank-admission';
const active = new WeakMap<object, { pending: Set<object>; uncertain: boolean }>();
export interface PreservationBankAdmission { readonly directory: string }

export function assertPreservationBankAdmission(admission: PreservationBankAdmission): void {
  if (!active.has(admission)) throw new Error('Preservation bank write has no active capacity reservation.');
}

/** Same-attempt custody only. A caller settles its own writer after actual
 * close; errors and timeout requests never settle it implicitly. */
export function beginPreservationBankWriter(admission: PreservationBankAdmission): (settled: boolean) => void {
  assertPreservationBankAdmission(admission);
  const state = active.get(admission)!;
  const writer = {};
  state.pending.add(writer);
  return settled => {
    if (!state.pending.delete(writer)) throw new Error('Preservation writer was already settled.');
    if (!settled) state.uncertain = true;
  };
}

async function syncBankDirectory(directory: string, identity: Awaited<ReturnType<typeof captureWorktreeMaterializationIdentity>>): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory() || stat.dev !== identity.device || stat.ino !== identity.inode) {
      throw new Error('Preservation directory durability lost its exact owner.');
    }
    await handle.sync();
    await assertWorktreeMaterializationIdentity(directory, identity);
  } finally { await handle.close(); }
}

/** Bounded namespace scan, including legacy files. Unknown directories, links,
 * incomplete preparations and reservations refuse growth without reclaiming it. */
async function measureBank(directory: string, completedReservation = false): Promise<{ bytes: number; entries: number }> {
  let bytes = 0;
  let entries = 0;
  const scan = async (current: string, root: boolean) => {
    const before = await lstat(current);
    if (!before.isDirectory() || before.isSymbolicLink() || (process.platform !== 'win32' && (before.mode & 0o077) !== 0)
      || (process.getuid && before.uid !== process.getuid()) || await realpath(current) !== current) {
      throw new Error('Preservation bank accounting has unsafe directory ownership.');
    }
    bytes += Math.max(65_536, before.blocks * 512);
    const reader = await opendir(current);
    for await (const entry of reader) {
      if (root && completedReservation && entry.name === RESERVATION) continue;
      if (++entries > PRESERVATION_BANK_POLICY.maxEntries) throw new Error('Preservation bank entry budget exceeded.');
      if (entry.name === RESERVATION || entry.name.startsWith('.prepare-') || entry.name.startsWith('.publish-')) {
        throw new Error('Preservation bank has an unresolved capacity reservation or staging write.');
      }
      const candidate = path.join(current, entry.name);
      const stat = await lstat(candidate);
      if (stat.isDirectory() && root && entry.name === 'git-bundles') await scan(candidate, false);
      else {
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
          || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) || (process.getuid && stat.uid !== process.getuid())) {
          throw new Error('Preservation bank accounting is incomplete; unknown evidence remains retained.');
        }
        // Charge sparse logical length as well as physical allocation, rounded
        // conservatively to cover normal filesystem allocation granularity.
        bytes += Math.max(Math.ceil(stat.size / 65_536) * 65_536, 65_536, stat.blocks * 512);
      }
      if (!Number.isSafeInteger(bytes) || bytes > PRESERVATION_BANK_POLICY.maxBytes) {
        throw new Error('Preservation bank aggregate byte budget exceeded.');
      }
    }
    const after = await lstat(current);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs) throw new Error('Preservation bank changed during bounded accounting.');
  };
  await scan(directory, true);
  return { bytes, entries };
}

export async function withPreservationBankAdmission<T>(
  directory: string,
  operation: (admission: PreservationBankAdmission) => Promise<T>,
): Promise<T> {
  getSqlite();
  const database = await realpath(process.env.CORTEX_IDE_DB_PATH || path.join(getDataDir(), 'cortex-ide.db'));
  const binding = createHash('sha256').update(database).digest('hex');
  const identity = await captureWorktreeMaterializationIdentity(directory);
  return withPacketLifecycleMutationLock('preservation-bank:' + createHash('sha256').update(directory).digest('hex'), async () => {
    const store = path.join(directory, STORE);
    // Initialization is serialized by this store before exclusive creation.
    // The binding prevents profiles with separate DB locks from
    // admitting concurrent writes into the same filesystem bank.
    try {
      await lstat(store);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeExactChildFile(directory, identity, store, binding, 0o600);
    }
    await syncBankDirectory(directory, identity);
    const bound = await lstat(store);
    if (!bound.isFile() || bound.isSymbolicLink() || bound.nlink !== 1 || bound.size !== 64
      || (await readExactChildFile(directory, identity, store)).contents !== binding) {
      throw new Error('Preservation bank belongs to a different or unproved lifecycle store.');
    }
    await assertWorktreeMaterializationIdentity(directory, identity);
    const retained = await measureBank(directory);
    if (retained.bytes + PRESERVATION_BANK_POLICY.captureBytes > PRESERVATION_BANK_POLICY.maxBytes
      || retained.entries + PRESERVATION_BANK_POLICY.captureEntries > PRESERVATION_BANK_POLICY.maxEntries) {
      throw new Error('Preservation bank aggregate budget cannot reserve another capture; source remains retained.');
    }
    const reservation = path.join(directory, RESERVATION);
    await writeExactChildFile(directory, identity, reservation, JSON.stringify({
      schema: 'o8/preservation-bank-admission/v1', binding, retained,
      reservedBytes: PRESERVATION_BANK_POLICY.captureBytes, reservedEntries: PRESERVATION_BANK_POLICY.captureEntries,
    }), 0o600);
    await syncBankDirectory(directory, identity);
    const receipt = await readExactChildFile(directory, identity, reservation);
    const admission: PreservationBankAdmission = { directory };
    const state = { pending: new Set<object>(), uncertain: false };
    active.set(admission, state);
    const release = async () => {
      if (state.pending.size || state.uncertain) {
        throw new Error('Preservation capacity remains held: writer closure is unproved.');
      }
      await assertWorktreeMaterializationIdentity(directory, identity);
      await measureBank(directory, true);
      const current = await readExactChildFile(directory, identity, reservation);
      if (current.contents !== receipt.contents || current.identity.device !== receipt.identity.device
        || current.identity.inode !== receipt.identity.inode) throw new Error('Preservation capacity reservation changed.');
      await retireExactChildFile(directory, identity, reservation,
        path.join(directory, '.bank-complete-' + randomUUID()), receipt.identity);
      await syncBankDirectory(directory, identity);
    };
    let result: T;
    try {
      try { result = await operation(admission); }
      catch (error) {
        try { await release(); }
        catch (held) {
          throw new Error(`${error instanceof Error ? error.message : String(error)}; ${held instanceof Error ? held.message : String(held)}`, { cause: error });
        }
        throw error;
      }
      await release();
      return result;
    } finally { active.delete(admission); }
  });
}
