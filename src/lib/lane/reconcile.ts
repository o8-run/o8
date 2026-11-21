import { resolveGitBinary } from '@/lib/git/binary';
import { execFile } from '@/lib/providers/child-process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileStamp, gitDirectories } from '@/lib/git/ref-stamp';
import { promisify } from 'node:util';

import { createApproval } from '@/lib/approvals/store';
import { laneCreationBaseCommit } from '@/lib/lane/creation-base';
import { getLaneEvents, listLanes, setLaneStatus } from '@/lib/lane/registry';
import type { Lane, LaneRuntime, LaneStatus } from '@/lib/lane/types';
import { getRuntime } from '@/lib/runtimes';
import { crashSurvivableWorkersEnabled } from '@/lib/runtimes/shared/owned-session/crash-survival';
import { listWorkspaceSnapshotsByPacketId } from '@/lib/worktree/snapshot-state';
import { enqueueInboxItem } from '@/lib/supervisor/inbox';
import { probeLaneSessionAlive } from './owned-session-liveness';
import { getOwnedSessionLifecycle } from '@/lib/runtimes/shared/owned-session-lifecycle';

const execFileAsync = promisify(execFile);

function isStuckLane(lane: Lane) {
  return lane.status === 'running' || lane.status === 'launching';
}

async function discoverSessionKeysByRuntime(lanes: Lane[]) {
  const runtimeIds = [...new Set(lanes.map((lane) => lane.runtime))];
  const discoveredSessionsByRuntime = new Map<LaneRuntime, Set<string> | null>();

  await Promise.all(runtimeIds.map(async (runtimeId) => {
    const runtime = getRuntime(runtimeId);
    if (!runtime) {
      console.warn(`[reconcile] Runtime ${runtimeId} is not registered; skipping lane checks for that runtime`);
      discoveredSessionsByRuntime.set(runtimeId, null);
      return;
    }

    try {
      const sessions = await runtime.discoverSessions();
      discoveredSessionsByRuntime.set(
        runtimeId,
        new Set(sessions.map((session) => session.sessionKey)),
      );
    } catch (error) {
      console.warn(
        `[reconcile] Failed to discover ${runtimeId} sessions during startup reconciliation: ${error instanceof Error ? error.message : String(error)}`,
      );
      discoveredSessionsByRuntime.set(runtimeId, null);
    }
  }));

  return discoveredSessionsByRuntime;
}

function createSessionLostApproval(lane: Lane) {
  const label = lane.label || lane.branch;
  return createApproval({
    source: 'runtime',
    runtime: lane.runtime,
    agent: label,
    sessionKey: lane.sessionKey || `lane:${lane.id}`,
    title: 'Agent session lost',
    description: `The agent session for lane "${label}" was lost during app restart. Resume the task or archive the lane.`,
    summary: `Lane "${label}" needs a resume after app restart`,
    risk: 'medium',
    metadata: {
      Lane: lane.id,
      Branch: lane.branch,
      Runtime: lane.runtime,
      ...(lane.packetId ? { Packet: lane.packetId } : {}),
    },
    continuation: {
      kind: 'lane',
      laneId: lane.id,
      verb: 'resume',
    },
  });
}

// #534 follow-up — orchestrator often bash-merges (git merge + git push) and
// cleans up its worktree without invoking the lane `merge` verb. The git
// state is correct but the lane SQLite record stays stuck in 'reviewing'
// forever because setLaneStatus never fired. Solution: detect lanes whose
// worktree path no longer exists on disk and auto-transition them to
// 'completed'. Model-agnostic — works whether the agent used the merge verb,
// raw bash, or any other path. The git probes below are ASYNC (execFile) — the
// earlier execFileSync version blocked the ws-server event loop for up to 2s
// per spawn on the 30s reconcile tick, chaining into multi-second wedges over
// a large .cortex-worktrees clone farm (#1498). existsSync stays — it's a
// single sub-millisecond stat per lane, not a walk.
const RECONCILABLE_WORKTREE_STATUSES: ReadonlySet<LaneStatus> = new Set<LaneStatus>([
  'reviewing',
  'merging',
  'awaiting_input',
]);

// #558 — Branch existence probe per repo. When the orchestrator bash-merges
// and deletes the branch but leaves the worktree dir intact (or when the agent
// push happens through an external tool), we need a second signal — branch
// gone from the repo's ref list. Grouping by repoPath keeps this O(repos)
// rather than O(lanes) on every reconcile tick.
async function getLocalBranchSetForRepo(repoPath: string): Promise<Set<string> | null> {
  try {
    const { stdout } = await execFileAsync(resolveGitBinary(), ['branch', '--format=%(refname:short)'], {
      windowsHide: true,
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 2_000,
    });
    const names = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return new Set(names);
  } catch {
    return null;
  }
}

