/**
 * Worktree Isolation Types
 *
 * Shared types for the WorktreeManager service.
 * Designed to generalize to IsolationProvider (containers, VMs) in 2028.
 */

import type {
  RepoSetupConfig,
  RepoSetupEnvMode,
  RepoWorkspaceIsolationPreference,
} from '@/lib/repos/types';
import type { DependencyMaterializationReceipt } from '@/lib/workspace/dependency-materializer';
import type { MetadataLockProcessIdentity } from './metadata-lock-process-identity';

export type WorktreeStatus = 'creating' | 'setup' | 'ready' | 'active' | 'stale' | 'merging' | 'cleaning';

export type AgentType = 'claude-code' | 'codex' | (string & {});

export type WorkspaceIsolationKind = 'git-worktree' | 'apfs-cow-clone';

export type WorkspaceIsolationPreference = RepoWorkspaceIsolationPreference;

/**
 * Metadata for a single worktree.
 */
export interface WorktreeInfo {
  /** Unique worktree identifier (derived from taskName) */
  id: string;
  /** Absolute filesystem path to worktree directory */
  path: string;
  /** Git branch name */
  branch: string;
  /** Branch this was created from */
  baseBranch: string;
  /** Which agent type is using this worktree */
  agentType: AgentType;
  /** Linked agent session key (if running) */
  sessionKey?: string;
  /** Current lifecycle status */
  status: WorktreeStatus;
  /** When the worktree was created */
  createdAt: number;
  /** Last file modification timestamp */
  lastActivityAt: number;
  /** Disk usage in bytes (lazy, computed on demand) */
  diskUsageBytes?: number;
  /** Files modified since worktree creation */
  dirtyFiles: string[];
  /** Whether Claude manages this worktree natively (--worktree flag) */
  claudeManaged: boolean;
  /** Backing isolation implementation for this workspace */
  isolationKind?: WorkspaceIsolationKind;
  /** Ignored dependency/cache paths hydrated into this workspace */
  hydrationPaths?: string[];
  /** Deterministic package-manager recipe installed into this private workspace. */
  dependencyRecipeKey?: string;
  /** Exact native install or mounted dependency-image receipt for this workspace. */
  dependencyMaterialization?: DependencyMaterializationReceipt;
}

/**
 * Report of file overlaps across active worktrees.
 */
export interface ConflictReport {
  overlapping: ConflictEntry[];
  /** True if no overlapping files exist */
  safe: boolean;
}

export interface ConflictEntry {
  /** File path relative to repo root */
  file: string;
  /** Which worktrees have modified this file */
  worktreeIds: [string, string];
  /** warning = same file different sections, conflict = overlapping lines */
  severity: 'warning' | 'conflict';
}

/**
 * Options for creating a worktree.
 */
export interface CreateWorktreeOptions {
  /** Internal idle preparation, pinned to the observed main commit. */
  warmBaseCommit?: string;
  /** Agent type (determines creation strategy) */
  agentType: AgentType;
  /** Human-readable task name (used for branch + dir naming) */
  taskName: string;
  /** Explicit branch name to create/bind for this worktree */
  branchName?: string;
  /** Base branch to create from (default: HEAD) */
  baseBranch?: string;
  /** Force a real git worktree even for runtimes that usually self-manage */
  managed?: boolean;
  /** Skip auto-setup (npm install, etc.) */
  skipSetup?: boolean;
  /** Review-only materialization: no repository code, setup, environment copying or rebase. */
  materializationOnly?: boolean;
  /** How env files should be bootstrapped into the worktree */
  envMode?: RepoSetupEnvMode;
  /** Env files to copy/symlink when bootstrapping */
  envFiles?: string[];
  /** Registry-owned package-manager contract; absent callers use strict lockfile detection. */
  repoSetup?: RepoSetupConfig;
  /** Preferred workspace isolation implementation */
  isolationPreference?: WorkspaceIsolationPreference;
  /**
   * Packet id this worktree is bound to. When set, the manager derives the
   * worktree directory as `packet-<id>` so parallel packets each get their
   * own isolated clone instead of colliding on a taskName-derived slot.
   * Matches the regex in `src/lib/runtimes/claude-code.ts` so orchestrator
   * session detection stays in sync.
   */
  packetId?: string;
  /** Existing lane that owns this packet launch and its workspace receipts. */
  laneId?: string;
  /** Scheduler-owned reservation reused by the manager admission boundary. */
  storageAdmissionReservationId?: string;
  /** Launch ownership must still hold before ready publication ends creation rollback. */
  beforeReady?: (worktree: WorktreeInfo) => void;
}

