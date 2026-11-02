import { assertSettledCompletedWorkspace, canRestoreCompletedWorkspace } from '@/lib/workspace/completed-packet';
import { lstat } from 'node:fs/promises';

import { NextRequest } from 'next/server';

import {
  resolveRequestPrincipal,
  resolveRequestPrincipalContext,
  workerPacketRefusal,
} from '@/lib/auth/principal';
import { findLatestLaneByPacket } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import {
  bindIdempotencyClientMutation,
  deriveIdempotencyKey,
  withIdempotency,
} from '@/lib/orchestrator/idempotency-store';
import { requirePanelAuth } from '@/lib/panel/auth';
import { listRepos } from '@/lib/repos/registry';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import '@/lib/runtimes';
import { parkWorkspace } from '@/lib/workspace/hibernator';
import { reconcileWorkspaceSnapshot } from '@/lib/workspace/reconciler';
import { restoreWorkspace } from '@/lib/workspace/restorer';
import {
  getWorkspaceSnapshot,
  listWorkspaceSnapshotTransitions,
  type WorkspaceSnapshotRecord,
  type WorkspaceSnapshotState,
} from '@/lib/worktree/snapshot-state';
import { canonicalRepoRoot } from '@/lib/worktree/root-layout';
import { asRecord, operatorError, operatorSuccess, parseJsonBody, replayShape } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type WorkspaceAction = 'park' | 'restore';
type WorkspaceActionStatus =
  | 'parked'
  | 'already_parked'
  | 'restored'
  | 'already_materialized'
  | 'refused';

interface ResolvedWorkspaceTarget {
  lane: Lane;
  repo: RepoRegistryEntry;
  snapshot: WorkspaceSnapshotRecord | null;
}

interface WorkspaceControlReceipt {
  schema: 'o8/workspace-control-receipt/v1';
  action: WorkspaceAction;
  status: WorkspaceActionStatus;
  clientMutationId: string;
  packetId: string;
  laneId: string;
  repositoryUuid: string;
  state: WorkspaceSnapshotState | 'materialized';
  branch: string;
  reviewedHead: string | null;
  treeSha: string | null;
  reviewFingerprint: string | null;
  reviewable: boolean;
  note: string;
  retryable: boolean;
}

async function workspacePathPresence(candidate: string): Promise<'absent' | 'occupied' | 'unknown'> {
  try {
    await lstat(candidate);
    return 'occupied';
  } catch (error) {
    return error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
      ? 'absent'
      : 'unknown';
  }
}

type WorkspaceMutationResult =
  | { ok: true; receipt: WorkspaceControlReceipt }
  | { ok: false; receipt: WorkspaceControlReceipt };

function snapshotForPacket(
  repos: RepoRegistryEntry[],
  lane: Lane,
  packetId: string,
): { repo: RepoRegistryEntry; snapshot: WorkspaceSnapshotRecord | null } | null {
  const exactRepo = repos.find((repo) => canonicalRepoRoot(repo.localPath) === canonicalRepoRoot(lane.repoPath));
  if (exactRepo) {
    const snapshot = getWorkspaceSnapshot(exactRepo.id, packetId);
    if (!snapshot || snapshot.laneId === lane.id) return { repo: exactRepo, snapshot };
  }
  const matches = repos.flatMap((repo) => {
    const snapshot = getWorkspaceSnapshot(repo.id, packetId);
    return snapshot?.laneId === lane.id ? [{ repo, snapshot }] : [];
  });
  return matches.length === 1 ? matches[0]! : null;
}

async function resolveWorkspaceTarget(packetId: string): Promise<ResolvedWorkspaceTarget | null> {
  const lane = findLatestLaneByPacket(packetId);
  if (!lane || lane.packetId !== packetId) return null;
  const resolved = snapshotForPacket(await listRepos(), lane, packetId);
  return resolved ? { lane, ...resolved } : null;
}

