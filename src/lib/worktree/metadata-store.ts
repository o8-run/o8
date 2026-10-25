import { AsyncLocalStorage } from 'node:async_hooks';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import type Database from 'better-sqlite3';

import { readJsonFile } from '@/lib/fs/json';
import {
  acquireMetadataTransactionLease,
  readMetadataTransactionState,
  readMetadataTransactionStateSnapshot,
  releaseMetadataTransactionLease,
  writeMetadataTransactionState,
  type MetadataTransactionBoundary,
  type MetadataTransactionLease,
} from '@/lib/worktree/metadata-transaction-lease';
import { getSqlite } from '@/lib/db';
import {
  assertManagedWorktreeMaterializationBoundary,
  canonicalWorktreeNamespace,
  observeManagedWorktreeRootIdentity,
  resolveWorktreeRootLayout,
} from '@/lib/worktree/root-layout';
import type { WorktreeMetaEntry, WorktreeMetaStore } from '@/lib/worktree/types';
import { isMetadataLockProcessIdentity } from './metadata-lock-process-identity';
import { observeStorageVolume, type StorageRootIdentity } from '@/lib/workspace/storage-admission';
import {
  readPinnedWorkspaceFile,
  readPinnedWorkspaceFileReceipt,
  writePinnedWorkspaceFile,
} from './materialization-leaf-io';
import type { WorktreeMaterializationIdentity } from './materialization-identity';
import { assertWorktreeMetadataEntryBudget, chargeWorktreeMetadataRead, worktreeMetadataReadLimit, WorktreeMaintenanceHeldError } from './maintenance-budget';

const META_FILENAME = '.meta.json';

const mutationQueues = new Map<string, Promise<void>>();
export interface WorktreeMetadataBoundary {
  root: StorageRootIdentity;
  base: WorktreeMaterializationIdentity;
}
const boundaryContext = new AsyncLocalStorage<ReadonlyMap<string, WorktreeMetadataBoundary>>();

async function captureMetadataBoundary(repoPath: string): Promise<WorktreeMetadataBoundary> {
  const root = await observeManagedWorktreeRootIdentity(repoPath);
  const observation = await observeStorageVolume(root.canonicalPath);
  if (observation.status !== 'observed') {
    throw new Error('The worktree metadata volume could not be observed.');
  }
  const base = await assertManagedWorktreeMaterializationBoundary(
    repoPath, observation.volumeId!, root,
  );
  return {
    root,
    base: {
      canonicalPath: base.canonicalPath,
      device: Number(base.device),
      inode: Number(base.inode),
      volumeId: observation.volumeId!,
    },
  };
}

export function withWorktreeMetadataBoundary<T>(
  repoPath: string,
  boundary: WorktreeMetadataBoundary,
  operation: () => Promise<T>,
): Promise<T> {
  const next = new Map(boundaryContext.getStore() ?? []);
  next.set(path.resolve(repoPath), boundary);
  return boundaryContext.run(next, operation);
}

