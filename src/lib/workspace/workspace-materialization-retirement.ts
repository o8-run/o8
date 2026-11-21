import { lstat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';

import { spokenReviewSnapshotFingerprint } from '@/lib/lane/lane-diff-facts';
import { appendEvent, archiveLane, getLane } from '@/lib/lane/registry';
import { exactWorkspaceOwningLanes } from '@/lib/lane/workspace-ownership-query';
import { findRepoByLocalPath } from '@/lib/repos/registry';
import { assertWorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { readWorktreeMetaSnapshot } from '@/lib/worktree/metadata-store';
import { beginWorkspaceSnapshotGeneration } from '@/lib/worktree/snapshot-generation';
import type { WorktreeMetaEntry } from '@/lib/worktree/types';
import {
  createWorkspaceSnapshot,
  listWorkspaceSnapshotTransitions,
  listWorkspaceSnapshotsByOriginalPath,
  transitionWorkspaceSnapshot,
  type WorkspaceSnapshotRecord,
} from '@/lib/worktree/snapshot-state';
import type { WorkspaceSnapshotJson } from '@/lib/worktree/snapshot-state-types';
import { canonicalRepoRoot } from '@/lib/worktree/root-layout';
import {
  materializationAwareExecFile,
  withWorktreeMaterializationExecution,
} from '@/lib/worktree/materialization-execution';
import { ensureWorkspaceRecoveryRef, workspaceRecoveryRef } from './hibernator';
import { readManagedWorkspaceMaterialization } from './managed-materialization-identity';
import {
  preserveWorkspaceArtifacts,
  preservationReceiptForSnapshot,
  readWorkspacePreservation,
} from './preservation-store';

export type WorkspaceRetirementAction = 'pr' | 'merge' | 'discard' | 'cleanup';

interface MergeWorkspaceSnapshotEvidence {
  mergeCandidateSha: string;
  reviewedHeadSha: string;
}

export interface WorkspaceMaterializationCaptureOptions {
  /**
   * Ordinary `cleanup` may retire an exactly-owned workspace whose child
   * directory is positively gone; pr/merge/discard capture never does, because
   * an absent checkout cannot produce the verified evidence those terminals
   * require. The capture layer re-checks the action so a mis-set flag still
   * refuses strict non-cleanup capture.
   */
  allowConfirmedMissingDirectory?: boolean;
}

interface WorkspaceRetirementReceipt {
  [key: string]: WorkspaceSnapshotJson;
  terminalAction: WorkspaceRetirementAction;
  laneId: string | null;
}

function transitionId(
  snapshot: WorkspaceSnapshotRecord,
  action: WorkspaceRetirementAction,
  phase: 'begin' | 'finish',
): string {
  return `retire:${snapshot.snapshotGeneration}:${action}:${phase}:${snapshot.version}`;
}

function retirementReceipt(
  snapshot: WorkspaceSnapshotRecord,
  action: WorkspaceRetirementAction,
): WorkspaceRetirementReceipt {
  const preservationId = getWorkspaceRetirementPreservationId(snapshot.originalPath);
  const sourceWasMissing = latestRetirementAdmission(snapshot)?.sourceMissingAtAdmission === true;
  return { terminalAction: action, laneId: snapshot.laneId,
    ...(sourceWasMissing ? { sourceMissingAtAdmission: true, preservationUnavailable: 'source-already-absent' }
      : preservationId ? { preservationId } : {}),
  };
}

function latestRetirementAdmission(snapshot: WorkspaceSnapshotRecord) {
  return listWorkspaceSnapshotTransitions(snapshot.repositoryUuid, snapshot.packetId)
    .findLast((entry) => entry.snapshotGeneration === snapshot.snapshotGeneration
      && entry.toState === 'retiring')?.receipt;
}

export function getWorkspaceRetirementPreservationId(workspacePath: string): string | null {
  const snapshot = exactSnapshot(workspacePath);
  if (!snapshot || (snapshot.state !== 'retiring' && snapshot.state !== 'retired')) return null;
  const admission = latestRetirementAdmission(snapshot);
  if (admission?.sourceMissingAtAdmission === true) return null;
  const id = admission?.preservationId;
  return typeof id === 'string' ? id : null;
}

function recordedAction(snapshot: WorkspaceSnapshotRecord): WorkspaceRetirementAction | null {
  const transition = listWorkspaceSnapshotTransitions(snapshot.repositoryUuid, snapshot.packetId)
    .findLast((entry) => entry.receipt?.terminalAction !== undefined);
  const action = transition?.receipt?.terminalAction;
  return action === 'pr' || action === 'merge' || action === 'discard' || action === 'cleanup'
    ? action
    : null;
}

/**
 * A snapshot certifies merge evidence only for the HEAD it captured, and for the
 * merge candidate its generation recorded when one was recorded.
 */
function certifiesMergeEvidence(
  snapshot: WorkspaceSnapshotRecord,
  evidence: MergeWorkspaceSnapshotEvidence,
): boolean {
  if (snapshot.headCommit !== evidence.reviewedHeadSha) return false;
  const creation = listWorkspaceSnapshotTransitions(snapshot.repositoryUuid, snapshot.packetId)
    .findLast((entry) => entry.kind === 'created' && entry.snapshotGeneration === snapshot.snapshotGeneration);
  const recordedCandidate = creation?.receipt?.mergeCandidateSha;
  return recordedCandidate === undefined || recordedCandidate === evidence.mergeCandidateSha;
}

function canonicalWorkspaceNamespace(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);
  return path.join(realpathSync.native(path.dirname(resolved)), path.basename(resolved));
}

/** The one durable snapshot for a workspace, matched by its resolved or its real path. */
export function exactSnapshot(workspacePath: string): WorkspaceSnapshotRecord | null {
  const resolved = path.resolve(workspacePath);
  const canonical = canonicalWorkspaceNamespace(resolved);
  const matches = [...new Map([resolved, canonical].flatMap(listWorkspaceSnapshotsByOriginalPath)
    .map(snapshot => [`${snapshot.repositoryUuid}:${snapshot.packetId}`, snapshot])).values()];
  if (matches.length > 1) {
    throw new Error('Workspace retirement found ambiguous durable materialization truth.');
  }
  return matches[0] ?? null;
}

/** The one durable packet lane that owns this exact manager path, if any. */
async function retirementLanes(repoLocalPath: string, workspacePath: string) {
  const metadata = (await readWorktreeMetaSnapshot(repoLocalPath))[path.basename(workspacePath)];
  return exactWorkspaceOwningLanes(repoLocalPath, workspacePath, metadata).filter((lane) => lane.packetId?.trim());
}

type ExactManagedChildObservation =
  | { status: 'present' }
  | { status: 'missing' }
  | { status: 'uncertain'; reason: string };

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 500);
}

