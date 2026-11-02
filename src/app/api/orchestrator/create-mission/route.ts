import { resolveSealedMissionContract } from '@/lib/orchestrator/sealed-task-contract';
import { MissionProjectScopeError } from '@/lib/orchestrator/mission-project-context';
import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveWorkerRouting } from '@/lib/agents/routing';
import { findMissionByCreationMutationId } from '@/lib/orchestrator/create-mission-receipt';
import { createMission, type ExistingBranchPolicy, type LoadedIssue } from '@/lib/orchestrator/operator-mission-service';
import { getOperatorDefaultsSync, resolveDefaultDispatchRuntimeSync } from '@/lib/operator/defaults';
import { resolveSubscriptionProfileRouting } from '@/lib/operator/subscription-profile';
import { resolveWorkerHuddle } from '@/lib/operator/worker-start-mode';
import { resolveEffortAliases, resolveRuntimeEffortPin } from '@/lib/orchestrator/effort-pin';
import { resolveComparisonCandidateTarget } from '@/lib/orchestrator/comparison-fanout';
import { normalizePacketTaskContract } from '@/lib/orchestrator/packet-task-contract';
import {
  isClaudeCodeModelSource,
  normalizeClaudeCodeGatewayModel,
} from '@/lib/claude-code/worker-profile-types';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import {
  formatDispatchableRuntimeChoices,
  getRuntimeCapability,
  isOrchestratorRuntime,
  resolveRuntimePreset,
} from '@/lib/orchestrator/runtime-capabilities';
import { assertRuntimeDispatchable, DispatchPreflightError } from '@/lib/runtimes/shared/auth-detect';
import {
  assertExecutionCarrierDispatchable,
  ExecutionCarrierPreflightError,
} from '@/lib/runtimes/shared/execution-carrier-preflight';
import { ControlPlaneLockTimeoutError } from '@/lib/orchestrator/control-plane';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import type { PacketDispatcherAttribution } from '@/lib/orchestrator/types';
import { normalizeWorkerLaunchContext } from '@/lib/orchestrator/worker-launch-context';
import { runtimeSupportsReadOnlyWorkMode } from '@/lib/runtime/launch-work-mode';
import {
  bindIdempotencyClientMutation,
  deriveIdempotencyKey,
  withIdempotency,
} from '@/lib/orchestrator/idempotency-store';
import { asRecord, operatorError, operatorSuccess, parseJsonBody, replayShape, unresolvedIdempotencyResponse } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_EXISTING_BRANCH_POLICIES = new Set<ExistingBranchPolicy>(['auto', 'reset', 'continue', 'error']);

function normalizeRuntime(value: unknown): OrchestratorRuntime | null {
  return isOrchestratorRuntime(value) ? value : null;
}

function normalizeIssues(value: unknown): LoadedIssue[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  return value.map((issue) => {
    const record = asRecord(issue);
    const perIssueRuntime = normalizeRuntime(record?.runtime);
    return {
      number: typeof record?.number === 'number' ? record.number : Number.NaN,
      title: typeof record?.title === 'string' ? record.title : '',
      body: typeof record?.body === 'string' ? record.body : '',
      url: typeof record?.url === 'string' ? record.url : '',
      ...(perIssueRuntime ? { runtime: perIssueRuntime } : {}),
    };
  });
}

function normalizeExistingBranchPolicy(value: unknown): ExistingBranchPolicy | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return VALID_EXISTING_BRANCH_POLICIES.has(value as ExistingBranchPolicy)
    ? value as ExistingBranchPolicy
    : undefined;
}

function runtimeDispatchError(runtime: OrchestratorRuntime) {
  const cap = getRuntimeCapability(runtime);
  if (cap.dispatchable) return null;
  return operatorError('runtime_not_dispatchable', `${cap.label} is not available for new dispatch. ${cap.description}`, 400, {
    runtime,
    dispatchable: false,
  });
}

// Best-of-N (item 3): the seed packet's comparison models. Clamp to ≤4 so the
// N-up matrix stays honest at the panel's max width; empty → undefined (no fan-out).
const MAX_COMPARISON_MODELS = 4;
function normalizeComparisonModels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const models = value.map((model) => String(model).trim()).filter(Boolean).slice(0, MAX_COMPARISON_MODELS);
  return models.length > 0 ? models : undefined;
}

