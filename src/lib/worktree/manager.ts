import { assertNotKnowledgeSource } from '@/lib/cortex/knowledge/sources';
/**
 * WorktreeManager — Orchestration Layer for Git Worktree Isolation
 *
 * Manages worktree lifecycle for ALL agent types:
 * - Default path (Codex, Claude Code as of #608): creates and manages the
 *   worktree via git commands, runs a pre-launch rebase onto origin/<base>,
 *   and spawns the agent with cwd=<worktreePath>.
 * - Legacy claude-managed path (only when `opts.managed` is falsy): records
 *   metadata only, lets the Claude CLI handle worktree creation itself via
 *   its `--worktree` flag. Retained so existing in-flight lanes keep working;
 *   new launches pass `managed: true` to force the managed path.
 *
 * Thin orchestration on top of git worktree + agent-specific behavior.
 *
 * Designed to generalize to IsolationProvider (containers, VMs) in 2028.
 *
 * @see https://github.com/o8-run/o8/issues/65
 * @see https://github.com/o8-run/o8/issues/66
 * @see https://github.com/o8-run/o8/issues/608
 */

import { access, lstat, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { mayHaveGitRepositoryContext } from '@/lib/git/repository-context';
import { taskDraftGitOptions } from '@/lib/mcp/task-draft-git';
import { assertReviewMaterializationOptions, finishReviewMaterialization } from './review-materialization';
import type {
  CleanupOptions,
  ConflictReport,
  CreateWorktreeOptions,
  WorktreeInfo,
  WorktreeMetaEntry,
  WorktreeStatus,
  WorkspaceIsolationKind,
  WorkspaceIsolationPreference,
} from './types';
import { getApfsCowCapability } from './apfs';
import { bootstrapEnvironmentFiles } from './environment-bootstrap';
import { finalizeCloneBranchRefs } from './clone-branch-refs';
import { worktreeActivityMtimeMs } from './activity';
import {
  readWorktreeMetaSnapshot,
  withWorktreeMetadataBoundary,
  withWorktreeMetaTransaction,
} from './metadata-store';
import { allowWorktreeRemoval } from './live-process-guard';
import {
  assertWorktreeMaterializationIdentity,
  captureWorktreeMaterializationIdentity,
} from './materialization-identity';
import {
  isMaterializationExecutionRefusal,
  materializationAwareExecFile,
  withWorktreeMaterializationExecution,
} from './materialization-execution';
import {
  createPinnedWorkspaceBinding,
  ensurePinnedWorkspaceDirectory,
  inspectPinnedWorkspaceEntry,
  isPinnedWorkspacePublishError,
  readPinnedWorkspaceFile,
  readPinnedWorkspaceFileReceipt,
} from './materialization-leaf-io';
import {
  completeExactManagedDirectoryRetirement,
  finishPendingExactManagedDirectoryRetirements,
  retireExactManagedDirectory,
} from '@/lib/workspace/exact-managed-directory-retirement';
import { readExactWorkspaceClaim } from '@/lib/workspace/exact-workspace-claim-state';
import { assertWorkspaceRetentionReleased } from '@/lib/workspace/retention-holds';
import { assertManagedRetirementQuiescence, withManagedRetirementOwnership } from '@/lib/workspace/retirement-process-authority';
import {
  confirmWorkspaceMaterializationRetirement,
  finishWorkspaceMaterializationRetirement,
  getWorkspaceRetirementAction,
  prepareWorkspaceMaterializationRetirement,
  rollbackWorkspaceMaterializationRetirement,
} from '@/lib/workspace/workspace-materialization-retirement';
import type { StorageRootIdentity } from '@/lib/workspace/storage-admission';
import {
  appendWorktreeCollisionSuffix,
  assertManagedWorktreeCreatedBoundary,
  assertManagedWorktreeMaterializationBoundary,
  managedPacketWorktreeId,
  resolveWorktreeRootLayout,
  WORKTREE_INDEX_EXCLUSION_SUFFIX,
} from './root-layout';
import { withManagedWorktreeRegistryQueue, withManagedWorktreeStorageAdmission } from './launch-storage-admission';
import { bindWarmPacketWorktree } from './warm-packet-pool';
import { assertWarmFilesystemBudget, assertWarmPacketSlot, markWarmPacketMaterializationStarted, releaseWarmPacketSlot } from './warm-packet-budget';
import { assertWarmPacketSeal, captureWarmPacketSeal } from './warm-packet-integrity';
import { settlePinnedWorkspaceReadSession } from './materialization-read-session';
import {
  gitCommandErrorMessage,
  shouldClassifyFetchAsOriginMissing,
} from './errors';
import {
  detectDependencyInstallCommand,
} from '@/lib/workspace/dependency-install';
import {
  detachDependencyMaterialization,
  materializeDependencyInstall,
  queueDependencyImagePublication,
  type DependencyMaterializationReceipt,
} from '@/lib/workspace/dependency-materializer';
import { retireDependencyImage } from '@/lib/workspace/apfs-dependency-image';
import {
  DEPENDENCY_MATERIALIZATION_INCOMPLETE,
  DependencyMaterializationIncompleteError,
  isDependencyMaterializationIncomplete,
  verifyDependencyMaterialization,
} from '@/lib/workspace/dependency-materialization-verification';
import { applyWorkspaceManifest } from '@/lib/workspace/manifest/apply';
import {
  probeMetadataLockProcessIdentity,
  sameMetadataLockProcessIdentity,
} from './metadata-lock-process-identity';
import { writeManagedWorkspaceSafetyHooks } from './safety-hooks';
import { recordDependencySelection, timeWorktreePreparation } from './preparation-timing';

const execFileAsync = materializationAwareExecFile;
const TRASH_DIR_NAME = '.o8-trash';
const CLAUDE_WORKTREE_DIR = '.claude/worktrees';
const STALE_THRESHOLD_MS = 24 * 60 * 60_000; // 24 hours
const RETENTION_CREATION_GRACE_MS = 5 * 60_000;
const AUTO_PRUNE_COOLDOWN_MS = 6 * 60 * 60_000; // 6 hours
const APFS_COW_ENV_FLAG = 'O8_APFS_COW_WORKSPACES';
const APFS_HYDRATION_CANDIDATES = [
  '.next/cache',
  '.turbo',
  '.venv',
  'vendor',
  'target',
  'Pods',
  'DerivedData',
];
let lastAutoPruneAt = 0;
let autoPrunePromise: Promise<unknown> | null = null;

export type WorktreeRebaseStrategy = 'ours' | 'theirs';

/**
 * Thrown when a worktree cannot be rebased onto its base branch cleanly.
 * Carries the conflicting files + base branch so callers can enqueue a
 * supervisor inbox item and surface the conflict to the operator instead
 * of handing a broken tree to codex (which would generate a diff that
 * reverts already-merged upstream work).
 */
export class WorktreeRebaseConflictError extends Error {
  public readonly baseBranch: string;
  public readonly conflictFiles: string[];
  public readonly worktreePath: string;
  public readonly branch: string;

  constructor(options: {
    baseBranch: string;
    conflictFiles: string[];
    worktreePath: string;
    branch: string;
    message?: string;
  }) {
    super(
      options.message
        ?? `Worktree rebase onto origin/${options.baseBranch} failed with ${options.conflictFiles.length} conflicting file${options.conflictFiles.length === 1 ? '' : 's'}.`,
    );
    this.name = 'WorktreeRebaseConflictError';
    this.baseBranch = options.baseBranch;
    this.conflictFiles = options.conflictFiles;
    this.worktreePath = options.worktreePath;
    this.branch = options.branch;
  }
}

/**
 * Thrown when `git fetch origin <baseBranch>` fails AND the local base
 * branch ref is older than the freshness window (default 5 min), so we
 * can't safely fall back to the local ref — the agent would branch from
 * a stale base and generate a diff full of already-merged upstream work.
 *
 * Caller surfaces this as a `fetch_unreachable` supervisor inbox kind so
 * the operator can run `git fetch` manually, reconnect, and retry.
 */
export class WorktreeFetchUnreachableError extends Error {
  public readonly baseBranch: string;
  public readonly worktreePath: string;
  public readonly branch: string;
  public readonly localRefAgeMs: number;
  public readonly fetchErrorMessage: string;

  constructor(options: {
    baseBranch: string;
    worktreePath: string;
    branch: string;
    localRefAgeMs: number;
    fetchErrorMessage: string;
    message?: string;
  }) {
    super(
      options.message
        ?? `fetch origin ${options.baseBranch} failed and local ref is stale (${Math.round(options.localRefAgeMs / 60_000)} min old).`,
    );
    this.name = 'WorktreeFetchUnreachableError';
    this.baseBranch = options.baseBranch;
    this.worktreePath = options.worktreePath;
    this.branch = options.branch;
    this.localRefAgeMs = options.localRefAgeMs;
    this.fetchErrorMessage = options.fetchErrorMessage;
  }
}

/**
 * Thrown when a freshly-created worktree's tsc fails before we hand it to an
 * agent. Indicates main HEAD is in an internally-inconsistent state (e.g. a
 * non-atomic commit landed the consumer side of a refactor without the
 * matching producer). Catching this here prevents the loop's classic failure
 * mode: every Codex diff appears clean against the broken base, and every
 * subsequent merge fails with tsc errors that don't belong to the agent.
 * See #1107.
 */
/**
 * Executable names for the repo-local `tsc`, in resolution order.
 *
 * npm writes TWO files into node_modules/.bin: an extensionless shell script
 * for POSIX, and a `.cmd` shim that is the only one Windows can execute.
 * Pointing execFile at the bare name therefore fails on Windows even when
 * TypeScript is installed — and because a failure here is reported as "the base
 * branch is broken", that turned into a permanent, entirely misdiagnosed
 * dispatch blocker on Windows. Same trap as #1758, second location.
 */
const TSC_SCRIPT = 'node_modules/typescript/bin/tsc';

export class WorktreeBaseTypecheckError extends Error {
  public readonly baseBranch: string;
  public readonly worktreePath: string;
  public readonly branch: string;
  public readonly tscOutput: string;

  constructor(options: {
    baseBranch: string;
    worktreePath: string;
    branch: string;
    tscOutput: string;
    message?: string;
  }) {
    super(
      options.message
        ?? `Base typecheck failed for ${options.baseBranch} before launch — main HEAD is in an inconsistent state. Commit any pending matching changes (e.g. hook updates) before dispatching.`,
    );
    this.name = 'WorktreeBaseTypecheckError';
    this.baseBranch = options.baseBranch;
    this.worktreePath = options.worktreePath;
    this.branch = options.branch;
    this.tscOutput = options.tscOutput;
  }
}

/** Age threshold for local base-branch ref on fetch failure (5 min). */
const LOCAL_BASE_REF_FRESHNESS_MS = 5 * 60_000;

/**
 * Sanitize a task name into a safe directory/branch name.
 * Replaces spaces with dashes, strips special chars, lowercases.
 */
function sanitizeTaskName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/**
 * Derive the worktree directory id from create options.
 *
 * When a `packetId` is provided we use the `packet-<sanitized>` prefix so two
 * packets dispatched in parallel never collide on the same dir slot — the
 * old behaviour collapsed every codex packet whose prompt summarised to
 * "context" into `.cortex-worktrees/context`. The `packet-` prefix also
 * matches the regex in `src/lib/runtimes/claude-code.ts` (`\.cortex-worktrees[\/\\]packet-/`)
 * so orchestrator session detection picks them up uniformly across runtimes.
 *
 * Without a packetId (scratch launches, diff-apply, etc.) we fall back to
 * the taskName-derived slug. Manager-created leaves append the index-exclusion
 * suffix before checkout population; externally managed Claude names stay intact.
 */
function deriveWorktreeId(opts: CreateWorktreeOptions): string {
  const packetWorktreeId = opts.packetId ? managedPacketWorktreeId(opts.packetId) : null;
  const worktreeId = packetWorktreeId ?? sanitizeTaskName(opts.taskName);
  return opts.agentType === 'claude-code' && !opts.managed
    ? worktreeId : `${worktreeId}${WORKTREE_INDEX_EXCLUSION_SUFFIX}`;
}

function sanitizeBranchName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]/g, '-')
    .replace(/\/+/g, '/')
    .replace(/-+/g, '-')
    .replace(/^[-/.]+|[-/.]+$/g, '')
    .slice(0, 120)
    .replace(/^[-/.]+|[-/.]+$/g, '');
}

function resolveIsolationPreference(opts: CreateWorktreeOptions): WorkspaceIsolationPreference {
  if (opts.isolationPreference) return opts.isolationPreference;
  // An unsaved repo setup means Auto, as the repo settings show it: an APFS clone
  // where the volume supports one, otherwise a git worktree. '0' opts out (#5079).
  return process.env[APFS_COW_ENV_FLAG] === '0' ? 'git-worktree' : 'auto';
}

export class WorktreeManager {
  private repoRoot: string;
  private worktreeBase: string;
  private worktreeBases: string[];

  constructor(repoRoot: string) {
    this.repoRoot = path.resolve(repoRoot);
    const layout = resolveWorktreeRootLayout(this.repoRoot);
    this.worktreeBase = layout.primaryBase;
    this.worktreeBases = layout.bases;
  }

  // ── Create ──

  /**
   * Create a new isolated worktree for an agent.
   * - `opts.managed: true` (default for Codex, and for Claude Code post-#608):
   *   git worktree add + rebase onto origin/<base> + optional setup
   * - `opts.managed: false/undefined` + agentType === 'claude-code':
   *   records metadata only (Claude creates worktree via --worktree flag).
   *   Legacy path — still reachable so existing claude-code lanes in flight
   *   at deploy time keep working until they drain.
   */
  async create(opts: CreateWorktreeOptions): Promise<WorktreeInfo> {
    assertNotKnowledgeSource(this.repoRoot);
    assertNotKnowledgeSource(this.worktreeBase);
    if (opts.warmBaseCommit) {
      await assertWarmFilesystemBudget(this.repoRoot);
      assertWarmPacketSlot(this.repoRoot, opts.warmReservationToken, deriveWorktreeId(opts));
    }
    if (opts.materializationOnly) assertReviewMaterializationOptions(opts);
    if (opts.agentType === 'claude-code' && !opts.managed) {
      return this.createMaterialized(opts, null, null, () => {});
    }
    return withManagedWorktreeStorageAdmission({
      repoRoot: this.repoRoot,
      packetId: opts.packetId,
      reservationId: opts.storageAdmissionReservationId,
    }, async (volumeId, rootIdentity) => {
      let baseIdentity: StorageRootIdentity | null = null;
      const created = await this.createMaterialized(
        opts, volumeId, rootIdentity, (identity) => { baseIdentity = identity; },
      );
      const capturedBase = baseIdentity as StorageRootIdentity | null;
      if (!capturedBase) throw new Error('Managed worktree base ownership was not captured.');
      await assertManagedWorktreeCreatedBoundary(
        this.repoRoot, created.path, volumeId, rootIdentity, capturedBase,
      );
      const materializationIdentity = await captureWorktreeMaterializationIdentity(created.path);
      await withWorktreeMetadataBoundary(this.repoRoot, {
        root: rootIdentity,
        base: {
          canonicalPath: capturedBase.canonicalPath,
          device: Number(capturedBase.device),
          inode: Number(capturedBase.inode),
          volumeId,
        },
      }, () => withWorktreeMetaTransaction(this.repoRoot, async (transaction) => {
          const entry = (await transaction.readAll())[created.id];
          if (!entry || entry.claudeManaged) {
            throw new Error('Managed workspace metadata disappeared before ownership was receipted.');
          }
          await transaction.save(created.id, { ...entry, materializationIdentity });
        }));
      return created;
    });
  }

