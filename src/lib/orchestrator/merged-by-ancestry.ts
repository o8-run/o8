import { resolveGitBinary } from '@/lib/git/binary';
import { execFile, spawn } from '@/lib/providers/child-process';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { promisify } from 'node:util';

import { appendEvent, archiveLane, getLane, getLaneEvents, listLanes, updateLane } from '@/lib/lane/registry';
import { assessOwnedTranscriptActivity } from '@/lib/lane/reaper-liveness';
import { laneCreationBaseCommit } from '@/lib/lane/creation-base';
import type { Lane } from '@/lib/lane/types';
import {
  readOrchestratorControlPlaneState,
  withLockedState,
} from '@/lib/orchestrator/control-plane';
import { MergedByAncestryBackoff } from '@/lib/orchestrator/merged-by-ancestry-backoff';
import { persistReleasedPacketToMission } from '@/lib/orchestrator/mission-registry';
import { packetTerminalState } from '@/lib/orchestrator/packet-state';
import { markPacketReleased } from '@/lib/orchestrator/packet-release-truth';
import { packetReleaseGeneration, packetReleaseIdentityIsCurrent, verifyCurrentLaneHead } from './release-ownership';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { enqueueInboxItem } from '@/lib/supervisor/inbox';
import { autoResolveMergedPacketVerificationIncidents } from '@/lib/supervisor/merged-incident-resolution';
import { withAutomaticWorkspaceReconciliation, workspaceAllowsAutomaticReconciliation } from '@/lib/workspace/automatic-reconciliation-guard';

const execFileAsync = promisify(execFile);
const DEFAULT_BASE_BRANCH = 'main';
const MERGED_BY_ANCESTRY_SOURCE = 'merged_by_ancestry_reconcile';
const AUTOMATIC_ARCHIVE_ACTIVITY_WINDOW_MS = 90_000;

type MergeEvidenceKind = 'ancestor' | 'patch-id' | 'no-changes';
type NoChangesReason = 'branch_missing' | 'branch_matches_base';

interface MergeEvidence {
  kind: MergeEvidenceKind;
  repoPath: string;
  branchRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  creationBaseSha?: string;
  mergeBaseSha?: string;
  patchId?: string;
  noChangesReason?: NoChangesReason;
}

interface Candidate {
  // null = lane-only candidate: a non-archived lane whose packet no longer
  // exists in live mission state (mission rotated/reset). These are exactly
  // the rows that sat in the rail forever — the sweep previously iterated
  // live packets only, so a lane orphaned from its mission was never healed.
  packet: OrchestratorPacket | null;
  lane: Lane | null;
  repoPath: string;
  branch: string;
  baseBranch: string;
  laneId: string | null;
}

// Lane statuses eligible for lane-only sweeping: settled states where no
// agent is actively working and no human prompt is pending. Active/attention
// states (running, merging, awaiting_*) are never touched. 'released' is not
// a LaneStatus enum value but exists in stored rows (packet vocabulary that
// leaked into lane status) — matched as a string on purpose.
const LANE_ONLY_SWEEPABLE_STATUSES = new Set<string>([
  'idle',
  'paused',
  'reviewing',
  'recovering',
  'failed',
  'completed',
  'released',
]);

// Packet-backed lanes need the same settled-state proof. In particular, a
// newly opened lane is already `launching` while its packet is still persisted
// as `queued`; its branch intentionally matches the base until provisioning
// finishes. Treating that ancestry as a merge archives the worktree underneath
// the required pre-launch typecheck.
const PACKET_SWEEPABLE_STATUSES = new Set<OrchestratorPacket['status']>([
  'idle',
  'awaiting_review',
  'failed',
  'blocked',
]);
const PACKET_LANE_SWEEPABLE_STATUSES = new Set<Lane['status']>([
  'idle',
  'paused',
  'reviewing',
  'failed',
  'completed',
]);

export interface MergedByAncestrySweepResult {
  scanned: number;
  merged: number;
  skipped: number;
}

// #1498 — persists across sweeps so a lane whose detect() keeps timing out is
// parked with exponential backoff instead of re-spawning its expensive git
// pipeline every 30s tick.
const detectBackoff = new MergedByAncestryBackoff();

