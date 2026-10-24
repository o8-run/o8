/**
 * Worktree Launch Integration
 *
 * Wires WorktreeManager into the agent launch flow.
 * - All supported agents (Codex, Claude Code): creates a managed git worktree,
 *   runs the pre-launch rebase onto origin/<baseBranch>, sets cwd for agent
 *   launch.
 *
 * Historically claude-code got the `--worktree` CLI flag and Claude managed
 * its own worktree externally. That skipped the pre-launch rebase and let
 * stale-base packets revert upstream work (#608). We now force managed mode
 * for claude-code so it walks through the same rebase gate Codex does.
 *
 * Auto-toggle: worktree isolation defaults ON when repo has active agents,
 * OFF when it's the first/only agent.
 *
 * @see https://github.com/o8-run/o8/issues/65
 * @see https://github.com/o8-run/o8/issues/608
 */

import { WorktreeManager } from './manager';
import { scheduleWarmPacketWorktrees, prepareWarmPacketWorktrees as prepareWarm, type WarmPacketOptions } from './warm-packet-pool';
export { shutdownWarmPacketWorktrees } from './warm-packet-pool';

export async function prepareWarmPacketWorktrees(opts: WarmPacketOptions): Promise<void> {
  await prepareWarm(opts, getManager(opts.repoRoot));
}
import { withPinnedWorkspaceReadSession } from './materialization-read-session';
import type { AgentType, WorktreeInfo, WorkspaceIsolationPreference } from './types';
import type { RepoSetupConfig, RepoSetupEnvMode } from '@/lib/repos/types';

// Cache managers per repo to avoid re-instantiating
const managers = new Map<string, WorktreeManager>();

function getManager(repoRoot: string): WorktreeManager {
  let mgr = managers.get(repoRoot);
  if (!mgr) {
    mgr = new WorktreeManager(repoRoot);
    managers.set(repoRoot, mgr);
  }
  return mgr;
}

/**
 * Resolve launch options for an agent, potentially creating a worktree.
 *
 * Returns:
 * - { worktree, cwd } if isolation was applied
 * - null if no isolation needed (first agent, or user opted out)
 */
export interface WorktreeLaunchResult {
  /** The worktree metadata */
  worktree: WorktreeInfo;
  /** CWD to launch the agent in (always the managed worktree path post-#608) */
  cwd: string;
  /**
   * Deprecated — historically the Claude CLI `--worktree` flag value. We now
   * always run claude-code from the managed worktree's cwd, so callers should
   * NOT forward this to the CLI. Kept optional on the type for backward-compat
   * with any in-flight lanes that still look it up during the transition.
   */
  claudeWorktreeFlag?: string;
}

export interface WorktreeLaunchOptions {
  /** Repository root path */
  repoRoot: string;
  /** Agent type being launched */
  agentType: AgentType;
  /** Human-readable task name */
  taskName: string;
  /**
   * Pre-assigned lane branch to bind the worktree to. When set, the manager
   * checks out this branch inside the worktree before the agent spawns so
   * codex/claude-code lands on the correct branch from turn 0 instead of
   * the legacy `worktree/<agent>/<slug>` placeholder. Required for packet
   * dispatch — without it the lane merge would observe an empty diff.
   */
  branchName?: string;
  /** Base branch (default: current HEAD) */
  baseBranch?: string;
  /** Force isolation on/off. If undefined, auto-decides based on active agents. */
  isolate?: boolean;
  /** Skip project setup (npm install, etc.) */
  skipSetup?: boolean;
  /** How env files should be bootstrapped into the worktree */
  envMode?: RepoSetupEnvMode;
  /** Env files to copy/symlink into the worktree */
  envFiles?: string[];
  /** Registry-owned package-manager and environment setup contract. */
  repoSetup?: RepoSetupConfig;
  /** Preferred workspace isolation implementation */
  isolationPreference?: WorkspaceIsolationPreference;
  /**
   * Packet id this launch is bound to. When set, the worktree directory is
   * named `packet-<id>` so two packets dispatched in parallel each get their
   * own clone instead of colliding on a taskName-derived slot.
   */
  packetId?: string;
  /** Existing lane that owns this packet launch and its workspace receipts. */
  laneId?: string;
  /** Scheduler-owned reservation reused at the materialization boundary. */
  storageAdmissionReservationId?: string;
}