  /** Prepare dependencies after releasing the short Git-creation admission queue. */
  async prepareWarmWorktree(opts: CreateWorktreeOptions, onCreated: (info: WorktreeInfo) => void): Promise<{ worktree: WorktreeInfo; hooks: NonNullable<Awaited<ReturnType<typeof readPinnedWorkspaceFileReceipt>>> }> {
    await assertWarmFilesystemBudget(this.repoRoot);
    assertWarmPacketSlot(this.repoRoot, opts.warmReservationToken);
    const info = await this.create({ ...opts, isolationPreference: 'git-worktree', skipSetup: true, envMode: 'skip', envFiles: [], managed: true });
    onCreated(info);
    const identity = await captureWorktreeMaterializationIdentity(info.path);
    try {
      const hooks = await readPinnedWorkspaceFileReceipt(info.path, identity, '.claude/settings.local.json');
      if (!hooks) throw new Error('Warm preparation requires managed safety settings.');
      return await withManagedWorktreeStorageAdmission({ repoRoot: this.repoRoot, backgroundSetup: true }, () => withWorktreeMaterializationExecution(info.path, identity, async () => {
        const receipt = await this.runSetupWithMaterialization(info.path, identity, opts.repoSetup);
        if (!receipt || receipt.mode !== 'native') throw new Error('Warm worktrees require private native dependencies.');
        info.dependencyRecipeKey = receipt.recipeKey;
        info.dependencyMaterialization = receipt;
        await this.updateMetaDependencyMaterialization(info.id, receipt);
        const tsc = process.env.O8_SKIP_PRELAUNCH_TYPECHECK === '1' ? null : await this.resolveTscBinary(info.path, identity);
        if (tsc) await execFileAsync(process.execPath, [tsc, '--noEmit', '--incremental', 'false'], {
          cwd: info.path, windowsHide: true, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
        });
        const preparedHooks = await readPinnedWorkspaceFileReceipt(info.path, identity, '.claude/settings.local.json');
        if (!preparedHooks || preparedHooks.device !== hooks.device || preparedHooks.inode !== hooks.inode || preparedHooks.content !== hooks.content) {
          throw new Error('Warm installation changed managed safety settings.');
        }
        await settlePinnedWorkspaceReadSession();
        if (!await allowWorktreeRemoval(info.path, { logPrefix: 'warm-preparation' })) throw new Error('Warm installer left a live or unknown process.');
        const seal = await captureWarmPacketSeal(this.repoRoot, info.path, identity, opts.warmBaseCommit!, info.branch);
        if (!await allowWorktreeRemoval(info.path, { logPrefix: 'warm-sealing' })) throw new Error('Warm installer is no longer quiescent.');
        await withWorktreeMetaTransaction(this.repoRoot, async transaction => {
          const entry = (await transaction.readAll())[info.id];
          if (!entry?.warmPool || entry.warmPool.seal) throw new Error('Warm sealing lost its original preparation ownership.');
          await transaction.save(info.id, { ...entry, warmPool: { ...entry.warmPool, seal } });
        });
        await this.updateMetaStatus(info.id, 'setup');
        return { worktree: info, hooks };
      }));
    } catch (error) {
      // Failed preparation has no disposable baseline. Keep every byte and its
      // durable reservation; cleanup may not bless a new, unknown inventory.
      await withWorktreeMetaTransaction(this.repoRoot, async transaction => {
        const entry = (await transaction.readAll())[info.id];
        if (entry?.warmPool) await transaction.save(info.id, { ...entry, warmPool: { ...entry.warmPool, held: true } });
      });
      throw error;
    }
  }

  /** Retire only the exact, immutable preparation inventory; otherwise retain. */
  async retireWarmWorktree(id: string): Promise<void> {
    const entry = (await this.loadAllMeta())[id];
    if (!entry?.warmPool || entry.packetId || entry.laneId || entry.sessionKey
      || !entry.materializationIdentity || !entry.materializationParentIdentity || !entry.branchName) {
      throw new Error('Warm retirement requires unused durable ownership.');
    }
    const workspace = path.join(this.worktreeBase, id);
    await withManagedRetirementOwnership(this.repoRoot, workspace, async () => {
      await assertWorktreeMaterializationIdentity(workspace, entry.materializationIdentity);
      await settlePinnedWorkspaceReadSession();
      if (!await allowWorktreeRemoval(workspace, { logPrefix: 'warm-worktree' })) throw new Error('Warm worktree is still in use.');
      await assertWarmPacketSeal(workspace, entry.materializationIdentity!, entry.warmPool!.seal);
      await this.detachDependencyMaterializationForWorkspace(workspace, entry.dependencyMaterialization);
      const head = await this.captureCreationBranchHead(id, workspace, entry.materializationIdentity!, entry.branchName!);
      await retireExactManagedDirectory({ repositoryPath: this.repoRoot, worktreeId: id, directoryPath: workspace,
        identity: entry.materializationIdentity!, parentIdentity: entry.materializationParentIdentity!, retirementReason: 'warm-pristine' });
      await withManagedWorktreeRegistryQueue(this.repoRoot, async () => {
        await execFileAsync('git', ['worktree', 'prune'], { cwd: this.repoRoot, windowsHide: true, timeout: 15_000 });
        if (entry.isolationKind === 'git-worktree' && head) await this.deleteCreationBranch(entry.branchName!, head);
      });
      await this.removeMeta(id);
      completeExactManagedDirectoryRetirement(this.repoRoot, id);
      releaseWarmPacketSlot(entry.warmPool!.slotToken);
    });
  }

  private async createMaterialized(
    opts: CreateWorktreeOptions,
    admittedVolumeId: string | null,
    admittedRootIdentity: StorageRootIdentity | null = null,
    captureBase: (identity: StorageRootIdentity) => void,
  ): Promise<WorktreeInfo> {
    // Git worktree maintenance and creation mutate the same shared registry.
    // Keep every create behind the throttled prune instead of letting a cold
    // start race `git worktree prune` against `git worktree add`.
    if (!opts.materializationOnly && !autoPrunePromise && Date.now() - lastAutoPruneAt > AUTO_PRUNE_COOLDOWN_MS) {
      lastAutoPruneAt = Date.now();
      const prune = this.prune().catch(() => []);
      autoPrunePromise = prune;
      void prune.then(() => {
        if (autoPrunePromise === prune) autoPrunePromise = null;
      });
    }
    if (!opts.materializationOnly && autoPrunePromise) await autoPrunePromise;

    const baseTaskId = deriveWorktreeId(opts);
    let taskId = baseTaskId;
    const baseBranch = opts.baseBranch ?? await this.getCurrentBranch();
    const creationBaseCommit = (opts.warmBaseCommit ?? (opts.laneId
      ? await import('@/lib/lane/creation-base').then(({ readPinnedLaneCreationBaseCommit }) => (
        readPinnedLaneCreationBaseCommit(opts.laneId!)
      ))
      : null)) || null;
    const now = Date.now();

    // Avoid ID collisions — append suffix if already exists in metadata,
    // OR on disk as a worktree directory, OR as a git branch. The metadata-
    // only check missed cases where a prior dispatch attempt created the
    // branch + worktree but never wrote meta (lane retry storms hit this
    // hard — see #TBD). We probe all three and bump the suffix until we
    // find a free slot.
    const existingMeta = await this.loadAllMeta();
    if (opts.warmBaseCommit && Object.values(existingMeta).filter(entry => entry.warmPool).length >= 2) {
      throw new Error('Warm worktree durable count budget is full.');
    }
    const desiredBranch = sanitizeBranchName(opts.branchName?.trim() || `worktree/${opts.agentType}/${taskId}`);
    const pinnedLaneBranch = opts.packetId ? opts.branchName?.trim() : undefined;
    if (pinnedLaneBranch && desiredBranch !== pinnedLaneBranch) {
      throw new Error(
        `Lane branch binding mismatch before worktree creation: recorded "${pinnedLaneBranch}", normalized "${desiredBranch}".`,
      );
    }
    const isClaudeUnmanaged = opts.agentType === 'claude-code' && !opts.managed;
    const probeWorktreeDirs = (id: string) => isClaudeUnmanaged
      ? [path.join(this.repoRoot, CLAUDE_WORKTREE_DIR, id)]
      : this.worktreeBases.map((base) => path.join(base, id));
    const branchExists = async (name: string) => {
      try {
        await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { windowsHide: true, cwd: this.repoRoot, timeout: 5_000 });
        return true;
      } catch {
        return false;
      }
    };
    const dirExists = async (p: string) => {
      try {
        const fs = await import('node:fs/promises');
        await fs.access(p);
        return true;
      } catch {
        return false;
      }
    };
    // When the caller pinned a branchName (lane dispatch passes lane.branch),
    // the branch IS the lane's identity — we can't recompute it to a free
    // value, and adding it to the collision check would spin forever (the
    // branch always exists after the first iteration). Only check branch
    // collisions when the caller didn't pin one.
    const branchPinned = !!opts.branchName?.trim();
    let attemptBranch = desiredBranch;
    const anyDirExists = async (id: string) => (
      (await Promise.all(probeWorktreeDirs(id).map(dirExists))).some(Boolean)
    );
    const hasPendingRetirement = (id: string) => Boolean(
      readExactWorkspaceClaim('managed-retirement', this.repoRoot, id),
    );
    let collided = existingMeta[taskId]
      || (await anyDirExists(taskId))
      || hasPendingRetirement(taskId)
      || (!branchPinned && (await branchExists(attemptBranch)));
    while (collided) {
      taskId = appendWorktreeCollisionSuffix(baseTaskId);
      // Only re-suffix the branch when the caller didn't pin one. With a pinned
      // lane.branch we let the collision retry recompute the dir id only — the
      // branch name is the lane's identity and must survive the loop.
      attemptBranch = sanitizeBranchName(opts.branchName?.trim() || `worktree/${opts.agentType}/${taskId}`);
      collided = existingMeta[taskId]
        || (await anyDirExists(taskId))
        || hasPendingRetirement(taskId)
        || (!branchPinned && (await branchExists(attemptBranch)));
    }
    const branchName = attemptBranch;
    if (opts.warmBaseCommit) assertWarmPacketSlot(this.repoRoot, opts.warmReservationToken, taskId);

    if (opts.agentType === 'claude-code' && !opts.managed) {
      // Claude manages its own worktree — we just track it
      const claudeWorktreePath = path.join(this.repoRoot, CLAUDE_WORKTREE_DIR, taskId);

      const info: WorktreeInfo = {
        id: taskId,
        path: claudeWorktreePath,
        branch: branchName,
        baseBranch,
        agentType: 'claude-code',
        status: 'creating',
        createdAt: now,
        lastActivityAt: now,
        dirtyFiles: [],
        claudeManaged: true,
        isolationKind: 'git-worktree',
      };

      await this.saveMeta(taskId, {
        id: taskId,
        packetId: opts.packetId,
        laneId: opts.laneId,
        agentType: 'claude-code',
        baseBranch,
        createdAt: now,
        claudeManaged: true,
        taskName: opts.taskName,
        branchName,
        status: 'creating',
        isolationKind: 'git-worktree',
      });

      return info;
    }

    // For Codex and all other agents: we manage the full worktree lifecycle
    const worktreePath = path.join(this.worktreeBase, taskId);

