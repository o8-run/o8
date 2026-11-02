import { MissionProjectScopeError } from '@/lib/orchestrator/mission-project-context';
import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveWorkerRouting } from '@/lib/agents/routing';
import {
  buildInlineIssuesFromPrompt,
  resolveSpawnCount,
  assertSpawnBatchMaterializable,
  createMission,
  dispatchMission,
} from '@/lib/orchestrator/operator-mission-service';
import { getOperatorDefaultsSync, resolveDefaultDispatchRuntimeSync } from '@/lib/operator/defaults';
import { resolveSubscriptionProfileRouting } from '@/lib/operator/subscription-profile';
import { resolveWorkerHuddle } from '@/lib/operator/worker-start-mode';
import { resolveEffortAliases, resolveRuntimeEffortPin } from '@/lib/orchestrator/effort-pin';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import {
  formatDispatchableRuntimeChoices,
  getRuntimeCapability,
  isDispatchableRuntime,
} from '@/lib/orchestrator/runtime-capabilities';
import { assertRuntimeDispatchable, DispatchPreflightError } from '@/lib/runtimes/shared/auth-detect';
import { assertExecutionCarrierDispatchable, ExecutionCarrierPreflightError } from '@/lib/runtimes/shared/execution-carrier-preflight';
import { findMissionByCreationMutationId } from '@/lib/orchestrator/create-mission-receipt';
import {
  bindIdempotencyClientMutation,
  deriveIdempotencyKey,
  withIdempotency,
} from '@/lib/orchestrator/idempotency-store';
import { asRecord, operatorError, operatorSuccess, parseJsonBody, unresolvedIdempotencyResponse } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function normalizeRuntime(value: unknown): OrchestratorRuntime | null {
  return isDispatchableRuntime(value) ? value : null;
}

/**
 * Voice / canvas spawn seam — "spawn N agents on <task>" → a gateless worktree
 * mission, created and dispatched in one call so cards bloom on the canvas the
 * instant you ask. The worktree spawn is reversible by construction (a branch
 * that touches nothing), so it carries no approval gate; only the downstream
 * irreversible verbs (merge / push / prod) stay gated.
 *
 * Body: { repoPath, task, count?, runtime?, requestedRuntime?, requestedModel?,
 *   requestedEffort?, thinkingEffort?, constraints?, useBrain?, origin? }
 *
 * `requestedEffort` / `thinkingEffort` are explicit reasoning-effort pins
 * (aliases; one value at most). No current canvas/symon caller passes them —
 * this is backend support so a future caller (e.g. voice "spawn at high effort")
 * can pin without a new route. A malformed, conflicting, or unsupported pin is
 * rejected here, before preflight/persistence/dispatch, mirroring the
 * create-mission effort contract (#2528).
 */