/**
 * Options for cleaning up a worktree.
 */
export interface CleanupOptions {
  /** A delayed creator may retire only the generation it actually returned. */
  expectedCreation?: Pick<WorktreeInfo, 'createdAt' | 'path' | 'branch'>;
  /** Force removal even with uncommitted changes */
  force?: boolean;
  /** Also delete the branch */
  deleteBranch?: boolean;
  /** Caller already confirmed the bound session process exited. */
  overrideLiveGuard?: true;
  /** Exact clean HEAD already published through an equivalent rebased commit. */
  mergedEquivalentHeadSha?: string;
  /** Durable terminal reason recorded before materialization retirement. */
  workspaceRetirementAction?: 'pr' | 'merge' | 'discard' | 'cleanup';
}

/**
 * Result of a merge/PR action.
 */
export interface MergeResult {
  /** Action that was taken */
  action: 'pr' | 'merge' | 'discard';
  /** Whether the action succeeded */
  ok: boolean;
  /** Human-readable description */
  note: string;
  /** PR URL if action was 'pr' */
  prUrl?: string;
  /** Merge-specific — true only when `git push origin <targetBranch>` also succeeded (#534) */
  pushedToOrigin?: boolean;
  /** Merge-specific — captured when the push failed so callers can surface it */
  pushError?: string;
}

/**
 * Metadata stored under the resolved per-repo worktree root. Legacy
 * `<repo>/.cortex-worktrees/.meta.json` stores remain readable.
 */
export interface WorktreeMetaStore {
  version: 1;
  worktrees: Record<string, WorktreeMetaEntry>;
}

export interface WorktreeMetaEntry {
  /** Unused idle preparation; removed before packet ownership is published. */
  warmPool?: { head: string; held?: boolean; seal?: import('./warm-packet-integrity').WarmPacketSeal };
  /** Durable source authority while an unused tree is transferred to a packet. */
  warmTransfer?: { sourceId: string; sourceBranch: string; head: string; seal?: import('./warm-packet-integrity').WarmPacketSeal };
  /** Exact link targets provisioned by the manager, never environment contents. */
  environmentReferences?: Record<string, string>;
  /** Creation-time association for bounded terminal discovery, including collision slots. */
  packetId?: string;
  laneId?: string;
  id: string;
  agentType: AgentType;
  sessionKey?: string;
  baseBranch: string;
  createdAt: number;
  claudeManaged: boolean;
  taskName: string;
  /** Git branch name for providers that are not visible in git worktree list */
  branchName?: string;
  /** Explicit lifecycle status — preserved through inferStatus */
  status?: WorktreeStatus;
  /** Backing isolation implementation. Missing means legacy git worktree. */
  isolationKind?: WorkspaceIsolationKind;
  /** Ignored dependency/cache paths hydrated into this workspace */
  hydrationPaths?: string[];
  /** Deterministic package-manager recipe installed into this private workspace. */
  dependencyRecipeKey?: string;
  /** Exact native install or mounted dependency-image receipt for this workspace. */
  dependencyMaterialization?: DependencyMaterializationReceipt;
  /** Exact process that owns an unfinished managed creation. */
  creationOwner?: {
    pid: number;
    identity: MetadataLockProcessIdentity;
  };
  /** Exact branch tip proven inside the owned creation before retirement. */
  creationBranchHead?: string;
  /** Exact restored directory identity; later destructive operations must match it. */
  materializationIdentity?: {
    device: number;
    inode: number;
    canonicalPath: string;
    volumeId?: string;
  };
  /** Exact parent namespace that owns the materialized directory name. */
  materializationParentIdentity?: {
    device: number;
    inode: number;
    canonicalPath: string;
    volumeId?: string;
  };
  /** Durable exact restore target prepared before external Git creation. */
  restorePreparation?: {
    /** Historical name; new restores populate this final target directly. */
    stagePath: string;
    expectedPath: string;
    head: string;
    tree: string;
    isolationKind: WorkspaceIsolationKind;
    populationState?: 'empty' | 'populating' | 'populated';
    cleanupPhase?: 'purging' | 'target-retired' | 'admin-retired';
    claimOperationId?: string;
    gitAdminIdentity?: {
      path: string;
      device: number;
      inode: number;
    };
  };
}