function projectReceipt(input: {
  action: WorkspaceAction;
  status: WorkspaceActionStatus;
  clientMutationId: string;
  target: ResolvedWorkspaceTarget;
  snapshot?: WorkspaceSnapshotRecord | null;
  note: string;
  retryable?: boolean;
}): WorkspaceControlReceipt {
  const snapshot = input.snapshot ?? input.target.snapshot;
  const reviewable = snapshot
    ? snapshot.state === 'materialized' || snapshot.state === 'parkable' || snapshot.state === 'parked'
    : input.target.lane.status === 'reviewing';
  return {
    schema: 'o8/workspace-control-receipt/v1',
    action: input.action,
    status: input.status,
    clientMutationId: input.clientMutationId,
    packetId: input.target.lane.packetId!,
    laneId: input.target.lane.id,
    repositoryUuid: input.target.repo.id,
    state: snapshot?.state ?? 'materialized',
    branch: snapshot?.branch ?? input.target.lane.branch,
    reviewedHead: snapshot?.headCommit ?? null,
    treeSha: snapshot?.treeSha ?? null,
    reviewFingerprint: snapshot?.diffFingerprint ?? null,
    reviewable,
    note: input.note,
    retryable: input.retryable ?? false,
  };
}

function mutationResponse(result: WorkspaceMutationResult, replayed: boolean) {
  if (result.ok) return operatorSuccess(replayShape({ replayed, inProgress: false, result: result.receipt }));
  return Response.json({
    ok: false,
    error: { code: `${result.receipt.action}_refused`, message: result.receipt.note },
    result: { ...result.receipt, ...(replayed ? { replayed: true } : {}) },
  }, {
    status: 409,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      ...(replayed ? { 'x-o8-idempotency-replayed': '1' } : {}),
    },
  });
}

async function reconcileMutation(
  action: WorkspaceAction,
  clientMutationId: string,
  packetId: string,
): Promise<WorkspaceMutationResult | null> {
  let target = await resolveWorkspaceTarget(packetId);
  if (!target?.snapshot) return null;
  if (target.snapshot.state === 'parkable'
    || target.snapshot.state === 'hibernating'
    || target.snapshot.state === 'restoring') {
    await reconcileWorkspaceSnapshot(target.snapshot);
    target = await resolveWorkspaceTarget(packetId);
  }
  const snapshot = target?.snapshot;
  if (!target || !snapshot) return null;
  const transitions = listWorkspaceSnapshotTransitions(snapshot.repositoryUuid, packetId);
  const expectedTransitionId = `${clientMutationId}:${action === 'park' ? 'parked' : 'materialized'}`;
  const transition = transitions.find((entry) => (
    entry.transitionId === expectedTransitionId
    && entry.snapshotGeneration === snapshot.snapshotGeneration
  ));
  const completedState = action === 'park' ? 'parked' : 'materialized';
  if (transition?.toState === completedState && snapshot.state === completedState) {
    return {
      ok: true,
      receipt: projectReceipt({
        action,
        status: action === 'park' ? 'parked' : 'restored',
        clientMutationId,
        target,
        snapshot,
        note: action === 'park'
          ? 'Workspace parking completed before the prior process ended; the exact receipt was recovered.'
          : 'Workspace restoration completed before the prior process ended; the exact receipt was recovered.',
      }),
    };
  }

  const startedSuffixes = action === 'park' ? [':parkable', ':hibernating'] : [':restoring'];
  const startedIndex = transitions.findLastIndex((entry) => (
    entry.snapshotGeneration === snapshot.snapshotGeneration
    && startedSuffixes.some((suffix) => entry.transitionId === `${clientMutationId}${suffix}`)
  ));
  if (startedIndex < 0) return null;
  const later = transitions.slice(startedIndex + 1);
  const superseded = later.some((entry) => (
    entry.snapshotGeneration === snapshot.snapshotGeneration
    && (entry.transitionId.endsWith(':parkable') || entry.transitionId.endsWith(':restoring'))
  ));
  if (superseded) return null;
  const failureSuffixes = action === 'park'
    ? [':failed-before-remove', ':failed-after-remove', ':quarantined-after-remove']
    : [':failed-path-absent', ':failed-path-unknown', ':failed-rolled-back', ':failed-quarantined'];
  const resolution = later.findLast((entry) => (
    entry.snapshotGeneration === snapshot.snapshotGeneration
    && entry.transitionId === snapshot.lastTransitionId
    && (entry.receipt?.reconciler === true
      || failureSuffixes.some((suffix) => entry.transitionId === `${clientMutationId}${suffix}`))
  ));
  if (!resolution) return null;

  if (action === 'park'
    && resolution.receipt?.reconciler === true
    && resolution.toState === 'parked'
    && snapshot.state === 'parked') {
    return {
      ok: true,
      receipt: projectReceipt({
        action,
        status: 'parked',
        clientMutationId,
        target,
        snapshot,
        note: 'Workspace parking completed from the exact interrupted removal receipt.',
      }),
    };
  }

  const safelyReset = snapshot.state === resolution.toState && (
    resolution.transitionId === `${clientMutationId}:failed-before-remove`
    || resolution.transitionId === `${clientMutationId}:failed-path-absent`
    || resolution.transitionId === `${clientMutationId}:failed-rolled-back`
    || (resolution.receipt?.reconciler === true
      && resolution.toState === (action === 'park' ? 'materialized' : 'parked'))
  );
  const durableFailure = snapshot.lastError?.message?.trim();
  return {
    ok: false,
    receipt: projectReceipt({
      action,
      status: 'refused',
      clientMutationId,
      target,
      snapshot,
      note: durableFailure || (safelyReset
        ? `The interrupted workspace ${action} was safely rolled back; a new exact mutation may retry it.`
        : `The interrupted workspace ${action} remains quarantined for operator inspection.`),
      retryable: safelyReset,
    }),
  };
}