// #5064 — a commit's patch id never changes, so each one is computed once per
// server process. Without this every 30s sweep re-ran `git show` and
// `git patch-id` for every main commit since each lane's merge base (hundreds
// of processes for an old lane). Keys are commit shas or `mergeBase..head`
// sha pairs; both name immutable content.
const PATCH_ID_CACHE_LIMIT = 20_000;
const patchIdCache = new Map<string, string | null>();

async function cachedPatchId(key: string, compute: () => Promise<string | null>): Promise<string | null> {
  if (patchIdCache.has(key)) return patchIdCache.get(key) ?? null;
  const patchId = await compute();
  if (patchIdCache.size >= PATCH_ID_CACHE_LIMIT) {
    const oldest = patchIdCache.keys().next().value;
    if (oldest !== undefined) patchIdCache.delete(oldest);
  }
  patchIdCache.set(key, patchId);
  return patchId;
}

function candidateKey(candidate: Candidate): string {
  return candidate.laneId
    ?? (candidate.packet ? `packet:${candidate.packet.id}` : `repo:${candidate.repoPath}:${candidate.branch}`);
}

function hasDurableLaunchEvidence(candidate: Candidate): boolean {
  if (candidate.lane?.sessionKey) return true;
  if (!candidate.laneId) return false;
  return getLaneEvents(candidate.laneId, 10_000).some((event) => (
    event.verb === 'attach_session'
    || event.verb === 'runtime_process_exit'
    || (
      event.verb === 'status_change'
      && ['agent_completed', 'silent_exit_work_present']
        .includes(String(event.payload.eventLabel ?? ''))
    )
  ));
}

function hasUnsuccessfulTurn(candidate: Candidate): boolean {
  const lane = candidate.laneId ? getLane(candidate.laneId) ?? candidate.lane : candidate.lane;
  if (candidate.packet?.status === 'failed' || candidate.packet?.status === 'blocked'
    || lane?.status === 'failed' || lane?.status === 'paused') return true;
  const exit = candidate.laneId
    ? getLaneEvents(candidate.laneId, 10_000).slice().reverse()
      .find((event) => event.verb === 'runtime_process_exit')?.payload
    : null;
  return Boolean(exit && (
    exit.runtimeOutcome === 'failed'
    || exit.runtimeOutcome === 'interrupted'
    || exit.completedTurn === false
    || (typeof exit.exitCode === 'number' && exit.exitCode !== 0)
  ));
}

async function git(
  cwd: string,
  args: string[],
  options: { timeout?: number; input?: string } = {},
): Promise<string> {
  if (options.input !== undefined) {
    return gitWithInput(cwd, args, options.input, options.timeout ?? 8_000);
  }
  const { stdout } = await execFileAsync(resolveGitBinary(), args, {
    windowsHide: true,
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: options.timeout ?? 8_000,
  });
  return stdout.trim();
}