/**
 * Distinguish a positively verified missing child from every inconclusive probe.
 *
 * A child `lstat` ENOENT is meaningful only after the durable parent receipt
 * still owns the child namespace. Anything else — an unreadable receipt, a
 * replaced/missing/inaccessible parent, a canonical-authority mismatch, a
 * non-directory occupant, or any non-ENOENT child error — is `uncertain` and
 * must keep durable metadata intact.
 */
async function observeExactManagedChild(
  repoPath: string,
  workspacePath: string,
): Promise<ExactManagedChildObservation> {
  const requestedPath = path.resolve(workspacePath);
  const worktreeId = path.basename(requestedPath);
  let metadata: WorktreeMetaEntry | undefined;
  try {
    metadata = (await readWorktreeMetaSnapshot(repoPath))[worktreeId];
  } catch (error) {
    return {
      status: 'uncertain',
      reason: `durable manager metadata is unreadable: ${compactError(error)}`,
    };
  }
  if (!metadata || metadata.id !== worktreeId || metadata.claudeManaged) {
    return { status: 'uncertain', reason: 'durable manager metadata is absent or unowned' };
  }
  const identity = metadata.materializationIdentity;
  const parent = metadata.materializationParentIdentity;
  if (!identity || !parent) {
    return { status: 'uncertain', reason: 'workspace has no exact ownership receipt' };
  }
  if (path.basename(identity.canonicalPath) !== worktreeId) {
    return { status: 'uncertain', reason: 'durable child name does not match the requested path' };
  }
  try {
    await assertWorktreeMaterializationIdentity(parent.canonicalPath, parent);
  } catch (error) {
    return {
      status: 'uncertain',
      reason: `parent ownership could not be proven: ${compactError(error)}`,
    };
  }
  const exactChildPath = path.join(parent.canonicalPath, worktreeId);
  if (identity.canonicalPath !== exactChildPath) {
    return { status: 'uncertain', reason: 'durable child canonical authority changed' };
  }
  try {
    const child = await lstat(exactChildPath);
    if (!child.isDirectory() || child.isSymbolicLink()) {
      return { status: 'uncertain', reason: 'child occupant is not a regular directory' };
    }
    return { status: 'present' };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'uncertain', reason: `child probe failed: ${compactError(error)}` };
  }
}

