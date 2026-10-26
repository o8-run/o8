import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import { assertWorktreeMaterializationIdentity, captureWorktreeMaterializationIdentity, type WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { clonePinnedWorkspaceDirectory, readPinnedWorkspaceFile, writePinnedWorkspaceFile } from '@/lib/worktree/materialization-leaf-io';
import { measureDirectoryStorage } from '@/lib/worktree/storage-telemetry';
import { createExactChildDirectory, readExactChildFile, writeExactChildFile } from './exact-parent-operation';
import { claimDependencyPoolSlot, dependencyPoolOwner, recoverDependencyPoolSlot } from './dependency-pool-owner';
import { purgeExactDirectory } from './exact-directory-purge';
import type { DependencyInstallRecipe } from './dependency-install';
import { dependencyCloneSnapshotMatches } from './dependency-clone-snapshot';
import { dependencyCloneSourceMatcher } from './dependency-clone-source';
import { validateDependencyCloneGraph } from './dependency-clone-validation';
import { probeDependencyCloneNativeFiles } from './dependency-clone-lifecycle';
import { publishDependencyPoolTree } from './dependency-pool-publication';
import { reserveStorage, releaseStorageReservation } from './storage-admission';
import { DependencyPayloadRefusal, inspectDependencyPayload, readDependencyPayloadReceipt, sealDependencyPayload, type DependencyPayloadReceipt } from './dependency-payload';

export const DEPENDENCY_POOL_POLICY = { maxTrees: 2, maxTreeBytes: 3 * 1024 ** 3 } as const;
type Graph = NonNullable<Awaited<ReturnType<typeof validateDependencyCloneGraph>>>;
interface ReadyTree {
  schema: 'o8/dependency-directory-pool/v1';
  key: string;
  parent: WorktreeMaterializationIdentity;
  tree: { device: number; inode: number };
  graph: Graph;
  logicalBytes: number;
  payload?: DependencyPayloadReceipt;
}
const refills = new Map<string, Promise<void>>();
const status = new Map<string, { state: string; reason: string | null }>();
const poolRoot = () => path.join(getDataDir(), 'dependency-directory-pool-v1');

/** Match #4377's dependency inputs, retaining the tree fence for unbounded lifecycle. */
export function dependencyDirectoryPoolKey(recipe: DependencyInstallRecipe, source: WorktreeMaterializationIdentity, graphDigest: string): string {
  const { key: _key, cacheAuthorityId: _cache, gitTreeSha, ...inputs } = recipe;
  return createHash('sha256').update(JSON.stringify({ inputs, source, graphDigest,
    ...(recipe.lifecycleScripts === 'enabled' && recipe.cloneLifecycleInputs === undefined ? { gitTreeSha } : {}),
  })).digest('hex');
}

async function readReady(slot: string): Promise<ReadyTree | null> {
  try {
    try { await lstat(path.join(slot, 'claimed')); return null; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = await captureWorktreeMaterializationIdentity(slot);
    const entry = await lstat(path.join(slot, 'ready.json'));
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > 8 * 1024 * 1024) return null;
    const record = JSON.parse((await readExactChildFile(slot, parent, path.join(slot, 'ready.json'))).contents) as ReadyTree;
    if (record.schema !== 'o8/dependency-directory-pool/v1' || !/^[a-f0-9]{64}$/.test(record.key)
      || !Number.isSafeInteger(record.logicalBytes) || record.logicalBytes < 0 || record.logicalBytes > DEPENDENCY_POOL_POLICY.maxTreeBytes) return null;
    await assertWorktreeMaterializationIdentity(slot, record.parent);
    return record;
  } catch { return null; }
}

async function claim(record: ReadyTree): Promise<boolean> {
  return claimDependencyPoolSlot(record.parent);
}

/** No scanning or deletion of foreign paths: only two fixed, receipted slots. */
export async function takeDependencyDirectoryPoolTree(input: {
  key: string; workspace: string; identity: WorktreeMaterializationIdentity;
  recipe: DependencyInstallRecipe;
  graph: Graph;
  onSelected: () => Promise<void>;
}): Promise<{ device: number; inode: number; sourceChanged: boolean; payload: DependencyPayloadReceipt } | null> {
  let rootIdentity: WorktreeMaterializationIdentity;
  try { rootIdentity = await captureWorktreeMaterializationIdentity(poolRoot()); }
  catch { return null; }
  for (let index = 0; index < DEPENDENCY_POOL_POLICY.maxTrees; index += 1) {
    const slot = path.join(poolRoot(), `slot-${index}`);
    const ready = await readReady(slot);
    if (!ready || ready.parent.canonicalPath !== path.join(rootIdentity.canonicalPath, `slot-${index}`)
      || ready.key !== input.key || ready.tree.device !== input.identity.device) continue;
    await assertWorktreeMaterializationIdentity(poolRoot(), rootIdentity);
    if (!await claim(ready)) continue;
    // Once claimed, nobody else can consume this tree, including another process.
    let publishing = false;
    try {
      if (!ready.payload) throw new DependencyPayloadRefusal('payload-unsealed');
      await readDependencyPayloadReceipt(slot, ready.parent, input.recipe, input.graph, ready.payload);
      if (!await dependencyCloneSnapshotMatches(slot, ready.graph.snapshot)) throw new DependencyPayloadRefusal('payload-changed');
      await input.onSelected();
      publishing = true;
      await publishDependencyPoolTree(input.workspace, input.identity, ready.parent, ready.tree);
      return { ...ready.tree, sourceChanged: false, payload: ready.payload };
    } catch (error) {
      if (!publishing) throw error;
      // A publication error cannot safely become an install over an occupied name.
      try { await lstat(path.join(input.workspace, 'node_modules')); throw error; }
      catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing; }
    } finally {
      try { await purgeExactDirectory(slot, ready.parent); }
      catch { status.set(poolRoot(), { state: 'held', reason: 'exact-cleanup-refused' }); }
    }
  }
  return null;
}