function isWorktreeMetaEntry(value: unknown, id: string): value is WorktreeMetaEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<WorktreeMetaEntry>;
  return entry.id === id
    && (entry.packetId === undefined || typeof entry.packetId === 'string')
    && (entry.laneId === undefined || typeof entry.laneId === 'string')
    && typeof entry.agentType === 'string'
    && entry.agentType.trim().length > 0
    && (entry.sessionKey === undefined || typeof entry.sessionKey === 'string')
    && typeof entry.baseBranch === 'string'
    && Number.isFinite(entry.createdAt)
    && typeof entry.claudeManaged === 'boolean'
    && typeof entry.taskName === 'string'
    && (entry.branchName === undefined || typeof entry.branchName === 'string')
    && (entry.status === undefined || [
      'creating', 'setup', 'ready', 'active', 'stale', 'merging', 'cleaning',
    ].includes(entry.status))
    && (entry.isolationKind === undefined
      || entry.isolationKind === 'git-worktree'
      || entry.isolationKind === 'apfs-cow-clone')
    && (entry.environmentReferences === undefined
      || (typeof entry.environmentReferences === 'object' && entry.environmentReferences !== null
        && !Array.isArray(entry.environmentReferences)
        && Object.entries(entry.environmentReferences).every(([relativePath, target]) => (
          relativePath.length > 0 && !path.isAbsolute(relativePath)
          && !relativePath.split(/[\\/]/).some((part) => !part || part === '.' || part === '..' || part === '.git')
          && typeof target === 'string' && path.isAbsolute(target)
        ))))
    && (entry.hydrationPaths === undefined
      || (Array.isArray(entry.hydrationPaths)
        && entry.hydrationPaths.every((item) => typeof item === 'string')))
    && (entry.dependencyRecipeKey === undefined
      || (typeof entry.dependencyRecipeKey === 'string'
        && /^[0-9a-f]{64}$/.test(entry.dependencyRecipeKey)))
    && (entry.dependencyMaterialization === undefined
      || (typeof entry.dependencyMaterialization === 'object'
        && entry.dependencyMaterialization !== null
        && (entry.dependencyMaterialization.mode === 'native'
          || entry.dependencyMaterialization.mode === 'image')
        && (entry.dependencyMaterialization.status === 'prepared'
          || entry.dependencyMaterialization.status === 'mounted')
        && typeof entry.dependencyMaterialization.installCommand === 'string'
        && entry.dependencyMaterialization.installCommand.length > 0
        && typeof entry.dependencyMaterialization.recipeKey === 'string'
        && /^[0-9a-f]{64}$/.test(entry.dependencyMaterialization.recipeKey)
        && (entry.dependencyMaterialization.mode === 'native'
          ? entry.dependencyMaterialization.status === 'mounted'
            && entry.dependencyMaterialization.leaseId === null
            && entry.dependencyMaterialization.generation === null
          : typeof entry.dependencyMaterialization.leaseId === 'string'
            && entry.dependencyMaterialization.leaseId.length > 0
            && typeof entry.dependencyMaterialization.generation === 'string'
            && entry.dependencyMaterialization.generation.length > 0)
        && Number.isSafeInteger(entry.dependencyMaterialization.workspaceDevice)
        && entry.dependencyMaterialization.workspaceDevice >= 0
        && Number.isSafeInteger(entry.dependencyMaterialization.workspaceInode)
        && entry.dependencyMaterialization.workspaceInode > 0
        && entry.dependencyRecipeKey === entry.dependencyMaterialization.recipeKey))
    && (entry.creationOwner === undefined
      || (typeof entry.creationOwner === 'object'
        && entry.creationOwner !== null
        && Number.isInteger(entry.creationOwner.pid)
        && entry.creationOwner.pid > 0
        && isMetadataLockProcessIdentity(entry.creationOwner.identity)))
    && (entry.creationBranchHead === undefined
      || (typeof entry.creationBranchHead === 'string'
        && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(entry.creationBranchHead)))
    && (entry.materializationIdentity === undefined
      || (typeof entry.materializationIdentity === 'object'
        && entry.materializationIdentity !== null
        && Number.isFinite(entry.materializationIdentity.device)
        && Number.isFinite(entry.materializationIdentity.inode)
        && typeof entry.materializationIdentity.canonicalPath === 'string'
        && entry.materializationIdentity.canonicalPath.length > 0
        && (entry.materializationIdentity.volumeId === undefined
          || (typeof entry.materializationIdentity.volumeId === 'string'
            && entry.materializationIdentity.volumeId.length > 0))))
    && (entry.materializationParentIdentity === undefined
      || (typeof entry.materializationParentIdentity === 'object'
        && entry.materializationParentIdentity !== null
        && Number.isFinite(entry.materializationParentIdentity.device)
        && Number.isFinite(entry.materializationParentIdentity.inode)
        && typeof entry.materializationParentIdentity.canonicalPath === 'string'
        && entry.materializationParentIdentity.canonicalPath.length > 0
        && (entry.materializationParentIdentity.volumeId === undefined
          || (typeof entry.materializationParentIdentity.volumeId === 'string'
            && entry.materializationParentIdentity.volumeId.length > 0))))
    && (entry.restorePreparation === undefined
      || (typeof entry.restorePreparation === 'object'
        && entry.restorePreparation !== null
        && typeof entry.restorePreparation.stagePath === 'string'
        && typeof entry.restorePreparation.expectedPath === 'string'
        && typeof entry.restorePreparation.head === 'string'
        && typeof entry.restorePreparation.tree === 'string'
        && (entry.restorePreparation.isolationKind === 'git-worktree'
          || entry.restorePreparation.isolationKind === 'apfs-cow-clone')));
}