// #558 — Verify the lane was actually merged into its base branch before
// reconciling on the branch-gone signal. Without this check, the orchestrator's
// cherry-pick-to-tmp-branch workflow looks identical to a real merge: original
// branch deleted, but the lane work landed on tmp-* and never made it to main.
// We look for a "Merge lane <branch>" commit on the base branch's recent history
// — that's the verb=merge / bash-merge canonical pattern.
async function recentMergeSubjectMentionsBranch(repoPath: string, baseBranch: string, branch: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      resolveGitBinary(),
      ['log', '--format=%s', '-n', '50', baseBranch],
      {
        windowsHide: true,
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 2_000,
      },
    );
    const branchToken = branch.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`Merge\\s+(?:branch|lane)\\b.*\\b${branchToken}\\b`, 'i');
    return stdout.split('\n').some((subject) => pattern.test(subject.trim()));
  } catch {
    return false;
  }
}

async function readRefSha(repoPath: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(resolveGitBinary(), ['rev-parse', '--verify', ref], {
      windowsHide: true,
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 2_000,
    });
    const output = stdout.trim();
    return output || null;
  } catch {
    return null;
  }
}

async function isAncestorCommit(repoPath: string, ancestorSha: string, descendantRef: string): Promise<boolean> {
  try {
    // Direction matters: the lane head must be the ancestor and the base ref
    // must be the descendant. Swapping these args caused #1457-style lies.
    await execFileAsync(resolveGitBinary(), ['merge-base', '--is-ancestor', ancestorSha, descendantRef], {
      windowsHide: true,
      cwd: repoPath,
      timeout: 2_000,
    });
    return true;
  } catch {
    return false;
  }
}

function latestRecordedMergeHeadSha(lane: Lane): string | null {
  return getLaneEvents(lane.id)
    .slice()
    .reverse()
    .map((event) => event.payload.laneHeadSha)
    .find((sha): sha is string => typeof sha === 'string' && sha.trim().length > 0)
    ?.trim() ?? null;
}

async function laneMergeConfirmed(lane: Lane): Promise<boolean> {
  const laneHeadSha = (await readRefSha(lane.repoPath, lane.branch)) ?? latestRecordedMergeHeadSha(lane);
  if (laneHeadSha) {
    const events = getLaneEvents(lane.id, 10_000);
    const creationBase = laneCreationBaseCommit(events);
    const recordedMerge = events.some((event) => (
      event.verb === 'merge' && event.payload.laneHeadSha === laneHeadSha
    ));
    if (lane.outcome !== 'merged' && !recordedMerge
      && (!creationBase || creationBase === laneHeadSha)) return false;
    return isAncestorCommit(lane.repoPath, laneHeadSha, lane.baseBranch);
  }

  // Legacy/manual lanes can lack durable head evidence. Keep the old subject
  // scan as a last-resort fallback instead of returning false forever.
  return recentMergeSubjectMentionsBranch(lane.repoPath, lane.baseBranch, lane.branch);
}

// Single-flight guard: the async reconcile can now be triggered concurrently
// (30s ws-server tick + a /api/lanes GET). Overlapping runs would double-scan
// and double-log; fold a concurrent call into the in-flight one.
let reconcileInFlight: Promise<number> | null = null;

