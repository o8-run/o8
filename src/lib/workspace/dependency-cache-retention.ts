import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import { withPacketLifecycleMutationLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import {
  assertWorktreeMaterializationIdentity,
  captureWorktreeMaterializationIdentity,
  type WorktreeMaterializationIdentity,
} from '@/lib/worktree/materialization-identity';
import { probeMetadataLockProcessIdentity, type MetadataLockProcessProbe } from '@/lib/worktree/metadata-lock-process-identity';
import { measureDirectoryStorage } from '@/lib/worktree/storage-telemetry';
import { purgeExactDirectory } from './exact-directory-purge';
import { readExactChildFile, renameExactChildDirectory, retireExactChildFile, writeExactChildFile } from './exact-parent-operation';
import type { DependencyInstallRecipe } from './dependency-install';

export const DEPENDENCY_CACHE_POLICY = {
  maxBytes: 2 * 1024 ** 3,
  maxEntries: 12,
  maxAgeMs: 14 * 24 * 60 * 60_000,
} as const;

export interface DependencyCachePolicy {
  maxBytes: number;
  maxEntries: number;
  maxAgeMs: number;
}

export interface DependencyCacheRetentionReceipt {
  schema: 'o8/dependency-cache-retention/v1';
  scope: 'managed-v1-only';
  policy: DependencyCachePolicy;
  measuredAt: string;
  status: 'within-budget' | 'held';
  retainedBytes: number | null;
  retainedEntries: number;
  removed: string[];
  held: Array<{ entry: string; reason: string }>;
  legacyPreserved: boolean;
}

interface CacheRecord {
  schema: 'o8/managed-dependency-cache/v1';
  key: string;
  manager: string;
  identity: WorktreeMaterializationIdentity;
  lastUsedAt: number;
  allocatedBytes: number | null;
}

interface CacheReservation {
  schema: 'o8/dependency-cache-reservation/v1';
  leaseId: string;
  key: string;
  manager: string;
  cacheAuthorityId: string;
  identity: WorktreeMaterializationIdentity;
  cacheIdentity: WorktreeMaterializationIdentity;
  pid: number;
  ownerProcess: MetadataLockProcessProbe;
  acquiredAt: number;
  retentionState: 'active-or-unresolved-installer';
}

const MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'];
const RECORD = '.o8-cache.json';
const ACTIVE = '.o8-active-';
// Confine exclusion to the managed namespace, including injected cache roots.
// Existing unsuffixed caches and their active installer leases stay untouched.
const MANAGED_DIRECTORY = process.platform === 'darwin' ? 'managed-v1.noindex' : 'managed-v1';

async function ensurePrivateDirectory(directoryPath: string, parentPath?: string): Promise<void> {
  try {
    await mkdir(directoryPath, { recursive: parentPath === undefined, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const [entry, canonical, canonicalRoot] = await Promise.all([
    lstat(directoryPath), realpath(directoryPath), realpath(parentPath ?? directoryPath),
  ]);
  if (!entry.isDirectory() || entry.isSymbolicLink()
    || (process.platform !== 'win32' && (entry.mode & 0o077) !== 0)
    || (parentPath !== undefined && canonical !== path.join(canonicalRoot, path.basename(directoryPath)))) {
    throw new Error('Package-manager recipe authority is not an exact private directory.');
  }
}

function cacheLock(root: string): string {
  return `dependency-cache:${createHash('sha256').update(root).digest('hex')}`;
}

function validPolicy(policy: DependencyCachePolicy): void {
  for (const value of [policy.maxBytes, policy.maxEntries, policy.maxAgeMs]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid dependency-cache retention policy.');
  }
}

async function assertCacheStoreBinding(managed: string): Promise<void> {
  // Lock state must have the same authority for every writer sharing this cache root.
  const database = await realpath(process.env.CORTEX_IDE_DB_PATH || path.join(getDataDir(), 'cortex-ide.db'));
  const expected = createHash('sha256').update(database).digest('hex');
  const identity = await captureWorktreeMaterializationIdentity(managed);
  const file = path.join(managed, '.o8-cache-store');
  try {
    await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      await writeExactChildFile(managed, identity, file, expected, 0o600);
    } catch {
      // A different profile may have won exclusive creation; read its claim, never overwrite it.
    }
  }
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 64
    || (await readExactChildFile(managed, identity, file)).contents !== expected) {
    throw new Error('Dependency cache belongs to a different or unproved lifecycle store.');
  }
}

async function removeRecordFile(root: string, identity: WorktreeMaterializationIdentity, name: string): Promise<void> {
  const file = path.join(root, name);
  const entry = await lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    throw new Error('Dependency-cache record is not a private regular file.');
  }
  await retireExactChildFile(root, identity, file, path.join(root, `.retired-${randomUUID()}`), {
    device: entry.dev, inode: entry.ino,
  });
}

async function saveRecord(root: string, record: CacheRecord): Promise<void> {
  try {
    await removeRecordFile(root, record.identity, RECORD);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeExactChildFile(root, record.identity, path.join(root, RECORD), JSON.stringify(record), 0o600);
}

async function readRecord(root: string, manager: string, key: string): Promise<CacheRecord> {
  const identity = await captureWorktreeMaterializationIdentity(root);
  const stat = await lstat(path.join(root, RECORD));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) {
    throw new Error('Cache retention record is unsafe.');
  }
  const record = JSON.parse((await readExactChildFile(root, identity, path.join(root, RECORD))).contents) as CacheRecord;
  if (record.schema !== 'o8/managed-dependency-cache/v1' || record.key !== key || record.manager !== manager
    || !Number.isSafeInteger(record.lastUsedAt) || record.lastUsedAt < 0
    || (record.allocatedBytes !== null && (!Number.isSafeInteger(record.allocatedBytes) || record.allocatedBytes < 0))) {
    throw new Error('Cache retention record is invalid.');
  }
  await assertWorktreeMaterializationIdentity(root, record.identity);
  return record;
}

/** New writers use a separate namespace: older apps cannot write unleased caches here. */
export async function acquireDependencyCache(
  cacheRoot: string,
  recipe: DependencyInstallRecipe,
  policy: DependencyCachePolicy = DEPENDENCY_CACHE_POLICY,
): Promise<{ root: string; cache: string; release: () => Promise<DependencyCacheRetentionReceipt> }> {
  validPolicy(policy);
  if (!MANAGERS.includes(recipe.packageManager) || !/^[0-9a-f]{64}$/.test(recipe.key)
    || recipe.cacheAuthorityId !== `native-download-cache:${recipe.packageManager}:recipe:${recipe.key}`) {
    throw new Error('Dependency recipe cache authority is invalid.');
  }
  await ensurePrivateDirectory(cacheRoot);
  const managed = path.join(await realpath(cacheRoot), MANAGED_DIRECTORY);
  await ensurePrivateDirectory(managed, cacheRoot);
  const managerRoot = path.join(managed, recipe.packageManager);
  const root = path.join(managerRoot, recipe.key);
  const cache = path.join(root, 'cache');
  const leaseId = randomUUID();
  const leaseName = `${ACTIVE}${leaseId}`;
  const { identity, cacheIdentity } = await withPacketLifecycleMutationLock(cacheLock(managed), async () => {
    await assertCacheStoreBinding(managed);
    await ensurePrivateDirectory(managerRoot, managed);
    await ensurePrivateDirectory(root, managerRoot);
    await ensurePrivateDirectory(cache, root);
    const captured = await captureWorktreeMaterializationIdentity(root);
    const cacheIdentity = await captureWorktreeMaterializationIdentity(cache);
    const reservation: CacheReservation = {
      schema: 'o8/dependency-cache-reservation/v1', leaseId, key: recipe.key, manager: recipe.packageManager,
      cacheAuthorityId: recipe.cacheAuthorityId, identity: captured, cacheIdentity, pid: process.pid,
      ownerProcess: await probeMetadataLockProcessIdentity(process.pid), acquiredAt: Date.now(),
      retentionState: 'active-or-unresolved-installer',
    };
    // Publish identity and retention before installer use. Unknown birth evidence remains explicit.
    // Crashes retain the reservation: parent death or age cannot prove installer children stopped.
    await writeExactChildFile(root, captured, path.join(root, leaseName), JSON.stringify(reservation), 0o600);
    await assertWorktreeMaterializationIdentity(cache, cacheIdentity);
    return { identity: captured, cacheIdentity };
  });
  let released = false;
  return {
    root,
    cache,
    release: async () => {
      if (released) throw new Error('Dependency-cache reservation was already released.');
      released = true;
      return withPacketLifecycleMutationLock(cacheLock(managed), async () => {
        await assertWorktreeMaterializationIdentity(root, identity);
        await assertWorktreeMaterializationIdentity(cache, cacheIdentity);
        await removeRecordFile(root, identity, leaseName);
        if (!(await readdir(root)).some(name => name.startsWith(ACTIVE))) {
          const storage = await measureDirectoryStorage(cache);
          await saveRecord(root, {
            schema: 'o8/managed-dependency-cache/v1', key: recipe.key, manager: recipe.packageManager,
            identity, lastUsedAt: Date.now(), allocatedBytes: storage.allocatedBytes,
          });
        }
        return pruneLocked(cacheRoot, managed, policy);
      });
    },
  };
}

/** Event-driven maintenance, never an idle timer or a dispatch preflight walk. */
export async function pruneDependencyCaches(
  cacheRoot: string,
  policy: DependencyCachePolicy = DEPENDENCY_CACHE_POLICY,
): Promise<DependencyCacheRetentionReceipt> {
  validPolicy(policy);
  await ensurePrivateDirectory(cacheRoot);
  const managed = path.join(await realpath(cacheRoot), MANAGED_DIRECTORY);
  await ensurePrivateDirectory(managed, cacheRoot);
  return withPacketLifecycleMutationLock(cacheLock(managed), () => pruneLocked(cacheRoot, managed, policy));
}

async function pruneLocked(
  cacheRoot: string,
  managed: string,
  policy: DependencyCachePolicy,
): Promise<DependencyCacheRetentionReceipt> {
  await assertCacheStoreBinding(managed);
  const now = Date.now();
  const receipt: DependencyCacheRetentionReceipt = {
    schema: 'o8/dependency-cache-retention/v1', scope: 'managed-v1-only', policy: { ...policy }, measuredAt: new Date(now).toISOString(),
    status: 'within-budget', retainedBytes: 0, retainedEntries: 0, removed: [], held: [],
    legacyPreserved: (await readdir(cacheRoot)).some(name => MANAGERS.includes(name)),
  };
  const candidates: Array<{ root: string; record: CacheRecord }> = [];
  for (const manager of MANAGERS) {
    const parent = path.join(managed, manager);
    try {
      const entry = await lstat(parent);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unsafe manager namespace.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      receipt.held.push({ entry: manager, reason: 'unsafe-manager-namespace' });
      continue;
    }
    for (const key of await readdir(parent)) {
      const label = `${manager}/${key}`;
      if (!/^[0-9a-f]{64}$/.test(key)) {
        receipt.held.push({ entry: label, reason: 'unrecognized-or-interrupted-retirement' });
        continue;
      }
      receipt.retainedEntries += 1;
      const root = path.join(parent, key);
      try {
        await captureWorktreeMaterializationIdentity(root);
        if ((await readdir(root)).some(name => name.startsWith(ACTIVE))) {
          receipt.held.push({ entry: label, reason: 'active-or-unresolved-installer' });
          continue;
        }
        const record = await readRecord(root, manager, key);
        if (record.allocatedBytes === null) throw new Error('Cache size is unknown.');
        receipt.retainedBytes! += record.allocatedBytes;
        candidates.push({ root, record });
      } catch {
        receipt.held.push({ entry: label, reason: 'unproved-cache-identity-or-size' });
      }
    }
  }
  candidates.sort((a, b) => a.record.lastUsedAt - b.record.lastUsedAt || a.root.localeCompare(b.root));
  for (const { root, record } of candidates) {
    if (receipt.retainedBytes! <= policy.maxBytes && receipt.retainedEntries <= policy.maxEntries
      && now - record.lastUsedAt <= policy.maxAgeMs) continue;
    const label = `${record.manager}/${record.key}`;
    try {
      await assertWorktreeMaterializationIdentity(root, record.identity);
      if ((await readdir(root)).some(name => name.startsWith(ACTIVE))) throw new Error('Cache became active.');
      const parent = path.dirname(root);
      const parentIdentity = await captureWorktreeMaterializationIdentity(parent);
      const retired = path.join(parent, `.o8-pruning-${record.key}-${randomUUID()}`);
      // Detach before purge so a successor install cannot reuse a partially retired namespace.
      await renameExactChildDirectory(parent, parentIdentity, root, retired, record.identity);
      await purgeExactDirectory(retired, record.identity);
      receipt.removed.push(label);
      receipt.retainedBytes! -= record.allocatedBytes!;
      receipt.retainedEntries -= 1;
    } catch {
      receipt.held.push({ entry: label, reason: 'retirement-incomplete' });
    }
  }
  if (receipt.held.length > 0) receipt.retainedBytes = null;
  if (receipt.held.length > 0 || receipt.retainedEntries > policy.maxEntries
    || (receipt.retainedBytes !== null && receipt.retainedBytes > policy.maxBytes)) receipt.status = 'held';
  const identity = await captureWorktreeMaterializationIdentity(managed);
  const receiptName = '.o8-retention.json';
  try {
    await removeRecordFile(managed, identity, receiptName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeExactChildFile(managed, identity, path.join(managed, receiptName), JSON.stringify(receipt), 0o600);
  return receipt;
}
