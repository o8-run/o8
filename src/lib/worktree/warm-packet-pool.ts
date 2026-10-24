import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { appendEvent } from '@/lib/lane/registry';
import { readPinnedLaneCreationBaseCommit } from '@/lib/lane/creation-base';
import { renameExactChildDirectory } from '@/lib/workspace/exact-parent-operation';
import { isDependencyMaterializationIncomplete, verifyDependencyMaterialization } from '@/lib/workspace/dependency-materialization-verification';
import { assertWorktreeMaterializationIdentity, captureWorktreeMaterializationIdentity, type WorktreeMaterializationIdentity } from './materialization-identity';
import { materializationAwareExecFile, withWorktreeMaterializationExecution } from './materialization-execution';
import { inspectPinnedWorkspaceEntry, readPinnedWorkspaceFile, readPinnedWorkspaceFileReceipt } from './materialization-leaf-io';
import { assertWarmFilesystemBudget, assertWarmPacketSlot, reserveWarmPacketSlot } from './warm-packet-budget';
import { assertWarmPacketSeal, type WarmPacketSeal } from './warm-packet-integrity';
import { allowWorktreeRemoval } from './live-process-guard';
import { settlePinnedWorkspaceReadSession } from './materialization-read-session';
import { listReposFresh } from '@/lib/repos/registry';
import { recoverWarmPacketTransfers } from './warm-packet-recovery';
import { readWorktreeMetaSnapshot, withWorktreeMetaTransaction } from './metadata-store';
import type { WorktreeManager } from './manager';
import type { WorktreeLaunchOptions } from './launch';
import type { CreateWorktreeOptions, WorktreeInfo, WorktreeMetaEntry } from './types';

// Process-wide caps include entries currently being built. Only one installer
// runs at a time, outside the dispatch provision queue. No packet is recycled.
const MAX_ENTRIES = 2;
const MAX_ENTRY_BYTES = 4 * 1024 ** 3;
const MAX_BYTES = MAX_ENTRIES * MAX_ENTRY_BYTES;
const entries: Entry[] = [];
const requests = new Map<string, Request>();
const pending: Array<{ request: Request; token: string; info?: WorktreeInfo; }> = [];
const recovered = new Set<string>();
let building: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
let foregroundQuietUntil = 0;
const FOREGROUND_QUIET_MS = 5_000;
const activeBindings = new Set<Promise<void>>();
let refresh: ReturnType<typeof setInterval> | null = null;

function startRefresh(): void {
  if (refresh || stopped) return;
  refresh = setInterval(() => {
    if (requests.size) queueRefill(0);
  }, 30_000);
  refresh.unref();
}

export type WarmPacketOptions = Pick<WorktreeLaunchOptions, 'repoRoot' | 'agentType' | 'baseBranch' | 'repoSetup' | 'isolationPreference'> & { capacity?: 1 | 2 };
interface Request { opts: WarmPacketOptions; manager: WorktreeManager; }
interface Entry {
  request: Request;
  key: string;
  head: string;
  info: WorktreeInfo;
  identity: WorktreeMaterializationIdentity;
  dependencies: WorktreeMaterializationIdentity;
  hooks: NonNullable<Awaited<ReturnType<typeof readPinnedWorkspaceFileReceipt>>>;
  bytes: number;
  seal: WarmPacketSeal;
  state: 'ready' | 'held' | 'retiring' | 'binding';
}
const git = (cwd: string, args: string[]) => materializationAwareExecFile('git', args, { cwd, windowsHide: true, timeout: 5_000 });

