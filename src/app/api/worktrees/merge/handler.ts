/**
 * Worktree Merge API
 *
 * POST /api/worktrees/merge — Create PR, merge to main, or discard a worktree
 *
 * @see https://github.com/o8-run/o8/issues/70
 */

import path from 'node:path';
import { NextResponse, type NextRequest } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { pushLfsObjects } from '@/lib/git/lfs-push';
import { NO_REPOSITORY_HOOKS } from '@/lib/git/no-repository-hooks';
import { assertLaneHeadOnBranch, laneGit } from '@/lib/lane/lane-git';
import { readLaneCreationBaseCommit } from '@/lib/lane/creation-base';
import { listLanes } from '@/lib/lane/registry';
import { commitDirtyWorktree } from '@/lib/lane/worktree-merge-git';
import { findRepoByLocalPath } from '@/lib/repos/registry';
import { requirePanelAuth } from '@/lib/panel/auth';
import { requestRealtimeRefresh } from '@/lib/realtime/publisher';
import {
  discardExactManagedWorktree,
  ExactDiscardUnavailableError,
} from '@/lib/workspace/exact-discard';
import { probeOwnedSessionProcessQuiescence } from '@/lib/workspace/process-probes';
import {
  withWorkspaceMaterializedMutation,
  WorkspaceMutationUnavailableError,
} from '@/lib/workspace/mutation-materialization-guard';
import { getWorktreeManager } from '@/lib/worktree/launch';
import {
  findWorkspaceMaterializationRetirement,
  replayWorkspaceMaterializationRetirement,
} from '@/lib/workspace/workspace-materialization-retirement';
import {
  isMaterializationExecutionRefusal,
  materializationAwareExecFile,
} from '@/lib/worktree/materialization-execution';
import type { MergeResult } from '@/lib/worktree/types';

const execFileAsync = materializationAwareExecFile;

interface MergeBody {
  repo: string;
  worktreeId: string;
  action: 'pr' | 'merge' | 'discard';
  /** Target branch for merge (default: main) */
  targetBranch?: string;
  /** PR title override */
  prTitle?: string;
  /** PR body override */
  prBody?: string;
}

export interface WorktreeMergeRouteDependencies {
  afterWorkspaceMaterializationProof?: (action: MergeBody['action']) => Promise<void> | void;
  beforeWorkspaceCleanup?: (action: 'pr' | 'merge') => Promise<void> | void;
  afterWorkspaceCleanup?: (action: MergeBody['action']) => Promise<void> | void;
  discardExact?: typeof discardExactManagedWorktree;
  createPR?: typeof createPR;
  mergeToTarget?: typeof mergeToTarget;
}