function outcomeUnknownResponse(
  action: WorkspaceAction,
  packetId: string,
  clientMutationId: string,
) {
  return Response.json({
    ok: false,
    error: {
      code: 'outcome_unknown',
      message: `The prior workspace ${action} process ended before its receipt was persisted. The exact mutation remains quarantined and was not repeated.`,
    },
    result: {
      action,
      packetId,
      clientMutationId,
      status: 'outcome_unknown',
      outcomeUnknown: true,
      retryable: false,
    },
  }, {
    status: 409,
    headers: { 'Cache-Control': 'no-store, max-age=0', 'x-o8-terminal-outcome': 'unknown' },
  });
}

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const packetId = request.nextUrl.searchParams.get('packetId')?.trim() ?? '';
  if (!packetId) return operatorError('invalid_request', 'packetId is required.', 400);
  const ownershipRefusal = workerPacketRefusal(resolveRequestPrincipalContext(request), packetId);
  if (ownershipRefusal) return operatorError(ownershipRefusal.code, ownershipRefusal.message, 403);
  try {
    const target = await resolveWorkspaceTarget(packetId);
    if (!target) return operatorError('workspace_not_found', 'The packet workspace target was not found.', 404);
    const state = target.snapshot?.state ?? 'materialized';
    const restorePath = state === 'parked' && target.snapshot
      ? await workspacePathPresence(target.snapshot.originalPath)
      : null;
    const restorePathNote = restorePath === 'occupied'
      ? 'The original workspace path is occupied; inspect or move it before restoring.'
      : restorePath === 'unknown'
        ? 'The original workspace path could not be verified absent; restore remains unavailable.'
        : null;
    let completedCanPark = false;
    if (target.lane.status === 'completed') {
      try { assertSettledCompletedWorkspace(target.lane, undefined, target.snapshot); completedCanPark = true; }
      catch { /* Fresh settled ownership is required for completed parking. */ }
    }
    return operatorSuccess({
      schema: 'o8/workspace-control-status/v1',
      packetId,
      laneId: target.lane.id,
      repositoryUuid: target.repo.id,
      state,
      branch: target.snapshot?.branch ?? target.lane.branch,
      reviewedHead: target.snapshot?.headCommit ?? null,
      reviewFingerprint: target.snapshot?.diffFingerprint ?? null,
      canPark: (target.lane.status === 'reviewing' || completedCanPark)
        && target.lane.ownership === 'managed'
        && Boolean(target.lane.sessionKey)
        && Boolean(target.lane.worktreePath)
        && state === 'materialized',
      canRestore: state === 'parked' && restorePath === 'absent'
        && (target.lane.status !== 'completed' || Boolean(target.snapshot && canRestoreCompletedWorkspace(target.lane, target.snapshot))),
      reviewable: state === 'materialized' || state === 'parkable' || state === 'parked',
      note: restorePathNote ?? target.snapshot?.lastError?.message ?? null,
    });
  } catch (error) {
    return operatorError('workspace_status_failed', error instanceof Error ? error.message : 'Unable to read workspace status.', 500);
  }
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  if (resolveRequestPrincipal(request) !== 'operator') {
    return operatorError('forbidden', 'Workspace parking and restoration are operator-only.', 403);
  }
  const record = asRecord(await parseJsonBody(request));
  if (!record) return operatorError('invalid_request', 'Invalid JSON body.', 400);
  const action = record.action === 'park' || record.action === 'restore' ? record.action : null;
  const packetId = typeof record.packetId === 'string' ? record.packetId.trim() : '';
  const clientMutationId = typeof record.clientMutationId === 'string' ? record.clientMutationId.trim() : '';
  if (!action || !packetId || !clientMutationId) {
    return operatorError('invalid_request', 'action, packetId, and clientMutationId are required.', 400);
  }
  const target = await resolveWorkspaceTarget(packetId).catch(() => null);
  if (!target) return operatorError('workspace_not_found', 'The packet workspace target was not found.', 404);
  const canonicalBody = JSON.stringify({ action, packetId });
  try {
    const binding = bindIdempotencyClientMutation({
      namespace: 'workspace_control',
      clientKey: clientMutationId,
      body: canonicalBody,
    });
    if (binding.status === 'conflict') {
      return operatorError('idempotency_conflict', 'clientMutationId was used for another workspace action.', 409);
    }
    if (binding.status === 'unavailable') {
      return operatorError('idempotency_unavailable', 'The workspace receipt store is unavailable; no action was taken.', 503);
    }
    const outcome = await withIdempotency<WorkspaceMutationResult>({
      key: deriveIdempotencyKey({
        verb: `workspace_${action}`,
        scopeId: packetId,
        clientKey: clientMutationId,
        body: canonicalBody,
      }),
      verb: `workspace_${action}`,
      scopeId: packetId,
      reconcileUnresolved: () => reconcileMutation(action, clientMutationId, packetId),
    }, async () => {
      let current = await resolveWorkspaceTarget(packetId);
      if (!current) {
        return {
          ok: false,
          receipt: projectReceipt({
            action,
            status: 'refused',
            clientMutationId,
            target,
            note: 'The packet workspace target disappeared before the action began.',
          }),
        };
      }
      if (current.snapshot?.state === 'parkable'
        || current.snapshot?.state === 'hibernating'
        || current.snapshot?.state === 'restoring') {
        await reconcileWorkspaceSnapshot(current.snapshot);
        current = await resolveWorkspaceTarget(packetId);
        if (!current) {
          return {
            ok: false,
            receipt: projectReceipt({
              action,
              status: 'refused',
              clientMutationId,
              target,
              note: 'The packet workspace target disappeared during interrupted-state recovery.',
            }),
          };
        }
      }
      const result = action === 'park'
        ? await parkWorkspace({ repositoryUuid: current.repo.id, packetId, operationId: clientMutationId })
        : await restoreWorkspace({ repositoryUuid: current.repo.id, packetId, operationId: clientMutationId,
          expectedSnapshot: target.snapshot ? { generation: target.snapshot.snapshotGeneration,
            version: target.snapshot.version, fingerprint: target.snapshot.snapshotFingerprint } : undefined });
      const ok = result.status !== 'refused';
      return {
        ok,
        receipt: projectReceipt({
          action,
          status: result.status,
          clientMutationId,
          target: current,
          snapshot: result.snapshot,
          note: result.status === 'refused'
            ? result.note
            : action === 'park'
              ? result.status === 'already_parked' ? 'Workspace is already parked.' : 'Workspace parked; immutable review remains available.'
              : result.status === 'already_materialized' ? 'Workspace is already materialized.' : 'Workspace restored and verified at its original path.',
          retryable: false,
        }),
      } satisfies WorkspaceMutationResult;
    });
    if (outcome.inProgress) {
      if (outcome.unresolved) return outcomeUnknownResponse(action, packetId, clientMutationId);
      return operatorSuccess(replayShape(outcome), 202);
    }
    return mutationResponse(outcome.result, outcome.replayed);
  } catch (error) {
    return operatorError('workspace_control_failed', error instanceof Error ? error.message : 'Workspace action failed.', 500, error);
  }
}
