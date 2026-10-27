import { readMemoryRevision } from '@/lib/cortex/memory-revision';
import { correctionStopVersion } from '@/lib/db/worker-correction-fences';
import { withOwnedActionGuard } from '@/lib/runtimes/shared/owned-session/action-admission';
import { workerFallbackGuard } from './worker-fallback-guard';
import { randomUUID } from 'node:crypto';

import { getSqlite } from '@/lib/db';
import {
  buildCrossHouseFallbackMessage,
  isRuntimeQuotaLimitError,
  resolveCrossHouseFallback,
} from '@/lib/orchestrator/cross-house-policy';
import { resolveCrossHouseWorkerFallbackSync, getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { createRoleRouteChoice } from '@/lib/operator/role-routing';
import { recordRoleRoutingReceiptSafely } from '@/lib/operator/role-routing-ledger';
import type { OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { enqueueInboxItem } from '@/lib/supervisor/inbox';
import { readOwnedRecoveryState } from '@/lib/runtimes/shared/owned-session/automatic-recovery';

function backendForRuntime(runtime: string): 'codex' | 'claude' | null {
  if (runtime === 'codex') return 'codex';
  if (runtime === 'claude-code') return 'claude';
  return null;
}

function workerEffort(
  runtime: OrchestratorRuntime,
  defaults: ReturnType<typeof getOperatorDefaultsSync>['values'],
): ThinkingEffort | null {
  if (runtime === 'codex') return defaults.codexWorkerEffort;
  if (runtime === 'claude-code') return defaults.claudeWorkerEffort;
  return null;
}

function workerChoice(
  runtime: OrchestratorRuntime,
  model: string | null | undefined,
  defaults: ReturnType<typeof getOperatorDefaultsSync>['values'],
) {
  return createRoleRouteChoice({
    backend: null,
    runtime,
    model: model?.trim() || null,
    effort: workerEffort(runtime, defaults),
  });
}

export interface WorkerQuotaFallbackResult {
  handled: boolean;
  action: 'ignored' | 'card' | 'redispatched' | 'waiting';
  toRuntime?: OrchestratorRuntime;
  inboxId?: string;
  sessionKey?: string;
}

function activeFallbackAttemptForFailure(
  laneId: string,
  runtime: string,
  surfaceId: string,
): { attemptId: string; kind: 'candidate_exhausted' | 'source_duplicate'; sessionKey?: string } | null {
  const rows = getSqlite().prepare(`
    SELECT verb, payload_json
    FROM lane_events
    WHERE lane_id = ? AND verb IN ('worker_fallback', 'worker_fallback_terminal')
    ORDER BY rowid DESC
  `).all(laneId) as Array<{ verb: string; payload_json: string }>;
  const terminal = new Set<string>();
  const seen = new Set<string>();
  for (const row of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    const attemptId = typeof payload.attemptId === 'string' ? payload.attemptId : null;
    if (!attemptId) continue;
    if (row.verb === 'worker_fallback_terminal') {
      terminal.add(attemptId);
      continue;
    }
    if (row.verb !== 'worker_fallback' || terminal.has(attemptId) || seen.has(attemptId)) continue;
    seen.add(attemptId);
    if (payload.toRuntime === runtime) {
      if (payload.status === 'launching') return { attemptId, kind: 'candidate_exhausted' };
      if (payload.status === 'redispatched' && payload.sessionKey === surfaceId) {
        return { attemptId, kind: 'candidate_exhausted', sessionKey: surfaceId };
      }
    }
    if (payload.fromRuntime === runtime && payload.surfaceId === surfaceId) {
      return {
        attemptId,
        kind: 'source_duplicate',
        ...(typeof payload.sessionKey === 'string' ? { sessionKey: payload.sessionKey } : {}),
      };
    }
  }
  return null;
}

/** Runtime-adapter exit seam. Keeping detection here lets tests drive the same
 * path as a real Codex or Claude child-process failure. */
export async function handleWorkerRuntimeFailure(input: {
  laneId: string;
  runtime: string;
  model?: string;
  surfaceId: string;
  prompt: string;
  rawFailure: string;
  waitForCapacity?: () => Promise<string | null>;
  buildHandoffContext?: () => Promise<string>;
  expectedStopVersion?: number;
}): Promise<WorkerQuotaFallbackResult> {
  const terminalFailures = input.rawFailure.split(/\r?\n/).flatMap(line => {
    try {
      const frame = JSON.parse(line);
      return frame?.type === 'turn.failed' || (frame?.type === 'result' && frame.is_error === true) ? [frame] : [];
    } catch { return []; }
  });
  if (!terminalFailures.some(isRuntimeQuotaLimitError) && !isRuntimeQuotaLimitError(input.rawFailure)) {
    return { handled: false, action: 'ignored' };
  }
  return handleWorkerQuotaExhaustion({
    laneId: input.laneId,
    runtime: input.runtime,
    model: input.model,
    surfaceId: input.surfaceId,
    prompt: input.prompt,
    error: input.rawFailure,
    waitForCapacity: input.waitForCapacity,
    buildHandoffContext: input.buildHandoffContext,
    expectedStopVersion: input.expectedStopVersion ?? correctionStopVersion(`worker:${input.surfaceId}`),
  });
}

export async function handleWorkerQuotaExhaustion(input: {
  laneId: string;
  runtime: string;
  model?: string;
  surfaceId: string;
  prompt: string;
  error: string;
  waitForCapacity?: () => Promise<string | null>;
  buildHandoffContext?: () => Promise<string>;
  expectedStopVersion?: number;
}): Promise<WorkerQuotaFallbackResult> {
  const expectedStopVersion = input.expectedStopVersion ?? correctionStopVersion(`worker:${input.surfaceId}`);
  const source = await readOwnedRecoveryState(input.surfaceId);
  if (source.owned && !source.automaticRecoveryAllowed) return { handled: false, action: 'ignored' };
  const backend = backendForRuntime(input.runtime);
  if (!backend) return { handled: false, action: 'ignored' };

  const [{ getLane, setLaneStatus, attachSession }, { recordLaneEvent }, { rebindLaneRuntime }] = await Promise.all([
    import('@/lib/lane/registry'),
    import('@/lib/lane/events'),
    import('@/lib/lane/runtime-rebind'),
  ]);
  const lane = getLane(input.laneId);
  if (!lane) return { handled: false, action: 'ignored' };

  const defaults = getOperatorDefaultsSync();
  const decision = resolveCrossHouseFallback({
    role: 'worker',
    backend,
    model: input.model,
    subscriptionProfile: defaults.values.subscriptionProfile,
  });
  if (!decision) return { handled: false, action: 'ignored' };

  const checkHandoff = workerFallbackGuard(lane, input.surfaceId, source.owned, decision.toRuntime, expectedStopVersion);
  try { checkHandoff(); } catch { return { handled: false, action: 'ignored' }; }
  const requestedRuntime = input.runtime as OrchestratorRuntime;
  const requestedRoute = workerChoice(requestedRuntime, decision.fromModel ?? input.model, defaults.values);
  const fallbackRoute = workerChoice(decision.toRuntime, decision.toModel, defaults.values);
  const routingSources = {
    backend: 'derived' as const,
    runtime: 'derived' as const,
    model: decision.toModel ? 'derived' as const : 'runtime-default' as const,
    effort: 'derived' as const,
  };
  const fallbackReason = buildCrossHouseFallbackMessage(decision);
  const recordRecovery = (inputReceipt: {
    receiptKey: string;
    effective: ReturnType<typeof workerChoice> | null;
    reason: string;
    status: 'fallback' | 'refused' | 'failed';
    fallbackReason?: string;
  }) => {
    recordRoleRoutingReceiptSafely({
      receiptKey: inputReceipt.receiptKey,
      role: 'recovery',
      repoPath: lane.repoPath,
      contextType: 'worker-quota-fallback',
      contextId: lane.packetId ?? lane.id,
      requested: requestedRoute,
      effective: inputReceipt.effective,
      sources: routingSources,
      reason: inputReceipt.reason,
      fallbackReason: inputReceipt.fallbackReason ?? fallbackReason,
      status: inputReceipt.status,
    });
  };

  const payload = {
    laneId: lane.id,
    packetId: lane.packetId,
    surfaceId: input.surfaceId,
    fromRuntime: input.runtime,
    suggestedRuntime: decision.toRuntime,
    fromModel: decision.fromModel,
    suggestedModel: decision.toModel,
    runtimeTier: decision.runtimeTier,
    error: input.error.slice(0, 2_000),
    note: buildCrossHouseFallbackMessage(decision),
  };
  recordLaneEvent(lane.id, 'worker_quota_exhausted', 'system', payload);

  const activeFallbackAttempt = activeFallbackAttemptForFailure(
    lane.id,
    input.runtime,
    input.surfaceId,
  );
  if (activeFallbackAttempt?.kind === 'source_duplicate') {
    return {
      handled: true,
      action: 'redispatched',
      toRuntime: decision.toRuntime,
      sessionKey: activeFallbackAttempt.sessionKey,
    };
  }
  if (activeFallbackAttempt?.kind === 'candidate_exhausted') {
    if (await input.waitForCapacity?.()) return { handled: true, action: 'waiting' };
    const terminalPayload = {
      ...payload,
      attemptId: activeFallbackAttempt.attemptId,
      suggestedRuntime: null,
      suggestedModel: null,
      status: 'both_houses_exhausted',
      bothHousesExhausted: true,
      note: 'Both comparable subscription houses are exhausted. Worker dispatch is paused for human action.',
    };
    recordLaneEvent(lane.id, 'worker_fallback_terminal', 'system', {
      ...terminalPayload,
    });
    setLaneStatus(lane.id, 'paused', 'system', 'worker_cross_house_fallback_exhausted');
    const item = enqueueInboxItem({
      repoPath: lane.repoPath,
      packetId: lane.packetId,
      kind: 'worker_quota_exhausted',
      status: 'human_required',
      payload: {
        ...terminalPayload,
        autoFallbackEnabled: resolveCrossHouseWorkerFallbackSync(),
      },
    });
    recordRecovery({
      receiptKey: `worker-fallback:${activeFallbackAttempt.attemptId}`,
      effective: fallbackRoute,
      reason: 'Both comparable worker routes exhausted their quota. Recovery paused for operator action.',
      status: 'failed',
      fallbackReason: terminalPayload.note,
    });
    return { handled: true, action: 'card', inboxId: item.id };
  }

  const autoFallback = resolveCrossHouseWorkerFallbackSync()
    && decision.action === 'handoff';

  if (!autoFallback) {
    if (await input.waitForCapacity?.()) return { handled: true, action: 'waiting' };
    try { checkHandoff(); } catch { return { handled: false, action: 'ignored' }; }
    setLaneStatus(lane.id, 'paused', 'system', 'worker_quota_exhausted');
    const item = enqueueInboxItem({
      repoPath: lane.repoPath,
      packetId: lane.packetId,
      kind: 'worker_quota_exhausted',
      status: 'human_required',
      payload: {
        ...payload,
        fallbackAlreadyTried: false,
        autoFallbackEnabled: resolveCrossHouseWorkerFallbackSync(),
      },
    });
    recordRecovery({
      receiptKey: `worker-quota:${lane.id}:${input.surfaceId}`,
      effective: null,
      reason: 'The configured worker route exhausted its quota. Automatic cross-account fallback is off.',
      status: 'refused',
    });
    return { handled: true, action: 'card', toRuntime: decision.toRuntime, inboxId: item.id };
  }

  let handoffPrompt: string;
  let promptMemoryRevision: string | undefined;
  try {
    checkHandoff();
    const revision = readMemoryRevision();
    handoffPrompt = await input.buildHandoffContext?.() ?? input.prompt;
    if (readMemoryRevision() !== revision) throw new Error('Worker memory changed during handoff.');
    if (input.buildHandoffContext) promptMemoryRevision = revision;
    const currentSource = source.owned ? await readOwnedRecoveryState(input.surfaceId) : null;
    if (currentSource?.owned && (currentSource.runId !== (source.owned ? source.runId : undefined) || currentSource.interrupted || !currentSource.automaticRecoveryAllowed)) {
      return { handled: false, action: 'ignored' };
    }
    checkHandoff();
  } catch { return { handled: false, action: 'ignored' }; }
  const attemptId = `worker-fallback-${randomUUID()}`;
  recordLaneEvent(lane.id, 'worker_fallback', 'system', {
    ...payload,
    attemptId,
    toRuntime: decision.toRuntime,
    status: 'launching',
    contextCarried: Boolean(input.buildHandoffContext),
  });
  rebindLaneRuntime(lane.id, decision.toRuntime, {
    reason: 'cross_house_worker_fallback',
    fromRuntime: lane.runtime,
    toRuntime: decision.toRuntime,
  });
  setLaneStatus(lane.id, 'launching', 'system', 'worker_quota_fallback_launching');

  let launchedSurface: string | undefined;
  try {
    const { launchRuntimeSurface } = await import('@/lib/runtime/actions');
    const result = await withOwnedActionGuard(() => checkHandoff(true), () => launchRuntimeSurface({
      runtime: decision.toRuntime,
      prompt: handoffPrompt,
      promptMemoryRevision,
      repoPath: lane.worktreePath ?? lane.repoPath,
      projectRepoPath: lane.repoPath,
      branchName: lane.branch,
      baseBranch: lane.baseBranch,
      model: decision.toModel,
      effort: workerEffort(decision.toRuntime, defaults.values) ?? undefined,
      ...(decision.toRuntime === 'claude-code' ? { claudeCodeCarrier: 'native' as const } : {}),
      clientMutationId: attemptId,
      isolate: false,
      skipSetup: true,
      existingLaneId: lane.id,
      packetId: lane.packetId ?? undefined,
    }));
    launchedSurface = result.surfaceId;
    checkHandoff(true);
    if (!result.ok || !result.surfaceId) {
      throw new Error(result.note || 'Equivalent runtime launch failed.');
    }

    attachSession(lane.id, result.surfaceId, 'system');
    setLaneStatus(lane.id, 'running', 'system', 'worker_quota_fallback_launched');
    recordLaneEvent(lane.id, 'worker_fallback', 'system', {
      ...payload,
      attemptId,
      toRuntime: decision.toRuntime,
      status: 'redispatched',
      contextCarried: Boolean(input.buildHandoffContext),
      sessionKey: result.surfaceId,
    });
    if (lane.packetId) {
      const { patchMissionPacket } = await import('@/lib/orchestrator/operator-mission-service/packet-patch');
      await patchMissionPacket(lane.packetId, {
        runtime: decision.toRuntime,
        assignedModel: decision.toModel,
        dispatchRuntimePin: decision.toRuntime,
      });
    }
    recordRecovery({
      receiptKey: `worker-fallback:${attemptId}`,
      effective: fallbackRoute,
      reason: `Recovery relaunched the packet on ${decision.toRuntime}.`,
      status: 'fallback',
    });
    return {
      handled: true,
      action: 'redispatched',
      toRuntime: decision.toRuntime,
      sessionKey: result.surfaceId,
    };
  } catch (error) {
    let cancelled = false;
    try { checkHandoff(true); } catch { cancelled = true; }
    if (cancelled && launchedSurface) {
      const { escalateInterruptOwnedSurface } = await import('@/lib/runtime/interrupt-escalation');
      await escalateInterruptOwnedSurface(launchedSurface);
    }
    const fallbackError = error instanceof Error ? error.message : String(error);
    recordLaneEvent(lane.id, 'worker_fallback_terminal', 'system', {
      ...payload,
      attemptId,
      toRuntime: decision.toRuntime,
      status: cancelled ? 'cancelled' : 'launch_failed',
      fallbackError,
    });
    const failedLane = getLane(lane.id);
    if (cancelled && (!failedLane || failedLane.status !== 'launching' || failedLane.sessionKey !== null
      || failedLane.runtime !== decision.toRuntime)) return { handled: false, action: 'ignored' };
    rebindLaneRuntime(lane.id, lane.runtime, {
      reason: 'cross_house_worker_fallback_failed',
      attemptedRuntime: decision.toRuntime,
    });
    if (source.owned) attachSession(lane.id, input.surfaceId, 'system');
    setLaneStatus(lane.id, 'paused', 'system', cancelled ? 'operator_stopped' : 'worker_quota_fallback_failed');
    if (cancelled) return { handled: false, action: 'ignored' };
    const item = enqueueInboxItem({
      repoPath: lane.repoPath,
      packetId: lane.packetId,
      kind: 'worker_quota_exhausted',
      status: 'human_required',
      payload: { ...payload, autoFallbackEnabled: true, fallbackError },
    });
    recordRecovery({
      receiptKey: `worker-fallback:${attemptId}`,
      effective: fallbackRoute,
      reason: `Recovery could not launch ${decision.toRuntime}: ${fallbackError}`,
      status: 'failed',
    });
    return { handled: true, action: 'card', toRuntime: decision.toRuntime, inboxId: item.id };
  }
}