export async function handlePost(
  req: NextRequest,
  dependencies: WorktreeMergeRouteDependencies,
) {
  const principal = resolveRequestPrincipal(req);
  if (principal === 'worker') {
    return NextResponse.json({ error: 'Worktree publication is operator-controlled.' }, { status: 403 });
  }
  if (principal !== 'device') {
    const denied = requirePanelAuth(req);
    if (denied) return denied;
  }

  let body: MergeBody;
  try {
    body = (await req.json()) as MergeBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.repo || !body.worktreeId || !body.action) {
    return NextResponse.json(
      { error: 'repo, worktreeId, and action are required' },
      { status: 400 },
    );
  }
  if (body.action !== 'pr' && body.action !== 'merge' && body.action !== 'discard') {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }

  const mgr = getWorktreeManager(body.repo);
  try {
    const registeredRepo = await findRepoByLocalPath(body.repo);
    if (registeredRepo) {
      const pending = findWorkspaceMaterializationRetirement(
        registeredRepo.id,
        body.worktreeId,
        body.action,
      );
      if (pending) {
        const cleaned = await mgr.cleanup(body.worktreeId, {
          force: true,
          deleteBranch: body.action !== 'pr',
          overrideLiveGuard: true,
          workspaceRetirementAction: body.action,
        });
        if (!cleaned) {
          return NextResponse.json({
            action: body.action,
            ok: false,
            note: 'Terminal workspace cleanup is still pending exact retirement.',
          } satisfies MergeResult, { status: 409 });
        }
        await replayWorkspaceMaterializationRetirement(
          registeredRepo.id, body.worktreeId, body.action,
        );
        return NextResponse.json({
          action: body.action,
          ok: true,
          note: `${body.action} already completed; terminal workspace retirement was replayed.`,
        } satisfies MergeResult);
      }
    }
  } catch (error) {
    return NextResponse.json({
      action: body.action,
      ok: false,
      note: error instanceof Error ? error.message : 'Terminal workspace truth could not be verified.',
    } satisfies MergeResult, { status: 409 });
  }

  const worktree = await mgr.get(body.worktreeId);

  if (!worktree) {
    return NextResponse.json({ error: 'Worktree not found' }, { status: 404 });
  }

  const repoPath = path.resolve(body.repo);
  const worktreePath = path.resolve(worktree.path);
  const lanes = listLanes().filter((lane) => (
    Boolean(lane.packetId?.trim())
    && path.resolve(lane.repoPath) === repoPath
    && lane.worktreePath !== null
    && path.resolve(lane.worktreePath) === worktreePath
    && lane.branch === worktree.branch
  ));
  if (lanes.length !== 1) {
    return NextResponse.json({
      action: body.action,
      ok: false,
      note: lanes.length === 0
        ? 'Worktree publication refused because its exact packet lane is unavailable.'
        : 'Worktree publication refused because its packet lane ownership is ambiguous.',
    } satisfies MergeResult, { status: 409 });
  }
  const lane = lanes[0]!;

  try {
    const result = await withWorkspaceMaterializedMutation(lane, async (): Promise<MergeResult> => {
      await dependencies.afterWorkspaceMaterializationProof?.(body.action);
      switch (body.action) {
        case 'pr': {
          const prResult = await (dependencies.createPR ?? createPR)(worktree.path, worktree.branch, worktree.dirtyFiles, {
            repoPath,
            title: body.prTitle,
            body: body.prBody,
            targetBranch: body.targetBranch ?? 'main',
            agentType: worktree.agentType,
            createdAt: worktree.createdAt,
            lfsBase: readLaneCreationBaseCommit(lane.id),
          });
          // Cleanup worktree but keep branch (PR needs it)
          if (prResult.ok) {
            await dependencies.beforeWorkspaceCleanup?.('pr');
            const cleaned = await mgr.cleanup(body.worktreeId, {
              force: true,
              deleteBranch: false,
              workspaceRetirementAction: 'pr',
            });
            if (!cleaned) {
              return {
                action: 'pr',
                ok: false,
                note: `${prResult.note} Local workspace cleanup remains pending and can be retried safely.`,
              };
            }
            await dependencies.afterWorkspaceCleanup?.('pr');
          }
          return prResult;
        }

        case 'merge': {
          const mergeResult = await (dependencies.mergeToTarget ?? mergeToTarget)(body.repo, worktree.path, worktree.branch, body.targetBranch ?? 'main', {
            importBranchFromWorkspace: worktree.isolationKind === 'apfs-cow-clone',
            lfsBase: readLaneCreationBaseCommit(lane.id),
          });
          if (mergeResult.ok) {
            await dependencies.beforeWorkspaceCleanup?.('merge');
            const cleaned = await mgr.cleanup(body.worktreeId, {
              force: true,
              deleteBranch: true,
              workspaceRetirementAction: 'merge',
            });
            if (cleaned) await dependencies.afterWorkspaceCleanup?.('merge');
            // #538 — Post-merge decomposition pipeline. Never blocks the response
            // and never rolls back the merge on failure.
            try {
              const { enqueueDecompositionsAfterMerge } = await import('@/lib/dispatch/decomposition-pipeline');
              const runtime = worktree.agentType === 'claude-code' ? 'claude-code' : 'codex';
              await enqueueDecompositionsAfterMerge({
                repoPath: body.repo,
                runtime,
              });
            } catch (decompositionError) {
              console.warn(
                `[worktrees/merge] Decomposition scan failed for ${body.repo}: ${decompositionError instanceof Error ? decompositionError.message : String(decompositionError)}`,
              );
            }
            if (!cleaned) {
              return {
                action: 'merge',
                ok: false,
                note: `${mergeResult.note} Local workspace cleanup remains pending and can be retried safely.`,
              };
            }
          }
          return mergeResult;
        }

        case 'discard':
          await (dependencies.discardExact ?? discardExactManagedWorktree)({
            lane,
            worktreeId: body.worktreeId,
            isolationKind: worktree.isolationKind ?? 'git-worktree',
            processProbe: probeOwnedSessionProcessQuiescence,
          });
          await dependencies.afterWorkspaceCleanup?.('discard');
          return { action: 'discard', ok: true, note: `Discarded worktree ${body.worktreeId}` };

        default:
          return { action: body.action, ok: false, note: 'Unknown action' };
      }
    });

    if (result.ok) {
      void requestRealtimeRefresh({
        targets: ['global', 'mobileInbox'],
        fresh: true,
        reason: `worktree.${body.action}`,
      });
    }

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ExactDiscardUnavailableError) {
      return NextResponse.json({
        action: body.action,
        ok: false,
        note: err.message,
      } satisfies MergeResult, { status: 409 });
    }
    if (isMaterializationExecutionRefusal(err)) {
      return NextResponse.json({
        action: body.action,
        ok: false,
        note: 'Managed workspace ownership changed before the requested action; no mutation ran.',
      } satisfies MergeResult, { status: 409 });
    }
    if (err instanceof WorkspaceMutationUnavailableError) {
      return NextResponse.json({
        action: body.action,
        ok: false,
        note: err.message,
      } satisfies MergeResult, { status: 409 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export function createWorktreeMergePostForTesting(dependencies: WorktreeMergeRouteDependencies) {
  return (req: NextRequest) => handlePost(req, dependencies);
}

async function commitWorkspaceChanges(
  action: 'pr' | 'merge',
  worktreePath: string,
  repoPath: string,
  branch: string,
  message: string,
): Promise<MergeResult | null> {
  const status = async () => (await laneGit(worktreePath, repoPath,
    ['status', '--porcelain=v1', '--untracked-files=all'], { timeout: 5_000 })).stdout.trim();
  try {
    const dirty = await status();
    await assertLaneHeadOnBranch(worktreePath, repoPath, branch);
    if (!dirty) return null;
    await commitDirtyWorktree(worktreePath, repoPath, branch, message);
    if (await status()) {
      return {
        action,
        ok: false,
        note: `Workspace commit failed before ${action} publication; the workspace remained dirty and was preserved.`,
      };
    }
    return null;
  } catch (error) {
    const ownershipChanged = isMaterializationExecutionRefusal(error);
    return {
      action,
      ok: false,
      note: ownershipChanged
        ? `Managed workspace ownership changed before ${action} publication; no publish command ran.`
        : `Workspace commit failed before ${action} publication; the workspace was preserved: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ── PR Creation ──

async function createPR(
  worktreePath: string,
  branch: string,
  dirtyFiles: string[],
  opts: { repoPath: string; title?: string; body?: string; targetBranch: string; agentType: string; createdAt?: number; lfsBase?: string | null },
): Promise<MergeResult> {
  const commitFailure = await commitWorkspaceChanges(
    'pr',
    worktreePath,
    opts.repoPath,
    branch,
    `chore: worktree changes from ${opts.agentType}`,
  );
  if (commitFailure) return commitFailure;

  // Push branch
  try {
    await pushLfsObjects((args, options) => laneGit(worktreePath, opts.repoPath, args, options), 'origin', branch, opts.lfsBase ?? null);
    await laneGit(worktreePath, opts.repoPath, ['push', '-u', 'origin', branch], { timeout: 30_000 });
  } catch (err) {
    return {
      action: 'pr',
      ok: false,
      note: `Failed to push branch: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Get diffstat for PR body
  let diffstat = '';
  try {
    const { stdout: statOut } = await execFileAsync('git', [
      'diff', '--shortstat', `${opts.targetBranch}...HEAD`,
    ], { windowsHide: true, cwd: worktreePath, timeout: 5000 });
    diffstat = statOut.trim();
  } catch { /* non-critical */ }

  // Get duration estimate
  const durationMin = opts.createdAt
    ? Math.round((Date.now() - opts.createdAt) / 60_000)
    : undefined;

  // Create PR via gh CLI
  const taskName = branch.split('/').pop() ?? branch;
  const title = opts.title ?? `${opts.agentType}: ${taskName}`;
  const fileList = dirtyFiles.map((f) => `- \`${f}\``).join('\n');
  const prBody = opts.body ?? [
    `## Changes`,
    `**Agent:** ${opts.agentType}${durationMin ? ` · **Duration:** ${durationMin} min` : ''}`,
    `**Branch:** \`${branch}\`${diffstat ? ` · ${diffstat}` : ''}`,
    ``,
    `### Files Modified (${dirtyFiles.length})`,
    fileList,
    ``,
    `---`,
    `*Created by o8 WorktreeManager*`,
  ].join('\n');

  try {
    const { stdout } = await execFileAsync('gh', [
      'pr', 'create',
      '--title', title,
      '--body', prBody,
      '--base', opts.targetBranch,
      '--head', branch,
    ], { windowsHide: true, cwd: worktreePath, timeout: 30_000 });

    const prUrl = stdout.trim();
    return {
      action: 'pr',
      ok: true,
      note: `PR created: ${prUrl}`,
      prUrl,
    };
  } catch (err) {
    return {
      action: 'pr',
      ok: false,
      note: `Failed to create PR: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Direct Merge ──

async function mergeToTarget(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  targetBranch: string,
  opts?: { importBranchFromWorkspace?: boolean; lfsBase?: string | null },
): Promise<MergeResult> {
  const commitFailure = await commitWorkspaceChanges(
    'merge',
    worktreePath,
    repoRoot,
    branch,
    'chore: worktree changes',
  );
  if (commitFailure) return commitFailure;

  if (opts?.importBranchFromWorkspace) {
    try {
      await execFileAsync('git', [...NO_REPOSITORY_HOOKS, 'fetch', worktreePath, `${branch}:refs/heads/${branch}`], {
        windowsHide: true,
        cwd: repoRoot,
        timeout: 30_000,
      });
    } catch (err) {
      return {
        action: 'merge',
        ok: false,
        note: `Failed to import workspace branch before merge: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Safety: refuse to merge if repo root has uncommitted changes
  try {
    const { stdout: dirtyCheck } = await execFileAsync('git', ['status', '--porcelain'], {
      windowsHide: true,
      cwd: repoRoot,
      timeout: 5000,
    });
    if (dirtyCheck.trim().length > 0) {
      return {
        action: 'merge',
        ok: false,
        note: 'Repo root has uncommitted changes. Commit or stash first, or use "Create PR" instead.',
      };
    }
  } catch {
    // If we can't check, refuse
    return {
      action: 'merge',
      ok: false,
      note: 'Could not verify repo root is clean. Use "Create PR" instead.',
    };
  }

  // Check for conflicts before merging using merge-tree (no working tree mutation)
  try {
    const { stdout: mergeCheck } = await execFileAsync('git', [
      'merge-tree', '--write-tree', targetBranch, branch,
    ], { windowsHide: true, cwd: repoRoot, timeout: 10_000 });

    if (mergeCheck.includes('CONFLICT')) {
      return {
        action: 'merge',
        ok: false,
        note: 'Merge conflicts detected. Use "Create PR" instead for manual resolution.',
      };
    }
  } catch {
    // merge-tree may not be available; fall through to try merge
  }

  // Save current branch to restore after merge
  let originalBranch: string | null = null;
  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      windowsHide: true,
      cwd: repoRoot,
      timeout: 5000,
    });
    originalBranch = stdout.trim() || null;
  } catch { /* best effort */ }

  // Perform the merge
  try {
    await execFileAsync('git', [...NO_REPOSITORY_HOOKS, 'checkout', targetBranch], {
      windowsHide: true,
      cwd: repoRoot,
      timeout: 10_000,
    });

    await execFileAsync('git', [...NO_REPOSITORY_HOOKS, 'merge', '--no-ff', branch, '-m', `Merge worktree: ${branch}`], {
      windowsHide: true,
      cwd: repoRoot,
      timeout: 15_000,
    });

    // #534 — push the merge to origin. Failure here must NOT revert the merge:
    // the base branch already has the commit locally.
    let pushedToOrigin = false;
    let pushError: string | undefined;
    try {
      await pushLfsObjects((args, options) => execFileAsync('git', [...NO_REPOSITORY_HOOKS, ...args], {
        windowsHide: true,
        cwd: repoRoot,
        ...options,
      }), 'origin', targetBranch, opts?.lfsBase ?? null);
      await execFileAsync('git', [...NO_REPOSITORY_HOOKS, 'push', 'origin', targetBranch], {
        windowsHide: true,
        cwd: repoRoot,
        timeout: 60_000,
      });
      pushedToOrigin = true;
    } catch (pushErr) {
      pushError = pushErr instanceof Error ? pushErr.message : String(pushErr);
      console.warn(`[worktrees/merge] Push to origin failed for ${targetBranch} after merging ${branch}: ${pushError}`);
    }

    // Restore original branch if it was different from target
    if (originalBranch && originalBranch !== targetBranch) {
      await execFileAsync('git', [...NO_REPOSITORY_HOOKS, 'checkout', originalBranch], {
        windowsHide: true,
        cwd: repoRoot,
        timeout: 10_000,
      }).catch(() => { /* best effort restore */ });
    }

    return {
      action: 'merge',
      ok: true,
      note: pushedToOrigin
        ? `Merged ${branch} into ${targetBranch} and pushed to origin.`
        : `Merged ${branch} into ${targetBranch} LOCALLY — push to origin failed: ${pushError ?? 'unknown error'}.`,
      pushedToOrigin,
      pushError,
    };
  } catch (err) {
    // Abort any partial merge
    await execFileAsync('git', [...NO_REPOSITORY_HOOKS, 'merge', '--abort'], { windowsHide: true, cwd: repoRoot, timeout: 5000 }).catch(() => {});
    // Restore original branch
    if (originalBranch) {
      await execFileAsync('git', [...NO_REPOSITORY_HOOKS, 'checkout', originalBranch], {
        windowsHide: true,
        cwd: repoRoot,
        timeout: 10_000,
      }).catch(() => {});
    }
    return {
      action: 'merge',
      ok: false,
      note: `Merge failed: ${err instanceof Error ? err.message : String(err)}. Use "Create PR" instead.`,
    };
  }
}