function archiveTerminalLane(snapshot: WorkspaceSnapshotRecord, action: WorkspaceRetirementAction): void {
  if (!snapshot.laneId || action === 'cleanup') return;
  const lane = getLane(snapshot.laneId);
  if (!lane || lane.status === 'archived') return;
  if (lane.packetId !== snapshot.packetId) return;
  if (lane.worktreePath
    && canonicalWorkspaceNamespace(lane.worktreePath) !== canonicalWorkspaceNamespace(snapshot.originalPath)) return;
  const endings = {
    pr: { outcome: 'pr_opened' as const, outcomeNote: 'Pull request opened; local workspace retired.' },
    merge: { outcome: 'merged' as const, outcomeNote: 'Merged; local workspace retired.' },
    discard: { outcome: 'discarded' as const, outcomeNote: 'Discarded by the operator.' },
  };
  archiveLane(snapshot.laneId, 'user', endings[action]);
}

async function gitValue(workspacePath: string, args: string[]): Promise<string> {
  const { stdout } = await materializationAwareExecFile('git', args, {
    cwd: workspacePath,
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Bind ordinary never-parked manager truth to a durable terminal snapshot before cleanup. */
export async function prepareWorkspaceMaterializationRetirement(
  repoPath: string,
  workspacePath: string,
  action: WorkspaceRetirementAction,
  options: WorkspaceMaterializationCaptureOptions = {},
): Promise<WorkspaceSnapshotRecord | null> {
  const snapshot = await captureWorkspaceMaterializationSnapshot(
    repoPath,
    workspacePath,
    action,
    undefined,
    options,
  );
  if (snapshot?.state === 'materialized') {
    if (action === 'cleanup' && options.allowConfirmedMissingDirectory) {
      const observation = await observeExactManagedChild(repoPath, workspacePath);
      if (observation.status === 'uncertain') {
        throw new Error(`Workspace retirement could not confirm the exact child directory: ${observation.reason}`);
      }
      if (observation.status === 'missing') {
        const repo = await findRepoByLocalPath(canonicalRepoRoot(repoPath));
        const lanes = await retirementLanes(repoPath, workspacePath);
        if (!repo || repo.id !== snapshot.repositoryUuid || lanes.length !== 1
          || lanes[0]!.packetId !== snapshot.packetId || lanes[0]!.id !== snapshot.laneId
          || await gitValue(repo.localPath, ['rev-parse', '--verify', snapshot.recoveryRef + '^{commit}']) !== snapshot.headCommit
          || await gitValue(repo.localPath, ['rev-parse', '--verify', snapshot.headCommit + '^{tree}']) !== snapshot.treeSha) {
          throw new Error('Confirmed absent cleanup lost its exact snapshot or retained Git recovery anchor.');
        }
        return beginRetirementWithReceipt(snapshot, action, {
          sourceMissingAtAdmission: true, preservationUnavailable: 'source-already-absent',
        });
      }
    }
    await preserveWorkspaceArtifacts(snapshot, repoPath, { discardSource: action === 'discard' });
  }
  return snapshot ? beginWorkspaceMaterializationRetirement(workspacePath, action) : null;
}

/** Capture immutable evidence while the reviewed checkout still exists. */
export async function captureWorkspaceMaterializationSnapshot(
  repoPath: string,
  workspacePath: string,
  action: WorkspaceRetirementAction,
  mergeEvidence?: MergeWorkspaceSnapshotEvidence,
  options: WorkspaceMaterializationCaptureOptions = {},
): Promise<WorkspaceSnapshotRecord | null> {
  const existing = exactSnapshot(workspacePath);
  if (existing && (!mergeEvidence || certifiesMergeEvidence(existing, mergeEvidence))) {
    return existing;
  }
  // Merge evidence for a newer reviewed HEAD (or merge candidate) supersedes the
  // older generation below; the older one stays in the append-only receipt chain.
  if (existing && existing.state !== 'materialized') {
    throw new Error(
      `Workspace snapshot is ${existing.state}; merge evidence for a new reviewed HEAD cannot supersede it.`,
    );
  }
  const repo = await findRepoByLocalPath(canonicalRepoRoot(repoPath));
  if (!repo) return null;
  const lanes = await retirementLanes(repo.localPath, workspacePath);
  if (lanes.length === 0) {
    // Name both halves of the identity that failed to meet: an operator reading
    // the persisted merge_error can tell "the workspace is unbound" apart from
    // "this merge was aimed at the wrong repository" (#2308).
    if (mergeEvidence) {
      throw new Error(
        `Merge evidence capture found no durable packet lane for ${path.resolve(workspacePath)} in ${repo.localPath}.`,
      );
    }
    return null;
  }
  if (lanes.length !== 1) throw new Error('Workspace retirement found ambiguous managed lane truth.');
  const lane = lanes[0]!;
  const packetId = lane.packetId!;
  if (existing && (existing.repositoryUuid !== repo.id || existing.packetId !== packetId)) {
    throw new Error('Workspace snapshot belongs to a different packet than its managed lane.');
  }
  if (options.allowConfirmedMissingDirectory && action === 'cleanup') {
    const observation = await observeExactManagedChild(repo.localPath, workspacePath);
    if (observation.status === 'missing') {
      appendEvent(lane.id, 'workspace_absence_observed', 'system', {
        reason: 'confirmed-missing-directory',
        action,
        workspacePath: path.resolve(workspacePath),
      });
      return null;
    }
    if (observation.status === 'uncertain') {
      throw new Error(
        `Workspace retirement could not confirm the exact child directory: ${observation.reason}`,
      );
    }
  }
  const managed = await readManagedWorkspaceMaterialization(repo.localPath, workspacePath);
  const isolationKind = managed.metadata.isolationKind;
  if (isolationKind !== 'git-worktree' && isolationKind !== 'apfs-cow-clone') {
    throw new Error('Workspace retirement has no exact isolation-provider receipt.');
  }
  const identity = managed.identity;
  await withWorktreeMaterializationExecution(workspacePath, identity, async () => {
    const reviewedRef = mergeEvidence?.reviewedHeadSha ?? 'HEAD';
    const [branch, headCommit, treeSha, baseTip, mergeCandidate] = await Promise.all([
      gitValue(workspacePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      gitValue(workspacePath, ['rev-parse', '--verify', `${reviewedRef}^{commit}`]),
      gitValue(workspacePath, ['rev-parse', '--verify', `${reviewedRef}^{tree}`]),
      gitValue(repo.localPath, ['rev-parse', '--verify', `refs/heads/${lane.baseBranch}^{commit}`]),
      mergeEvidence
        ? gitValue(repo.localPath, ['rev-parse', '--verify', `${mergeEvidence.mergeCandidateSha}^{commit}`])
        : Promise.resolve(null),
    ]);
    if (branch !== lane.branch) throw new Error('Workspace retirement branch no longer matches its lane.');
    if (mergeEvidence && headCommit !== mergeEvidence.reviewedHeadSha) {
      throw new Error('Workspace HEAD changed before merge evidence capture.');
    }
    if (mergeEvidence && mergeCandidate !== mergeEvidence.mergeCandidateSha) {
      throw new Error('Workspace merge candidate changed before evidence capture.');
    }
    // A rebase can replace HEAD while the original review still identifies the
    // evidence to retain. Bank that object before reading ancestry in the base
    // repository; packet clones need not have a local base branch.
    if (isolationKind === 'apfs-cow-clone') {
      await gitValue(repo.localPath, ['fetch', '--no-tags', workspacePath, headCommit]);
    }
    const baseCommit = await gitValue(repo.localPath, ['merge-base', baseTip, headCommit]);
    const nextGeneration = existing ? existing.snapshotGeneration + 1 : 1;
    const recoveryRef = existing
      ? workspaceRecoveryRef(repo.id, packetId, nextGeneration)
      : `refs/o8/recovery/${repo.id}/${packetId}`;
    const diffFingerprint = spokenReviewSnapshotFingerprint(headCommit, baseCommit, treeSha);
    await ensureWorkspaceRecoveryRef(repo.localPath, workspacePath, {
      branch,
      baseCommit,
      headCommit,
      treeSha,
      recoveryRef,
      diffFingerprint,
      isolationKind,
    });
    const truth = {
      repositoryUuid: repo.id,
      packetId,
      laneId: lane.id,
      originalPath: canonicalWorkspaceNamespace(workspacePath),
      branch,
      baseCommit,
      headCommit,
      treeSha,
      recoveryRef,
      diffFingerprint,
      sessionIdentities: lane.sessionKey
        ? [{ kind: 'owned-session', identity: lane.sessionKey }]
        : [],
    };
    if (!existing) {
      createWorkspaceSnapshot({
        ...truth,
        creationId: `retire:${action}:create`,
        receipt: { terminalBootstrap: true, terminalAction: action, ...mergeEvidence },
      });
      return;
    }
    // A lost compare-and-swap is settled by the postcondition below: a
    // concurrent capture for the same evidence is reused, anything else refuses.
    beginWorkspaceSnapshotGeneration({
      ...truth,
      missionId: existing.missionId,
      dependencyRecipeKey: existing.dependencyRecipeKey,
      reservation: existing.reservation,
      creationId: `retire:${action}:g${nextGeneration}:${headCommit}:${mergeCandidate}`,
      expectedState: 'materialized',
      expectedVersion: existing.version,
      expectedGeneration: existing.snapshotGeneration,
      receipt: { terminalAction: action, ...mergeEvidence },
    });
  });
  const captured = exactSnapshot(workspacePath);
  if (mergeEvidence && (!captured || !certifiesMergeEvidence(captured, mergeEvidence))) {
    throw new Error('Workspace snapshot no longer identifies the reviewed merge HEAD.');
  }
  return captured;
}

/** Persist terminal cleanup intent before any exact path removal begins. */
export async function beginWorkspaceMaterializationRetirement(
  workspacePath: string,
  action: WorkspaceRetirementAction,
): Promise<WorkspaceSnapshotRecord | null> {
  const snapshot = exactSnapshot(workspacePath);
  if (!snapshot) return null;
  if (snapshot.state === 'retiring' || snapshot.state === 'retired') {
    if (recordedAction(snapshot) !== action) {
      throw new Error('Workspace retirement action conflicts with its durable terminal receipt.');
    }
    return snapshot;
  }
  if (snapshot.state !== 'materialized') {
    throw new Error(`Workspace retirement requires materialized truth, not ${snapshot.state}.`);
  }
  const preservation = await preservationReceiptForSnapshot(snapshot);
  return beginRetirementWithReceipt(snapshot, action, {
    preservationId: preservation.preservationId,
    manifestSha256: preservation.manifestSha256,
    handoffSha256: preservation.handoffSha256,
    artifactCount: preservation.artifactCount,
    artifactBytes: preservation.artifactBytes,
    sourceDevice: preservation.sourceDevice,
    sourceInode: preservation.sourceInode,
    gitBundleSha256: preservation.gitBundle!.sha256,
    gitBundleBytes: preservation.gitBundle!.bytes,
  });
}

function beginRetirementWithReceipt(
  snapshot: WorkspaceSnapshotRecord,
  action: WorkspaceRetirementAction,
  receipt: Record<string, WorkspaceSnapshotJson>,
): WorkspaceSnapshotRecord {
  const result = transitionWorkspaceSnapshot({
    repositoryUuid: snapshot.repositoryUuid,
    packetId: snapshot.packetId,
    transitionId: transitionId(snapshot, action, 'begin'),
    expectedState: 'materialized',
    expectedVersion: snapshot.version,
    expectedGeneration: snapshot.snapshotGeneration,
    toState: 'retiring',
    receipt: {
      terminalAction: action,
      laneId: snapshot.laneId,
      ...receipt,
    },
  });
  if (result.status === 'missing' || result.status === 'conflict') {
    throw new Error('Workspace retirement lost its durable begin compare-and-swap.');
  }
  if (!result.record) throw new Error('Workspace retirement has no durable begin record.');
  return result.record;
}

/** Finalize only after the exact public materialization path is absent. */
export async function finishWorkspaceMaterializationRetirement(
  workspacePath: string,
  action?: WorkspaceRetirementAction,
): Promise<WorkspaceSnapshotRecord | null> {
  const snapshot = exactSnapshot(workspacePath);
  if (!snapshot) return null;
  const durableAction = recordedAction(snapshot);
  if (!durableAction || (action && action !== durableAction)) {
    throw new Error('Workspace retirement finish has no matching durable action receipt.');
  }
  if (snapshot.state === 'retired') {
    archiveTerminalLane(snapshot, durableAction);
    return snapshot;
  }
  if (snapshot.state !== 'retiring') {
    throw new Error(`Workspace retirement cannot finish from ${snapshot.state}.`);
  }
  const preservationId = getWorkspaceRetirementPreservationId(workspacePath);
  if (preservationId) await readWorkspacePreservation(preservationId);
  const occupant = await lstat(path.resolve(workspacePath)).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (occupant) throw new Error('Workspace retirement cannot finish while its public path is occupied.');
  const result = transitionWorkspaceSnapshot({
    repositoryUuid: snapshot.repositoryUuid,
    packetId: snapshot.packetId,
    transitionId: transitionId(snapshot, durableAction, 'finish'),
    expectedState: 'retiring',
    expectedVersion: snapshot.version,
    expectedGeneration: snapshot.snapshotGeneration,
    toState: 'retired',
    receipt: retirementReceipt(snapshot, durableAction),
  });
  if (result.status === 'missing' || result.status === 'conflict') {
    throw new Error('Workspace retirement lost its durable finish compare-and-swap.');
  }
  archiveTerminalLane(result.record, durableAction);
  return result.record;
}

/** Roll back only a proven pre-removal failure whose exact public path remains manager-owned. */
export function rollbackWorkspaceMaterializationRetirement(
  workspacePath: string,
  action: WorkspaceRetirementAction,
  error: unknown,
): WorkspaceSnapshotRecord | null {
  const snapshot = exactSnapshot(workspacePath);
  if (!snapshot) return null;
  if (snapshot.state === 'materialized') return snapshot;
  if (snapshot.state !== 'retiring' || recordedAction(snapshot) !== action) {
    throw new Error('Workspace retirement rollback does not match durable terminal truth.');
  }
  const result = transitionWorkspaceSnapshot({
    repositoryUuid: snapshot.repositoryUuid,
    packetId: snapshot.packetId,
    transitionId: `retire:${snapshot.snapshotGeneration}:${action}:rollback:${snapshot.version}`,
    expectedState: 'retiring',
    expectedVersion: snapshot.version,
    expectedGeneration: snapshot.snapshotGeneration,
    toState: 'materialized',
    receipt: {
      terminalAction: action,
      rollback: true,
      note: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    },
  });
  if (result.status === 'missing' || result.status === 'conflict') {
    throw new Error('Workspace retirement rollback lost its durable compare-and-swap.');
  }
  return result.record;
}

export function getWorkspaceRetirementAction(
  workspacePath: string,
): WorkspaceRetirementAction | null {
  const snapshot = exactSnapshot(workspacePath);
  return snapshot && (snapshot.state === 'retiring' || snapshot.state === 'retired')
    ? recordedAction(snapshot)
    : null;
}

export function getRecordedRetirementAction(
  snapshot: WorkspaceSnapshotRecord,
): WorkspaceRetirementAction | null {
  return recordedAction(snapshot);
}

/**
 * Record the terminal completion claim for an observed-absent workspace.
 * Callers must invoke this only after metadata removal succeeded; a late
 * failure must leave no completion receipt behind.
 */
export async function confirmWorkspaceMaterializationRetirement(
  repoPath: string,
  workspacePath: string,
  action: WorkspaceRetirementAction,
): Promise<void> {
  const repo = await findRepoByLocalPath(repoPath);
  if (!repo) return;
  const lanes = await retirementLanes(repo.localPath, workspacePath);
  if (lanes.length !== 1) return;
  appendEvent(lanes[0]!.id, 'workspace_retirement_confirmed', 'system', {
    reason: 'confirmed-missing-directory',
    action,
    workspacePath: path.resolve(workspacePath),
  });
}
