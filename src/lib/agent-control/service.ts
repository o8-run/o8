import {
  performRuntimeAction,
  type RuntimeActionKind,
  type RuntimeActionRequest,
  type RuntimeActionResult,
} from '@/lib/runtime/actions';
import {
  AGENT_CONTROL_RESULT_SCHEMA,
  AGENT_CONTROL_TARGET_SCHEMA,
  type AgentControlRef,
  type AgentControlRequest,
  type AgentControlResult,
  type AgentControlTarget,
  type PacketControlAction,
  type SessionControlAction,
} from './types';
import type { Lane } from '@/lib/lane/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

type SessionControlRequest = Extract<AgentControlRequest, { ref: { kind: 'session' } }>;
type LaneControlRequest = Extract<AgentControlRequest, { ref: { kind: 'lane' } }>;
type PacketControlRequest = Extract<AgentControlRequest, { ref: { kind: 'packet' } }>;
type UnresolvedAgentControlResult = Omit<AgentControlResult, 'target'>;

interface AgentControlTargetHints {
  runtime?: string;
  surfaceId?: string;
  sessionKey?: string;
  laneId?: string;
  packetId?: string;
  approvalId?: string;
}

function isSessionControlRequest(request: AgentControlRequest): request is SessionControlRequest {
  return request.ref.kind === 'session';
}

function isLaneControlRequest(request: AgentControlRequest): request is LaneControlRequest {
  return request.ref.kind === 'lane';
}

function baseResult(
  request: AgentControlRequest,
  result: Omit<UnresolvedAgentControlResult, 'schema' | 'ref' | 'action' | 'clientMutationId'>,
): UnresolvedAgentControlResult {
  return {
    schema: AGENT_CONTROL_RESULT_SCHEMA,
    ref: request.ref,
    action: request.action.kind,
    clientMutationId: request.clientMutationId,
    ...result,
  };
}