export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await parseJsonBody(request);
  const record = asRecord(body);
  if (!record) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }

  const repoPath = typeof record.repoPath === 'string' ? record.repoPath.trim() : '';
  if (!repoPath) {
    return operatorError('invalid_request', 'repoPath is required.', 400);
  }

  const task = typeof record.task === 'string' ? record.task.trim() : '';
  if (!task) {
    return operatorError('invalid_request', 'task is required.', 400);
  }
  const clientMutationId = typeof record.clientMutationId === 'string'
    ? record.clientMutationId.trim()
    : '';
  if (!clientMutationId) {
    return operatorError('client_mutation_id_required', 'clientMutationId is required.', 400);
  }

  let count: number;
  try {
    count = resolveSpawnCount(record.count);
  } catch (error) {
    return operatorError('invalid_request', (error as Error).message, 400);
  }
  try {
    assertSpawnBatchMaterializable(task, count, typeof record.constraints === 'string' ? record.constraints : '', repoPath);
  } catch (error) {
    return operatorError('resource_limit', (error as Error).message, 400);
  }

  const requestedRuntimeRaw = record.requestedRuntime ?? record.runtime;
  const requestedModel = record.requestedModel ?? record.model;
  // An explicit effort is a pin, not a hint. Validate BOTH aliases independently
  // (so a malformed value cannot hide behind the other) and reject conflicting
  // explicit values rather than letting first-wins pick one (#2528).
  const effortAliases = resolveEffortAliases(record.requestedEffort, record.thinkingEffort);
  if (!effortAliases.ok) {
    return operatorError(effortAliases.code, effortAliases.message, 400);
  }
  const requestedEffort = effortAliases.requestedEffort;
  const explicitRuntimeRequested = !(requestedRuntimeRaw === undefined || requestedRuntimeRaw === null || requestedRuntimeRaw === '');
  const requestedRuntime = !explicitRuntimeRequested
    ? resolveDefaultDispatchRuntimeSync()
    : normalizeRuntime(requestedRuntimeRaw);
  if (!requestedRuntime) {
    return operatorError('invalid_request', `runtime must be one of: ${formatDispatchableRuntimeChoices()}.`, 400);
  }
  const defaults = getOperatorDefaultsSync().values;
  const profileRouting = resolveSubscriptionProfileRouting({
    profile: defaults.subscriptionProfile,
    requestedRuntime: explicitRuntimeRequested || defaults.subscriptionProfile === 'both' ? requestedRuntime : null,
    requestedModel: typeof requestedModel === 'string' ? requestedModel : null,
    defaultDispatchModel: defaults.defaultDispatchModel,
  });
  if (!profileRouting.ok) {
    return operatorError(profileRouting.code, profileRouting.message, 400);
  }

  const workerRouting = resolveWorkerRouting({
    workerIntent: record.workerIntent,
    requestedProvider: record.requestedProvider,
    requestedRuntime: profileRouting.requestedRuntime,
    requestedModel: profileRouting.requestedModel,
    requestedEffort,
    source: 'spawn-prompt-api',
  });
  const huddle = resolveWorkerHuddle({
    mode: defaults.workerStartMode,
    explicitHuddle: typeof record.huddle === 'boolean' ? record.huddle : undefined,
    profile: defaults.subscriptionProfile,
    runtime: workerRouting.selectedRuntime,
    model: workerRouting.selectedModel,
  });
  // Validate the FINAL selected runtime/model before preflight, persistence, or
  // dispatch — an unsupported runtime or an adapter-coerced/dropped model fails
  // here instead of silently losing the pin on a launched agent (#2528).
  const actualLaunchedModel = workerRouting.selectedModel
    ?? getRuntimeCapability(workerRouting.selectedRuntime).defaultModel
    ?? null;
  const effortPin = await resolveRuntimeEffortPin({
    requestedEffort,
    runtime: workerRouting.selectedRuntime,
    explicitModel: typeof requestedModel === 'string' ? requestedModel.trim() || null : null,
    model: actualLaunchedModel,
    modelDisposition: workerRouting.modelDisposition,
  }, { cwd: repoPath });
  if (!effortPin.ok) {
    return operatorError(effortPin.code, effortPin.message, 400);
  }
  try {
    if (defaults.workerExecutionCarrier) {
      await assertExecutionCarrierDispatchable(workerRouting.selectedRuntime, defaults.workerExecutionCarrier);
    } else {
      await assertRuntimeDispatchable(workerRouting.selectedRuntime, workerRouting.selectedModel, repoPath);
    }
  } catch (error) {
    if (error instanceof DispatchPreflightError) {
      return operatorError(error.code, `${error.status.detail} ${error.status.fix}`, 400, {
        runtime: error.status.runtime,
        house: error.status.house,
        installed: error.status.installed,
        authenticated: error.status.authenticated,
        unavailableReason: error.status.unavailableReason,
      });
    }
    if (error instanceof ExecutionCarrierPreflightError) {
      return operatorError(error.failure, error.message, 400, {
        runtime: workerRouting.selectedRuntime,
        executionCarrier: defaults.workerExecutionCarrier,
      });
    }
    const message = error instanceof Error ? error.message : 'Runtime readiness check failed.';
    return operatorError('runtime_preflight_failed', message, 500);
  }

  let issues;
  try {
    issues = buildInlineIssuesFromPrompt(task, count);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to build spawn tasks.';
    return operatorError('invalid_request', message, 400);
  }

  if (record.projectId !== undefined && (typeof record.projectId !== 'string' || !record.projectId.trim())) {
    return operatorError('invalid_request', 'projectId must be a non-empty project identifier.', 400);
  }
  const createInput = {
      issues,
      repoPath,
      ...(typeof record.projectId === 'string' ? { projectId: record.projectId.trim() } : {}),
      runtime: workerRouting.selectedRuntime,
      workerIntent: workerRouting.workerIntent,
      requestedProvider: workerRouting.requestedProvider,
      requestedRuntime: profileRouting.requestedRuntime,
      requestedModel: workerRouting.requestedModel,
      requestedEffort,
      constraints: typeof record.constraints === 'string' ? record.constraints : '',
      // This endpoint creates and dispatches as one durable operation. Keep
      // scheduler admission if the synchronous dispatch is interrupted.
      dispatchOnCreate: true,
      ...(typeof record.useBrain === 'boolean' ? { useBrain: record.useBrain } : {}),
      huddle,
  };
  const canonicalBody = JSON.stringify({ ...createInput, origin: record.origin === 'symon' ? 'symon' : null });
  const binding = bindIdempotencyClientMutation({
    namespace: 'spawn_prompt',
    clientKey: clientMutationId,
    body: canonicalBody,
  });
  if (binding.status === 'conflict') {
    return operatorError('idempotency_conflict', 'clientMutationId was used for another spawn.', 409);
  }
  if (binding.status === 'unavailable') {
    return operatorError('idempotency_unavailable', 'The spawn receipt store is unavailable.', 503);
  }
  const creationMutationId = `${clientMutationId}:mission`;
  const finishSpawn = async (mission: Awaited<ReturnType<typeof createMission>>) => {
    const dispatch = await dispatchMission({ missionId: mission.missionId });
    return {
      ...mission,
      ...dispatch,
      packetIds: mission.packets.map((packet) => packet.id),
      ...(record.origin === 'symon' ? { origin: 'symon' } : {}),
    };
  };
  try {
    const outcome = await withIdempotency({
      key: deriveIdempotencyKey({
        verb: 'spawn_prompt',
        scopeId: repoPath,
        clientKey: clientMutationId,
        body: canonicalBody,
      }),
      verb: 'spawn_prompt',
      scopeId: repoPath,
      reconcileUnresolved: async () => {
        const missionState = findMissionByCreationMutationId(creationMutationId);
        if (!missionState?.creationReceipt) return null;
        return finishSpawn(missionState.creationReceipt);
      },
    }, async () => {
      const mission = await createMission({ ...createInput, clientMutationId: creationMutationId });
      try {
        return await finishSpawn(mission);
      } catch (error) {
        return {
          ...mission,
          packetIds: mission.packets.map((packet) => packet.id),
          ok: false,
          outcomeUnknown: true,
          note: error instanceof Error ? error.message : 'Spawn dispatch outcome is unknown.',
        };
      }
    });
    if (outcome.inProgress) {
      const unresolved = unresolvedIdempotencyResponse(outcome, 'agent spawn');
      if (unresolved) return unresolved;
    }
    if ('outcomeUnknown' in outcome.result && outcome.result.outcomeUnknown === true) {
      return operatorError(
        'spawn_outcome_unknown',
        outcome.result.note,
        409,
      );
    }
    return operatorSuccess({
      ...outcome.result,
      replayed: outcome.replayed || undefined,
      inProgress: outcome.inProgress || undefined,
    }, outcome.inProgress ? 202 : 201);
  } catch (error) {
    if (error instanceof MissionProjectScopeError) return operatorError(error.code, error.message, 400);
    const message = error instanceof Error ? error.message : 'Unable to spawn agents.';
    return operatorError('spawn_prompt_failed', message, 500, error);
  }
}