function validatedMetaStore(value: unknown, metaPath: string): WorktreeMetaStore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Worktree metadata at ${metaPath} is not an object.`);
  }
  const store = value as Partial<WorktreeMetaStore>;
  if (store.worktrees && typeof store.worktrees === 'object') {
    assertWorktreeMetadataEntryBudget(metaPath, Object.keys(store.worktrees).length);
  }
  if (store.version !== 1
    || !store.worktrees
    || typeof store.worktrees !== 'object'
    || Array.isArray(store.worktrees)
    || !Object.entries(store.worktrees).every(([id, entry]) => isWorktreeMetaEntry(entry, id))) {
    throw new Error(`Worktree metadata at ${metaPath} has an unsupported shape.`);
  }
  return store as WorktreeMetaStore;
}

async function readMeta(
  metaPath: string,
  pinned?: { basePath: string; identity: WorktreeMaterializationIdentity },
): Promise<Record<string, WorktreeMetaEntry>> {
  if (pinned && path.resolve(path.dirname(metaPath)) === path.resolve(pinned.basePath)) {
    const raw = await readPinnedWorkspaceFile(pinned.basePath, pinned.identity, META_FILENAME);
    if (raw === null) return {};
    return validatedMetaStore(JSON.parse(raw) as unknown, metaPath).worktrees;
  }
  let metaStat: Awaited<ReturnType<typeof lstat>>;
  try {
    metaStat = await lstat(metaPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  if (!metaStat.isFile() || metaStat.isSymbolicLink()) {
    throw new Error(`Worktree metadata at ${metaPath} is not a regular file.`);
  }
  const limit = worktreeMetadataReadLimit();
  if (limit !== undefined) {
    const handle = await open(metaPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > limit) {
        throw new WorktreeMaintenanceHeldError(metaPath, `metadata ${before.size} bytes exceeds the read allowance ${limit}`);
      }
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (read.bytesRead === 0) throw new Error('Metadata changed during bounded read.');
        offset += read.bytesRead;
      }
      const after = await handle.stat();
      if (before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error('Metadata changed during bounded read.');
      }
      chargeWorktreeMetadataRead(metaPath, bytes.length);
      return validatedMetaStore(JSON.parse(bytes.toString('utf8')) as unknown, metaPath).worktrees;
    } finally { await handle.close(); }
  }
  return validatedMetaStore(await readJsonFile<unknown>(metaPath), metaPath).worktrees;
}

/**
 * Read the durable metadata mirror without acquiring a mutation lease or
 * creating the managed worktree root. Inventory and startup reconciliation
 * are snapshot reads; an untouched repository must remain untouched.
 */
export async function readWorktreeMetaSnapshot(
  repoPath: string,
  sqlite: Database.Database = getSqlite(),
): Promise<Record<string, WorktreeMetaEntry>> {
  const metadataRoot = resolveWorktreeRootLayout(repoPath).primaryBase;
  const metaPath = path.join(metadataRoot, META_FILENAME);
  const rootCandidates = [path.resolve(metadataRoot)];
  try {
    const canonicalRoot = await realpath(metadataRoot);
    if (!rootCandidates.includes(canonicalRoot)) rootCandidates.unshift(canonicalRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const canonicalRoot = canonicalWorktreeNamespace(metadataRoot);
    if (!rootCandidates.includes(canonicalRoot)) rootCandidates.unshift(canonicalRoot);
  }
  for (const root of rootCandidates) {
    const durableState = readMetadataTransactionStateSnapshot(root, sqlite);
    if (durableState) {
      return validatedMetaStore(JSON.parse(durableState.payload) as unknown, metaPath).worktrees;
    }
  }
  return readMeta(metaPath);
}

async function withMutationLock<T>(
  repoPath: string,
  boundary: WorktreeMetadataBoundary | undefined,
  operation: (lease: MetadataTransactionLease) => Promise<T>,
): Promise<T> {
  const layout = resolveWorktreeRootLayout(repoPath);
  const metadataRoot = layout.primaryBase;
  const queueKey = path.resolve(metadataRoot);
  const previous = mutationQueues.get(queueKey) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const current = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const queued = previous.then(() => current);
  mutationQueues.set(queueKey, queued);
  await previous;
  let holder: MetadataTransactionLease | null = null;
  try {
    const leaseBoundary: MetadataTransactionBoundary | undefined = boundary ? {
      rootPath: layout.configuredRoot,
      rootCanonicalPath: boundary.root.canonicalPath,
      rootDevice: Number(boundary.root.device),
      rootInode: Number(boundary.root.inode),
      metadataRootIdentity: boundary.base,
    } : undefined;
    holder = await acquireMetadataTransactionLease(metadataRoot, leaseBoundary);
    return await operation(holder);
  } finally {
    try {
      if (holder) releaseMetadataTransactionLease(holder);
    } finally {
      releaseQueue();
      if (mutationQueues.get(queueKey) === queued) mutationQueues.delete(queueKey);
    }
  }
}

export interface WorktreeMetaTransaction {
  readAll: () => Promise<Record<string, WorktreeMetaEntry>>;
  remove: (worktreeId: string) => Promise<void>;
  /** Additional synchronous state committed with authoritative metadata, before mirror I/O. */
  save: (worktreeId: string, entry: WorktreeMetaEntry, commit?: (sqlite: Database.Database) => void) => Promise<void>;
}

export async function withWorktreeMetaTransaction<T>(
  repoPath: string,
  operation: (transaction: WorktreeMetaTransaction) => Promise<T>,
): Promise<T> {
  const boundary = boundaryContext.getStore()?.get(path.resolve(repoPath))
    ?? await captureMetadataBoundary(repoPath);
  return withMutationLock(repoPath, boundary, async (lease) => {
    const metaPath = path.join(resolveWorktreeRootLayout(repoPath).primaryBase, META_FILENAME);
    const durableState = readMetadataTransactionState(lease);
    let entries: Record<string, WorktreeMetaEntry>;
    let mirrorIdentity: {
      device: number;
      inode: number;
      canonicalPath?: string;
      volumeId?: string;
    } | null;
    if (durableState === null) {
      const imported = await readPinnedWorkspaceFileReceipt(
        path.dirname(metaPath), boundary.base, META_FILENAME,
      );
      entries = imported
        ? validatedMetaStore(JSON.parse(imported.content) as unknown, metaPath).worktrees
        : {};
      mirrorIdentity = imported
        ? {
            device: imported.device,
            inode: imported.inode,
            canonicalPath: imported.canonicalPath,
            volumeId: imported.volumeId,
          }
        : null;
      writeMetadataTransactionState(
        lease,
        JSON.stringify({ version: 1, worktrees: entries } satisfies WorktreeMetaStore),
        mirrorIdentity,
        repoPath,
      );
    } else {
      entries = validatedMetaStore(JSON.parse(durableState.payload) as unknown, metaPath).worktrees;
      mirrorIdentity = durableState.mirrorIdentity;
    }
    const persist = async (commit?: (sqlite: Database.Database) => void): Promise<void> => {
      const serialized = JSON.stringify({ version: 1, worktrees: entries } satisfies WorktreeMetaStore, null, 2);
      writeMetadataTransactionState(lease, serialized, mirrorIdentity, repoPath, commit);
      mirrorIdentity = await writePinnedWorkspaceFile(
        path.dirname(metaPath),
        boundary.base,
        META_FILENAME,
        serialized,
        undefined,
        mirrorIdentity,
      );
      writeMetadataTransactionState(lease, serialized, mirrorIdentity, repoPath);
      const persisted = await readMeta(metaPath, {
        basePath: path.dirname(metaPath), identity: boundary.base,
      });
      if (JSON.stringify(persisted) !== JSON.stringify(entries)) {
        throw new Error(`Exact worktree metadata verification failed at ${metaPath}.`);
      }
    };
    return operation({
      readAll: async () => entries,
      remove: async (worktreeId) => {
        if (!(worktreeId in entries)) return;
        delete entries[worktreeId];
        await persist();
      },
      save: async (worktreeId, entry, commit) => {
        entries[worktreeId] = entry;
        await persist(commit);
      },
    });
  });
}