function trimmed(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function canonicalControlRef(input: {
  packetId: string | null;
  laneId: string | null;
  sessionKey: string | null;
  fallback: AgentControlRef;
}): AgentControlRef {
  if (input.packetId) return { kind: 'packet', id: input.packetId };
  if (input.laneId) return { kind: 'lane', id: input.laneId };
  if (input.sessionKey) return { kind: 'session', id: input.sessionKey };
  return input.fallback;
}

async function findPersistedPacket(packetId: string | null): Promise<OrchestratorPacket | null> {
  if (!packetId) return null;
  const [{ readOrchestratorControlPlaneState }, { findMissionRegistryEntryByPacketId }] = await Promise.all([
    import('@/lib/orchestrator/control-plane'),
    import('@/lib/orchestrator/mission-registry'),
  ]);
  const current = readOrchestratorControlPlaneState().packets
    .find((candidate) => candidate.id === packetId);
  if (current) return current;
  const registry = findMissionRegistryEntryByPacketId(packetId, { includeArchived: true });
  return registry?.mission.packets.find((candidate) => candidate.id === packetId) ?? null;
}

/** Resolve the action ref onto persisted lane, packet, worktree, and approval truth. */
export async function resolveAgentControlTarget(
  ref: AgentControlRef,
  hints: AgentControlTargetHints = {},
): Promise<AgentControlTarget> {
  let lane: Lane | null = null;
  let packet: OrchestratorPacket | null = null;
  let persistenceReadFailed = false;

  try {
    const {
      findLaneBySession,
      findLatestLaneByPacket,
      getLane,
      listLanes,
    } = await import('@/lib/lane/registry');
    if (ref.kind === 'lane') {
      lane = getLane(ref.id);
    } else if (ref.kind === 'packet') {
      packet = await findPersistedPacket(ref.id);
      const boundLaneId = trimmed(packet?.lane?.laneId);
      const boundLane = boundLaneId ? getLane(boundLaneId) : null;
      lane = boundLane?.packetId === ref.id ? boundLane : findLatestLaneByPacket(ref.id);
    } else {
      const sessionCandidates = new Set([
        trimmed(hints.sessionKey),
        trimmed(hints.surfaceId),
        trimmed(ref.id),
      ].filter((value): value is string => Boolean(value)));
      lane = [...sessionCandidates]
        .map((sessionKey) => findLaneBySession(sessionKey))
        .find((candidate): candidate is Lane => candidate !== null)
        ?? [...listLanes()].reverse()
          .find((candidate) => Boolean(candidate.sessionKey && sessionCandidates.has(candidate.sessionKey)))
        ?? null;
    }

    if (!lane && hints.laneId) lane = getLane(hints.laneId);
    const packetId = trimmed(lane?.packetId ?? hints.packetId ?? (ref.kind === 'packet' ? ref.id : null));
    packet ??= await findPersistedPacket(packetId);
  } catch {
    persistenceReadFailed = true;
  }

  const packetId = trimmed(lane?.packetId ?? packet?.id ?? hints.packetId ?? (ref.kind === 'packet' ? ref.id : null));
  const laneId = trimmed(lane?.id ?? hints.laneId ?? packet?.lane?.laneId ?? (ref.kind === 'lane' ? ref.id : null));
  const sessionKey = trimmed(
    lane?.sessionKey
      ?? packet?.lane?.sessionKey
      ?? hints.sessionKey
      ?? (ref.kind === 'session' ? ref.id : null),
  );
  const repoPath = trimmed(lane?.repoPath ?? packet?.lane?.repoPath ?? packet?.workspaceTargetPath);
  const worktreePath = trimmed(lane?.worktreePath ?? packet?.lane?.worktreePath);
  const runtime = trimmed(lane?.runtime ?? packet?.lane?.runtime ?? packet?.runtime ?? hints.runtime);
  const surfaceId = trimmed(hints.surfaceId ?? sessionKey);
  const owned = ref.kind === 'session'
    ? await import('@/lib/runtimes/shared/owned-session-index').then(module => module.readOwnedSessionRecord(ref.id))
    : null;
  const approval = {
    id: null as string | null,
    status: (persistenceReadFailed ? 'unknown' : 'none') as AgentControlTarget['approval']['status'],
  };

  if (!persistenceReadFailed) {
    try {
      const { getApproval, listApprovalsForContext } = await import('@/lib/approvals/store');
      const explicit = hints.approvalId ? getApproval(hints.approvalId) : null;
      if (hints.approvalId) {
        approval.id = hints.approvalId;
        approval.status = explicit?.status ?? 'unknown';
      } else {
        const contextual = listApprovalsForContext({
          packetId: packetId ?? undefined,
          laneId: laneId ?? undefined,
          sessionKey: sessionKey ?? undefined,
          projectId: lane?.projectId ?? null,
        }).find((candidate) => candidate.status === 'pending') ?? null;
        if (contextual) {
          approval.id = contextual.id;
          approval.status = contextual.status;
        }
      }
    } catch {
      approval.status = 'unknown';
    }
  }

  const persisted = Boolean(lane || packet || owned);
  const runtimeResolved = Boolean(hints.runtime || hints.surfaceId || hints.sessionKey);
  return {
    schema: AGENT_CONTROL_TARGET_SCHEMA,
    canonicalRef: canonicalControlRef({ packetId, laneId, sessionKey, fallback: ref }),
    resolution: persisted ? 'persisted' : runtimeResolved ? 'runtime' : 'request',
    runtime: runtime ?? (owned ? ref.id.split('-owned:')[0] : null),
    surfaceId,
    sessionKey,
    projectId: trimmed(lane?.projectId),
    repoPath: repoPath ?? owned?.repoPath ?? null,
    worktreePath: worktreePath ?? owned?.cwd ?? null,
    branch: trimmed(lane?.branch ?? packet?.branchTarget ?? owned?.branch),
    baseBranch: trimmed(lane?.baseBranch),
    laneId,
    laneStatus: trimmed(lane?.status),
    packetId,
    packetStatus: trimmed(packet?.status),
    approval,
  };
}

function mergeAgentControlTargets(
  before: AgentControlTarget,
  after: AgentControlTarget,
): AgentControlTarget {
  const packetId = after.packetId ?? before.packetId;
  const laneId = after.laneId ?? before.laneId;
  const sessionKey = after.sessionKey ?? before.sessionKey;
  const resolution = after.resolution === 'persisted' || before.resolution !== 'persisted'
    ? after.resolution
    : 'persisted';
  return {
    ...after,
    canonicalRef: canonicalControlRef({
      packetId,
      laneId,
      sessionKey,
      fallback: after.canonicalRef,
    }),
    resolution,
    runtime: after.runtime ?? before.runtime,
    surfaceId: after.surfaceId ?? before.surfaceId,
    sessionKey,
    projectId: after.projectId ?? before.projectId,
    repoPath: after.repoPath ?? before.repoPath,
    worktreePath: after.worktreePath ?? before.worktreePath,
    branch: after.branch ?? before.branch,
    baseBranch: after.baseBranch ?? before.baseBranch,
    laneId,
    packetId,
  };
}

function runtimeActionKind(action: Exclude<SessionControlAction, { kind: 'resume' | 'retry' | 'retire' }>): RuntimeActionKind {
  if (action.kind === 'send') return 'send_input';
  return action.kind;
}

async function performSessionControl(
  request: SessionControlRequest,
): Promise<UnresolvedAgentControlResult> {
  const action = request.action;
  if (action.kind === 'resume' || action.kind === 'retry' || action.kind === 'retire') {
    const { controlSavedWorker } = await import('./worker-recovery');
    return baseResult(request, { ...await controlSavedWorker(request.ref.id, action.kind),
      surfaceId: request.ref.id, sessionKey: request.ref.id });
  }
  const runtimeResult = await performRuntimeAction({
    action: runtimeActionKind(action),
    surfaceId: request.ref.id,
    clientMutationId: request.clientMutationId,
    message: action.kind === 'send' ? action.message : undefined,
    attachments: action.kind === 'send' ? action.attachments : undefined,
    runId: action.kind === 'send' || action.kind === 'interrupt' ? action.runId : undefined,
    auditSteer: action.kind === 'send' ? action.auditSteer : undefined,
    steerSource: action.kind === 'send' ? action.steerSource : undefined,
    automaticRecoveryRunId: action.kind === 'send' ? action.automaticRecoveryRunId : undefined,
  });

  return baseResult(request, {
    ok: runtimeResult.ok,
    status: runtimeResult.status,
    note: runtimeResult.note,
    runtime: runtimeResult.runtime,
    surfaceId: runtimeResult.surfaceId,
    sessionKey: runtimeResult.sessionKey,
    runId: runtimeResult.runId,
    aborted: runtimeResult.aborted,
    retryable: runtimeResult.retryable,
    reason: runtimeResult.reason,
  });
}

async function performLaneControl(
  request: LaneControlRequest,
): Promise<UnresolvedAgentControlResult> {
  const action = request.action;
  const { dispatch } = await import('@/lib/lane/commands');
  const laneResult = action.kind === 'send_turn'
    ? await dispatch({ verb: 'send_turn', laneId: request.ref.id, message: action.message, actor: 'user' })
    : action.kind === 'interrupt'
      ? await dispatch({ verb: 'interrupt', laneId: request.ref.id, actor: 'user' })
      : await dispatch({ verb: 'stop', laneId: request.ref.id, actor: 'user' });

  return baseResult(request, {
    ok: laneResult.ok || Boolean(laneResult.approvalId),
    status: laneResult.approvalId
      ? 'pending_approval'
      : !laneResult.ok
        ? 'unavailable'
        : action.kind === 'send_turn'
          ? 'queued'
          : action.kind === 'hold'
            ? 'held'
            : 'completed',
    note: laneResult.note,
    laneId: laneResult.laneId,
    approvalId: laneResult.approvalId,
    reason: laneResult.reason,
    mergeSha: laneResult.mergeSha,
  });
}

async function performPacketControl(
  request: PacketControlRequest,
): Promise<UnresolvedAgentControlResult> {
  const packetId = request.ref.id;
  const action: PacketControlAction = request.action;

  if (action.kind === 'steer') {
    const { steerPacket } = await import('@/lib/orchestrator/operator-mission-service');
    let result: Awaited<ReturnType<typeof steerPacket>>;
    try {
      result = await steerPacket({
        packetId,
        message: action.message,
        source: action.source,
        clientMutationId: request.clientMutationId,
      });
    } catch (error) {
      const { isPostEffectSteerFailure } = await import(
        '@/lib/orchestrator/operator-mission-service/steer'
      );
      if (!isPostEffectSteerFailure(error)) throw error;
      return baseResult(request, {
        ok: false,
        status: 'unavailable',
        note: error.message,
        packetId,
        retryable: false,
        reason: error.code,
      });
    }
    return baseResult(request, {
      ok: true,
      status: 'queued',
      note: result.note,
      packetId,
      laneId: result.laneId,
    });
  }

  if (action.kind === 'reset' || action.kind === 'retry') {
    const { resetPacket } = await import('@/lib/orchestrator/operator-mission-service');
    let result: Awaited<ReturnType<typeof resetPacket>>;
    try {
      result = await resetPacket({
        packetId,
        reason: action.reason,
        clearWorktree: action.kind === 'reset',
      });
    } catch (error) {
      const {
        ResetCleanupFailedError,
        ResetKillUnconfirmedError,
        ResetSessionArchiveUnconfirmedError,
      } = await import('@/lib/orchestrator/operator-mission-service/reset');
      if (
        !(error instanceof ResetKillUnconfirmedError)
        && !(error instanceof ResetSessionArchiveUnconfirmedError)
        && !(error instanceof ResetCleanupFailedError)
      ) throw error;
      const reason = error instanceof ResetKillUnconfirmedError
        ? 'kill_unconfirmed'
        : error instanceof ResetSessionArchiveUnconfirmedError
          ? 'session_archive_unconfirmed'
          : 'worktree_cleanup_failed';
      return baseResult(request, {
        ok: false,
        status: 'unavailable',
        note: error.message,
        packetId,
        retryable: true,
        reason,
      });
    }
    const salvaged = 'salvaged' in result && result.salvaged === true;
    const stateChanged = 'reset' in result && result.reset === false && !salvaged;
    return baseResult(request, {
      ok: !stateChanged,
      status: stateChanged ? 'unavailable' : salvaged ? 'completed' : 'held',
      note: result.note,
      packetId,
      laneId: salvaged && 'laneId' in result && typeof result.laneId === 'string'
        ? result.laneId
        : undefined,
      retryable: stateChanged || undefined,
      reason: stateChanged ? 'packet_state_changed' : undefined,
    });
  }

  if (action.kind === 'rerun') {
    const { rerunWithFeedback } = await import('@/lib/orchestrator/operator-mission-service');
    let result: Awaited<ReturnType<typeof rerunWithFeedback>>;
    try {
      result = await rerunWithFeedback({ packetId, feedback: action.feedback });
    } catch (error) {
      const {
        RerunCleanupFailedError,
        RerunKillUnconfirmedError,
        RerunPostRetirementFailedError,
        RerunSessionArchiveUnconfirmedError,
        RerunStateChangedError,
      } = await import('@/lib/orchestrator/operator-mission-service/rerun-with-feedback');
      if (
        !(error instanceof RerunKillUnconfirmedError)
        && !(error instanceof RerunSessionArchiveUnconfirmedError)
        && !(error instanceof RerunCleanupFailedError)
        && !(error instanceof RerunPostRetirementFailedError)
        && !(error instanceof RerunStateChangedError)
      ) throw error;
      const reason = error instanceof RerunKillUnconfirmedError
        ? 'kill_unconfirmed'
        : error instanceof RerunSessionArchiveUnconfirmedError
          ? 'session_archive_unconfirmed'
          : error instanceof RerunCleanupFailedError
            ? 'worktree_cleanup_failed'
            : error instanceof RerunPostRetirementFailedError
              ? 'rerun_failed'
            : 'packet_state_changed';
      return baseResult(request, {
        ok: false,
        status: 'unavailable',
        note: error.message,
        packetId,
        retryable: true,
        reason,
      });
    }
    return baseResult(request, {
      ok: true,
      status: 'queued',
      note: result.note,
      packetId,
    });
  }

  if (action.kind === 'terminate') {
    const { stopPacket } = await import('@/lib/orchestrator/stop-packet');
    const result = await stopPacket(packetId);
    return baseResult(request, {
      ok: result.ok,
      status: result.ok ? 'held' : 'unavailable',
      note: result.note,
      packetId,
      aborted: result.killConfirmed,
      reason: result.blockedReason,
    });
  }

  const { approveAndMergePacket } = await import('@/lib/orchestrator/operator-mission-service');
  const result = await approveAndMergePacket({
    packetId,
    commitMessage: action.commitMessage,
    expectedHeadSha: action.expectedHeadSha,
    actor: 'user',
  });
  return baseResult(request, {
    ok: result.merged || Boolean(result.approvalId),
    status: result.merged ? 'completed' : result.approvalId ? 'pending_approval' : 'unavailable',
    note: result.note,
    packetId,
    approvalId: result.approvalId,
    mergeSha: result.mergeSha,
    reason: result.reason,
  });
}

export async function performAgentControlAction(request: AgentControlRequest): Promise<AgentControlResult> {
  const beforeTarget = await resolveAgentControlTarget(request.ref);
  const result = isSessionControlRequest(request)
    ? await performSessionControl(request)
    : isLaneControlRequest(request)
      ? await performLaneControl(request)
      : await performPacketControl(request as PacketControlRequest);
  const afterTarget = await resolveAgentControlTarget(request.ref, {
    runtime: result.runtime ?? beforeTarget.runtime ?? undefined,
    surfaceId: result.surfaceId ?? beforeTarget.surfaceId ?? undefined,
    sessionKey: result.sessionKey ?? beforeTarget.sessionKey ?? undefined,
    laneId: result.laneId ?? beforeTarget.laneId ?? undefined,
    packetId: result.packetId ?? beforeTarget.packetId ?? undefined,
    approvalId: result.approvalId,
  });
  return {
    ...result,
    target: mergeAgentControlTargets(beforeTarget, afterTarget),
  };
}

function legacySessionAction(payload: RuntimeActionRequest): SessionControlAction | null {
  if (payload.action === 'steer' || payload.action === 'send_input') {
    return {
      kind: 'send',
      message: payload.message ?? '',
      runId: payload.runId,
      attachments: payload.attachments,
      auditSteer: payload.auditSteer,
      steerSource: payload.steerSource,
      automaticRecoveryRunId: payload.automaticRecoveryRunId,
    };
  }
  if (payload.action === 'stop' || payload.action === 'interrupt') {
    return { kind: 'interrupt', runId: payload.runId };
  }
  if (payload.action === 'watch' || payload.action === 'resolve') {
    return { kind: payload.action };
  }
  return null;
}

/** Keep the legacy runtime route stable while it crosses the shared control seam. */
export async function performLegacyRuntimeActionViaAgentControl(
  payload: RuntimeActionRequest,
): Promise<RuntimeActionResult> {
  const action = legacySessionAction(payload);
  if (!action) return performRuntimeAction(payload);

  const result = await performAgentControlAction({
    ref: { kind: 'session', id: payload.surfaceId },
    action,
    clientMutationId: payload.clientMutationId,
  });
  return {
    ok: result.ok,
    action: payload.action,
    surfaceId: result.surfaceId ?? payload.surfaceId,
    sessionKey: result.sessionKey,
    runtime: result.runtime ?? '',
    clientMutationId: result.clientMutationId,
    status: result.status === 'queued' ? 'queued' : result.status === 'completed' ? 'completed' : 'unavailable',
    note: result.note,
    retryable: result.retryable,
    reason: result.reason === 'surface_not_ready' ? 'surface_not_ready' : undefined,
    runId: result.runId,
    aborted: result.aborted,
  };
}