async function fingerprint(opts: WarmPacketOptions): Promise<{ key: string; head: string; } | null> {
  if ((opts.baseBranch ?? 'main') !== 'main') return null;
  const identity = await captureWorktreeMaterializationIdentity(opts.repoRoot);
  return withWorktreeMaterializationExecution(opts.repoRoot, identity, async () => {
    const refs = (await git(opts.repoRoot, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/main', 'refs/remotes/origin/main'])).stdout.trim().split('\n');
    const localMain = refs.find(row => row.startsWith('refs/heads/main '))?.split(' ')[1];
    const head = refs.find(row => row.startsWith('refs/remotes/origin/main '))?.split(' ')[1] ?? localMain;
    if (!head) return null;
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head)) return null;
    const hash = createHash('sha256').update(JSON.stringify({
      head, localMain, setup: opts.repoSetup, isolation: opts.isolationPreference ?? opts.repoSetup?.workspaceIsolationPreference ?? 'auto',
      abi: process.versions.modules, platform: process.platform, arch: process.arch
    }));
    // Working lockfile changes invalidate even before they are committed to main.
    // Pinned reads refuse symlinks, hardlinks and replaced ancestors.
    for (const file of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']) {
      hash.update(file).update(await readPinnedWorkspaceFile(opts.repoRoot, identity, file) ?? '<absent>');
    }
    return { key: hash.digest('hex'), head };
  });
}

async function retire(entry: Entry): Promise<void> {
  if (entry.state !== 'ready' && entry.state !== 'held') throw new Error('Warm worktree is already claimed.');
  entry.state = 'retiring';
  // Retain the slot and disk charge if exact cleanup refuses ownership.
  try {
    await entry.request.manager.retireWarmWorktree(entry.info.id);
    const index = entries.indexOf(entry);
    if (index >= 0) entries.splice(index, 1);
  } catch (error) { entry.state = 'held'; throw error; }
}

async function currentRequest(request: Request): Promise<boolean> {
  if (stopped || requests.get(request.opts.repoRoot) !== request) return false;
  const repo = (await listReposFresh()).find(repo => repo.localPath === request.opts.repoRoot);
  if (!repo?.setup?.installOnCreateWorkspace || !repo.setup.installCommand
    || !isDeepStrictEqual(repo.setup, request.opts.repoSetup)) {
    if (requests.get(request.opts.repoRoot) === request) requests.delete(request.opts.repoRoot);
    return false;
  }
  return true;
}

async function fill(): Promise<void> {
  for (const request of requests.values()) {
    if (stopped || performance.now() < foregroundQuietUntil) return;
    if (!await currentRequest(request)) continue;
    await assertWarmFilesystemBudget(request.opts.repoRoot);
    if (!recovered.has(request.opts.repoRoot)) {
      await recoverWarmPacketTransfers(request.opts.repoRoot, request.manager);
      const old = await readWorktreeMetaSnapshot(request.opts.repoRoot);
      for (const entry of Object.values(old)) {
        if (entry.warmPool && !entries.some(ready => ready.info.id === entry.id)) {
          await request.manager.retireWarmWorktree(entry.id);
        }
      }
      recovered.add(request.opts.repoRoot);
    }
    const current = await fingerprint(request.opts);
    for (const entry of [...entries]) {
      if (entry.state !== 'binding' && entry.request.opts.repoRoot === request.opts.repoRoot && entry.key !== current?.key) await retire(entry);
    }
    if (!current || !await currentRequest(request)) continue;
    while (!stopped && performance.now() >= foregroundQuietUntil && entries.length + pending.length < MAX_ENTRIES
      && entries.filter(entry => entry.request.opts.repoRoot === request.opts.repoRoot).length < Math.min(MAX_ENTRIES, Math.max(1, request.opts.capacity ?? MAX_ENTRIES))
      && entries.reduce((n, entry) => n + entry.bytes, 0) + MAX_ENTRY_BYTES <= MAX_BYTES) {
      if (!await currentRequest(request)) break;
      const token = reserveWarmPacketSlot(request.opts.repoRoot);
      if (!token) break;
      const reservation: { request: Request; token: string; info?: WorktreeInfo; } = { request, token };
      pending.push(reservation);
      try {
        const { worktree: info, hooks } = await request.manager.prepareWarmWorktree({
          agentType: request.opts.agentType, taskName: `warm-${token}`, baseBranch: 'main',
          warmBaseCommit: current.head, warmReservationToken: token, repoSetup: request.opts.repoSetup, isolationPreference: request.opts.isolationPreference,
        }, created => { reservation.info = created; });
        const identity = await captureWorktreeMaterializationIdentity(info.path);
        if ((await inspectPinnedWorkspaceEntry(info.path, identity, '.git'))?.kind !== 'file') throw new Error('Warm pool requires a linked Git worktree, not a private Git clone.');
        const seal = (await readWorktreeMetaSnapshot(request.opts.repoRoot))[info.id]?.warmPool?.seal;
        if (!seal) throw new Error('Warm worktree has no original sealed inventory.');
        const dependencies = await captureWorktreeMaterializationIdentity(path.join(info.path, 'node_modules'));
        const { stdout } = await withWorktreeMaterializationExecution(info.path, identity, () => (
          materializationAwareExecFile('du', ['-sk', '.'], { cwd: info.path, windowsHide: true, timeout: 30_000 })
        ));
        const bytes = Number(stdout.trim().split(/\s/)[0]) * 1024;
        const entry: Entry = { request, ...current, info, identity, dependencies, hooks, seal, bytes, state: 'ready' };
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_ENTRY_BYTES || stopped
          || !await currentRequest(request) || (await fingerprint(request.opts))?.key !== current.key) {
          await request.manager.retireWarmWorktree(info.id);
          pending.splice(pending.indexOf(reservation), 1);
          break;
        }
        entries.push(entry);
        pending.splice(pending.indexOf(reservation), 1);
      } catch (error) {
        if (reservation.info) {
          const entry = entries.find(entry => entry.info.id === reservation.info!.id);
          if (entry) entry.state = 'held';
          await withWorktreeMetaTransaction(request.opts.repoRoot, async transaction => {
            const meta = (await transaction.readAll())[reservation.info!.id];
            if (meta?.warmPool?.slotToken === token) await transaction.save(meta.id, { ...meta, warmPool: { ...meta.warmPool, held: true } });
          });
        }
        throw error;
      }
    }
  }
}