/**
 * Should this launch get worktree isolation?
 *
 * Auto-logic:
 * - If isolate is explicitly set, respect it
 * - If there are already active worktrees for this repo, isolate
 * - If this is the first/only agent, don't isolate (no conflict risk)
 */
export async function shouldIsolate(opts: WorktreeLaunchOptions): Promise<boolean> {
  if (opts.isolate !== undefined) return opts.isolate;

  const mgr = getManager(opts.repoRoot);
  const existing = await mgr.list();
  const active = existing.filter(
    (wt) => wt.status === 'active' || wt.status === 'ready' || wt.status === 'setup',
  );

  // If there's already at least one active worktree, this new agent needs isolation
  return active.length > 0;
}

/**
 * Prepare a worktree for an agent launch.
 *
 * Creates a real managed git worktree for every supported agent, runs the
 * pre-launch rebase onto origin/<baseBranch>, runs setup, and returns the
 * worktree cwd. claude-code used to take a metadata-only path with
 * `--worktree`; that was retired in #608.
 *
 * Returns null if isolation is not needed.
 */
export async function prepareLaunchWorktree(
  opts: WorktreeLaunchOptions,
): Promise<WorktreeLaunchResult | null> {
  const isolate = await shouldIsolate(opts);
  if (!isolate) return null;

  const { captureLaunchLaneValidation } = await import('./launch-lane');
  const beforeReady = captureLaunchLaneValidation(opts);
  const mgr = getManager(opts.repoRoot);

  // #608 — claude-code packets now go through the same managed worktree path
  // as Codex so the pre-launch rebase runs. Force `managed: true` on claude-code
  // to bypass the Claude-self-managed early-return in WorktreeManager.create.
  const worktree = await withPinnedWorkspaceReadSession(() => mgr.create({
    agentType: opts.agentType,
    taskName: opts.taskName,
    branchName: opts.branchName,
    baseBranch: opts.baseBranch,
    skipSetup: opts.skipSetup,
    envMode: opts.envMode,
    envFiles: opts.envFiles,
    repoSetup: opts.repoSetup,
    isolationPreference: opts.isolationPreference,
    packetId: opts.packetId,
    laneId: opts.laneId,
    storageAdmissionReservationId: opts.storageAdmissionReservationId,
    beforeReady,
    managed: opts.agentType === 'claude-code' ? true : undefined,
  }));

  if (opts.packetId) scheduleWarmPacketWorktrees(opts, mgr);
  return {
    worktree,
    cwd: worktree.path, // All agents run inside the managed worktree directory
  };
}

/**
 * Link a launched agent session to its worktree.
 * Called after successful agent launch to associate the session key.
 */
export async function linkSessionToWorktree(
  repoRoot: string,
  worktreeId: string,
  sessionKey: string,
): Promise<void> {
  const mgr = getManager(repoRoot);
  await mgr.linkSession(worktreeId, sessionKey);
}

/**
 * Get the WorktreeManager for a repo (for direct use in API routes).
 */
export function getWorktreeManager(repoRoot: string): WorktreeManager {
  return getManager(repoRoot);
}

/**
 * Get worktree info for all repos that have active worktrees.
 * Used by the squad panel to show worktree indicators.
 */
export async function getActiveWorktreeSummary(repoRoot: string): Promise<{
  worktrees: WorktreeInfo[];
  conflicts: { safe: boolean; count: number };
  totalDiskUsage: number;
}> {
  const mgr = getManager(repoRoot);
  const [worktrees, conflicts] = await Promise.all([
    // The ONLY caller in the codebase that reads diskUsageBytes, so it is the
    // only one that pays for the `du -sk` recursive walk. Everyone else — most
    // importantly the ws-server's 5s conflict scan — gets the cheap list.
    mgr.list({ withDiskUsage: true }),
    mgr.detectConflicts(),
  ]);

  const totalDiskUsage = worktrees.reduce((sum, wt) => sum + (wt.diskUsageBytes ?? 0), 0);

  return {
    worktrees,
    conflicts: {
      safe: conflicts.safe,
      count: conflicts.overlapping.length,
    },
    totalDiskUsage,
  };
}