function gitWithInput(
  cwd: string,
  args: string[],
  input: string,
  timeout: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveGitBinary(), args, {
      windowsHide: true,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`git ${args.join(' ')} timed out`));
    }, timeout);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `git ${args.join(' ')} exited ${code ?? 'unknown'}`));
      }
    });
    // #3627: git can exit (or be killed on timeout) before reading all of a
    // large diff. The pending write then fails with EPIPE on stdin; without a
    // listener that error is uncaught and takes down the whole server. The
    // close or timeout path above already settles the promise.
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') return;
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.end(input);
  });
}

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  try {
    await git(repoPath, ['rev-parse', '--verify', '--quiet', ref], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    await git(repoPath, ['rev-parse', '--git-dir'], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

async function revParse(repoPath: string, ref: string): Promise<string | null> {
  try {
    return await git(repoPath, ['rev-parse', '--verify', ref], { timeout: 3_000 });
  } catch {
    return null;
  }
}

async function refreshOriginBase(repoPath: string, baseBranch: string, refreshed: Set<string>): Promise<void> {
  // Worktrees share their repository's refs, so one fetch per repository and
  // base serves every candidate in the same sweep.
  let repository = repoPath;
  try {
    repository = await git(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 3_000 });
  } catch {
    // An unreadable repository keys on its own path; the fetch below fails too.
  }
  const key = `${repository}\0${baseBranch}`;
  if (refreshed.has(key)) return;
  refreshed.add(key);
  try {
    await git(repoPath, ['fetch', '--quiet', 'origin', `${baseBranch}:refs/remotes/origin/${baseBranch}`], {
      timeout: 20_000,
    });
  } catch {
    // Best effort only. The proof step below must still verify readable refs.
  }
}

async function resolveBaseRef(repoPath: string, baseBranch: string): Promise<string | null> {
  const originRef = `origin/${baseBranch}`;
  if (await refExists(repoPath, originRef)) return originRef;
  if (await refExists(repoPath, baseBranch)) return baseBranch;
  return null;
}

async function resolveBranchRef(repoPath: string, branch: string): Promise<string | null> {
  if (await refExists(repoPath, branch)) return branch;
  const originRef = `origin/${branch}`;
  if (await refExists(repoPath, originRef)) return originRef;
  return null;
}

async function isAncestor(repoPath: string, headSha: string, baseRef: string): Promise<boolean> {
  try {
    await git(repoPath, ['merge-base', '--is-ancestor', headSha, baseRef], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function mergeBase(repoPath: string, branchRef: string, baseRef: string): Promise<string | null> {
  try {
    return await git(repoPath, ['merge-base', branchRef, baseRef], { timeout: 5_000 });
  } catch {
    return null;
  }
}

async function patchIdOf(repoPath: string, diffArgs: string[]): Promise<string | null> {
  const diff = await git(repoPath, diffArgs, { timeout: 10_000 });
  if (!diff.trim()) return null;
  const patchOutput = await git(repoPath, ['patch-id', '--stable'], {
    input: `${diff}\n`,
    timeout: 10_000,
  });
  return patchOutput.split(/\s+/)[0] || null;
}

async function patchIdsForMainCommits(repoPath: string, range: string): Promise<Set<string>> {
  const shas = (await git(repoPath, ['log', '--format=%H', range], { timeout: 10_000 }))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const ids = new Set<string>();
  for (const sha of shas) {
    const patchId = await cachedPatchId(sha, () => patchIdOf(repoPath, ['show', '--format=', '--no-ext-diff', sha]));
    if (patchId) ids.add(patchId);
  }
  return ids;
}

async function squashPatchExistsOnBase(
  repoPath: string,
  headSha: string,
  baseRef: string,
): Promise<{ merged: boolean; mergeBaseSha?: string; patchId?: string }> {
  const mergeBaseSha = await mergeBase(repoPath, headSha, baseRef);
  if (!mergeBaseSha) return { merged: false };

  const range = `${mergeBaseSha}..${headSha}`;
  const aggregatePatchId = await cachedPatchId(range, () => patchIdOf(repoPath, ['diff', range]));
  if (!aggregatePatchId) return { merged: false, mergeBaseSha };

  const mainPatchIds = await patchIdsForMainCommits(repoPath, `${mergeBaseSha}..${baseRef}`);
  return {
    merged: mainPatchIds.has(aggregatePatchId),
    mergeBaseSha,
    patchId: aggregatePatchId,
  };
}

async function detectMergedByAncestry(candidate: Candidate, refreshedBases: Set<string>): Promise<MergeEvidence | null> {
  const { repoPath, branch, baseBranch } = candidate;
  if (!branch) return null;

  await refreshOriginBase(repoPath, baseBranch, refreshedBases);

  const branchRef = await resolveBranchRef(repoPath, branch);
  const baseRef = await resolveBaseRef(repoPath, baseBranch);
  const laneAlreadyMerged = candidate.lane?.outcome === 'merged';
  const durableLaunch = hasDurableLaunchEvidence(candidate);
  const creationBaseCommit = candidate.laneId
    ? laneCreationBaseCommit(getLaneEvents(candidate.laneId, 10_000))
    : null;
  const noChangesEligible = !laneAlreadyMerged
    && durableLaunch
    && !hasUnsuccessfulTurn(candidate)
    && (
      candidate.packet === null || candidate.packet.status === 'awaiting_review'
    );
  if (!branchRef && baseRef && noChangesEligible) {
    // A settled lane whose branch resolves nowhere has no reviewable commit.
    // Preserve that terminal truth explicitly instead of archiving it as an
    // ambiguous branch-reconciliation cleanup.
    if (await isGitRepo(repoPath)) {
      const baseSha = await revParse(repoPath, baseRef);
      if (baseSha) {
        return {
          kind: 'no-changes',
          repoPath,
          branchRef: branch,
          baseRef,
          headSha: '',
          baseSha,
          noChangesReason: 'branch_missing',
        };
      }
    }
    return null;
  }
  if (!branchRef || !baseRef) return null;

  const [headSha, baseSha] = await Promise.all([
    revParse(repoPath, branchRef),
    revParse(repoPath, baseRef),
  ]);
  if (!headSha || !baseSha) return null;

  if (!laneAlreadyMerged && creationBaseCommit === headSha) {
    // An attempted turn does not prove work. Never let an unsuccessful
    // no-change lane fall through to the reflexive ancestry check below.
    if (!noChangesEligible) return null;
    return {
      kind: 'no-changes',
      repoPath,
      branchRef,
      baseRef,
      headSha,
      baseSha,
      creationBaseSha: creationBaseCommit,
      noChangesReason: 'branch_matches_base',
    };
  }

  const publishedBranchExists = branch !== baseBranch
    && await refExists(repoPath, `origin/${branch}`);
  if (headSha === baseSha && !laneAlreadyMerged && creationBaseCommit === null) {
    if (noChangesEligible
      && creationBaseCommit === null
      && (branch === baseBranch || !publishedBranchExists)) {
      return {
        kind: 'no-changes',
        repoPath,
        branchRef,
        baseRef,
        headSha,
        baseSha,
        noChangesReason: 'branch_matches_base',
      };
    }
    return null;
  }

  if (await isAncestor(repoPath, headSha, baseRef)) {
    // Legacy lanes without a creation baseline need a recorded merge head;
    // ancestry alone cannot distinguish untouched work from a real merge.
    if (!creationBaseCommit && !laneAlreadyMerged && !(
      candidate.laneId && getLaneEvents(candidate.laneId, 10_000).some((event) => (
        event.verb === 'merge' && event.payload.laneHeadSha === headSha
      ))
    )) return null;
    return {
      kind: 'ancestor',
      repoPath,
      branchRef,
      baseRef,
      headSha,
      baseSha,
    };
  }

  const patch = await squashPatchExistsOnBase(repoPath, headSha, baseRef);
  if (!patch.merged) return null;

  return {
    kind: 'patch-id',
    repoPath,
    branchRef,
    baseRef,
    headSha,
    baseSha,
    mergeBaseSha: patch.mergeBaseSha,
    patchId: patch.patchId,
  };
}

function buildCandidates(): Candidate[] {
  const lanes = listLanes();
  const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
  const laneByPacket = new Map(lanes.filter((lane) => lane.packetId).map((lane) => [lane.packetId!, lane]));

  const packets = readOrchestratorControlPlaneState().packets;
  const remotePackets = packets.filter((packet) => packet.runtime === 'cloud' || packet.lane?.runtime === 'cloud');
  const remotePacketIds = new Set(remotePackets.map((packet) => packet.id));
  const remoteLaneIds = new Set(remotePackets.map((packet) => packet.lane?.laneId).filter(Boolean));
  const packetCandidates = packets
    .filter((packet) => {
      const terminal = packetTerminalState(packet);
      return packet.runtime !== 'cloud'
        && packet.lane?.runtime !== 'cloud'
        && terminal !== 'released'
        && terminal !== 'archived'
        && PACKET_SWEEPABLE_STATUSES.has(packet.status);
    })
    .map((packet) => {
      const laneId = packet.lane?.laneId?.trim() || null;
      const lane = (laneId ? laneById.get(laneId) ?? getLane(laneId) : null)
        ?? laneByPacket.get(packet.id)
        ?? null;
      const boundWorktreePath = lane?.worktreePath?.trim()
        || packet.lane?.worktreePath?.trim()
        || '';
      const repoPath = (boundWorktreePath && existsSync(boundWorktreePath) ? boundWorktreePath : '')
        || lane?.repoPath
        || packet.lane?.repoPath?.trim()
        || packet.workspaceTargetPath?.trim()
        || '';
      const branch = lane?.branch || packet.branchTarget;
      const baseBranch = lane?.baseBranch || DEFAULT_BASE_BRANCH;
      return {
        packet,
        lane,
        repoPath,
        branch,
        baseBranch,
        laneId: lane?.id ?? laneId,
      };
    })
    // A coordinator checkout cannot prove a remote worker's branch or diff.
    .filter((candidate) => candidate.lane?.runtime !== 'cloud'
      && Boolean(candidate.repoPath && candidate.branch));

  // Lane-only pass: non-archived settled lanes with no packet in live mission
  // state. Prefer the worktree clone as the git cwd — dispatched branches
  // usually exist only there — falling back to the lane's canonical repo.
  const coveredLaneIds = new Set(packetCandidates.map((c) => c.laneId).filter(Boolean));
  const laneOnlyCandidates: Candidate[] = lanes
    .filter((lane) => (
      lane.runtime !== 'cloud'
      && !remotePacketIds.has(lane.packetId ?? '')
      && !remoteLaneIds.has(lane.id)
      && !coveredLaneIds.has(lane.id)
      && LANE_ONLY_SWEEPABLE_STATUSES.has(lane.status)
      && Boolean(lane.branch)
      && (lane.branch !== lane.baseBranch || Boolean(lane.packetId))
    ))
    .map((lane) => {
      const worktree = lane.worktreePath && existsSync(lane.worktreePath) ? lane.worktreePath : null;
      const repoPath = worktree || lane.repoPath || '';
      return {
        packet: null,
        lane,
        repoPath,
        branch: lane.branch,
        baseBranch: lane.baseBranch || DEFAULT_BASE_BRANCH,
        laneId: lane.id,
      };
    })
    .filter((candidate) => Boolean(candidate.repoPath && existsSync(candidate.repoPath)));

  return [...packetCandidates, ...laneOnlyCandidates];
}

/**
 * Re-prove the evidence against the branch as it stands NOW.
 *
 * Detection and the release write are separated by a control-plane lock
 * acquisition, and a steer can land a successor commit inside that window. The
 * detected proof then describes a commit the packet has already moved past, and
 * releasing on it marks work merged that is not on the base branch at all.
 */
async function evidenceStillHolds(evidence: MergeEvidence): Promise<boolean> {
  const currentBaseSha = await revParse(evidence.repoPath, evidence.baseRef);
  if (!currentBaseSha) return false;

  if (evidence.kind === 'no-changes') {
    if (evidence.noChangesReason === 'branch_missing') {
      const currentBranchRef = await resolveBranchRef(evidence.repoPath, evidence.branchRef);
      const currentHeadSha = await revParse(evidence.repoPath, 'HEAD');
      return currentBranchRef === null && currentHeadSha === currentBaseSha;
    }
    const currentHeadSha = await revParse(evidence.repoPath, evidence.branchRef);
    const noChangesBaseSha = evidence.creationBaseSha ?? currentBaseSha;
    return currentHeadSha === evidence.headSha && currentHeadSha === noChangesBaseSha;
  }

  const currentHeadSha = await revParse(evidence.repoPath, evidence.branchRef);
  if (currentHeadSha !== evidence.headSha) return false;
  if (evidence.kind === 'ancestor') {
    return isAncestor(evidence.repoPath, currentHeadSha, evidence.baseRef);
  }
  return (await squashPatchExistsOnBase(
    evidence.repoPath,
    currentHeadSha,
    evidence.baseRef,
  )).merged;
}

function recordEvidenceDeclined(candidate: Candidate, evidence: MergeEvidence): void {
  if (!candidate.laneId) return;
  appendEvent(candidate.laneId, 'merge_ancestry_release_declined', 'system', {
    packetId: candidate.packet?.id ?? candidate.lane?.packetId ?? null,
    evidenceKind: evidence.kind,
    branchRef: evidence.branchRef,
    baseRef: evidence.baseRef,
    provedHeadSha: evidence.headSha,
    reason: 'The Git state changed after reconciliation detected its outcome, so that proof no longer applies.',
  });
}

async function releasePacket(candidate: Candidate, evidence: MergeEvidence, generation: string | null): Promise<boolean> {
  if (!(await evidenceStillHolds(evidence))) {
    recordEvidenceDeclined(candidate, evidence);
    return false;
  }

  const releasedAt = new Date().toISOString();
  const { cancelAutoReviewForLane } = await import('@/lib/lane/auto-review');
  const archive = () => {
    if (!candidate.laneId) return;
    cancelAutoReviewForLane(candidate.laneId, MERGED_BY_ANCESTRY_SOURCE);
    appendEvent(candidate.laneId, 'merged_by_ancestry_reconciled', 'system', {
      packetId: candidate.packet?.id ?? candidate.lane?.packetId ?? null,
      evidenceKind: evidence.kind, branchRef: evidence.branchRef, baseRef: evidence.baseRef,
      headSha: evidence.headSha, baseSha: evidence.baseSha,
      mergeBaseSha: evidence.mergeBaseSha ?? null, patchId: evidence.patchId ?? null,
    });
    archiveLane(candidate.laneId, 'system', { outcome: 'merged',
      outcomeNote: `Merged by ${evidence.kind === 'ancestor' ? 'ancestry' : 'patch identity'} into ${evidence.baseRef}.` });
  };
  if (candidate.packet) {
    const packetId = candidate.packet.id;
    const { result: accepted } = await withLockedState(async (state) => {
      const packet = state.packets.find((item) => item.id === packetId);
      if (!packet || !candidate.laneId || !generation
        || !packetReleaseIdentityIsCurrent(packet, candidate.laneId, generation)) return false;
      const terminal = packetTerminalState(packet);
      if (terminal === 'released' || terminal === 'archived') return false;
      const lane = getLane(candidate.laneId);
      if (!lane || !PACKET_LANE_SWEEPABLE_STATUSES.has(lane.status)) return false;
      if (!(await verifyCurrentLaneHead(lane, evidence.headSha))) return false;
      if (await revParse(evidence.repoPath, evidence.baseRef) !== evidence.baseSha
        || !packetReleaseIdentityIsCurrent(packet, lane.id, generation)) return false;

      markPacketReleased(packet, {
        source: MERGED_BY_ANCESTRY_SOURCE,
        mergeCommit: evidence.baseSha,
        headSha: evidence.headSha || null,
        evidenceKind: evidence.kind,
        releasedAt,
      });
      packet.lastEventAt = releasedAt;
      packet.lastEventLabel = evidence.kind === 'ancestor'
        ? 'merged_by_ancestry'
        : 'merged_by_patch_id';
      if (packet.lane) {
        packet.lane.lastEventAt = releasedAt;
        packet.lane.lastEventLabel = packet.lastEventLabel;
      }
      if (!(await persistReleasedPacketToMission(packet, lane.id, generation))) {
        throw new Error('Durable packet ownership changed before ancestry release could be persisted.');
      }
      archive();
      return true;
    });
    if (!accepted) return false;
  } else {
    const current = candidate.laneId ? getLane(candidate.laneId) : null;
    if (current && (!LANE_ONLY_SWEEPABLE_STATUSES.has(current.status)
      || current.sessionKey !== candidate.lane?.sessionKey)) return false;
    archive();
  }

  const incidentPacketId = candidate.packet?.id ?? candidate.lane?.packetId ?? null;
  if (incidentPacketId) {
    autoResolveMergedPacketVerificationIncidents({
      packetId: incidentPacketId,
      laneId: candidate.laneId,
      event: MERGED_BY_ANCESTRY_SOURCE,
    });
  }
  return true;
}

async function finishWithoutChanges(candidate: Candidate, evidence: MergeEvidence, generation: string | null): Promise<boolean> {
  if (hasUnsuccessfulTurn(candidate)) return false;
  if (!(await evidenceStillHolds(evidence))) {
    recordEvidenceDeclined(candidate, evidence);
    return false;
  }

  const finishedAt = new Date().toISOString();
  const note = 'Agent finished without making changes';
  const packetId = candidate.packet?.id ?? candidate.lane?.packetId ?? null;
  const packetTitle = candidate.packet?.title ?? candidate.lane?.label ?? packetId ?? 'Dispatched packet';

  if (candidate.packet) {
    let accepted = false;
    await withLockedState((state) => {
      const packet = state.packets.find((item) => item.id === candidate.packet?.id);
      if (!packet || !candidate.laneId || !generation
        || !packetReleaseIdentityIsCurrent(packet, candidate.laneId, generation)
        || hasUnsuccessfulTurn({ ...candidate, packet })) return;
      accepted = true;
      packet.status = 'archived';
      packet.queueState = 'held';
      packet.blockedReason = null;
      packet.archivedAt = finishedAt;
      packet.lastEventAt = finishedAt;
      packet.lastEventLabel = 'finished_no_changes';
    });
    if (!accepted) return false;
  }

  if (candidate.laneId) {
    const { cancelAutoReviewForLane } = await import('@/lib/lane/auto-review');
    cancelAutoReviewForLane(candidate.laneId, 'finished_no_changes');
    updateLane(candidate.laneId, {
      outcome: 'no_changes',
      outcomeNote: note,
      lastEventAt: finishedAt,
      lastEventLabel: 'finished_no_changes',
    }, 'system');
    appendEvent(candidate.laneId, 'status_change', 'system', {
      reason: evidence.noChangesReason === 'branch_missing'
        ? 'branch_missing_reconciled'
        : 'branch_matches_base_reconciled',
      outcome: 'no_changes',
      note,
      branch: evidence.branchRef,
      baseRef: evidence.baseRef,
      baseSha: evidence.baseSha,
      creationBaseSha: evidence.creationBaseSha ?? null,
      repoPath: evidence.repoPath,
    });
    archiveLane(candidate.laneId, 'system');
  }

  const repoPath = candidate.lane?.repoPath || evidence.repoPath;
  const repoName = basename(repoPath);
  enqueueInboxItem({
    repoPath,
    packetId,
    kind: 'packet_no_changes',
    status: 'pending',
    payload: {
      laneId: candidate.laneId,
      packetTitle,
      repoName,
      outcome: 'no_changes',
      note: `${packetTitle} in ${repoName} produced no changes.`,
    },
  });
  return true;
}

let sweepInFlight: Promise<MergedByAncestrySweepResult> | null = null;

// The 30s interval does not wait for the previous sweep. On a loaded machine
// overlapping sweeps multiplied the git work instead of finishing it, so a
// caller that arrives mid-sweep shares the running one (#5064).
export function sweepPacketsMergedByAncestry(): Promise<MergedByAncestrySweepResult> {
  sweepInFlight ??= runSweep().finally(() => {
    sweepInFlight = null;
  });
  return sweepInFlight;
}

async function runSweep(): Promise<MergedByAncestrySweepResult> {
  const candidates = buildCandidates();
  const refreshedBases = new Set<string>();
  let merged = 0;
  let skipped = 0;

  // Drop parked entries for candidates that vanished (archived/merged out) so
  // the negative cache can't grow unbounded across sweeps.
  detectBackoff.prune(candidates.map(candidateKey));
  const now = Date.now();

  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    const packetId = candidate.packet?.id ?? candidate.lane?.packetId ?? null;
    if (!workspaceAllowsAutomaticReconciliation(packetId)) {
      skipped += 1;
      continue;
    }
    if (
      candidate.packet
      && candidate.lane
      && !PACKET_LANE_SWEEPABLE_STATUSES.has(candidate.lane.status)
    ) {
      skipped += 1;
      continue;
    }
    // A candidate whose detect() has been timing out is parked with growing
    // backoff — skip re-spawning its git pipeline until the window opens.
    if (detectBackoff.shouldSkip(key, now)) {
      skipped += 1;
      continue;
    }
    try {
      const generation = candidate.packet && candidate.laneId
        ? packetReleaseGeneration(candidate.packet, candidate.laneId) : null;
      const evidence = await detectMergedByAncestry(candidate, refreshedBases);
      detectBackoff.recordSuccess(key);
      if (!evidence) {
        skipped += 1;
        continue;
      }
      if (candidate.lane) {
        const transcriptActivity = await assessOwnedTranscriptActivity(candidate.lane, {
          staleThresholdMs: AUTOMATIC_ARCHIVE_ACTIVITY_WINDOW_MS,
          now,
        });
        if (transcriptActivity?.keep) {
          skipped += 1;
          console.log(
            `[merged-by-ancestry] ${candidate.lane.id} KEPT via ${transcriptActivity.source}: ${transcriptActivity.note}`,
          );
          continue;
        }
      }
      const settled = await withAutomaticWorkspaceReconciliation(packetId, async () => {
        const currentLane = candidate.laneId ? getLane(candidate.laneId) : null;
        if (candidate.lane && (!currentLane || currentLane.packetId !== candidate.lane.packetId)) return false;
        return evidence.kind === 'no-changes'
          ? finishWithoutChanges(candidate, evidence, generation)
          : releasePacket(candidate, evidence, generation);
      });
      if (settled) merged += 1;
      else skipped += 1;
    } catch (error) {
      detectBackoff.recordFailure(key, now);
      skipped += 1;
      console.warn(
        `[merged-by-ancestry] skipped ${candidate.packet ? `packet ${candidate.packet.id}` : `lane ${candidate.laneId}`}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    scanned: candidates.length,
    merged,
    skipped,
  };
}