function workspaceLifecycleOwnsMissingPath(lane: Lane): boolean {
  const packetId = lane.packetId?.trim();
  if (!packetId) return false;
  try {
    const snapshots = listWorkspaceSnapshotsByPacketId(packetId);
    if (snapshots.length === 0) return false;
    return snapshots.length !== 1 || snapshots[0]!.state !== 'materialized';
  } catch (error) {
    console.warn(
      `[reconcile] Skipping missing-worktree inference for packet ${packetId}; durable workspace truth is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return true;
  }
}

// A lane whose branch is present, or gone but not provably merged, gets the
// same answer until its record, its newest event or one of the refs the answer
// read changes. Remember what those looked like and skip the git probes for it
// until then, so an unchanged lane costs no git process per sweep.
const unchangedBranchAnswers = new Map<string, string>();

function branchAnswerFingerprint(lane: Lane): string | null {
  const directories = gitDirectories(lane.repoPath);
  if (!directories) return null;
  const { commonDir } = directories;
  const refs = [`heads/${lane.branch}`, `remotes/origin/${lane.branch}`, `heads/${lane.baseBranch}`];
  return JSON.stringify([
    lane.status, lane.updatedAt, lane.branch, lane.baseBranch, lane.outcome ?? null,
    getLaneEvents(lane.id, 1)[0]?.id ?? null, fileStamp(join(commonDir, 'packed-refs')),
    ...refs.flatMap((ref) => [fileStamp(join(commonDir, 'refs', ref)), fileStamp(join(commonDir, 'logs', 'refs', ref))]),
  ]);
}

export function reconcileOrphanedWorktrees(): Promise<number> {
  if (reconcileInFlight) return reconcileInFlight;
  reconcileInFlight = runReconcileOrphanedWorktrees().finally(() => {
    reconcileInFlight = null;
  });
  return reconcileInFlight;
}

async function runReconcileOrphanedWorktrees(): Promise<number> {
  const reconcilableLanes = listLanes().filter(
    (lane) =>
      RECONCILABLE_WORKTREE_STATUSES.has(lane.status)
      && !workspaceLifecycleOwnsMissingPath(lane),
  );
  const liveIds = new Set(reconcilableLanes.map((lane) => lane.id));
  for (const id of unchangedBranchAnswers.keys()) if (!liveIds.has(id)) unchangedBranchAnswers.delete(id);
  if (reconcilableLanes.length === 0) return 0;

  // Worktree-gone candidates (original #541 logic)
  const worktreeGone = reconcilableLanes.filter((lane) => (
    typeof lane.worktreePath === 'string'
    && lane.worktreePath.length > 0
    && !existsSync(lane.worktreePath)
  ));

  // Branch-gone candidates (#558) — worktree still on disk but branch removed
  // AND the lane was actually merged into its base branch. The merge-verify
  // step prevents the orchestrator's cherry-pick-to-tmp-* workflow from
  // tripping a false-completion (branch deleted, work parked on tmp-*, main
  // not yet updated). Probe once per repo to keep the cost bounded.
  const branchSetsByRepo = new Map<string, Set<string> | null>();
  const branchGone: Lane[] = [];
  for (const lane of reconcilableLanes) {
    if (lane.worktreePath && !existsSync(lane.worktreePath)) continue; // already caught by worktreeGone
    if (!lane.branch) continue;
    const fingerprint = branchAnswerFingerprint(lane);
    if (fingerprint !== null && unchangedBranchAnswers.get(lane.id) === fingerprint) continue;
    unchangedBranchAnswers.delete(lane.id);
    if (!branchSetsByRepo.has(lane.repoPath)) {
      branchSetsByRepo.set(lane.repoPath, await getLocalBranchSetForRepo(lane.repoPath));
    }
    const branches = branchSetsByRepo.get(lane.repoPath);
    if (!branches) continue; // probe failed — skip rather than false-positive
    if (branches.has(lane.branch) || !(await laneMergeConfirmed(lane))) {
      if (fingerprint !== null) unchangedBranchAnswers.set(lane.id, fingerprint);
      continue;
    }
    branchGone.push(lane);
  }

  const confirmedWorktreeGone: Lane[] = [];
  for (const lane of worktreeGone) {
    if (await laneMergeConfirmed(lane)) {
      confirmedWorktreeGone.push(lane);
      continue;
    }
    setLaneStatus(lane.id, 'awaiting_orchestrator', 'system', 'worktree_missing_unverified');
    enqueueInboxItem({
      repoPath: lane.repoPath,
      packetId: lane.packetId,
      kind: 'packet_missing',
      status: 'human_required',
      payload: {
        laneId: lane.id,
        laneLabel: lane.label,
        worktreePath: lane.worktreePath,
        blockedReason: 'worktree_missing_unverified',
        recoveryAction: 'acknowledge_missing_worktree',
        summary: 'The packet worktree is missing and merge ancestry could not be verified. Acknowledge the missing path to discard the packet without deleting anything that still exists on disk.',
      },
    });
    console.warn(
      `[reconcile] Lane ${lane.id} (${lane.label || lane.branch}) worktree is gone but merge ancestry is unverified — left for operator review`,
    );
  }

  const candidates = [...confirmedWorktreeGone, ...branchGone];
  if (candidates.length === 0) return 0;

  let reconciled = 0;
  const decompositionScans = new Map<string, LaneRuntime>();
  const worktreeGoneIds = new Set(confirmedWorktreeGone.map((lane) => lane.id));
  for (const lane of candidates) {
    const reason = worktreeGoneIds.has(lane.id)
      ? 'worktree_missing_reconciled'
      : 'branch_merged_reconciled';
    const updated = setLaneStatus(lane.id, 'completed', 'system', reason);
    if (updated) {
      reconciled += 1;
      const signal = worktreeGoneIds.has(lane.id)
        ? `worktree ${lane.worktreePath} is gone`
        : `branch ${lane.branch} is gone (merged+deleted)`;
      console.log(
        `[reconcile] Lane ${lane.id} (${lane.label || lane.branch}) ${signal} — transitioned ${lane.status} → completed`,
      );
      // #544 — When the orchestrator bash-merges and cleans up its worktree,
      // the verb=merge post-merge hook never fires. This catches that case
      // by triggering the same #538 decomposition scan on the merge commit
      // (which is HEAD of baseBranch at this point). One scan per repo is
      // enough — multiple lanes for the same repo share one merge SHA
      // during a dogfood sweep.
      decompositionScans.set(lane.repoPath, lane.runtime);
    }
  }

  if (decompositionScans.size > 0) {
    void (async () => {
      try {
        const { enqueueDecompositionsAfterMerge } = await import('@/lib/dispatch/decomposition-pipeline');
        for (const [repoPath, runtime] of decompositionScans) {
          try {
            await enqueueDecompositionsAfterMerge({ repoPath, runtime });
          } catch (error) {
            console.warn(
              `[reconcile] Decomposition scan failed for ${repoPath}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      } catch (error) {
        console.warn(
          `[reconcile] Failed to load decomposition pipeline: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
  }

  return reconciled;
}

export async function reconcileStuckLanes(): Promise<void> {
  const candidateLanes = listLanes().filter(isStuckLane);
  let recoveredCount = 0;
  // #4 Stage 2 — a stuck (running/launching) lane whose session is still in the
  // live set is RE-BOUND (left intact). When crash-survivable workers are on, a
  // re-bind across a ws-server/app restart means a detached worker outlived the
  // crash and its lane resumes running with the transcript intact — the
  // crash-survival win. Counted here for the boot observability log below.
  let reboundCount = 0;

  if (candidateLanes.length === 0) {
    console.log('[reconcile] Checked 0 lanes, recovered 0 stuck lanes');
    return;
  }

  const discoveredSessionsByRuntime = await discoverSessionKeysByRuntime(candidateLanes);

  for (const lane of candidateLanes) {
    const liveSessionKeys = discoveredSessionsByRuntime.get(lane.runtime);
    if (liveSessionKeys === undefined || liveSessionKeys === null) {
      continue;
    }

    const owned = Boolean(lane.sessionKey && getOwnedSessionLifecycle(lane.sessionKey)?.detachedPacketIdentity);
    const ownedAlive = owned ? await probeLaneSessionAlive(lane) : undefined;
    // An unidentified survivor must neither rebind nor be finalized as lost.
    if (owned && ownedAlive === undefined) continue;
    if (owned ? ownedAlive : lane.sessionKey && liveSessionKeys.has(lane.sessionKey)) {
      reboundCount += 1;
      continue;
    }

    try {
      // One state model for lost sessions: the live reaper sends a
      // session-gone lane to `recovering`, so a session lost across an app
      // restart lands in the SAME state (it used to diverge into `paused`).
      // Intentional interaction: `recovering` now carries a 15-min wedge-timeout
      // to `awaiting_orchestrator` (see wedge-timeouts.ts) — that escalation is
      // exactly what a restart-lost, packet-bound lane wants if the operator
      // never acts on the approval card below. The lane keeps its (stale)
      // sessionKey, so archiveStaleDeadLanes leaves it for the wedge to own.
      const updatedLane = setLaneStatus(lane.id, 'recovering', 'system', 'session_lost');
      if (!updatedLane) {
        console.warn(`[reconcile] Lane ${lane.id} disappeared before it could be recovered`);
        continue;
      }

      createSessionLostApproval(lane);
      recoveredCount += 1;
    } catch (error) {
      console.warn(
        `[reconcile] Failed to recover lane ${lane.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(`[reconcile] Checked ${candidateLanes.length} lanes, recovered ${recoveredCount} stuck lanes`);
  if (reboundCount > 0 && crashSurvivableWorkersEnabled()) {
    console.log(`[crash-survival] re-bound ${reboundCount} surviving worker(s) on reconcile — lanes resumed running, transcripts intact`);
  }
}