function normalizeQualitySearch(value: unknown) {
  const record = asRecord(value);
  if (!record) return null;
  const taskContract = normalizePacketTaskContract(record.taskContract);
  return taskContract ? { taskContract } : null;
}

function resolveDispatcher(request: NextRequest, record: Record<string, unknown>): PacketDispatcherAttribution {
  const principal = resolveRequestPrincipalContext(request);
  const workerPacketId = request.headers.get('x-o8-worker-packet-id')?.trim() ?? '';
  if (principal.role === 'worker') {
    return { surface: 'agent', id: principal.packetId || workerPacketId || 'unknown-worker' };
  }

  const threadId = typeof record.orchestratorThreadId === 'string' ? record.orchestratorThreadId.trim() : '';
  if (threadId) return { surface: 'orchestrator', id: threadId };

  const declared = asRecord(record.dispatcher);
  const declaredSurface = declared?.surface;
  const declaredId = typeof declared?.id === 'string' ? declared.id.trim() : '';
  if (declaredSurface === 'orchestrator' && declaredId) {
    return { surface: 'orchestrator', id: declaredId };
  }
  return { surface: 'operator', id: declaredSurface === 'operator' && declaredId ? declaredId : 'desktop' };
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await parseJsonBody(request);
  const record = asRecord(body);
  if (!record) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }
  const clientKey = typeof record.clientMutationId === 'string'
    ? record.clientMutationId.trim()
    : typeof record.idempotencyKey === 'string'
      ? record.idempotencyKey.trim()
      : '';
  if (!clientKey) return operatorError('client_mutation_id_required', 'clientMutationId is required.', 400);

  const repoPath = typeof record.repoPath === 'string' ? record.repoPath.trim() : '';
  if (!repoPath) {
    return operatorError('invalid_request', 'repoPath is required.', 400);
  }
  if (record.origin !== undefined && record.origin !== 'design-mode') {
    return operatorError('invalid_request', 'origin must be "design-mode" when provided.', 400);
  }
  const origin = record.origin === 'design-mode' ? 'design-mode' as const : undefined;
  const launchContext = normalizeWorkerLaunchContext(record.launchContext);
  if (record.launchContext !== undefined && !launchContext) {
    return operatorError('invalid_request', 'launchContext must name a valid source, presentation, and repoContext.', 400);
  }

  const issues = normalizeIssues(record.issues);
  if (!issues) {
    return operatorError('invalid_request', 'issues must be a non-empty array.', 400);
  }

  // When runtime is omitted, preserve the effective operator default as
  // requested routing metadata.
  const requestedRuntimeRaw = record.requestedRuntime ?? record.runtime;
  const requestedModel = record.requestedModel ?? record.model;
  const requestedModelText = typeof requestedModel === 'string' ? requestedModel.trim() || null : null;
  const carrierRaw = record.claudeCodeCarrier ?? record.carrier;
  const claudeCodeCarrier = isClaudeCodeModelSource(carrierRaw) ? carrierRaw : null;
  if (carrierRaw !== undefined && carrierRaw !== null && carrierRaw !== '' && !claudeCodeCarrier) {
    return operatorError('invalid_request', 'carrier must be one of: "native", "openrouter", "codex-subscription".', 400);
  }
  const claudeCodeModel = normalizeClaudeCodeGatewayModel(requestedModel);
  // An explicit effort is a pin, not a hint. Validate BOTH aliases independently
  // (so a malformed value cannot hide behind the other) and reject conflicting
  // explicit values rather than letting first-wins pick one.
  const effortAliases = resolveEffortAliases(record.requestedEffort, record.thinkingEffort);
  if (!effortAliases.ok) {
    return operatorError(effortAliases.code, effortAliases.message, 400);
  }
  const requestedEffort = effortAliases.requestedEffort;
  const requestedEffortRaw = requestedEffort;
  const explicitRuntimeRequested = !(requestedRuntimeRaw === undefined || requestedRuntimeRaw === null || requestedRuntimeRaw === '');
  const requestedRuntime = !explicitRuntimeRequested
    ? resolveDefaultDispatchRuntimeSync()
    : normalizeRuntime(requestedRuntimeRaw);
  if (!requestedRuntime) {
    return operatorError('invalid_request', `runtime must be one of: ${formatDispatchableRuntimeChoices()}.`, 400);
  }
  if (explicitRuntimeRequested) {
    const dispatchError = runtimeDispatchError(requestedRuntime);
    if (dispatchError) return dispatchError;
  }
  const defaults = getOperatorDefaultsSync().values;
  const profileRouting = resolveSubscriptionProfileRouting({
    profile: defaults.subscriptionProfile,
    requestedRuntime: explicitRuntimeRequested || defaults.subscriptionProfile === 'both' ? requestedRuntime : null,
    requestedModel: claudeCodeCarrier ? null : requestedModelText,
    defaultDispatchModel: defaults.defaultDispatchModel,
  });
  if (!profileRouting.ok) {
    return operatorError(profileRouting.code, profileRouting.message, 400);
  }
  const runtimePresetId = origin && !requestedModelText ? 'ui-edit-low-latency' as const : null;
  const runtimePreset = runtimePresetId
    && profileRouting.requestedRuntime
    && !(claudeCodeCarrier && profileRouting.requestedRuntime === 'claude-code')
    ? resolveRuntimePreset(runtimePresetId, profileRouting.requestedRuntime)
    : null;
  const carrierOwnsMissionModel = Boolean(
    claudeCodeCarrier && profileRouting.requestedRuntime === 'claude-code',
  );
  const effectiveRequestedModel = carrierOwnsMissionModel
    ? null
    : runtimePreset?.model ?? profileRouting.requestedModel;
  const issueRoutings = [];
  for (const issue of issues) {
    if (!issue.runtime) continue;
    const dispatchError = runtimeDispatchError(issue.runtime);
    if (dispatchError) return dispatchError;
    const issueProfileRouting = resolveSubscriptionProfileRouting({
      profile: defaults.subscriptionProfile,
      requestedRuntime: issue.runtime,
      requestedModel: claudeCodeCarrier ? null : requestedModelText,
      defaultDispatchModel: defaults.defaultDispatchModel,
    });
    if (!issueProfileRouting.ok) {
      return operatorError(issueProfileRouting.code, issueProfileRouting.message, 400);
    }
    const issueRuntime = issueProfileRouting.requestedRuntime ?? issue.runtime;
    const carrierOwnsIssueModel = Boolean(claudeCodeCarrier && issueRuntime === 'claude-code');
    const issuePreset = runtimePresetId && !carrierOwnsIssueModel
      ? resolveRuntimePreset(runtimePresetId, issueProfileRouting.requestedRuntime ?? issue.runtime)
      : null;
    issueRoutings.push(resolveWorkerRouting({
      workerIntent: record.workerIntent,
      requestedProvider: record.requestedProvider,
      requestedRuntime: issueRuntime,
      requestedModel: carrierOwnsIssueModel ? null : issuePreset?.model ?? issueProfileRouting.requestedModel,
      requestedEffort,
      source: 'create-mission-api-issue',
    }));
  }
  const workerRouting = resolveWorkerRouting({
    workerIntent: record.workerIntent,
    requestedProvider: record.requestedProvider,
    requestedRuntime: profileRouting.requestedRuntime,
    requestedModel: effectiveRequestedModel,
    requestedEffort,
    source: 'create-mission-api',
  });
  if (launchContext?.workMode === 'read-only') {
    const unsupportedRuntime = [
      workerRouting.selectedRuntime,
      ...issueRoutings.map((routing) => routing.selectedRuntime),
    ].find((runtime) => !runtimeSupportsReadOnlyWorkMode(runtime));
    if (unsupportedRuntime) {
      return operatorError(
        'invalid_request',
        `runtime ${unsupportedRuntime} cannot enforce read-only worker execution. Use codex, claude-code or pi-builtin.`,
        400,
      );
    }
  }
  const hasClaudeCodePacket = issues.some((issue) => (
    (issue.runtime ?? workerRouting.selectedRuntime) === 'claude-code'
  ));
  if (claudeCodeCarrier && !hasClaudeCodePacket) {
    return operatorError('invalid_request', 'carrier can only be set when the mission includes a claude-code packet.', 400);
  }
  if (hasClaudeCodePacket && requestedModelText && !claudeCodeModel) {
    return operatorError('invalid_request', 'model must be a valid claude-code worker model identifier.', 400);
  }
  // Every explicit effort pin is judged against the runtime + model it will
  // actually launch on (mission-level, per-issue, and best-of-N candidates). An
  // unsupported runtime, a dropped/incompatible model, or an adapter coercion
  // fails here — before preflight, branch preparation, or any persisted mission.
  const actualMissionModel = (routing: typeof workerRouting): string | null => (
    routing.selectedModel
    ?? (routing.selectedRuntime === 'claude-code' ? claudeCodeModel : null)
    ?? getRuntimeCapability(routing.selectedRuntime).defaultModel
    ?? null
  );
  const missionRoutingUsed = issues.some((issue) => !issue.runtime);
  const missionAndIssueRoutings = missionRoutingUsed ? [workerRouting, ...issueRoutings] : issueRoutings;
  const comparisonCandidates = normalizeComparisonModels(record.comparisonModels) ?? [];
  const effortPinFailure = (await Promise.all([
    ...missionAndIssueRoutings.map((routing) => resolveRuntimeEffortPin({
      requestedEffort: requestedEffortRaw,
      runtime: routing.selectedRuntime,
      explicitModel: requestedModelText,
      model: actualMissionModel(routing),
      modelDisposition: routing.modelDisposition,
    }, { cwd: repoPath })),
    // Each packet fans comparison candidates out on ITS runtime; judge every
    // candidate against the runtime/model it will actually launch on.
    ...missionAndIssueRoutings.flatMap((routing) => comparisonCandidates.map((candidate) => {
      const target = resolveComparisonCandidateTarget(routing.selectedRuntime, candidate);
      const candidateRouting = resolveWorkerRouting({
        workerIntent: routing.workerIntent,
        requestedProvider: routing.requestedProvider,
        requestedRuntime: target.runtime,
        requestedModel: target.model,
        requestedEffort,
        confidence: routing.confidence,
        source: 'create-mission-api-comparison',
      });
      return resolveRuntimeEffortPin({
        requestedEffort: requestedEffortRaw,
        runtime: candidateRouting.selectedRuntime,
        explicitModel: target.explicitModel,
        model: actualMissionModel(candidateRouting),
        modelDisposition: candidateRouting.modelDisposition,
      }, { cwd: repoPath });
    })),
  ])).find((result) => !result.ok);
  if (effortPinFailure && !effortPinFailure.ok) {
    return operatorError(effortPinFailure.code, effortPinFailure.message, 400);
  }
  const huddle = resolveWorkerHuddle({
    mode: defaults.workerStartMode,
    explicitHuddle: typeof record.huddle === 'boolean' ? record.huddle : undefined,
    profile: defaults.subscriptionProfile,
    runtime: workerRouting.selectedRuntime,
    model: workerRouting.selectedModel,
  });
  try {
    // Preflight has to judge the carrier this mission will actually launch on, not the
    // stored worker profile: a mission pinned to openrouter / codex-subscription never
    // touches the native CLI login, so a logged-out native CLI must not refuse it.
    const preflightCarrier = { claudeCodeCarrier };
    const preflightRuntime = async (routing: typeof workerRouting) => {
      if (defaults.workerExecutionCarrier) {
        await assertExecutionCarrierDispatchable(routing.selectedRuntime, defaults.workerExecutionCarrier);
        return;
      }
      await assertRuntimeDispatchable(
        routing.selectedRuntime, routing.selectedModel, repoPath, preflightCarrier,
      );
    };
    await preflightRuntime(workerRouting);
    for (const issueRouting of issueRoutings) {
      await preflightRuntime(issueRouting);
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
  const existingBranchPolicy = normalizeExistingBranchPolicy(record.existingBranchPolicy);
  if (record.existingBranchPolicy !== undefined && !existingBranchPolicy) {
    return operatorError('invalid_request', 'existingBranchPolicy must be one of: "auto", "reset", "continue", "error".', 400);
  }
  const qualitySearch = record.qualitySearch === undefined
    ? undefined
    : normalizeQualitySearch(record.qualitySearch);
  if (record.qualitySearch !== undefined && !qualitySearch) {
    return operatorError('invalid_request', 'qualitySearch.taskContract must be a valid version 1 task contract.', 400);
  }
  if (qualitySearch && record.comparisonModels !== undefined) {
    return operatorError('invalid_request', 'qualitySearch cannot be combined with comparisonModels.', 400);
  }
  if (qualitySearch && record.huddle === true) {
    return operatorError('invalid_request', 'qualitySearch already uses a sealed contract and cannot be combined with huddle mode.', 400);
  }
  if (record.taskContract !== undefined && record.taskContract !== 'off') {
    return operatorError('invalid_request', 'taskContract must be "off" when provided.', 400);
  }
  const taskContract = record.taskContract === 'off' ? 'off' as const : undefined;
  if (qualitySearch && taskContract === 'off') {
    return operatorError('invalid_request', 'qualitySearch already uses a sealed contract and cannot be combined with taskContract: "off".', 400);
  }
  if (record.dispatchOnCreate !== undefined && typeof record.dispatchOnCreate !== 'boolean') {
    return operatorError('invalid_request', 'dispatchOnCreate must be a boolean when provided.', 400);
  }
  if (record.projectId !== undefined && (typeof record.projectId !== 'string' || !record.projectId.trim())) {
    return operatorError('invalid_request', 'projectId must be a non-empty project identifier.', 400);
  }
  let sealedTaskContract;
  try {
    sealedTaskContract = resolveSealedMissionContract(record, issues.length === 1 && !issues[0].url && issues[0].number >= 90001);
  } catch (error) {
    return operatorError('invalid_request', error instanceof Error ? error.message : 'Invalid sealed task contract.', 400);
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
      ...(runtimePresetId ? { runtimePreset: runtimePresetId } : {}),
      ...(hasClaudeCodePacket && claudeCodeModel ? { claudeCodeModel } : {}),
      ...(hasClaudeCodePacket && claudeCodeCarrier ? { claudeCodeCarrier } : {}),
      requestedEffort,
      constraints: typeof record.constraints === 'string' ? record.constraints : '',
      dispatchOnCreate: record.dispatchOnCreate === true,
      ...(origin ? { origin } : {}),
      sequential: record.sequential === true,
      existingBranchPolicy,
      ...(typeof record.useBrain === 'boolean' ? { useBrain: record.useBrain } : {}),
      ...(record.holdMerges === true ? { holdMerges: true } : {}),
      ...(!qualitySearch && !sealedTaskContract ? { huddle } : {}),
      ...(taskContract ? { taskContract } : {}),
      ...(sealedTaskContract ? { sealedTaskContract } : {}),
      // #1329 — carry the dispatching orchestrator thread id so workers inherit
      // its session rules. Optional; thread-less callers omit it.
      ...(typeof record.orchestratorThreadId === 'string' && record.orchestratorThreadId.trim()
        ? { orchestratorThreadId: record.orchestratorThreadId.trim() }
        : {}),
      ...(typeof record.orchestratorTurnId === 'string' && record.orchestratorTurnId.trim()
        ? { orchestratorTurnId: record.orchestratorTurnId.trim() }
        : {}),
      dispatcher: resolveDispatcher(request, record),
      ...(launchContext ? { launchContext } : {}),
      ...(normalizeComparisonModels(record.comparisonModels)
        ? { comparisonModels: normalizeComparisonModels(record.comparisonModels) }
        : {}),
      ...(qualitySearch ? { qualitySearch } : {}),
  };
  const canonicalBody = JSON.stringify(createInput);
  const binding = bindIdempotencyClientMutation({ namespace: 'create_mission', clientKey, body: canonicalBody });
  if (binding.status === 'conflict') {
    return operatorError('idempotency_conflict', 'clientMutationId was used for another mission.', 409);
  }
  if (binding.status === 'unavailable') {
    return operatorError('idempotency_unavailable', 'The mission creation receipt store is unavailable.', 503);
  }
  try {
    const outcome = await withIdempotency({
      key: deriveIdempotencyKey({ verb: 'create_mission', scopeId: repoPath, clientKey, body: canonicalBody }),
      verb: 'create_mission',
      scopeId: repoPath,
      reconcileUnresolved: async () => {
        return findMissionByCreationMutationId(clientKey)?.creationReceipt ?? null;
      },
    }, () => createMission({ ...createInput, clientMutationId: clientKey }));
    if (outcome.inProgress) return unresolvedIdempotencyResponse(outcome, 'mission creation') ?? operatorSuccess(replayShape(outcome), 202);
    return operatorSuccess(replayShape(outcome), 201);
  } catch (error) {
    if (error instanceof MissionProjectScopeError) return operatorError(error.code, error.message, 400);
    if (error instanceof ControlPlaneLockTimeoutError) {
      return operatorError(
        'mission_store_busy',
        'Mission store is busy dispatching — retry in a moment.',
        503,
      );
    }
    const message = error instanceof Error ? error.message : 'Unable to create mission.';
    return operatorError('create_mission_failed', message, 500, error);
  }
}