async function refill(sourceWorkspace: string, recipe: DependencyInstallRecipe, sourceIdentity: WorktreeMaterializationIdentity, graph: Graph, keyIdentity: WorktreeMaterializationIdentity): Promise<void> {
  const root = poolRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootIdentity = await captureWorktreeMaterializationIdentity(root);
  const mode = await lstat(root);
  if ((mode.mode & 0o077) !== 0) throw new Error('Dependency pool root is not private.');
  const key = dependencyDirectoryPoolKey(recipe, keyIdentity, graph.digest);
  const matches = dependencyCloneSourceMatcher(sourceWorkspace, sourceIdentity, recipe,
    recipe.lifecycleScripts === 'enabled' && recipe.cloneLifecycleInputs === undefined);
  for (let index = 0; index < DEPENDENCY_POOL_POLICY.maxTrees; index += 1) {
    const slot = path.join(root, `slot-${index}`);
    await assertWorktreeMaterializationIdentity(root, rootIdentity);
    await recoverDependencyPoolSlot(slot, rootIdentity);
    const previous = await readReady(slot);
    if (previous && previous.parent.canonicalPath !== path.join(rootIdentity.canonicalPath, `slot-${index}`)) continue;
    if (previous?.key === key && previous.payload) continue;
    if (previous && await claim(previous)) {
      await assertWorktreeMaterializationIdentity(root, rootIdentity);
      await purgeExactDirectory(slot, previous.parent);
    }
    await assertWorktreeMaterializationIdentity(root, rootIdentity);
    let created: { device: number; inode: number };
    try { created = await createExactChildDirectory(root, rootIdentity, slot, 0o700); }
    catch (error) {
      // Another process may have reserved this fixed name. Never adopt it.
      try { await lstat(slot); continue; }
      catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing; }
      throw error;
    }
    const parent = await captureWorktreeMaterializationIdentity(slot);
    if (parent.device !== created.device || parent.inode !== created.inode) throw new Error('Dependency pool slot changed after creation.');
    const id = `dependency-pool:${randomUUID()}`;
    await writeExactChildFile(slot, parent, path.join(slot, 'owner.json'), JSON.stringify(dependencyPoolOwner(parent, id)), 0o600);
    let reservation: Awaited<ReturnType<typeof reserveStorage>>['reservation'] = null;
    let record: ReadyTree | null = null;
    try {
      await assertWorktreeMaterializationIdentity(sourceWorkspace, sourceIdentity);
      if (parent.device !== sourceIdentity.device || !await matches()
        || !await dependencyCloneSnapshotMatches(sourceWorkspace, graph.snapshot)) throw new Error('Dependency pool source changed.');
      const sourcePayload = await readDependencyPayloadReceipt(sourceWorkspace, sourceIdentity, recipe, graph);
      const measured = await measureDirectoryStorage(path.join(sourceWorkspace, 'node_modules'));
      if (measured.logicalBytes === null || measured.logicalBytes > DEPENDENCY_POOL_POLICY.maxTreeBytes) throw new Error('Dependency pool tree exceeds its byte budget or cannot be measured.');
      const admitted = await reserveStorage({ mutationId: id, reservationId: id, targetPath: slot,
        rootIdentity: { canonicalPath: parent.canonicalPath, device: String(parent.device), inode: String(parent.inode) },
        exactBytes: DEPENDENCY_POOL_POLICY.maxTreeBytes, ownerId: id, ownerGeneration: 1, leaseExpiresAt: Date.now() + 5 * 60_000 });
      if (admitted.decision !== 'reserved' || !admitted.reservation) throw new Error(`Dependency pool storage held: ${admitted.reason}`);
      reservation = admitted.reservation;
      for (const name of ['package.json', recipe.lockfile.path]) {
        const contents = await readPinnedWorkspaceFile(sourceWorkspace, sourceIdentity, name);
        if (contents === null) throw new Error('Dependency pool source input missing.');
        await writePinnedWorkspaceFile(slot, parent, name, contents);
      }
      const cloned = await clonePinnedWorkspaceDirectory(slot, parent, 'node_modules', path.join(sourceWorkspace, 'node_modules'));
      if (cloned.disposition !== 'created' || cloned.sourceChanged) throw new Error('Dependency pool clone unavailable or changed.');
      const target = await validateDependencyCloneGraph(slot, recipe.lockfile.path);
      if (!target || target.digest !== graph.digest || !await matches()
        || !await dependencyCloneSnapshotMatches(sourceWorkspace, graph.snapshot)) throw new Error('Dependency pool validation changed.');
      const captured = await inspectDependencyPayload(slot, parent, target.entrypoints);
      if (captured.contents !== sourcePayload.contents || captured.device !== cloned.device || captured.inode !== cloned.inode) throw new DependencyPayloadRefusal('payload-changed');
      await probeDependencyCloneNativeFiles(slot, parent, target.nativeFiles);
      if (!await dependencyCloneSnapshotMatches(slot, target.snapshot)) throw new Error('Dependency pool native validation changed.');
      const payload = await sealDependencyPayload(slot, parent, recipe, target, captured, cloned);
      const recordedGraph = await validateDependencyCloneGraph(slot, recipe.lockfile.path);
      if (!recordedGraph || recordedGraph.digest !== graph.digest) throw new DependencyPayloadRefusal('payload-changed');
      await readDependencyPayloadReceipt(sourceWorkspace, sourceIdentity, recipe, graph, sourcePayload);
      const finalSize = await measureDirectoryStorage(path.join(slot, 'node_modules'));
      if (finalSize.logicalBytes === null || finalSize.logicalBytes > DEPENDENCY_POOL_POLICY.maxTreeBytes) throw new Error('Dependency pool clone exceeds its byte budget.');
      record = { schema: 'o8/dependency-directory-pool/v1', key, parent, tree: cloned, graph: recordedGraph, payload, logicalBytes: finalSize.logicalBytes };
    } finally {
      if (reservation) {
        const released = await releaseStorageReservation({ mutationId: `${reservation.reservationId}:release`, reservationId: reservation.reservationId,
          volumeId: reservation.volumeId, ownerId: reservation.ownerId, ownerGeneration: reservation.ownerGeneration, expectedGeneration: reservation.generation });
        if (released.decision !== 'released') throw new Error(`Dependency pool release held: ${released.reason}`);
      }
      if (!record) await purgeExactDirectory(slot, parent);
    }
    await writeExactChildFile(slot, parent, path.join(slot, 'ready.json'), JSON.stringify(record), 0o600);
    status.set(root, { state: 'ready', reason: null });
  }
}