/** Awaitable for lifecycle tests and idle startup; dispatch never awaits a refill. */
export async function prepareWarmPacketWorktrees(opts: WarmPacketOptions, manager: WorktreeManager): Promise<void> {
  if (stopped || process.platform !== 'linux') return;
  if (!opts.repoSetup?.installOnCreateWorkspace || !opts.repoSetup.installCommand) { requests.delete(opts.repoRoot); return; }
  requests.set(opts.repoRoot, { opts, manager });
  startRefresh();
  if (!building) {
    building = fill().finally(() => { building = null; });
  }
  await building;
}

export function scheduleWarmPacketWorktrees(opts: WarmPacketOptions, manager: WorktreeManager): void {
  if (stopped || process.platform !== 'linux') return;
  // Credential-policy validation also runs in generated child helpers. Keep
  // new background spawns outside every foreground worker's startup window.
  foregroundQuietUntil = Math.max(foregroundQuietUntil, performance.now() + FOREGROUND_QUIET_MS);
  if (!opts.repoSetup?.installOnCreateWorkspace || !opts.repoSetup.installCommand) { requests.delete(opts.repoRoot); return; }
  requests.set(opts.repoRoot, { opts, manager });
  startRefresh();
  queueRefill(FOREGROUND_QUIET_MS);
}

function queueRefill(delay: number): void {
  if (timer || stopped) return;
  const refill = () => {
    timer = null;
    if (stopped) return;
    const remaining = foregroundQuietUntil - performance.now();
    if (remaining > 0) {
      timer = setTimeout(refill, remaining);
      timer.unref();
      return;
    }
    const filling = building ?? (building = fill().finally(() => { building = null; }));
    void filling.catch(() => { /* Cold provisioning remains authoritative. */ });
  };
  timer = setTimeout(refill, delay);
  timer.unref();
}

export async function shutdownWarmPacketWorktrees(): Promise<void> {
  stopped = true;
  if (timer) clearTimeout(timer);
  if (refresh) clearInterval(refresh);
  timer = null;
  refresh = null;
  await Promise.all([...activeBindings]);
  await building?.catch (() => { });
  const results = await Promise.allSettled([
    ...entries.map(retire),
    ...pending.filter(slot => slot.info).map(slot => slot.request.manager.retireWarmWorktree(slot.info!.id)),
  ]);
  requests.clear();
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Warm worktree shutdown retained an unproven workspace.');
}