    if (!admittedVolumeId || !admittedRootIdentity) {
      throw new Error('Managed worktree creation requires an exact storage admission root.');
    }
    const baseIdentity = await assertManagedWorktreeMaterializationBoundary(
      this.repoRoot, admittedVolumeId, admittedRootIdentity,
    );
    captureBase(baseIdentity);
    const baseExecutionIdentity = await captureWorktreeMaterializationIdentity(this.worktreeBase);
    if (String(baseExecutionIdentity.device) !== baseIdentity.device
      || String(baseExecutionIdentity.inode) !== baseIdentity.inode
      || baseExecutionIdentity.canonicalPath !== baseIdentity.canonicalPath) {
      throw new Error('Managed worktree base changed before its execution handle was captured.');
    }
    const creationOwner = await this.captureCreationOwner();
    return withWorktreeMetadataBoundary(this.repoRoot, {
      root: admittedRootIdentity,
      base: baseExecutionIdentity,
    }, async () => {

    const warm = await bindWarmPacketWorktree({
      repoRoot: this.repoRoot, opts, taskId, branchName, baseBranch,
      creationBaseCommit, worktreePath, baseExecutionIdentity, creationOwner,
    });
    if (warm) {
      const identity = await captureWorktreeMaterializationIdentity(warm.path);
      const warmSeal = (await this.loadAllMeta())[warm.id]?.warmTransfer?.seal;
      try {
        return await withWorktreeMaterializationExecution(warm.path, identity, async () => {
          // This is the last pristine boundary. Packet initialization below may
          // intentionally create environment bindings and a manifest receipt.
          // Keep the original seal; never capture a new baseline over those writes.
          await assertWarmPacketSeal(warm.path, identity, warmSeal, true, warm.branch);
          await this.bootstrapEnvFiles(warm.path, identity, opts);
          // The pool already prepared hooks; binding verified their exact identity.
          // Packet-specific manifests and ownership validation still run at dispatch.
          await this.runSetupWithMaterialization(warm.path, identity, opts.repoSetup, { ...opts, skipSetup: true });
          opts.beforeReady?.(warm);
          await settlePinnedWorkspaceReadSession();
          if (!await allowWorktreeRemoval(warm.path, { logPrefix: 'warm-handoff' })) throw new Error('Warm worktree acquired a live process before handoff.');
          // Initialization may write approved receipts, but must never replace
          // the exact warm directory whose seal authorized this handoff.
          await assertWorktreeMaterializationIdentity(warm.path, identity);
          await this.updateMetaStatus(warm.id, 'ready');
          return { ...warm, status: 'ready' };
        });
      } catch (error) {
        const head = await this.captureCreationBranchHead(taskId, warm.path, identity, branchName);
        await this.retireFailedManagedCreation(taskId, warm.path, identity, baseExecutionIdentity);
        if (warm.isolationKind === 'git-worktree' && head) await this.deleteCreationBranch(branchName, head);
        await this.removeMeta(taskId);
        completeExactManagedDirectoryRetirement(this.repoRoot, taskId);
        throw error;
      }
    }

    if (opts.warmBaseCommit) markWarmPacketMaterializationStarted(this.repoRoot, opts.warmReservationToken);
    const isolationKind = await this.resolveIsolationKind(resolveIsolationPreference(opts));
    if (isolationKind === 'apfs-cow-clone') {
      return this.createApfsCowClone({
        opts,
        taskId,
        branchName,
        baseBranch,
        creationBaseCommit,
        worktreePath,
        now,
        baseExecutionIdentity,
        admittedVolumeId,
        admittedRootIdentity,
        baseIdentity,
        creationOwner,
      });
    }

    const reviewGitOptions = opts.materializationOnly ? await taskDraftGitOptions(this.repoRoot) : [];
    const preparedExecutionIdentity = await ensurePinnedWorkspaceDirectory(
      this.worktreeBase, baseExecutionIdentity, taskId,
    );
    // Persist the empty directory's exact inode before Git can populate it.
    // A crash after Git returns therefore leaves reclaimable authority rather
    // than an identity-less workspace that cleanup must refuse forever.
    await this.saveMeta(taskId, {
      id: taskId,
      packetId: opts.packetId,
      laneId: opts.laneId,
      agentType: opts.agentType,
      baseBranch,
      createdAt: now,
      claudeManaged: false,
      taskName: opts.taskName,
      branchName,
      status: 'creating',
      isolationKind: 'git-worktree',
      materializationIdentity: preparedExecutionIdentity,
      materializationParentIdentity: baseExecutionIdentity,
      creationOwner,
      ...(opts.warmBaseCommit ? { warmPool: { head: opts.warmBaseCommit, slotToken: opts.warmReservationToken } } : {}),
    });

    try {
    const { stdout: gitDirectoryOutput } = await execFileAsync(
      'git', ['rev-parse', '--absolute-git-dir'],
      { windowsHide: true, cwd: this.repoRoot, timeout: 5000 },
    );
    const gitDirectory = gitDirectoryOutput.trim();
    if (!path.isAbsolute(gitDirectory)) throw new Error('Repository Git directory is not absolute.');
    await withWorktreeMaterializationExecution(this.worktreeBase, baseExecutionIdentity, () => (
      execFileAsync('git', [
        ...reviewGitOptions,
        `--git-dir=${gitDirectory}`,
        'worktree', 'add',
        taskId,
        '-b', branchName,
        creationBaseCommit ?? baseBranch,
      ], { windowsHide: true, cwd: this.worktreeBase, timeout: 30_000 })
    ));
    await assertManagedWorktreeCreatedBoundary(
      this.repoRoot, worktreePath, admittedVolumeId, admittedRootIdentity, baseIdentity,
    );
    const createdExecutionIdentity = await assertWorktreeMaterializationIdentity(
      worktreePath, preparedExecutionIdentity,
    );
    await this.bindCreatedMaterializationIdentity(taskId, createdExecutionIdentity);
    if (opts.materializationOnly) {
      const info = await withWorktreeMaterializationExecution(worktreePath, createdExecutionIdentity, () => finishReviewMaterialization({ id: taskId, path: worktreePath, branch: branchName, baseBranch, agentType: opts.agentType, status: 'ready', createdAt: now, lastActivityAt: now, dirtyFiles: [], claudeManaged: false, isolationKind: 'git-worktree' }, reviewGitOptions));
      await this.updateMetaStatus(taskId, 'ready');
      return info;
    }

    // Packet lanes with a pinned creation receipt were cut from the exact
    // fetched base above. Other callers retain the remote-first rebase path.
    // On conflict we abort + tear down the worktree and throw a typed error so
    // the caller can surface it to the operator instead of spawning codex into
    // a broken tree.
    return await withWorktreeMaterializationExecution(worktreePath, createdExecutionIdentity, async () => {
      if (pinnedLaneBranch) {
        await this.assertCreatedWorktreeBranch(worktreePath, pinnedLaneBranch);
      }
      if (!creationBaseCommit) {
        await this.rebaseOntoBase(worktreePath, baseBranch, branchName);
      }

    const info: WorktreeInfo = {
      id: taskId,
      path: worktreePath,
      branch: branchName,
      baseBranch,
      agentType: opts.agentType,
      status: 'setup',
      createdAt: now,
      lastActivityAt: now,
      dirtyFiles: [],
      claudeManaged: false,
      isolationKind: 'git-worktree',
    };

    await this.bootstrapEnvFiles(worktreePath, createdExecutionIdentity, opts);
    await this.injectSafetyHooks(worktreePath, createdExecutionIdentity);

    if (!opts.skipSetup || (opts.packetId && opts.laneId)) {
      info.status = 'setup';
      await this.updateMetaStatus(taskId, 'setup');
      const dependencyMaterialization = await this.runSetupWithMaterialization(
        worktreePath,
        createdExecutionIdentity,
        opts.repoSetup,
        opts,
      );
      if (dependencyMaterialization) {
        info.dependencyRecipeKey = dependencyMaterialization.recipeKey;
        info.dependencyMaterialization = dependencyMaterialization;
        await this.updateMetaDependencyMaterialization(taskId, dependencyMaterialization);
      }
    }
    if (!opts.warmBaseCommit) await this.resetTrackedWorkspaceChanges(worktreePath);

    // Pre-launch typecheck gate (#1107). The agent's diff is ALWAYS measured
    // against the worktree's tsc, so a non-atomic commit on main HEAD (consumer
    // side without the matching producer) poisons every packet branched off it:
    // the agent's own work looks clean against the broken base AND the merge
    // fails with tsc errors that don't belong to the agent. Catch that here
    // and refuse to spawn the agent into a broken tree.
    //
    // Opt out with O8_SKIP_PRELAUNCH_TYPECHECK=1 if tsc is too slow / noisy for
    // the dispatch loop. The binary and module tree must both belong to the
    // worktree; sharing the host repo's node_modules lets a packet-side install
    // mutate or erase the operator's main checkout.
    const tscBin = process.env.O8_SKIP_PRELAUNCH_TYPECHECK === '1'
      ? null
      : await this.resolveTscBinary(worktreePath, createdExecutionIdentity);
    if (tscBin) {
      try {
        await execFileAsync(process.execPath, [tscBin, '--noEmit', '--incremental', 'false'], {
          windowsHide: true,
          cwd: worktreePath,
          timeout: 180_000,
          maxBuffer: 8 * 1024 * 1024,
        });
      } catch (err) {
        const processError = err as { stdout?: unknown; stderr?: unknown };
        const text = (value: unknown) => typeof value === 'string'
          ? value
          : value instanceof Buffer ? value.toString('utf8') : '';
        const tscOutput = [
          text(processError.stdout),
          text(processError.stderr),
          err instanceof Error ? err.message : String(err),
        ].map((value) => value.trim()).filter(Boolean).join('\n');
        throw new WorktreeBaseTypecheckError({
          baseBranch,
          worktreePath,
          branch: branchName,
          tscOutput: tscOutput.slice(0, 4000),
        });
      }
    }

    opts.beforeReady?.(info);
    info.status = 'ready';
    await this.updateMetaStatus(taskId, opts.warmBaseCommit ? 'setup' : 'ready');
    if (info.dependencyMaterialization) {
      queueDependencyImagePublication(worktreePath, info.dependencyMaterialization);
    }
    return info;
    });
    } catch (err) {
      // Preserve failed review materialization and its inode receipt for
      // inspection; ordinary rollback may invoke repository Git hooks.
      if (opts.materializationOnly) throw err;
      if (isPinnedWorkspacePublishError(err)) throw err;
      try {
        await this.detachDependencyMaterializationForWorkspace(
          worktreePath,
          (await this.loadAllMeta())[taskId]?.dependencyMaterialization,
        );
        const creationBranchHead = await this.captureCreationBranchHead(
          taskId,
          worktreePath,
          preparedExecutionIdentity,
          branchName,
        );
        await this.retireFailedManagedCreation(
          taskId, worktreePath, preparedExecutionIdentity, baseExecutionIdentity,
        );
        if (creationBranchHead) {
          await this.deleteCreationBranch(branchName, creationBranchHead);
        }
      } catch (retirementError) {
        throw this.creationRetirementRefusal(err, retirementError);
      }
      await this.removeMeta(taskId);
      completeExactManagedDirectoryRetirement(this.repoRoot, taskId);
      throw err;
    }
    });
  }

  private async resolveIsolationKind(
    preference: WorkspaceIsolationPreference,
  ): Promise<WorkspaceIsolationKind> {
    if (preference === 'git-worktree') return 'git-worktree';

    const capability = await getApfsCowCapability(this.repoRoot, this.worktreeBase);
    if (capability.canCowClone) return 'apfs-cow-clone';

    if (preference === 'apfs-cow-clone') {
      throw new Error(capability.reason ?? 'APFS copy-on-write workspaces are unavailable for this repository.');
    }

    if (process.env[APFS_COW_ENV_FLAG] === '1') {
      console.warn(`[worktree] APFS CoW unavailable, falling back to git worktree: ${capability.reason ?? 'unknown reason'}`);
    }
    return 'git-worktree';
  }

  private async createApfsCowClone(params: {
    opts: CreateWorktreeOptions;
    taskId: string;
    branchName: string;
    baseBranch: string;
    creationBaseCommit: string | null;
    worktreePath: string;
    now: number;
    baseExecutionIdentity: Awaited<ReturnType<typeof captureWorktreeMaterializationIdentity>>;
    admittedVolumeId: string;
    admittedRootIdentity: StorageRootIdentity;
    baseIdentity: StorageRootIdentity;
    creationOwner: NonNullable<WorktreeMetaEntry['creationOwner']>;
  }): Promise<WorktreeInfo> {
    const {
      opts, taskId, branchName, baseBranch, creationBaseCommit, worktreePath, now, baseExecutionIdentity,
      admittedVolumeId, admittedRootIdentity, baseIdentity,
      creationOwner,
    } = params;

    const preparedExecutionIdentity = await ensurePinnedWorkspaceDirectory(
      this.worktreeBase, baseExecutionIdentity, taskId,
    );
    await this.saveMeta(taskId, {
      id: taskId,
      packetId: opts.packetId,
      laneId: opts.laneId,
      agentType: opts.agentType,
      baseBranch,
      createdAt: now,
      claudeManaged: false,
      taskName: opts.taskName,
      branchName,
      status: 'creating',
      isolationKind: 'apfs-cow-clone',
      hydrationPaths: [],
      materializationIdentity: preparedExecutionIdentity,
      materializationParentIdentity: baseExecutionIdentity,
      creationOwner,
      ...(opts.warmBaseCommit ? { warmPool: { head: opts.warmBaseCommit, slotToken: opts.warmReservationToken } } : {}),
    });

    let createdExecutionIdentity: Awaited<ReturnType<typeof captureWorktreeMaterializationIdentity>> | null = preparedExecutionIdentity;
    try {
      await timeWorktreePreparation(opts, 'clone', () => withWorktreeMaterializationExecution(this.worktreeBase, baseExecutionIdentity, () => (
        execFileAsync('git', ['clone', '--local', '--no-checkout', this.repoRoot, taskId], {
          windowsHide: true,
          cwd: this.worktreeBase,
          timeout: 60_000,
        })
      )));
      await assertManagedWorktreeCreatedBoundary(
        this.repoRoot, worktreePath, admittedVolumeId, admittedRootIdentity, baseIdentity,
      );
      const capturedExecutionIdentity = await assertWorktreeMaterializationIdentity(
        worktreePath, preparedExecutionIdentity,
      );
      createdExecutionIdentity = capturedExecutionIdentity;
      await this.bindCreatedMaterializationIdentity(taskId, capturedExecutionIdentity);
      return await withWorktreeMaterializationExecution(worktreePath, capturedExecutionIdentity, async () => {

      const originUrl = await this.getOriginUrl();
      if (originUrl) {
        await execFileAsync('git', ['remote', 'set-url', 'origin', originUrl], {
          windowsHide: true,
          cwd: worktreePath,
          timeout: 5000,
        });
      }

      await timeWorktreePreparation(opts, 'checkout', () => execFileAsync('git', ['checkout', '-B', branchName, creationBaseCommit ?? baseBranch], {
        windowsHide: true,
        cwd: worktreePath,
        timeout: 30_000,
      }));

      if (opts.packetId && opts.branchName?.trim()) {
        await this.assertCreatedWorktreeBranch(worktreePath, opts.branchName.trim());
      }

      if (!creationBaseCommit) {
        try {
          await this.rebaseOntoBase(worktreePath, baseBranch, branchName);
        } catch (err) {
          throw err;
        }
      }

      await finalizeCloneBranchRefs(this.repoRoot, worktreePath, branchName, baseBranch, Boolean(originUrl));

      // #1132 — Reset to HEAD so operator WIP can't leak into the agent's
      // commit. Cheap belt-and-braces against any path that could have
      // injected modifications between the clone and the agent dispatch
      // (race window, transient hydration artifacts, future code changes).
      // `git reset --hard HEAD` zeroes any tracked-file modifications and
      // `git clean -fd` removes any stray untracked files. Both are no-ops
      // on a properly clean tree, so this is safe to apply unconditionally
      // and only adds work when there's actually drift to fix.
      // Ignored files (.env, node_modules) are intentionally preserved —
      // hydration / bootstrap fills those next.
      try {
        await this.resetTrackedWorkspaceChanges(worktreePath);
        await execFileAsync('git', ['clean', '-fd'], {
          windowsHide: true,
          cwd: worktreePath,
          timeout: 15_000,
        });
      } catch (err) {
        throw new Error(
          `Fresh-worktree sanitation failed; refusing to dispatch into a clone that may contain source WIP: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const info: WorktreeInfo = {
        id: taskId,
        path: worktreePath,
        branch: branchName,
        baseBranch,
        agentType: opts.agentType,
        status: 'setup',
        createdAt: now,
        lastActivityAt: now,
        dirtyFiles: [],
        claudeManaged: false,
        isolationKind: 'apfs-cow-clone',
        hydrationPaths: [],
      };

      const hydrationPaths = await timeWorktreePreparation(opts, 'asset_hydration', () => this.hydrateApfsCowAssets(worktreePath, capturedExecutionIdentity));
      info.hydrationPaths = hydrationPaths;
      await this.updateMetaHydrationPaths(taskId, hydrationPaths);

      await this.bootstrapEnvFiles(worktreePath, capturedExecutionIdentity, opts);
      await this.injectSafetyHooks(worktreePath, capturedExecutionIdentity);

      if (!opts.skipSetup || (opts.packetId && opts.laneId)) {
        info.status = 'setup';
        await this.updateMetaStatus(taskId, 'setup');
        const dependencyMaterialization = await this.runSetupWithMaterialization(
          worktreePath,
          capturedExecutionIdentity,
          opts.repoSetup,
          opts,
        );
        if (dependencyMaterialization) {
          info.dependencyRecipeKey = dependencyMaterialization.recipeKey;
          info.dependencyMaterialization = dependencyMaterialization;
          await this.updateMetaDependencyMaterialization(taskId, dependencyMaterialization);
        }
      }
      await this.resetTrackedWorkspaceChanges(worktreePath);

      opts.beforeReady?.(info);
      info.status = 'ready';
      await this.updateMetaStatus(taskId, opts.warmBaseCommit ? 'setup' : 'ready');
      if (info.dependencyMaterialization) {
        queueDependencyImagePublication(worktreePath, info.dependencyMaterialization);
      }
      return info;
      });
    } catch (err) {
      if (isPinnedWorkspacePublishError(err)) throw err;
      if (createdExecutionIdentity) {
        try {
          await this.detachDependencyMaterializationForWorkspace(
            worktreePath,
            (await this.loadAllMeta())[taskId]?.dependencyMaterialization,
          );
          await this.retireFailedManagedCreation(
            taskId, worktreePath, createdExecutionIdentity, baseExecutionIdentity,
          );
        } catch (retirementError) {
          throw this.creationRetirementRefusal(err, retirementError);
        }
      }
      try {
        await this.removeMeta(taskId);
        completeExactManagedDirectoryRetirement(this.repoRoot, taskId);
      } catch {
        // Retain the trusted purge claim until metadata removal can replay.
      }
      throw err;
    }
  }

  // ── Rebase ──

  /**
   * Fetch origin + rebase the worktree's branch onto origin/<baseBranch>.
   * Runs inside the worktree (not the repoRoot) so the rebase affects only
   * the newly-created branch.
   *
   * On rebase conflict: aborts the rebase and throws WorktreeRebaseConflictError
   * with the list of conflicting files. The caller is responsible for tearing
   * down the worktree and surfacing the conflict to the operator.
   *
   * Clean path: logs `[worktree-rebase] <branch> rebased onto origin/<baseBranch>`.
   */
  async rebaseOntoMain(
    worktreePath: string,
    opts: {
      baseBranch?: string;
      branchName?: string;
      strategy?: WorktreeRebaseStrategy;
    } = {},
  ): Promise<void> {
    const baseBranch = opts.baseBranch?.trim() || 'main';
    const branchName = opts.branchName?.trim() || path.basename(worktreePath);
    await this.rebaseOntoBase(worktreePath, baseBranch, branchName, opts.strategy);
  }

  /** Resolve the exact fetched base a managed packet branch will start from. */
  async resolveCreationBaseCommit(baseBranch: string, branchName: string): Promise<string> {
    const base = baseBranch.trim() || 'main';
    const { target } = await this.resolveBaseTarget(this.repoRoot, base, branchName);
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', `${target}^{commit}`], {
      windowsHide: true,
      cwd: this.repoRoot,
      timeout: 5_000,
    });
    return stdout.trim().toLowerCase();
  }

  private async resolveBaseTarget(
    cwd: string,
    baseBranch: string,
    branchName: string,
  ): Promise<{ target: string; originMissing: boolean }> {
    // Fetch the latest base ref from origin. Failure is recoverable only if
    // the local base ref is recent — otherwise the agent would branch from a
    // stale base and generate a diff that reverts already-merged upstream
    // work. On stale+unreachable: throw so the caller escalates to a
    // fetch_unreachable supervisor inbox item.
    try {
      await execFileAsync('git', ['fetch', 'origin', baseBranch, '--quiet'], {
        windowsHide: true,
        cwd,
        timeout: 60_000,
      });
    } catch (fetchErr) {
      const fetchErrorMessage = gitCommandErrorMessage(fetchErr);
      if (await shouldClassifyFetchAsOriginMissing(cwd, fetchErrorMessage)) {
        // Local-only repo with no origin: keep dispatching. The worktree branch
        // already came off local main at checkout time; there's nothing to
        // rebase onto upstream. The operator pushes manually after merge.
        console.warn(
          `[worktree-rebase] origin not configured for ${baseBranch} — skipping rebase (local-only repo).`,
        );
        return { target: baseBranch, originMissing: true };
      }
      const localRefAgeMs = await this.localBaseRefAgeMs(cwd, baseBranch);
      if (localRefAgeMs == null || localRefAgeMs > LOCAL_BASE_REF_FRESHNESS_MS) {
        console.warn(
          `[worktree-rebase] fetch origin ${baseBranch} failed (${fetchErrorMessage}) and local ${baseBranch} ref is ${localRefAgeMs == null ? 'missing' : `${Math.round(localRefAgeMs / 60_000)} min old`} — escalating as fetch_unreachable.`,
        );
        throw new WorktreeFetchUnreachableError({
          baseBranch,
          worktreePath: cwd,
          branch: branchName,
          localRefAgeMs: localRefAgeMs ?? Number.POSITIVE_INFINITY,
          fetchErrorMessage,
        });
      }
      console.warn(
        `[worktree-rebase] fetch origin ${baseBranch} failed (${fetchErrorMessage}); local ref is ${Math.round(localRefAgeMs / 60_000)} min old — rebasing onto local ${baseBranch} instead.`,
      );
    }

    // Prefer origin/<baseBranch> if it exists; fall back to the local ref.
    let target = `origin/${baseBranch}`;
    try {
      await execFileAsync('git', ['rev-parse', '--verify', target], {
        windowsHide: true,
        cwd,
        timeout: 5000,
      });
      // #1469 — when LOCAL base is strictly ahead of origin (unpushed merge
      // commits on main), rebasing onto origin linearizes the unpushed merges
      // and conflicts deterministically — every dispatch failed until the
      // operator happened to push. The local ref is the truth the next merge
      // will land on; rebase onto it when it's ahead. (Diverged histories
      // keep origin — a conflict there is real and must surface.)
      try {
        const comparisons = await Promise.allSettled([
          execFileAsync('git', ['rev-list', '--count', `${target}..${baseBranch}`],
            { windowsHide: true, cwd, timeout: 5000 }),
          execFileAsync('git', ['rev-list', '--count', `${baseBranch}..${target}`],
            { windowsHide: true, cwd, timeout: 5000 }),
        ]);
        const [aheadResult, behindResult] = comparisons;
        if (aheadResult.status === 'rejected') throw aheadResult.reason;
        if (behindResult.status === 'rejected') throw behindResult.reason;
        const aheadRaw = aheadResult.value.stdout;
        const behindRaw = behindResult.value.stdout;
        const ahead = Number.parseInt(aheadRaw.trim(), 10) || 0;
        const behind = Number.parseInt(behindRaw.trim(), 10) || 0;
        if (ahead > 0 && behind === 0) {
          console.log(
            `[worktree-rebase] local ${baseBranch} is ${ahead} commit(s) ahead of ${target} (not behind) — rebasing onto local ${baseBranch}.`,
          );
          target = baseBranch;
        }
      } catch { /* comparison failed — keep origin target */ }
    } catch {
      target = baseBranch;
    }
    return { target, originMissing: false };
  }

  private async rebaseOntoBase(
    worktreePath: string,
    baseBranch: string,
    branchName: string,
    strategy?: WorktreeRebaseStrategy,
  ): Promise<void> {
    const { target: rebaseTarget, originMissing } = await this.resolveBaseTarget(
      worktreePath,
      baseBranch,
      branchName,
    );
    if (originMissing) return;

    try {
      const rebaseArgs = ['rebase'];
      if (strategy) {
        rebaseArgs.push('-X', strategy);
      }
      rebaseArgs.push(rebaseTarget);
      await execFileAsync('git', rebaseArgs, {
        windowsHide: true,
        cwd: worktreePath,
        timeout: 60_000,
      });
      console.log(`[worktree-rebase] ${branchName} rebased onto ${rebaseTarget}`);
    } catch (err) {
      // Collect conflicting files before aborting so the caller can tell
      // the operator exactly what clashed.
      let conflictFiles: string[] = [];
      try {
        const { stdout } = await execFileAsync(
          'git', ['diff', '--name-only', '--diff-filter=U'],
          { windowsHide: true, cwd: worktreePath, timeout: 5000 },
        );
        conflictFiles = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
      } catch { /* best effort */ }

      try {
        await execFileAsync('git', ['rebase', '--abort'], {
          windowsHide: true,
          cwd: worktreePath,
          timeout: 10_000,
        });
      } catch { /* rebase state may already be clean */ }

      const underlying = err instanceof Error ? err.message : String(err);
      console.warn(
        `[worktree-rebase] ${branchName} rebase onto ${rebaseTarget} failed with ${conflictFiles.length} conflict${conflictFiles.length === 1 ? '' : 's'}: ${underlying}`,
      );

      throw new WorktreeRebaseConflictError({
        baseBranch,
        conflictFiles,
        worktreePath,
        branch: branchName,
        message: conflictFiles.length > 0
          ? `Rebase onto ${rebaseTarget} failed. Conflicting files: ${conflictFiles.join(', ')}`
          : `Rebase onto ${rebaseTarget} failed. ${underlying}`,
      });
    }
  }

  /**
   * Return the age (ms) of the local base-branch ref's tip commit. Used to
   * decide whether falling back to the local ref is safe when `git fetch`
   * fails. Returns null if the ref doesn't exist or the timestamp can't be
   * parsed.
   */
  private async localBaseRefAgeMs(
    worktreePath: string,
    baseBranch: string,
  ): Promise<number | null> {
    try {
      const { stdout } = await execFileAsync(
        'git', ['log', '-1', '--format=%ct', baseBranch],
        { windowsHide: true, cwd: worktreePath, timeout: 5000 },
      );
      const commitUnixSeconds = parseInt(stdout.trim(), 10);
      if (!Number.isFinite(commitUnixSeconds) || commitUnixSeconds <= 0) {
        return null;
      }
      return Date.now() - commitUnixSeconds * 1000;
    } catch {
      return null;
    }
  }

  // ── List ──

  /**
   * List all worktrees (both managed and Claude-native).
   * Combines git worktree list with our metadata.
   *
   * ## Why `withDiskUsage` is opt-in
   *
   * `diskUsageBytes` costs a `du -sk` — a recursive stat of every inode under
   * the worktree (189ms for one 38MB worktree, measured; worse as it grows).
   * It used to be computed unconditionally, and the ws-server's 5-second
   * conflict scan calls `list()`. So an IDLE o8 was recursively walking every
   * worktree on disk twelve times a minute, forever — ~2.1s of pure disk walk
   * per tick with 11 worktrees present, on a tick that fires every 5s.
   *
   * Exactly one caller in the codebase reads `diskUsageBytes`
   * (`getWorktreeStats` in launch.ts). Everyone else — including the conflict
   * report, which never touches the field — was paying for it. It is now off by
   * default; ask for it explicitly if you actually render bytes.
   *
   * Both passes also run their per-worktree probes concurrently. They were
   * serial `await`s in a `for` loop, so the wall time was the SUM of every
   * worktree's git probes rather than the slowest one.
   */
  async list(opts: { withDiskUsage?: boolean } = {}): Promise<WorktreeInfo[]> {
    const [gitWorktrees, meta] = await Promise.all([
      this.gitWorktreeList(),
      readWorktreeMetaSnapshot(this.repoRoot),
    ]);

    const metaResults = await Promise.all(
      Object.entries(meta).map(async ([id, entry]): Promise<WorktreeInfo | null> => {
        const worktreePath = entry.claudeManaged
          ? path.join(this.repoRoot, CLAUDE_WORKTREE_DIR, id)
          : await this.resolveManagedWorktreePath(id);
        const gitWt = gitWorktrees.find((g) => g.path === worktreePath || g.branch?.includes(id));

        // Check if directory actually exists
        const exists = await this.pathExists(worktreePath);
        if (!exists && !entry.claudeManaged) return null; // Cleaned up externally

        const [dirtyFiles, diskUsageBytes] = await Promise.all([
          exists ? this.getDirtyFiles(worktreePath, entry.baseBranch) : Promise.resolve([]),
          exists && opts.withDiskUsage ? this.getDiskUsage(worktreePath) : Promise.resolve(0),
        ]);
        const lastActivity = exists
          ? await worktreeActivityMtimeMs({
              worktreePath,
              sessionKey: entry.sessionKey,
              changedPaths: dirtyFiles,
            })
          : entry.createdAt;
        const status = this.inferStatus(lastActivity, dirtyFiles, entry);
        const isolationKind = entry.isolationKind ?? 'git-worktree';

        return {
          id,
          path: worktreePath,
          branch: entry.branchName ?? gitWt?.branch ?? `worktree/${entry.agentType}/${id}`,
          baseBranch: entry.baseBranch,
          agentType: entry.agentType,
          sessionKey: entry.sessionKey,
          status,
          createdAt: entry.createdAt,
          lastActivityAt: lastActivity,
          diskUsageBytes,
          dirtyFiles,
          claudeManaged: entry.claudeManaged,
          isolationKind,
          hydrationPaths: entry.hydrationPaths ?? [],
          dependencyRecipeKey: entry.dependencyRecipeKey,
          dependencyMaterialization: entry.dependencyMaterialization,
        };
      }),
    );

    const results: WorktreeInfo[] = metaResults.filter(
      (entry): entry is WorktreeInfo => entry !== null,
    );

    // Surface worktrees that exist in git but lost their metadata entry
    // (dev-server restart, accidental .meta deletion). Without this fallback,
    // path-based lookups in lane/commands.ts merge path fail with
    // "Worktree not found on disk" even when the worktree is fully on disk
    // and registered with git.
    const knownPaths = new Set(results.map((r) => r.path));
    const orphanResults = await Promise.all(
      gitWorktrees.map(async (gitWt): Promise<WorktreeInfo | null> => {
        if (knownPaths.has(gitWt.path)) return null;
        if (await this.samePath(gitWt.path, this.repoRoot)) return null;
        const exists = await this.pathExists(gitWt.path);
        if (!exists) return null;

        const id = path.basename(gitWt.path);
        const branch = gitWt.branch ?? `worktree/unknown/${id}`;
        const agentType = branch.includes('/codex/') ? 'codex' : 'claude-code';
        const dirtyFiles = await this.getDirtyFiles(gitWt.path, 'main').catch(() => []);
        const lastActivity = await worktreeActivityMtimeMs({
          worktreePath: gitWt.path,
          changedPaths: dirtyFiles,
        });
        const ageMs = Date.now() - lastActivity;
        const status: WorktreeStatus = ageMs > STALE_THRESHOLD_MS
          ? 'stale'
          : dirtyFiles.length > 0 && ageMs < 5 * 60_000
            ? 'active'
            : 'ready';

        return {
          id,
          path: gitWt.path,
          branch,
          baseBranch: 'main',
          agentType,
          sessionKey: undefined,
          status,
          createdAt: lastActivity,
          lastActivityAt: lastActivity,
          diskUsageBytes: 0,
          dirtyFiles,
          claudeManaged: false,
          isolationKind: 'git-worktree',
        };
      }),
    );

    for (const entry of orphanResults) {
      if (entry) results.push(entry);
    }

    // Sort by most recent activity
    results.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return results;
  }

  /**
   * Get a single worktree by ID.
   */
  async get(worktreeId: string): Promise<WorktreeInfo | null> {
    const all = await this.list();
    return all.find((wt) => wt.id === worktreeId) ?? null;
  }

  /**
   * Read only the dependency receipt for the managed worktree at an exact path.
   * Unlike get()/list(), this avoids probing git status across the fleet.
   */
  async getDependencyMaterializationByPath(worktreePath: string): Promise<{
    dependencyMaterialization?: DependencyMaterializationReceipt;
    id: string;
    path: string;
  } | null> {
    const id = path.basename(path.resolve(worktreePath));
    const entry = (await readWorktreeMetaSnapshot(this.repoRoot))[id];
    if (!entry) return null;
    const managedPath = entry.claudeManaged
      ? path.join(this.repoRoot, CLAUDE_WORKTREE_DIR, id)
      : await this.resolveManagedWorktreePath(id);
    if (!(await this.samePath(managedPath, worktreePath))) return null;
    return {
      dependencyMaterialization: entry.dependencyMaterialization,
      id,
      path: managedPath,
    };
  }

  // ── Setup ──

  /**
   * Auto-detect project type and run appropriate install command.
   * Node dependencies always live inside the worktree. A legacy symlink is
   * removed as a link before npm is allowed to touch the path.
   */
  async runSetup(
    worktreePath: string,
    identity?: Awaited<ReturnType<typeof captureWorktreeMaterializationIdentity>>,
    repoSetup?: CreateWorktreeOptions['repoSetup'],
  ): Promise<string | null> {
    const materialization = await this.runSetupWithMaterialization(
      worktreePath,
      identity,
      repoSetup,
    );
    if (materialization) {
      const worktreeId = path.basename(worktreePath);
      if ((await this.loadAllMeta())[worktreeId]) {
        await this.updateMetaDependencyMaterialization(worktreeId, materialization);
      }
      queueDependencyImagePublication(worktreePath, materialization);
    }
    return materialization?.recipeKey ?? null;
  }

  private async runSetupWithMaterialization(
    worktreePath: string,
    identity?: Awaited<ReturnType<typeof captureWorktreeMaterializationIdentity>>,
    repoSetup?: CreateWorktreeOptions['repoSetup'],
    launch?: Pick<CreateWorktreeOptions, 'laneId' | 'packetId' | 'skipSetup'>,
  ): Promise<DependencyMaterializationReceipt | null> {
    let dependencyMaterialization: DependencyMaterializationReceipt | null = null;
    if (!launch?.skipSetup) {
      const hasPackageJson = await this.pathExists(path.join(worktreePath, 'package.json'));
      const installCommand = repoSetup
        ? repoSetup.installOnCreateWorkspace
          ? repoSetup.installCommand?.trim() || null
          : null
        : hasPackageJson
          ? await detectDependencyInstallCommand(worktreePath)
          : null;
      if (repoSetup?.installOnCreateWorkspace && !installCommand) {
        throw new Error('The registered repo requires install-on-create but has no install command.');
      }
      if (hasPackageJson) {
        await this.assertInstallableLocalNodeModules(worktreePath, identity);
      }
      if (installCommand) {
        const result = await timeWorktreePreparation(launch, 'dependency_materialization', () => materializeDependencyInstall(worktreePath, installCommand, {
          materializationIdentity: identity,
          cloneSourceWorkspace: this.repoRoot,
          useDependencyPool: true,
          onSelection: (selection) => recordDependencySelection(launch, selection),
          persistReceipt: (receipt) => (
            receipt
              ? this.recordDependencyMaterialization(path.basename(worktreePath), receipt)
              : this.clearDependencyMaterialization(path.basename(worktreePath))
          ),
        }));
        dependencyMaterialization = result.receipt;
        if (launch?.packetId && launch.laneId) {
          const verification = await verifyDependencyMaterialization(worktreePath);
          if (isDependencyMaterializationIncomplete(verification)) {
            let imageGenerationInvalidated = false;
            let imageInvalidationError: string | null = null;
            if (dependencyMaterialization.mode === 'image') {
              try {
                await detachDependencyMaterialization(worktreePath, dependencyMaterialization);
                await this.clearDependencyMaterialization(path.basename(worktreePath));
                await retireDependencyImage(dependencyMaterialization.recipeKey);
                imageGenerationInvalidated = true;
              } catch (error) {
                imageInvalidationError = error instanceof Error ? error.message : String(error);
              }
            }
            const blocker = new DependencyMaterializationIncompleteError(
              verification,
              imageGenerationInvalidated,
              imageInvalidationError,
            );
            const { appendEvent, setLaneStatus } = await import('@/lib/lane/registry');
            appendEvent(launch.laneId, DEPENDENCY_MATERIALIZATION_INCOMPLETE, 'system', {
              code: blocker.code,
              packetId: launch.packetId,
              mode: dependencyMaterialization.mode,
              recipeKey: dependencyMaterialization.recipeKey,
              topLevelEntryCount: verification.topLevelEntryCount,
              verifiedBinaries: verification.verifiedBinaries,
              missingBinaries: verification.missingBinaries,
              resolutionErrors: verification.resolutionErrors,
              scriptBinaries: verification.scriptBinaries,
              unreadableFiles: verification.unreadableFiles,
              imageGenerationInvalidated,
              imageInvalidationError,
            });
            setLaneStatus(
              launch.laneId,
              'failed',
              'system',
              DEPENDENCY_MATERIALIZATION_INCOMPLETE,
            );
            throw blocker;
          }
          const { appendEvent } = await import('@/lib/lane/registry');
          appendEvent(launch.laneId, 'dependency_materialized', 'system', {
            packetId: launch.packetId,
            mode: dependencyMaterialization.mode,
            recipeKey: dependencyMaterialization.recipeKey,
            topLevelEntryCount: verification.topLevelEntryCount,
            verifiedBinaries: verification.verifiedBinaries,
            missingBinaries: verification.missingBinaries,
            resolutionErrors: verification.resolutionErrors,
            scriptBinaries: verification.scriptBinaries,
            unreadableFiles: verification.unreadableFiles,
          });
        }
      }
      if (await this.pathExists(path.join(worktreePath, 'requirements.txt'))) {
        await execFileAsync('pip', ['install', '-r', 'requirements.txt'], {
          windowsHide: true,
          cwd: worktreePath,
          timeout: 120_000,
        }).catch((error) => {
          if (launch?.packetId && launch.laneId) throw error;
          // Interactive workspaces can still proceed without optional tooling.
        });
      }
      if (await this.pathExists(path.join(worktreePath, 'go.mod'))) {
        await execFileAsync('go', ['mod', 'download'], {
          windowsHide: true,
          cwd: worktreePath,
          timeout: 60_000,
        }).catch((error) => {
          if (launch?.packetId && launch.laneId) throw error;
        });
      }
      if (await this.pathExists(path.join(worktreePath, 'Cargo.toml'))) {
        await execFileAsync('cargo', ['fetch'], {
          windowsHide: true,
          cwd: worktreePath,
          timeout: 120_000,
        }).catch((error) => {
          if (launch?.packetId && launch.laneId) throw error;
        });
      }
    }
    if (launch?.packetId && launch.laneId) {
      await applyWorkspaceManifest({
        repoPath: this.repoRoot, worktreePath,
        packetId: launch.packetId, laneId: launch.laneId,
      });
    }
    return dependencyMaterialization;
  }

  private async resetTrackedWorkspaceChanges(worktreePath: string): Promise<void> {
    await execFileAsync('git', ['reset', '--hard', 'HEAD'], {
      windowsHide: true,
      cwd: worktreePath,
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  }

  private async retireFailedManagedCreation(
    worktreeId: string,
    worktreePath: string,
    identity: Awaited<ReturnType<typeof captureWorktreeMaterializationIdentity>>,
    parentIdentity: Awaited<ReturnType<typeof captureWorktreeMaterializationIdentity>>,
  ): Promise<void> {
    await retireExactManagedDirectory({
      repositoryPath: this.repoRoot,
      worktreeId,
      directoryPath: worktreePath,
      identity,
      parentIdentity,
      retirementReason: 'creation-rollback',
    });
    await execFileAsync('git', ['worktree', 'prune'], {
      windowsHide: true,
      cwd: this.repoRoot,
      timeout: 15_000,
    });
  }

  private async captureCreationOwner(): Promise<NonNullable<WorktreeMetaEntry['creationOwner']>> {
    const probe = await probeMetadataLockProcessIdentity(process.pid);
    if (probe.state !== 'live') {
      throw new Error(`Managed worktree creation could not prove its process owner${probe.state === 'unknown' ? `: ${probe.detail.replace(/\.$/, '')}` : ''}.`);
    }
    return { pid: process.pid, identity: probe.identity };
  }

  private async captureCreationBranchHead(
    worktreeId: string,
    worktreePath: string,
    identity: Awaited<ReturnType<typeof captureWorktreeMaterializationIdentity>>,
    branchName: string,
  ): Promise<string | null> {
    let topLevel: string;
    let actualBranch: string;
    let branchHead: string;
    try {
      const [topLevelReceipt, branchReceipt, headReceipt] = await withWorktreeMaterializationExecution(
        worktreePath,
        identity,
        () => Promise.all([
          execFileAsync('git', ['rev-parse', '--show-toplevel'], {
            windowsHide: true,
            cwd: worktreePath,
            timeout: 5_000,
          }),
          execFileAsync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
            windowsHide: true,
            cwd: worktreePath,
            timeout: 5_000,
          }),
          execFileAsync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
            windowsHide: true,
            cwd: worktreePath,
            timeout: 5_000,
          }),
        ]),
      );
      topLevel = await realpath(topLevelReceipt.stdout.trim());
      actualBranch = branchReceipt.stdout.trim();
      branchHead = headReceipt.stdout.trim();
    } catch (error) {
      if (isMaterializationExecutionRefusal(error)) throw error;
      return null;
    }
    if (topLevel !== identity.canonicalPath || actualBranch !== branchName) return null;
    await this.updateMetaCreationBranchHead(worktreeId, branchHead);
    return branchHead;
  }

  private async deleteCreationBranch(branchName: string, expectedHead: string): Promise<void> {
    const refName = `refs/heads/${branchName}`;
    const { stdout } = await execFileAsync('git', ['show-ref', '--hash', '--verify', refName], {
      windowsHide: true,
      cwd: this.repoRoot,
      timeout: 5_000,
    }).catch((error: unknown) => {
      const code = error instanceof Error && 'code' in error
        ? Number((error as NodeJS.ErrnoException).code)
        : null;
      if (code === 1) return { stdout: '', stderr: '' };
      throw error;
    });
    const currentHead = stdout.trim();
    if (!currentHead) return;
    if (currentHead !== expectedHead) {
      throw new Error(`Creation branch ${branchName} changed after its ownership receipt.`);
    }
    await execFileAsync('git', ['update-ref', '-d', refName, expectedHead], {
      windowsHide: true,
      cwd: this.repoRoot,
      timeout: 5_000,
    });
  }

  private async recoverInterruptedCreations(
    entries: Record<string, WorktreeMetaEntry>,
  ): Promise<string[]> {
    const recovered: string[] = [];
    for (const entry of Object.values(entries)) {
      if (entry.claudeManaged
        || (entry.status !== 'creating' && entry.status !== 'setup')
        || !entry.creationOwner
        || !entry.materializationIdentity
        || !entry.materializationParentIdentity) continue;
      const owner = await probeMetadataLockProcessIdentity(entry.creationOwner.pid);
      const ownerIsDead = owner.state === 'absent'
        || (owner.state === 'live'
          && !sameMetadataLockProcessIdentity(owner.identity, entry.creationOwner.identity));
      if (!ownerIsDead) continue;

      const worktreePath = entry.materializationIdentity.canonicalPath;
      const pathExists = await this.pathExists(worktreePath);
      const pendingRetirement = readExactWorkspaceClaim(
        'managed-retirement', this.repoRoot, entry.id,
      );
      if (!pathExists && !pendingRetirement) continue;
      if (pathExists && !(await allowWorktreeRemoval(worktreePath, {
        logPrefix: 'worktree-creation-recovery',
      }))) continue;

      try {
        const branchName = entry.branchName ?? `worktree/${entry.agentType}/${entry.id}`;
        let creationBranchHead = entry.creationBranchHead ?? null;
        if (pathExists && entry.isolationKind === 'git-worktree') {
          creationBranchHead = await this.captureCreationBranchHead(
            entry.id,
            worktreePath,
            entry.materializationIdentity,
            branchName,
          ) ?? creationBranchHead;
        }
        if (entry.isolationKind === 'git-worktree' && !creationBranchHead) {
          const branchExists = await execFileAsync(
            'git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
            { windowsHide: true, cwd: this.repoRoot, timeout: 5_000 },
          ).then(() => true, () => false);
          if (branchExists) {
            throw new Error(`Creation branch ${branchName} has no exact ownership receipt.`);
          }
        }
        await this.retireFailedManagedCreation(
          entry.id,
          worktreePath,
          entry.materializationIdentity,
          entry.materializationParentIdentity,
        );
        if (entry.isolationKind === 'git-worktree' && creationBranchHead) {
          await this.deleteCreationBranch(branchName, creationBranchHead);
        }
        await this.removeMeta(entry.id);
        completeExactManagedDirectoryRetirement(this.repoRoot, entry.id);
        recovered.push(entry.id);
      } catch (error) {
        console.error(
          `[worktree-creation-recovery] REFUSED recovery for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return recovered;
  }

  private creationRetirementRefusal(
    creationError: unknown,
    retirementError: unknown,
  ): Error {
    const creationMessage = creationError instanceof Error
      ? creationError.message
      : String(creationError);
    const retirementMessage = retirementError instanceof Error
      ? retirementError.message
      : String(retirementError);
    return new Error(
      `${creationMessage} Exact retirement was refused; durable workspace ownership was retained: ${retirementMessage}`,
      { cause: retirementError },
    );
  }

  private async getOriginUrl(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('git', ['config', '--get', 'remote.origin.url'], {
        windowsHide: true,
        cwd: this.repoRoot,
        timeout: 5000,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async hydrateApfsCowAssets(
    worktreePath: string,
    identity: Awaited<ReturnType<typeof captureWorktreeMaterializationIdentity>>,
  ): Promise<string[]> {
    const capability = await getApfsCowCapability(this.repoRoot, worktreePath);
    if (!capability.canCowClone) return [];

    const hydrated: string[] = [];
    for (const relativePath of APFS_HYDRATION_CANDIDATES) {
      const sourcePath = path.join(this.repoRoot, relativePath);
      if (!(await this.pathExists(sourcePath))) continue;
      try {
        let disposition = await createPinnedWorkspaceBinding(worktreePath, identity, relativePath, {
          mode: 'clone-tree',
          source: sourcePath,
        });
        if (disposition === 'unsupported') {
          disposition = await createPinnedWorkspaceBinding(worktreePath, identity, relativePath, { mode: 'copy-tree', source: sourcePath });
        }
        if (disposition === 'created') hydrated.push(relativePath);
      } catch (err) {
        if (isPinnedWorkspacePublishError(err)) throw err;
        console.warn(
          `[worktree] APFS hydration skipped for ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return hydrated;
  }

  /**
   * The repo-local `tsc` to gate a launch with, or null to skip the gate.
   *
   * Absence is not failure. The pre-launch typecheck exists to catch a base
   * branch that is genuinely broken (#1107) — but it used to point execFile at
   * an unchecked path, so a repo with no TypeScript at all (no tsconfig, or no
   * install yet) raised ENOENT and was reported to the operator as "main HEAD
   * is in an inconsistent state". That refused dispatch into every
   * non-TypeScript repo, diagnosing a missing tool as a broken branch.
   *
   * Skipping when there is nothing to check keeps the gate meaningful for the
   * repos it was written for and silent everywhere else.
   */
  private async resolveTscBinary(
    worktreePath: string,
    identity: Awaited<ReturnType<typeof captureWorktreeMaterializationIdentity>>,
  ): Promise<string | null> {
    if (await readPinnedWorkspaceFile(worktreePath, identity, 'tsconfig.json') === null) {
      console.log('[worktree] no tsconfig.json — skipping the pre-launch typecheck');
      return null;
    }
    if (await readPinnedWorkspaceFile(worktreePath, identity, TSC_SCRIPT) === null) {
      console.log('[worktree] no worktree-local tsc — skipping the pre-launch typecheck');
      return null;
    }
    return TSC_SCRIPT;
  }

  /**
   * Make node_modules installable, or refuse.
   *
   * Older worktrees were hydrated with node_modules symlinked at the host
   * repo's. npm's removal step is readdir + rm per entry, so an install through
   * that link empties the OPERATOR's tree. An unpinned workspace is migrated by
   * removing the link itself - never its contents - so the install lands
   * locally. A pinned managed workspace has no governed primitive for removing
   * a leaf, and nothing in the managed path creates that link any more, so an
   * unexpected one is refused rather than repaired.
   */
  private async assertInstallableLocalNodeModules(
    worktreePath: string,
    identity?: Awaited<ReturnType<typeof captureWorktreeMaterializationIdentity>>,
  ): Promise<void> {
    const targetPath = path.join(worktreePath, 'node_modules');
    const target = identity
      ? await inspectPinnedWorkspaceEntry(worktreePath, identity, 'node_modules')
      : await lstat(targetPath).then((entry) => ({
          kind: entry.isSymbolicLink() ? 'symlink' as const
            : entry.isDirectory() ? 'directory' as const
            : entry.isFile() ? 'file' as const : 'other' as const,
        })).catch(() => null);
    if (target?.kind !== 'symlink') return;
    if (identity) {
      throw new Error(`Refusing to install through linked node_modules at ${targetPath}.`);
    }
    try {
      await rm(targetPath, { force: true });
    } catch (error) {
      throw new Error(
        `Refusing to install through linked node_modules at ${targetPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async bootstrapEnvFiles(
    worktreePath: string,
    identity: Awaited<ReturnType<typeof captureWorktreeMaterializationIdentity>>,
    opts: CreateWorktreeOptions,
  ): Promise<void> {
    await bootstrapEnvironmentFiles(this.repoRoot, worktreePath, identity, opts);
  }

  // ── Safety Hook Injection ──

  /**
   * Inject o8 safety hooks into a worktree's private Claude settings overlay.
   * Ensures every dispatched agent gets:
   *  - PreToolUse: destructive command blocker
   *  - PostToolUse: typecheck after edits + completion gate
   *
   * Hooks resolve relative to the o8 install (this.repoRoot) so they work
   * regardless of where the user's repo lives.
   */
  private async injectSafetyHooks(
    worktreePath: string,
    identity: Awaited<ReturnType<typeof captureWorktreeMaterializationIdentity>>,
  ): Promise<void> {
    await writeManagedWorkspaceSafetyHooks(this.repoRoot, worktreePath, identity);
  }

  // ── Conflict Detection ──

  /**
   * Detect file overlaps across all active worktrees.
   * Returns a ConflictReport with overlapping files and severity.
   */
  async detectConflicts(): Promise<ConflictReport> {
    const worktrees = await this.list();
    const active = worktrees.filter((wt) =>
      wt.status === 'active' || wt.status === 'ready' || wt.dirtyFiles.length > 0,
    );

    const overlapping: ConflictReport['overlapping'] = [];

    for (let i = 0; i < active.length; i++) {
      const filesA = new Set(active[i]!.dirtyFiles);
      for (let j = i + 1; j < active.length; j++) {
        for (const file of active[j]!.dirtyFiles) {
          if (filesA.has(file)) {
            overlapping.push({
              file,
              worktreeIds: [active[i]!.id, active[j]!.id],
              severity: 'conflict', // File-level is always conflict; line-level analysis is Phase 2 (#69)
            });
          }
        }
      }
    }

    return { overlapping, safe: overlapping.length === 0 };
  }

  // ── Cleanup ──

  /**
   * Remove a worktree and optionally its branch.
   * Refuses uncommitted changes so retirement never rewrites unfinished work.
   */
  async cleanup(worktreeId: string, opts?: CleanupOptions): Promise<boolean> {
    try {
      const worktreePath = await this.resolveManagedWorktreePath(worktreeId);
      return await withManagedRetirementOwnership(this.repoRoot, worktreePath, () => this.cleanupOwned(worktreeId, opts));
    } catch (error) {
      console.error(`[worktree-cleanup] REFUSED lifecycle authority for ${worktreeId}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async cleanupOwned(worktreeId: string, opts?: CleanupOptions): Promise<boolean> {
    const meta = await readWorktreeMetaSnapshot(this.repoRoot);
    const entry = meta[worktreeId];
    if (opts?.expectedCreation) {
      const expected = opts.expectedCreation;
      if (!entry || entry.createdAt !== expected.createdAt || entry.branchName !== expected.branch
        || path.resolve(await this.resolveManagedWorktreePath(worktreeId)) !== path.resolve(expected.path)) return false;
    }

    if (opts?.reviewedCleanup && entry?.dependencyMaterialization?.mode === 'image') {
      console.error('[worktree-cleanup] REFUSED reviewed dependency-image shadow retirement; retain its exact namespaces.');
      return false;
    }

    if (entry?.claudeManaged) {
      // Claude-managed: just remove our metadata; Claude handles its own cleanup
      await this.removeMeta(worktreeId);
      return true;
    }

    // #1404 — a blank/dot/traversal worktreeId resolves to the container dir
    // (or above it); the container isn't a git dir, so the preserve path's
    // `git status` WALKS UP to the repo root and `add -A + commit` lands on
    // the operator's main. No lane-lifecycle git write may ever target a
    // registered repo root — refuse the whole cleanup instead.
    const worktreePath = await this.resolveManagedWorktreePath(worktreeId);
    const pathInitiallyExists = await this.pathExists(worktreePath);
    const resolvedTarget = path.resolve(worktreePath);
    const resolvedBases = this.worktreeBases.map((base) => path.resolve(base));
    const containingBase = resolvedBases.find((base) => (
      resolvedTarget === base || resolvedTarget.startsWith(`${base}${path.sep}`)
    ));
    if (
      !worktreeId.trim()
      || resolvedBases.includes(resolvedTarget)
      || resolvedTarget === path.resolve(this.repoRoot)
      || !containingBase
    ) {
      console.error(`[worktree-prune] REFUSED cleanup for unsafe worktreeId ${JSON.stringify(worktreeId)} → ${resolvedTarget} (repo-root write guard, #1404)`);
      return false;
    }
    if (!entry && pathInitiallyExists) {
      console.error(
        `[worktree-cleanup] REFUSED cleanup without authoritative metadata ${JSON.stringify(worktreeId)}`,
      );
      return false;
    }
    if (entry && !entry.claudeManaged && !entry.materializationIdentity) {
      console.error(
        `[worktree-cleanup] REFUSED cleanup for legacy identity-less metadata ${JSON.stringify(worktreeId)}`,
      );
      return false;
    }
    if (entry && !entry.claudeManaged && !entry.materializationParentIdentity) {
      console.error(
        `[worktree-cleanup] REFUSED cleanup without parent ownership ${JSON.stringify(worktreeId)}`,
      );
      return false;
    }
    if (entry?.materializationParentIdentity) {
      const parent = await captureWorktreeMaterializationIdentity(containingBase);
      await assertWorktreeMaterializationIdentity(containingBase, entry.materializationParentIdentity, {
        legacyVolumeId: parent.volumeId,
      });
    }

    const retirementAction = opts?.workspaceRetirementAction
      ?? getWorkspaceRetirementAction(worktreePath)
      ?? 'cleanup';

    try {
      assertWorkspaceRetentionReleased(worktreePath, entry?.materializationIdentity);
    } catch {
      return false;
    }

    if (entry?.status === 'creating' || entry?.status === 'setup') {
      const pending = readExactWorkspaceClaim('managed-retirement', this.repoRoot, worktreeId);
      if (pending?.authority?.retirementReason !== 'creation-rollback'
        || !entry.materializationIdentity || !entry.materializationParentIdentity) return false;
      if (pathInitiallyExists && !(await allowWorktreeRemoval(worktreePath, {
        logPrefix: 'worktree-creation-cleanup', overrideLiveGuard: opts?.overrideLiveGuard,
      }))) return false;
      try {
        const branchName = entry.branchName ?? `worktree/${entry.agentType}/${worktreeId}`;
        let branchHead = entry.creationBranchHead ?? null;
        if (opts?.deleteBranch && entry.isolationKind === 'git-worktree') {
          if (pathInitiallyExists) {
            branchHead = await this.captureCreationBranchHead(
              worktreeId, worktreePath, entry.materializationIdentity, branchName,
            ) ?? branchHead;
          }
          if (!branchHead && await execFileAsync(
            'git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
            { windowsHide: true, cwd: this.repoRoot, timeout: 5_000 },
          ).then(() => true, () => false)) {
            throw new Error('Creation branch has no exact ownership receipt.');
          }
        }
        await this.retireFailedManagedCreation(
          worktreeId, worktreePath, entry.materializationIdentity, entry.materializationParentIdentity,
        );
        if (opts?.deleteBranch && entry.isolationKind === 'git-worktree' && branchHead) {
          await this.deleteCreationBranch(branchName, branchHead);
        }
        await this.removeMeta(worktreeId);
        completeExactManagedDirectoryRetirement(this.repoRoot, worktreeId);
        return true;
      } catch (error) {
        console.error(`[worktree-creation-cleanup] REFUSED rollback replay for ${worktreeId}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    }

    let cleanupIdentity: Awaited<ReturnType<typeof captureWorktreeMaterializationIdentity>> | null = null;
    let confirmedMissingRetirement = false;

    // Safety: preserve uncommitted agent work before removing. Every Git read
    // and preservation write stays on the same captured workspace inode that
    // the eventual retirement receipt owns.
    if (pathInitiallyExists) {
      try {
        cleanupIdentity = entry?.materializationIdentity
          ? await assertWorktreeMaterializationIdentity(worktreePath, entry.materializationIdentity)
          : await captureWorktreeMaterializationIdentity(worktreePath);
        await assertManagedRetirementQuiescence({
          repositoryPath: this.repoRoot, worktreeId, sourcePath: worktreePath,
          candidatePath: worktreePath, identity: cleanupIdentity,
        });
        const preserved = await withWorktreeMaterializationExecution(
          worktreePath,
          cleanupIdentity,
          async () => {
          const uncommitted = await this.preserveUncommittedWork(worktreePath, worktreeId);
          if (uncommitted === 'skip') return false;
          let reviewedHeadWasMerged = false;
          if (opts?.mergedEquivalentHeadSha) {
            try {
              const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
                windowsHide: true,
                cwd: worktreePath,
                timeout: 5000,
              });
              reviewedHeadWasMerged = stdout.trim() === opts.mergedEquivalentHeadSha;
            } catch {
              // Fall through to the normal preservation guard.
            }
          }
          if (!reviewedHeadWasMerged) {
            const committed = await this.preserveCommittedWork(
              worktreePath,
              worktreeId,
              entry?.baseBranch ?? 'main',
              entry?.isolationKind ?? 'git-worktree',
            );
            if (committed === 'skip') return false;
          }
          return true;
          },
        );
        if (!preserved) return false;
      } catch (error) {
        console.error(
          `[worktree-cleanup] REFUSED preservation boundary for ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
    }

    if (entry?.materializationIdentity && entry.materializationParentIdentity) {
      cleanupIdentity ??= entry.materializationIdentity;
      if (!(await allowWorktreeRemoval(worktreePath, {
        logPrefix: 'worktree-cleanup',
        overrideLiveGuard: opts?.overrideLiveGuard,
      }))) {
        if (await this.pathExists(worktreePath)) return false;
      }
      let retirementTruth: Awaited<ReturnType<typeof prepareWorkspaceMaterializationRetirement>>;
      try {
        retirementTruth = await prepareWorkspaceMaterializationRetirement(
          this.repoRoot, worktreePath, retirementAction,
          retirementAction === 'cleanup' ? { allowConfirmedMissingDirectory: true } : {},
        );
      } catch (error) {
        console.error(
          `[worktree-cleanup] REFUSED durable retirement begin for ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
      let dependencyDetachStarted = false;
      try {
        if (retirementTruth?.state !== 'retired') {
          if (entry.dependencyMaterialization?.mode === 'image') {
            dependencyDetachStarted = true;
            await this.detachDependencyMaterializationForWorkspace(
              worktreePath,
              entry.dependencyMaterialization,
            );
          }
          await retireExactManagedDirectory({
            repositoryPath: this.repoRoot,
            worktreeId,
            directoryPath: worktreePath,
            identity: cleanupIdentity,
            parentIdentity: entry.materializationParentIdentity,
            beforeSourceRemoval: opts?.beforeSourceRemoval,
            reviewedCleanup: opts?.reviewedCleanup,
          });
        }
      } catch (error) {
        let refusal = error;
        try {
          await assertWorktreeMaterializationIdentity(
            worktreePath, entry.materializationIdentity,
          );
          rollbackWorkspaceMaterializationRetirement(
            worktreePath, retirementAction, error,
          );
          if (dependencyDetachStarted && entry.dependencyMaterialization) {
            await this.restoreDependencyMaterialization(
              worktreeId,
              entry.dependencyMaterialization,
            );
          }
        } catch (recoveryError) {
          // Missing or replaced public names keep the durable retiring claim
          // for exact crash replay; they cannot be rolled back safely.
          refusal = new Error(
            `Exact retirement failed and dependency rollback was incomplete: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
            { cause: error },
          );
        }
        console.error(
          `[worktree-cleanup] REFUSED exact retirement for ${worktreePath}: ${refusal instanceof Error ? refusal.message : String(refusal)}`,
        );
        return false;
      }
      if (await this.pathExists(worktreePath)) return false;
      await finishWorkspaceMaterializationRetirement(worktreePath, retirementAction);
      confirmedMissingRetirement = retirementTruth === null && !pathInitiallyExists;
      if ((entry?.isolationKind ?? 'git-worktree') === 'git-worktree') {
        await execFileAsync('git', ['worktree', 'prune'], {
          windowsHide: true,
          cwd: this.repoRoot,
          timeout: 10_000,
        }).catch(() => {});
      }
    }

    // A missing checkout with no verified snapshot has not passed committed-
    // work preservation. Keep its branch: it may be the last named reference
    // to work that survived the directory's removal.
    if (opts?.deleteBranch && entry && !confirmedMissingRetirement) {
      const branchName = entry.branchName ?? `worktree/${entry.agentType}/${worktreeId}`;
      await execFileAsync('git', ['branch', '-D', branchName], {
        windowsHide: true,
        cwd: this.repoRoot,
        timeout: 5000,
      }).catch(() => { /* branch may not exist */ });
    }

    // Remove our metadata
    await this.removeMeta(worktreeId);
    completeExactManagedDirectoryRetirement(this.repoRoot, worktreeId);
    if (confirmedMissingRetirement) {
      await confirmWorkspaceMaterializationRetirement(
        this.repoRoot, worktreePath, retirementAction,
      );
    }
    return true;
  }

  /**
   * Prune all stale worktrees (no activity for maxAgeMs).
   * Skips worktrees that have an active lane (running/reviewing/merging).
   */
  async prune(maxAgeMs = STALE_THRESHOLD_MS): Promise<string[]> {
    let authoritativeMeta = await this.loadAllMeta();
    const pruned: string[] = [];

    // Guard: never prune a worktree bound to a NON-TERMINAL lane. "Active" is
    // the canonical terminal-states truth — every lane whose status is not in
    // {failed, completed, archived} protects its worktree (blocked /
    // awaiting_input / awaiting_orchestrator / reviewing / paused / launching /
    // recovering all count). #1585: the old guard read `listActiveLanes()`
    // AND fell back to prune-guard-free when the registry import threw — a
    // null guard reaped every live worker's worktree. Fail CLOSED now: if the
    // registry can't be read we cannot tell active from terminal, so we abort
    // the whole prune pass rather than reap blind.
    let activeLanePaths: Set<string>;
    try {
      const { listLanes } = await import('@/lib/lane/registry');
      const { isLaneTerminal } = await import('@/lib/lane/terminal-states');
      const lanePaths = listLanes()
        .filter((l) => !isLaneTerminal(l.status))
        .map((l) => l.worktreePath)
        .filter((p): p is string => Boolean(p));
      activeLanePaths = new Set(
        await Promise.all(lanePaths.map((lanePath) => this.canonicalPath(lanePath))),
      );
    } catch (err) {
      console.error(
        `[worktree-prune] PRUNE ABORTED — lane registry unavailable (fail closed): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }

    pruned.push(...await this.recoverInterruptedCreations(authoritativeMeta));
    authoritativeMeta = await this.loadAllMeta();
    const worktrees = await this.list();
    const now = Date.now();

    // A crash after exact source→retired rename leaves the public child absent
    // but retains metadata and the receipt. Resume through cleanup so branch,
    // materialization state, and metadata advance together instead of letting
    // the generic receipt sweep erase the only replay authority.
    for (const entry of Object.values(authoritativeMeta)) {
      if (entry.claudeManaged || !entry.materializationIdentity
        || !entry.materializationParentIdentity) continue;
      const ownedPath = entry.materializationIdentity.canonicalPath;
      if (await this.pathExists(ownedPath) || activeLanePaths.has(ownedPath)) continue;
      const removed = await this.cleanup(entry.id, {
        force: true,
        deleteBranch: true,
        overrideLiveGuard: true,
      });
      if (removed) pruned.push(entry.id);
    }

    const handledPaths = new Set(
      await Promise.all(worktrees.map((worktree) => this.canonicalPath(worktree.path))),
    );
    for (const wt of worktrees) {
      if (now - wt.lastActivityAt > maxAgeMs
        && wt.status !== 'active'
        && wt.status !== 'creating'
        && wt.status !== 'setup'
        && now - wt.createdAt >= RETENTION_CREATION_GRACE_MS) {
        // Check if this worktree backs an active lane
        const wtPath = wt.path;
        const [canonicalWtPath, canonicalListedPath] = await Promise.all([
          this.canonicalPath(wtPath),
          this.canonicalPath(wt.path),
        ]);
        if (activeLanePaths.has(canonicalWtPath) || activeLanePaths.has(canonicalListedPath)) {
          console.log(`[worktree-prune] Skipping ${wt.id} — active lane bound to this worktree`);
          continue;
        }
        const removed = await this.cleanup(wt.id, { force: true, deleteBranch: true });
        if (removed) {
          pruned.push(wt.id);
        }
      }
    }

    // F39 (#1031): scan the worktree base dir for orphan packet dirs that
    // aren't in meta and aren't in `git worktree list`. These accumulate after
    // dev-bridge restarts or aborted dispatch cycles and don't get reaped by
    // the loop above because list() can't see them. Without this sweep, the
    // disk fills within a few dispatch days (we hit 100% in May 2026).
    try {
      const { readdir } = await import('node:fs/promises');
      for (const worktreeBase of this.worktreeBases) {
        let worktreeBaseIdentity: Awaited<ReturnType<typeof captureWorktreeMaterializationIdentity>> | null = null;
        for (const candidate of Object.values(authoritativeMeta)) {
          const parentIdentity = candidate.materializationParentIdentity;
          if (!parentIdentity || candidate.claudeManaged) continue;
          try {
            await assertWorktreeMaterializationIdentity(worktreeBase, parentIdentity);
            worktreeBaseIdentity = parentIdentity;
            break;
          } catch {
            // A durable parent receipt from another or replaced base is not authority here.
          }
        }
        for (const candidate of Object.values(authoritativeMeta)) {
          if (worktreeBaseIdentity) break;
          const childIdentity = candidate.materializationIdentity;
          if (!childIdentity || candidate.claudeManaged) continue;
          const candidatePath = path.join(worktreeBase, candidate.id);
          try {
            await assertWorktreeMaterializationIdentity(candidatePath, childIdentity);
            const capturedBase = await captureWorktreeMaterializationIdentity(worktreeBase);
            if (path.dirname(childIdentity.canonicalPath) !== capturedBase.canonicalPath) continue;
            await assertWorktreeMaterializationIdentity(candidatePath, childIdentity);
            worktreeBaseIdentity = capturedBase;
            break;
          } catch {
            // A durable child receipt from another base is not authority here.
          }
        }
        const entries = await readdir(worktreeBase, { withFileTypes: true }).catch(() => []);
        if (!worktreeBaseIdentity) {
          for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.startsWith('packet-')) continue;
            const mtime = await this.probeMtimeMs(path.join(worktreeBase, entry.name));
            if (mtime === null) {
              console.warn(`[worktree-prune] SKIPPED orphan ${entry.name} — mtime probe failed/unknown (never deleting on unknown age)`);
            }
          }
          continue;
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          // #1673 — the quarantine dir itself is never an orphan candidate.
          if (entry.name === TRASH_DIR_NAME) continue;
          if (!entry.name.startsWith('packet-')) continue;
          const orphanPath = path.join(worktreeBase, entry.name);
          const orphanIdentity = await captureWorktreeMaterializationIdentity(orphanPath)
            .catch(() => null);
          if (!orphanIdentity) continue;
          const canonicalOrphanPath = orphanIdentity.canonicalPath;
          if (handledPaths.has(canonicalOrphanPath) || activeLanePaths.has(canonicalOrphanPath)) continue;
          // #1585: an UNKNOWN mtime must mean KEEP, never delete. The old code
          // (`.catch(() => 0)`) turned a failed probe into epoch 0 and fell
          // through to `rm -rf` — a fresh worktree whose stat momentarily failed
          // read as "infinitely old". Probe failure / zero / non-finite → skip.
          const mtime = await this.probeMtimeMs(orphanPath);
          if (mtime === null) {
            console.warn(`[worktree-prune] SKIPPED orphan ${entry.name} — mtime probe failed/unknown (never deleting on unknown age)`);
            continue;
          }
          if (now - mtime <= maxAgeMs) continue;
          try {
            await assertWorktreeMaterializationIdentity(orphanPath, orphanIdentity);
          } catch {
            continue;
          }
          if (!(await allowWorktreeRemoval(orphanPath, { logPrefix: 'worktree-prune-orphan' }))) continue;
          try {
            await retireExactManagedDirectory({
              repositoryPath: this.repoRoot,
              worktreeId: entry.name,
              directoryPath: orphanPath,
              identity: orphanIdentity,
              parentIdentity: worktreeBaseIdentity,
              retirementReason: 'empty-orphan',
            });
          } catch (error) {
            console.warn(
              `[worktree-prune] REFUSED exact orphan retirement ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
            );
            continue;
          }
          completeExactManagedDirectoryRetirement(this.repoRoot, entry.name);
          console.log(`[worktree-prune] Reaped orphan ${entry.name} (no meta, no git, age ${Math.round((now - mtime) / 3_600_000)}h)`);
          pruned.push(entry.name);
        }

        // Resume only SQLite-claimed exact retirements. Arbitrary names under
        // the base or legacy quarantine directory are never sweep targets.
        await finishPendingExactManagedDirectoryRetirements(
          this.repoRoot,
          worktreeBase,
          worktreeBaseIdentity,
          (worktreeId) => !(worktreeId in authoritativeMeta),
        );
      }
    } catch (err) {
      console.warn(`[worktree-prune] Orphan scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Retention enforcement (Cursor-parity): beyond the operator's max-count /
    // max-total-size limits, reclaim the OLDEST safe worktrees first. "Safe" =
    // not bound to an active/reviewing lane AND no uncommitted changes. Runs on
    // the same throttled prune cadence as the age sweep above.
    const retired = await this.enforceRetentionLimits(activeLanePaths).catch((err) => {
      console.warn(`[worktree-retention] enforcement failed: ${err instanceof Error ? err.message : String(err)}`);
      return [] as string[];
    });
    for (const id of retired) pruned.push(id);

    // Also run git's built-in prune for any orphaned worktrees
    await execFileAsync('git', ['worktree', 'prune'], {
      windowsHide: true,
      cwd: this.repoRoot,
      timeout: 10_000,
    }).catch(() => {});

    return pruned;
  }

  /**
   * Enforce the managed-worktree retention ceilings (count + total GB).
   *
   * Triple-guarded, in this order — when ANY guard is unsure, the worktree is
   * KEPT, never removed:
   *   1. SAFE-to-remove: the worktree's path must NOT back an active/reviewing
   *      lane (`activeLanePaths` is every non-terminal lane's worktree path).
   *      A path absent from that set is a terminal-lane or orphan worktree.
   *   2. OLDEST-FIRST: candidates are sorted ascending by last activity; only
   *      the oldest are considered for removal, up to what the limits require.
   *   3. CLEAN: `git status --porcelain` must be empty (no uncommitted/untracked
   *      changes). A dirty tree is skipped + logged, never deleted — matching
   *      the "never lose agent work" contract of the rest of this file.
   *
   * `activeLanePaths` is passed in from {@link prune} (single lane-registry read).
   * A `0` limit on either axis means that axis is unbounded (guard off).
   * Returns the ids actually removed.
   */
  private async enforceRetentionLimits(activeLanePaths: Set<string> | null): Promise<string[]> {
    // Fail closed: a null set means the lane-registry read failed, so we can't
    // tell active from terminal. The age sweep tolerates that (24h floor); this
    // path has NO age floor and could reap a clean in-flight worktree — skip
    // the whole pass instead.
    if (activeLanePaths === null) {
      console.warn('[worktree-retention] lane registry unavailable — skipping retention pass (fail closed)');
      return [];
    }
    let maxCount = 0;
    let maxTotalGb = 0;
    try {
      const { resolveWorktreeRetentionSync } = await import('@/lib/operator/defaults');
      const limits = resolveWorktreeRetentionSync();
      maxCount = limits.maxCount;
      maxTotalGb = limits.maxTotalGb;
    } catch {
      // Operator defaults unavailable — no configured ceiling, nothing to do.
      return [];
    }
    if (maxCount <= 0 && maxTotalGb <= 0) return [];

    // Measure disk usage (needed for the size axis). Only candidate worktrees
    // living DIRECTLY under this repo's primary or legacy managed bases are in
    // scope — this excludes claude-managed trees (.claude/worktrees) and is symlink-safe
    // (macOS /var → /private/var would defeat a plain string prefix match).
    const all = await this.list({ withDiskUsage: maxTotalGb > 0 });
    const inScope = await Promise.all(
      all.map(async (wt) => (
        (await this.isManagedWorktreeBase(path.dirname(wt.path)))
        && !activeLanePaths?.has(await this.canonicalPath(wt.path))
      )),
    );
    const candidates = all
      .filter((_, i) => inScope[i])
      .filter((wt) => wt.status !== 'creating' && wt.status !== 'setup')
      .filter((wt) => Date.now() - wt.createdAt >= RETENTION_CREATION_GRACE_MS)
      // #1585: an unknown / zero / non-finite mtime must NOT sort as "oldest"
      // and get reaped first — that ranked the NEWEST worktrees for deletion.
      // Exclude unknown-age candidates from retention entirely.
      .filter((wt) => Number.isFinite(wt.lastActivityAt) && wt.lastActivityAt > 0)
      // Oldest first — the retention victim order.
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt);

    if (candidates.length === 0) return [];

    const maxBytes = maxTotalGb > 0 ? maxTotalGb * 1024 * 1024 * 1024 : 0;
    let liveCount = candidates.length;
    let liveBytes = candidates.reduce((sum, wt) => sum + (wt.diskUsageBytes ?? 0), 0);
    const removed: string[] = [];

    for (const wt of candidates) {
      const overCount = maxCount > 0 && liveCount > maxCount;
      const overSize = maxBytes > 0 && liveBytes > maxBytes;
      if (!overCount && !overSize) break;

      // Guard 3: never delete a worktree with uncommitted work.
      if (await this.hasUncommittedChanges(wt.path)) {
        console.log(`[worktree-retention] Skipping ${wt.id} — uncommitted changes present (refusing to delete dirty worktree)`);
        continue;
      }

      const didRemove = await this.cleanup(wt.id, { force: true, deleteBranch: true });
      if (!didRemove) continue;
      liveCount -= 1;
      liveBytes -= wt.diskUsageBytes ?? 0;
      removed.push(wt.id);
      console.log(
        `[worktree-retention] Reclaimed ${wt.id} (oldest-first; count ${liveCount}/${maxCount || '∞'}, `
        + `size ${(liveBytes / 1024 / 1024 / 1024).toFixed(2)}GB/${maxTotalGb || '∞'})`,
      );
    }

    return removed;
  }

  /**
   * True when the worktree has uncommitted or untracked changes (`git status
   * --porcelain` is non-empty). Fail-safe: if git can't be trusted here — the
   * toplevel isn't this dir (would walk up to the repo root, #1404) or the probe
   * throws — return true so the caller KEEPS the worktree rather than risk a
   * delete over unsaved work.
   */
  private async hasUncommittedChanges(worktreePath: string): Promise<boolean> {
    try {
      const { stdout: toplevelRaw } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
        windowsHide: true,
        cwd: worktreePath,
        timeout: 5000,
      });
      if (!(await this.samePath(toplevelRaw.trim(), worktreePath))) return true;
      const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
        windowsHide: true,
        cwd: worktreePath,
        timeout: 5000,
      });
      return stdout.trim().length > 0;
    } catch {
      return true;
    }
  }

  // ── Link to Agent Session ──

  /**
   * Associate a worktree with an agent session key.
   */
  async linkSession(worktreeId: string, sessionKey: string): Promise<void> {
    await withWorktreeMetaTransaction(this.repoRoot, async (transaction) => {
      const entry = (await transaction.readAll())[worktreeId];
      if (entry) {
        entry.sessionKey = sessionKey;
        if (entry.status === 'creating' || entry.status === 'setup') {
          entry.status = 'active';
        }
        delete entry.creationOwner;
        await transaction.save(worktreeId, entry);
      }
    });
  }

  // ── Private Helpers ──

  /**
   * Check for uncommitted changes without rewriting source or its index.
   * Dirty or uncertain source must remain in its checkout.
   */
  private async preserveUncommittedWork(
    worktreePath: string,
    worktreeId: string,
  ): Promise<'clean' | 'skip'> {
    try {
      // #1404 belt-and-suspenders: even if a caller slips an unsafe path past
      // the cleanup guard, never add/commit unless the git toplevel IS the
      // worktree dir itself — a non-git dir makes git walk up to the repo root
      // and this preserve would commit the OPERATOR'S uncommitted work.
      const { stdout: toplevelRaw } = await execFileAsync(
        'git', ['rev-parse', '--show-toplevel'],
        { windowsHide: true, cwd: worktreePath, timeout: 5000 },
      );
      if (!(await this.samePath(toplevelRaw.trim(), worktreePath))) {
        console.error(`[worktree-prune] REFUSED preserve for ${worktreeId}: git toplevel ${toplevelRaw.trim()} != ${worktreePath} (repo-root write guard, #1404)`);
        return 'skip';
      }

      const { stdout: status } = await execFileAsync(
        'git', ['status', '--porcelain'],
        { windowsHide: true, cwd: worktreePath, timeout: 5000 },
      );
      if (!status.trim()) return 'clean';

      console.log(`[worktree-prune] ${worktreeId} has uncommitted changes; retaining checkout`);
      return 'skip';
    } catch {
      // The caller captured a live directory identity before entering this
      // guard, so an unreadable Git state is unknown work, never clean work.
      return 'skip';
    }
  }

  /**
   * Preserve committed-but-unmerged work before destroying a worktree (#1103).
   * `preserveUncommittedWork` only saves dirty files; a *clean* worktree can
   * still hold commits that were never merged or pushed (e.g. the agent
   * committed, but the lane was marked no_changes_produced before review). We
   * copy those commits into the main repo under `preserved/<id>` so the dir can
   * still be removed (disk reclaimed) without discarding the work.
   * Returns 'preserved' if commits were saved, 'clean' if HEAD is already merged
   * into base / empty, or 'skip' if preservation failed (caller aborts cleanup).
   */
  private async preserveCommittedWork(
    worktreePath: string,
    worktreeId: string,
    baseBranch: string,
    isolationKind: WorkspaceIsolationKind,
  ): Promise<'preserved' | 'clean' | 'skip'> {
    const base = baseBranch.trim() || 'main';

    let headSha: string;
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        windowsHide: true,
        cwd: worktreePath,
        timeout: 5000,
      });
      headSha = stdout.trim();
      if (!headSha) return 'clean';
    } catch {
      // The cleanup caller proved the directory exists. If HEAD cannot be
      // resolved, ownership is ambiguous and destructive cleanup must stop.
      return 'skip';
    }

    // If HEAD is already an ancestor of base, the work is merged — o8 rebases
    // before merge, so a merged branch fast-forwards into base. Nothing to do.
    try {
      await execFileAsync('git', ['merge-base', '--is-ancestor', headSha, base], {
        windowsHide: true,
        cwd: isolationKind === 'apfs-cow-clone' ? this.repoRoot : worktreePath,
        timeout: 10_000,
      });
      return 'clean'; // exit 0 → HEAD ⊆ base
    } catch {
      // exit 1 (HEAD has commits not in base) or unknown base — preserve to be safe.
    }

    const preservedRef = `refs/heads/preserved/${worktreeId}`;
    try {
      if (isolationKind === 'apfs-cow-clone') {
        // Separate object store — copy the commits into the main repo's store.
        await execFileAsync('git', ['fetch', worktreePath, `+HEAD:${preservedRef}`], {
          windowsHide: true,
          cwd: this.repoRoot,
          timeout: 30_000,
        });
      } else {
        // Shared object store — the commit is already present; just point a ref.
        await execFileAsync('git', ['update-ref', preservedRef, headSha], {
          windowsHide: true,
          cwd: this.repoRoot,
          timeout: 5000,
        });
      }
      console.log(`[worktree-prune] ${worktreeId} had unmerged commits — preserved as branch preserved/${worktreeId} (${headSha.slice(0, 8)})`);
      return 'preserved';
    } catch (err) {
      console.warn(`[worktree-prune] Could not preserve committed work for ${worktreeId}, skipping cleanup to avoid loss: ${err instanceof Error ? err.message : String(err)}`);
      return 'skip';
    }
  }

  private async getCurrentBranch(): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
        windowsHide: true,
        cwd: this.repoRoot,
        timeout: 5000,
      });
      return stdout.trim() || 'main';
    } catch {
      return 'main';
    }
  }

  private async assertCreatedWorktreeBranch(worktreePath: string, expectedBranch: string): Promise<void> {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      windowsHide: true,
      cwd: worktreePath,
      timeout: 5000,
    });
    const actualBranch = stdout.trim();
    if (actualBranch !== expectedBranch) {
      throw new Error(
        `Lane branch binding mismatch after worktree creation: recorded "${expectedBranch}", actual "${actualBranch || '(detached)'}".`,
      );
    }
  }

  private async gitWorktreeList(): Promise<Array<{ path: string; branch?: string }>> {
    if (!await mayHaveGitRepositoryContext(this.repoRoot)) return [];
    try {
      const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
        windowsHide: true,
        cwd: this.repoRoot,
        timeout: 5000,
      });

      const entries: Array<{ path: string; branch?: string }> = [];
      let current: { path: string; branch?: string } | null = null;

      for (const line of stdout.split('\n')) {
        if (line.startsWith('worktree ')) {
          if (current) entries.push(current);
          current = { path: line.slice('worktree '.length) };
        } else if (line.startsWith('branch ') && current) {
          current.branch = line.slice('branch refs/heads/'.length);
        }
      }
      if (current) entries.push(current);

      return entries;
    } catch {
      return [];
    }
  }

  async getDirtyFiles(worktreePath: string, baseBranch?: string): Promise<string[]> {
    try {
      // Three independent git probes with no ordering dependency between them.
      // They used to run SERIALLY — three full process-spawn round trips
      // (~68ms each on the operator's Intel box, so ~204ms per worktree) to
      // answer three questions that could have been asked at the same time.
      // Concurrent: wall time becomes the slowest probe, not the sum.
      //
      // Deliberately NOT collapsed into a single `git diff --name-only HEAD`.
      // That would miss a file that was staged and then reverted in the working
      // tree (index differs from HEAD, working tree does not) — the union of the
      // three probes is the correct definition of "dirty" and is preserved here
      // exactly, including the failure semantics: if either of the first two
      // probes throws, Promise.all rejects and the outer catch returns [], just
      // as it did before. Only the base-branch probe swallows its own error,
      // because the base branch may legitimately not be reachable.
      const [uncommitted, staged, committed] = await Promise.all([
        // Uncommitted changes (working tree vs index)
        execFileAsync('git', ['diff', '--name-only'], {
          windowsHide: true,
          cwd: worktreePath,
          timeout: 5000,
        }).then((r) => r.stdout),

        // Staged changes (index vs HEAD)
        execFileAsync('git', ['diff', '--name-only', '--cached'], {
          windowsHide: true,
          cwd: worktreePath,
          timeout: 5000,
        }).then((r) => r.stdout),

        // Committed changes since base (if base provided)
        baseBranch
          ? execFileAsync('git', ['diff', '--name-only', `${baseBranch}...HEAD`], {
              windowsHide: true,
              cwd: worktreePath,
              timeout: 5000,
            })
              .then((r) => r.stdout)
              .catch(() => '' /* base branch may not be reachable */)
          : Promise.resolve(''),
      ]);

      const allFiles = [...uncommitted.split('\n'), ...staged.split('\n'), ...committed.split('\n')]
        .map((f) => f.trim())
        .filter(Boolean);

      return [...new Set(allFiles)];
    } catch {
      return [];
    }
  }

  /**
   * Recursive disk walk. NOT cheap — `du -sk` stats every inode under the path,
   * and a worktree carries node_modules / .next / target. Measured at 189ms for
   * a single 38MB worktree on the operator's box, and it scales with the tree.
   *
   * The old comment here claimed "fast even for large dirs". It is not, and that
   * claim cost real money: `list()` called this unconditionally, and the 5s
   * conflict scan calls `list()`, so idle o8 was recursively walking every
   * worktree on disk twelve times a minute, forever.
   *
   * Only ever call this behind `list({ withDiskUsage: true })`.
   */
  private async getDiskUsage(dirPath: string): Promise<number> {
    try {
      const { stdout } = await execFileAsync('du', ['-sk', dirPath], { windowsHide: true, timeout: 5000 });
      const kb = parseInt(stdout.split('\t')[0] ?? '0', 10);
      return kb * 1024;
    } catch {
      return 0;
    }
  }

  /**
   * Probe a directory's mtime, returning `null` when the age is UNKNOWN (stat
   * failed, or the mtime is zero/non-finite). This NEVER masks a failed probe
   * as "now" or "epoch 0" — the caller decides
   * what unknown age means. The prune orphan-sweep uses it so an unknown mtime
   * is KEPT, never treated as infinitely old and reaped (#1585).
   */
  private async probeMtimeMs(dirPath: string): Promise<number | null> {
    try {
      const s = await stat(dirPath);
      return Number.isFinite(s.mtimeMs) && s.mtimeMs > 0 ? s.mtimeMs : null;
    } catch {
      return null;
    }
  }

  private inferStatus(lastActivity: number, dirtyFiles: string[], entry: WorktreeMetaEntry): WorktreeStatus {
    // Preserve explicit lifecycle states tracked in metadata
    if (entry.status === 'creating' || entry.status === 'setup') return entry.status;

    const ageMs = Date.now() - lastActivity;
    if (ageMs > STALE_THRESHOLD_MS) return 'stale';
    if (dirtyFiles.length > 0 && ageMs < 5 * 60_000) return 'active';
    if (dirtyFiles.length > 0) return 'ready';
    return 'ready';
  }

  private async pathExists(p: string): Promise<boolean> {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  }

  private async resolveManagedWorktreePath(worktreeId: string): Promise<string> {
    for (const base of this.worktreeBases) {
      const candidate = path.join(base, worktreeId);
      if (await this.pathExists(candidate)) return candidate;
    }
    return path.join(this.worktreeBase, worktreeId);
  }

  private async isManagedWorktreeBase(candidate: string): Promise<boolean> {
    for (const base of this.worktreeBases) {
      if (await this.samePath(candidate, base)) return true;
    }
    return false;
  }

  private async samePath(a: string, b: string): Promise<boolean> {
    if (a === b) return true;
    const [canonicalA, canonicalB] = await Promise.all([
      this.canonicalPath(a),
      this.canonicalPath(b),
    ]);
    return canonicalA === canonicalB;
  }

  private async canonicalPath(candidatePath: string): Promise<string> {
    try {
      return await realpath(candidatePath);
    } catch {
      return path.resolve(candidatePath);
    }
  }

  // ── Metadata Persistence ──

  private async loadAllMeta(): Promise<Record<string, WorktreeMetaEntry>> {
    return withWorktreeMetaTransaction(
      this.repoRoot,
      (transaction) => transaction.readAll(),
    );
  }

  private async saveMeta(id: string, entry: WorktreeMetaEntry): Promise<void> {
    await withWorktreeMetaTransaction(this.repoRoot, (transaction) => transaction.save(id, entry));
  }

  private async removeMeta(id: string): Promise<void> {
    await withWorktreeMetaTransaction(this.repoRoot, (transaction) => transaction.remove(id));
  }

  private async updateMetaStatus(id: string, status: WorktreeStatus): Promise<void> {
    await withWorktreeMetaTransaction(this.repoRoot, async (transaction) => {
      const entry = (await transaction.readAll())[id];
      if (!entry) return;
      const releasedSlot = status === 'ready' ? entry.warmTransfer?.slotToken : undefined;
      entry.status = status;
      if (status !== 'creating' && status !== 'setup') {
        delete entry.creationOwner;
        delete entry.warmTransfer;
      }
      await transaction.save(id, entry, releasedSlot
        ? sqlite => releaseWarmPacketSlot(releasedSlot, sqlite) : undefined);
    });
  }

  private async updateMetaHydrationPaths(id: string, hydrationPaths: string[]): Promise<void> {
    await withWorktreeMetaTransaction(this.repoRoot, async (transaction) => {
      const entry = (await transaction.readAll())[id];
      if (!entry) return;
      entry.hydrationPaths = hydrationPaths;
      await transaction.save(id, entry);
    });
  }

  private async updateMetaDependencyMaterialization(
    id: string,
    dependencyMaterialization: DependencyMaterializationReceipt,
  ): Promise<void> {
    await withWorktreeMetaTransaction(this.repoRoot, async (transaction) => {
      const entry = (await transaction.readAll())[id];
      if (!entry) return;
      entry.dependencyRecipeKey = dependencyMaterialization.recipeKey;
      entry.dependencyMaterialization = dependencyMaterialization;
      await transaction.save(id, entry);
    });
  }

  async recordDependencyMaterialization(
    worktreeId: string,
    dependencyMaterialization: DependencyMaterializationReceipt,
  ): Promise<void> {
    await this.updateMetaDependencyMaterialization(worktreeId, dependencyMaterialization);
    const entry = (await this.loadAllMeta())[worktreeId];
    if (!entry || JSON.stringify(entry.dependencyMaterialization) !== JSON.stringify(dependencyMaterialization)) {
      throw new Error('Managed workspace lost its dependency materialization receipt.');
    }
  }

  async clearDependencyMaterialization(worktreeId: string): Promise<void> {
    await this.markDependencyMaterializationUnavailable(worktreeId, null);
  }

  async markDependencyMaterializationUnavailable(
    worktreeId: string,
    dependencyMaterialization: DependencyMaterializationReceipt | null,
  ): Promise<void> {
    await withWorktreeMetaTransaction(this.repoRoot, async (transaction) => {
      const entry = (await transaction.readAll())[worktreeId];
      if (!entry) return;
      if (dependencyMaterialization) {
        entry.dependencyRecipeKey = dependencyMaterialization.recipeKey;
        entry.dependencyMaterialization = dependencyMaterialization;
      } else {
        delete entry.dependencyRecipeKey;
        delete entry.dependencyMaterialization;
      }
      if (entry.status === 'ready' || entry.status === 'active') entry.status = 'setup';
      await transaction.save(worktreeId, entry);
    });
    const entry = (await this.loadAllMeta())[worktreeId];
    if (dependencyMaterialization === null
      && (entry?.dependencyMaterialization || entry?.dependencyRecipeKey)) {
      throw new Error('Managed workspace retained a cleared dependency materialization receipt.');
    }
  }

  async restoreDependencyMaterialization(
    worktreeId: string,
    expected: DependencyMaterializationReceipt,
  ): Promise<DependencyMaterializationReceipt> {
    if (expected.mode !== 'image' || !expected.leaseId || !expected.generation) return expected;
    const entry = (await this.loadAllMeta())[worktreeId];
    if (!entry?.materializationIdentity) {
      throw new Error('Exact dependency remount lost its managed workspace identity.');
    }
    const workspacePath = entry.materializationIdentity.canonicalPath;
    if (expected.workspaceDevice !== entry.materializationIdentity.device
      || expected.workspaceInode !== entry.materializationIdentity.inode) {
      throw new Error('Exact dependency remount receipt differs from its managed workspace identity.');
    }
    const installCommand = expected.installCommand.trim();
    if (!installCommand) {
      throw new Error('Exact dependency remount lost its install command.');
    }
    await this.assertInstallableLocalNodeModules(
      workspacePath,
      entry.materializationIdentity,
    );
    let persistedReceipt: DependencyMaterializationReceipt | null = expected;
    const result = await materializeDependencyInstall(workspacePath, installCommand, {
      materializationIdentity: entry.materializationIdentity,
      exactGenerationRemount: {
        recipeKey: expected.recipeKey,
        generation: expected.generation,
        workspacePath,
      },
      afterMount: async (receipt) => {
        if (receipt.leaseId === expected.leaseId
          || receipt.recipeKey !== expected.recipeKey
          || receipt.generation !== expected.generation
          || receipt.workspaceDevice !== expected.workspaceDevice
          || receipt.workspaceInode !== expected.workspaceInode) {
          throw new Error('Exact dependency remount returned invalid replacement authority.');
        }
      },
      persistReceipt: async (receipt) => {
        await this.replaceDependencyMaterialization(
          worktreeId,
          persistedReceipt,
          receipt,
        );
        persistedReceipt = receipt;
      },
    });
    if (result.receipt.mode !== 'image'
      || result.receipt.status !== 'mounted'
      || result.receipt.leaseId === expected.leaseId
      || result.receipt.recipeKey !== expected.recipeKey
      || result.receipt.generation !== expected.generation
      || result.receipt.workspaceDevice !== expected.workspaceDevice
      || result.receipt.workspaceInode !== expected.workspaceInode) {
      throw new Error('Exact dependency remount returned invalid replacement authority.');
    }
    return result.receipt;
  }

  private async replaceDependencyMaterialization(
    worktreeId: string,
    expected: DependencyMaterializationReceipt | null,
    replacement: DependencyMaterializationReceipt | null,
  ): Promise<void> {
    await withWorktreeMetaTransaction(this.repoRoot, async (transaction) => {
      const entry = (await transaction.readAll())[worktreeId];
      if (!entry) {
        throw new Error('Exact dependency remount lost its managed workspace metadata.');
      }
      const current = entry.dependencyMaterialization ?? null;
      if (JSON.stringify(current) !== JSON.stringify(expected)) {
        throw new Error('Exact dependency remount lost its receipt compare-and-swap.');
      }
      if (replacement) {
        entry.dependencyRecipeKey = replacement.recipeKey;
        entry.dependencyMaterialization = replacement;
      } else {
        delete entry.dependencyRecipeKey;
        delete entry.dependencyMaterialization;
        if (entry.status === 'ready' || entry.status === 'active') entry.status = 'setup';
      }
      await transaction.save(worktreeId, entry);
    });
  }

  async listDependencyMaterializationAuthorities(): Promise<Array<{
    worktreeId: string;
    workspacePath: string;
    receipt: DependencyMaterializationReceipt;
  }>> {
    return Object.values(await readWorktreeMetaSnapshot(this.repoRoot)).flatMap((entry) => (
      entry.materializationIdentity && entry.dependencyMaterialization
        ? [{
            worktreeId: entry.id,
            workspacePath: entry.materializationIdentity.canonicalPath,
            receipt: entry.dependencyMaterialization,
          }]
        : []
    ));
  }

  async detachDependencyMaterialization(worktreeId: string): Promise<void> {
    const entry = (await this.loadAllMeta())[worktreeId];
    if (!entry?.materializationIdentity) return;
    await this.detachDependencyMaterializationForWorkspace(
      entry.materializationIdentity.canonicalPath,
      entry.dependencyMaterialization,
    );
  }

  private async detachDependencyMaterializationForWorkspace(
    workspacePath: string,
    dependencyMaterialization?: DependencyMaterializationReceipt,
  ): Promise<void> {
    await detachDependencyMaterialization(workspacePath, dependencyMaterialization);
  }

  private async updateMetaCreationBranchHead(id: string, creationBranchHead: string): Promise<void> {
    await withWorktreeMetaTransaction(this.repoRoot, async (transaction) => {
      const entry = (await transaction.readAll())[id];
      if (!entry) return;
      entry.creationBranchHead = creationBranchHead;
      await transaction.save(id, entry);
    });
  }

  private async bindCreatedMaterializationIdentity(
    id: string,
    identity: Awaited<ReturnType<typeof captureWorktreeMaterializationIdentity>>,
  ): Promise<void> {
    const parentIdentity = await captureWorktreeMaterializationIdentity(
      path.dirname(identity.canonicalPath),
    );
    await assertWorktreeMaterializationIdentity(identity.canonicalPath, identity);
    await withWorktreeMetaTransaction(this.repoRoot, async (transaction) => {
      const entry = (await transaction.readAll())[id];
      if (!entry || entry.claudeManaged) {
        throw new Error('Created managed workspace metadata is absent before ownership binding.');
      }
      if (entry.materializationIdentity
        && (entry.materializationIdentity.device !== identity.device
          || entry.materializationIdentity.inode !== identity.inode
          || entry.materializationIdentity.canonicalPath !== identity.canonicalPath)) {
        throw new Error('Created managed workspace metadata already names another materialization.');
      }
      await transaction.save(id, {
        ...entry,
        materializationIdentity: identity,
        materializationParentIdentity: parentIdentity,
      });
    });
  }
}
