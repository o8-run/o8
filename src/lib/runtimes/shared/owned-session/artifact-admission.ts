import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import { withPacketLifecycleSpawnLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { WorkspaceLifecycleLeaseUnavailableError } from '@/lib/orchestrator/workspace-lifecycle-lease';
import { workerO8CliRoot } from './worker-o8-cli-paths';

export const OWNED_ARTIFACT_POLICY = { maxBytes: 4 * 1024 ** 3, maxEntries: 10_000 } as const;
const heldRoots = new AsyncLocalStorage<Map<string, { active: boolean; admitted: boolean }>>();

export class OwnedArtifactAdmissionError extends Error {
  readonly code = 'owned_artifact_admission_held';
  readonly sideEffect = 'none' as const;
  constructor(public readonly reason: string) {
    super(`Owned artifact admission held: ${reason}. Retained evidence was not removed; read, stop, archive and recovery remain available. Review retained artifacts before starting another run.`);
    this.name = 'OwnedArtifactAdmissionError';
  }
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

async function optionalStat(name: string): Promise<Stats | null> {
  try { return await lstat(name); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// Both the active and archive sibling use the same canonical namespace and
// existing cross-process lease. Binding the namespace to that lease's database
// prevents two profiles with unrelated locks admitting into the same roots.
async function canonicalRoot(root: string): Promise<string> {
  const absolute = path.resolve(root);
  await mkdir(path.dirname(absolute), { recursive: true });
  return path.join(await realpath(path.dirname(absolute)), path.basename(absolute));
}

async function bindStore(root: string): Promise<void> {
  const parent = path.dirname(root);
  const before = await lstat(parent);
  const database = await realpath(process.env.CORTEX_IDE_DB_PATH || path.join(getDataDir(), 'cortex-ide.db'));
  const binding = createHash('sha256').update(database).digest('hex');
  const file = path.join(parent, `.${path.basename(root)}-artifact-store`);
  try {
    const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(binding); await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 64
      || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
      throw new OwnedArtifactAdmissionError('the runtime root has different or unproved lifecycle ownership');
    }
    const bytes = Buffer.alloc(64);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== 64 || bytes.toString('utf8') !== binding || (await handle.stat()).size !== 64
      || !sameIdentity(stat, await lstat(file))) throw new OwnedArtifactAdmissionError('the lifecycle binding changed');
  } finally { await handle.close(); }
  if (process.platform !== 'win32') {
    const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (!sameIdentity(before, await directory.stat())) throw new OwnedArtifactAdmissionError('the runtime parent changed');
      await directory.sync();
    } finally { await directory.close(); }
  }
  if (!sameIdentity(before, await lstat(parent)) || await realpath(parent) !== parent) {
    throw new OwnedArtifactAdmissionError('the runtime parent changed');
  }
}

async function measureArtifacts(root: string): Promise<void> {
  let bytes = 0;
  let entries = 0;
  const identities = new Set<string>();
  const observed = new Map<string, Stats | null>();
  const visit = async (name: string, depth: number, optional = false): Promise<void> => {
    if (depth > 64) throw new OwnedArtifactAdmissionError('artifact directory depth is unsafe');
    const stat = optional ? await optionalStat(name) : await lstat(name);
    observed.set(name, stat);
    if (!stat) return;
    if ((!stat.isDirectory() && !stat.isFile()) || stat.isSymbolicLink()
      || (stat.isFile() && stat.nlink !== 1)
      || (process.getuid && stat.uid !== process.getuid()) || await realpath(name) !== name) {
      throw new OwnedArtifactAdmissionError('artifact accounting contains redirected, shared or unknown ownership');
    }
    const identity = `${stat.dev}:${stat.ino}`;
    if (identities.has(identity)) throw new OwnedArtifactAdmissionError('artifact identity is aliased');
    identities.add(identity);
    entries += 1;
    bytes += Math.max(65_536, Math.ceil(stat.size / 65_536) * 65_536, (stat.blocks ?? 0) * 512);
    if (!Number.isSafeInteger(bytes) || bytes >= OWNED_ARTIFACT_POLICY.maxBytes
      || entries >= OWNED_ARTIFACT_POLICY.maxEntries) {
      throw new OwnedArtifactAdmissionError('retained artifacts reached the 4 GiB or 10,000-entry admission threshold');
    }
    if (stat.isDirectory()) {
      const reader = await opendir(name);
      for await (const entry of reader) {
        // Recheck the ancestor before descending; supported rename operations
        // share this lease. Uncoordinated replacement refuses the observation.
        if (!sameIdentity(stat, await lstat(name)) || await realpath(name) !== name) {
          throw new OwnedArtifactAdmissionError('artifact directory changed during accounting');
        }
        await visit(path.join(name, entry.name), depth + 1);
      }
    }
  };
  const roots = [root, `${root}-archive`, workerO8CliRoot()];
  for (const candidate of roots.filter((candidate, index) => !roots.some((parent, other) => (
    (other < index && parent === candidate) || (other !== index && candidate.startsWith(parent + path.sep))
  )))) await visit(candidate, 0, true);
  for (const [name, before] of observed) {
    const after = await optionalStat(name);
    if (!before ? after !== null : !after || !sameIdentity(before, after)
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new OwnedArtifactAdmissionError('artifact accounting changed; retry after writers settle');
    }
  }
}

/** Short admission/rename lock only; never held for a provider's lifetime. */
export async function withOwnedArtifactRootLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  let canonical: string;
  try { canonical = await canonicalRoot(root); }
  catch { throw new OwnedArtifactAdmissionError('the runtime root could not be resolved'); }
  const existing = heldRoots.getStore()?.get(canonical);
  if (existing?.active) return operation();
  try {
    return await withPacketLifecycleSpawnLock(`owned-artifacts:${createHash('sha256').update(canonical).digest('hex')}`, async () => {
      try { await bindStore(canonical); }
      catch (error) {
        if (error instanceof OwnedArtifactAdmissionError) throw error;
        throw new OwnedArtifactAdmissionError('the lifecycle store binding could not be verified');
      }
      const cliNamespace = path.join(await realpath(path.dirname(workerO8CliRoot())), 'worker-cli');
      return withPacketLifecycleSpawnLock(`owned-cli-artifacts:${createHash('sha256').update(cliNamespace).digest('hex')}`, async () => {
        await bindStore(cliNamespace);
        const authority = { active: true, admitted: false };
        try {
          return await heldRoots.run(new Map([...(heldRoots.getStore() ?? []), [canonical, authority]]), operation);
        } finally { authority.active = false; }
      });
    });
  } catch (error) {
    if (error instanceof WorkspaceLifecycleLeaseUnavailableError) {
      throw new OwnedArtifactAdmissionError('another lifecycle operation owns this runtime root');
    }
    throw error;
  }
}