export async function bindWarmPacketWorktree(input: {
  repoRoot: string; opts: CreateWorktreeOptions; taskId: string; branchName: string; baseBranch: string;
  creationBaseCommit: string | null; worktreePath: string; baseExecutionIdentity: WorktreeMaterializationIdentity;
  creationOwner: NonNullable<WorktreeMetaEntry['creationOwner']>;
}): Promise<WorktreeInfo | null> {
  const { opts, repoRoot, taskId, branchName, baseBranch, worktreePath, baseExecutionIdentity } = input;
  if (stopped || !opts.packetId || !opts.laneId || opts.skipSetup || opts.materializationOnly || !entries.length) return null;
  const current = await fingerprint({ repoRoot, ...opts });
  const pinnedHead = input.creationBaseCommit ?? readPinnedLaneCreationBaseCommit(opts.laneId);
  if (!current || pinnedHead !== current.head) return null;
  const index = entries.findIndex(entry => entry.state === 'ready' && entry.key === current.key && entry.request.opts.repoRoot === repoRoot);
  if (index < 0) return null;
  const entry = entries[index]!;
  entry.state = 'binding';
  let release!: () => void;
  const completion = new Promise<void>(resolve => { release = resolve; });
  activeBindings.add(completion);
  try {
    await settlePinnedWorkspaceReadSession();
    await assertWorktreeMaterializationIdentity(entry.info.path, entry.identity);
    await assertWorktreeMaterializationIdentity(path.join(entry.info.path, 'node_modules'), entry.dependencies);
    const hooks = await readPinnedWorkspaceFileReceipt(entry.info.path, entry.identity, '.claude/settings.local.json');
    if (!hooks || hooks.device !== entry.hooks.device || hooks.inode !== entry.hooks.inode || hooks.content !== entry.hooks.content) {
      throw new Error('Warm worktree safety settings changed before binding.');
    }
    const meta = (await readWorktreeMetaSnapshot(repoRoot))[entry.info.id];
    if (!meta || meta.status !== 'setup' || meta.sessionKey || meta.packetId || meta.environmentReferences
      || !meta.warmPool || meta.warmPool.held || meta.dependencyMaterialization?.mode !== 'native') throw new Error('Warm worktree lost its unused native ownership.');
    if (JSON.stringify(meta.warmPool.seal) !== JSON.stringify(entry.seal)) throw new Error('Warm worktree lost its original durable seal.');
    assertWarmPacketSlot(repoRoot, meta.warmPool.slotToken, entry.info.id);
    if (!await allowWorktreeRemoval(entry.info.path, { logPrefix: 'warm-binding' })) throw new Error('Warm worktree has a live or unknown process.');
    await assertWarmPacketSeal(entry.info.path, entry.identity, entry.seal);
    await withWorktreeMaterializationExecution(entry.info.path, entry.identity, async () => {
      const head = (await git(entry.info.path, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
      if (head !== current.head || (await git(entry.info.path, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim()) {
        throw new Error('Warm worktree changed before packet binding.');
      }
    });
    const nextIdentity = { ...entry.identity, canonicalPath: path.join(baseExecutionIdentity.canonicalPath, taskId) };
    let renamed = false;
    let rebound = false;
    let targetPublished = false;
    try {
      await withWorktreeMetaTransaction(repoRoot, async transaction => {
        const currentMetadata = await transaction.readAll();
        if (currentMetadata[taskId]) throw new Error('Warm packet destination already has an owner.');
        if (JSON.stringify(currentMetadata[entry.info.id]) !== JSON.stringify(meta)) throw new Error('Warm source ownership changed before transfer.');
        // Publish target authority BEFORE rename; a crash never leaves an unowned tree.
        const { warmPool: _warmPool, ...packetMeta } = meta;
        void _warmPool;
        await transaction.save(taskId, {
          ...packetMeta, id: taskId, packetId: opts.packetId, laneId: opts.laneId,
          agentType: opts.agentType, branchName, baseBranch, taskName: opts.taskName, status: 'creating',
          warmTransfer: { sourceId: entry.info.id, sourceBranch: entry.info.branch, head: current.head,
            seal: entry.seal, slotToken: meta.warmPool!.slotToken },
          materializationIdentity: nextIdentity, materializationParentIdentity: baseExecutionIdentity, creationOwner: input.creationOwner
        });
        targetPublished = true;
        if ((await fingerprint({ repoRoot, ...opts }))?.key !== current.key) throw new Error('Warm generation changed during binding.');
        if (!await allowWorktreeRemoval(entry.info.path, { logPrefix: 'warm-rename' })) throw new Error('Warm worktree acquired a live process before rename.');
        await renameExactChildDirectory(path.dirname(worktreePath), baseExecutionIdentity, entry.info.path, worktreePath, entry.identity);
        renamed = true;
        await assertWorktreeMaterializationIdentity(worktreePath, nextIdentity);
        if (entry.info.isolationKind === 'git-worktree') {
          const repoIdentity = await captureWorktreeMaterializationIdentity(repoRoot);
          await withWorktreeMaterializationExecution(repoRoot, repoIdentity, () => git(repoRoot, ['worktree', 'repair', worktreePath]));
        }
        await withWorktreeMaterializationExecution(worktreePath, nextIdentity, async () => {
          await git(worktreePath, ['branch', '-m', branchName]);
          rebound = true;
          const verification = await verifyDependencyMaterialization(worktreePath);
          if (isDependencyMaterializationIncomplete(verification)) throw new Error('Warm packet dependencies failed launch verification.');
          appendEvent(opts.laneId!, 'dependency_materialized', 'system', {
            packetId: opts.packetId,
            mode: 'native', recipeKey: entry.info.dependencyRecipeKey, source: 'warm-worktree', ...verification
          });
          appendEvent(opts.laneId!, 'worktree_preparation_timing', 'system', {
            packetId: opts.packetId,
            stage: 'dependency_selection', path: 'warm-worktree', reason: 'matching-main-and-lockfile'
          });
        });
        await assertWarmPacketSeal(worktreePath, nextIdentity, entry.seal, true, branchName);
        if (!await allowWorktreeRemoval(worktreePath, { logPrefix: 'warm-bound' })) throw new Error('Warm worktree acquired a live process during binding.');
        await transaction.remove(entry.info.id);
      });
    } catch (error) {
      // An exact operation may report a post-rename proof failure. Recover only
      // if the target still proves the captured source inode.
      if (!renamed) renamed = await assertWorktreeMaterializationIdentity(worktreePath, nextIdentity).then(() => true, () => false);
      if (targetPublished) await withWorktreeMetaTransaction(repoRoot, async transaction => {
        const target = (await transaction.readAll())[taskId];
        if (target?.warmTransfer?.sourceId !== entry.info.id
          || target.materializationIdentity?.inode !== nextIdentity.inode
          || target.materializationIdentity.device !== nextIdentity.device
          || target.packetId !== opts.packetId || target.laneId !== opts.laneId) {
          throw new Error('Warm rollback lost its exact target metadata authority.');
        }
        if (renamed) {
          await assertWorktreeMaterializationIdentity(worktreePath, nextIdentity);
          if (rebound) await withWorktreeMaterializationExecution(worktreePath, nextIdentity, () => git(worktreePath, ['branch', '-m', entry.info.branch]));
          await renameExactChildDirectory(path.dirname(worktreePath), baseExecutionIdentity, worktreePath, entry.info.path, nextIdentity);
          if (entry.info.isolationKind === 'git-worktree') {
            const repoIdentity = await captureWorktreeMaterializationIdentity(repoRoot);
            await withWorktreeMaterializationExecution(repoRoot, repoIdentity, () => git(repoRoot, ['worktree', 'repair', entry.info.path]));
          }
        }
        await transaction.save(entry.info.id, meta);
        await transaction.remove(taskId);
      });
      throw error;
    }
    entries.splice(entries.indexOf(entry), 1);
    return { ...entry.info, id: taskId, path: worktreePath, branch: branchName, agentType: opts.agentType, status: 'setup' };
  } catch (error) { entry.state = 'held'; throw error; }
  finally { release(); activeBindings.delete(completion); }
}