/** Cold misses keep the existing path. Refill never delays or rejects dispatch. */
export function queueDependencyDirectoryPoolRefill(sourceWorkspace: string, recipe: DependencyInstallRecipe, sourceIdentity: WorktreeMaterializationIdentity, graph: Graph, keyIdentity = sourceIdentity): void {
  const root = poolRoot();
  if (refills.has(root)) return;
  status.set(root, { state: 'refilling', reason: null });
  const pending = new Promise<void>((resolve) => setImmediate(resolve)).then(() => refill(sourceWorkspace, recipe, sourceIdentity, graph, keyIdentity))
    .catch((error: unknown) => { status.set(root, { state: 'held', reason: error instanceof Error ? error.message : 'refill-failed' }); })
    .finally(() => { refills.delete(root); });
  refills.set(root, pending);
}

export async function dependencyDirectoryPoolStatus() {
  const trees = await Promise.all(Array.from({ length: DEPENDENCY_POOL_POLICY.maxTrees }, (_, index) => readReady(path.join(poolRoot(), `slot-${index}`))));
  const occupied = await Promise.all(Array.from({ length: DEPENDENCY_POOL_POLICY.maxTrees }, async (_, index) => {
    try { await lstat(path.join(poolRoot(), `slot-${index}`)); return 1; } catch { return 0; }
  }));
  const occupiedSlots = occupied.reduce<number>((total, count) => total + count, 0);
  const readyTrees = trees.filter(Boolean).length;
  return { policy: DEPENDENCY_POOL_POLICY, ...status.get(poolRoot()), readyTrees, occupiedSlots, heldSlots: occupiedSlots - readyTrees,
    logicalBytes: trees.reduce((total, tree) => total + (tree?.logicalBytes ?? 0), 0) };
}

/** Await background work at fixture/shutdown boundaries, never from dispatch. */
export async function waitForDependencyDirectoryPool(): Promise<void> { await refills.get(poolRoot()); }