/** Recheck new CLI bytes even when initial admission is already held. */
export async function assertOwnedArtifactBudget(root: string): Promise<void> {
  return withOwnedArtifactRootLock(root, async () => measureArtifacts(await canonicalRoot(root)));
}

export async function withOwnedArtifactAdmission<T>(
  root: string,
  operation: () => Promise<T>,
  onRetry?: (attempt: number, cause: string) => void,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    let operationStarted = false;
    try {
      return await withOwnedArtifactRootLock(root, async () => {
        const canonical = await canonicalRoot(root);
        const authority = heldRoots.getStore()!.get(canonical)!;
        if (!authority.admitted) {
          try { await measureArtifacts(canonical); }
          catch (error) {
            if (error instanceof OwnedArtifactAdmissionError) throw error;
            throw new OwnedArtifactAdmissionError('retained artifact accounting could not be verified');
          }
          authority.admitted = true;
        }
        operationStarted = true;
        return operation();
      });
    } catch (error) {
      if (operationStarted || !(error instanceof OwnedArtifactAdmissionError) || attempt >= 3
        || (error.reason !== 'artifact accounting changed; retry after writers settle'
          && error.reason !== 'another lifecycle operation owns this runtime root')) throw error;
      onRetry?.(attempt + 1, error.message);
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}
