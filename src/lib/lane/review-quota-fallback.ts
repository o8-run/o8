import { isExternalReviewPacket } from '@/lib/tasks/external-review-turn';
import { recordLaneEvent } from '@/lib/lane/events';
import {
  buildCrossHouseFallbackMessage,
  isRuntimeQuotaLimitError,
  resolveCrossHouseFallback,
  type CrossHouseFallbackDecision,
} from '@/lib/orchestrator/cross-house-policy';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { createBackendRoleRouteChoice, type RoleRouteChoice } from '@/lib/operator/role-routing';
import { recordRoleRoutingReceiptSafely } from '@/lib/operator/role-routing-ledger';
import { isCodexModelId, isSupportedModelId } from '@/lib/models';
import { resolveOrchestratorModelSync } from './codex-orchestrator-session';
import { validateRuntimeModelSelection } from '@/lib/runtimes/shared/model-compatibility';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import {
  bindReviewTurnAbortController,
  finishReviewTurn,
  startReviewTurn,
  recordReviewTurnRuntimeReceipt,
} from '@/lib/lane/review-turn-state';
import type { OrchestratorEvent } from './orchestrator-stream-events';
import { getOrchestratorBackend } from './orchestrator-backends/registry';
import type { OrchestratorBackend, OrchestratorBackendId } from './orchestrator-backends/types';
import { getLane } from './registry';
import { recordReviewTurnUsage } from './review-payer';
import { resolveReviewRoute } from './review-route';
import {
  isReviewerSessionBusyMessage,
  type ReviewUnavailableReason,
} from './review-transient-failure';

export interface ReviewFallbackTurnResult {
  ok: boolean;
  backend: OrchestratorBackendId;
  text: string;
  errors: string[];
  fallback: CrossHouseFallbackDecision | null;
  reviewTurnId: string | null;
  unavailableReason: ReviewUnavailableReason | null;
  approximateCost: number | null;
}

interface ReviewAttemptResult {
  observedRoute: RoleRouteChoice | null;
  text: string;
  errors: string[];
  quotaError: string | null;
  reviewTurnId: string | null;
  unavailableReason: ReviewUnavailableReason | null;
  approximateCost: number | null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runAttempt(input: {
  backend: OrchestratorBackend;
  repoPath: string;
  threadId: string;
  sessionThreadId?: string;
  laneId: string;
  surface: string;
  prompt: string;
  expectedHeadSha?: string | null;
  /** Internal format-repair constraint, never accepted from a public review caller. */
  formatRetryRejecting?: boolean;
  model?: string;
  thinkingEffort?: ThinkingEffort;
  freshSession?: boolean;
  readOnly?: boolean;
  signal?: AbortSignal;
  onEvent?: (backend: OrchestratorBackend, event: OrchestratorEvent) => void;
}): Promise<ReviewAttemptResult> {
  const packetId = getLane(input.laneId)?.packetId;
  const externalReview = isExternalReviewPacket(packetId);
  // External review requires a backend that enforces the requested tool profile.
  if (externalReview && !(['codex', 'claude', 'pi'] as const).some(id => id === input.backend.id)) {
    return {
      observedRoute: null,
      text: '',
      errors: [`${input.backend.label} does not support the restricted external-review profile. Select Codex, Claude or Pi.`],
      quotaError: null,
      reviewTurnId: null,
      unavailableReason: null,
      approximateCost: null,
    };
  }
  const readOnly = input.readOnly || externalReview;
  const sessionThreadId = input.sessionThreadId ?? input.threadId;
  const session = input.backend.ensureSession(input.repoPath, undefined, sessionThreadId);
  if (session.status === 'busy') {
    return {
      observedRoute: null,
      text: '',
      errors: [`${input.backend.label} session ${session.status}`],
      quotaError: null,
      reviewTurnId: null,
      unavailableReason: 'session_busy',
      approximateCost: null,
    };
  }

  const reviewTurnId = startReviewTurn({
    laneId: input.laneId,
    threadId: input.threadId,
    sessionThreadId,
    backend: input.backend.id,
    surface: input.surface,
    expectedHeadSha: input.expectedHeadSha,
    formatRetryRejecting: input.formatRetryRejecting,
  });
  const turnController = new AbortController();
  const forwardAbort = () => turnController.abort(input.signal?.reason);
  if (input.signal?.aborted) forwardAbort();
  else input.signal?.addEventListener('abort', forwardAbort, { once: true });
  const unbindAbortController = bindReviewTurnAbortController(
    input.laneId,
    reviewTurnId,
    turnController,
  );
  let observedRoute: RoleRouteChoice | null = null;
  let text = '';
  let quotaError: string | null = null;
  let unavailableReason: ReviewUnavailableReason | null = null;
  let approximateCost: number | null = null;
  let observedModel: string | null = null;
  const errors: string[] = [];
  const lane = getLane(input.laneId);
  const reviewUsage = { reviewTurnId, laneId: input.laneId, packetId: lane?.packetId ?? null, surface: input.surface };
  try {
    await input.backend.sendTurn(input.repoPath, input.prompt, (event) => {
      if (event.type === 'turn_receipt') {
        const status = recordReviewTurnRuntimeReceipt({ laneId: input.laneId, reviewTurnId,
          threadId: input.threadId, sessionThreadId, backend: input.backend.id, surface: input.surface,
          expectedHeadSha: input.expectedHeadSha ?? null, model: event.leadModel, effort: event.effort });
        observedRoute = status === 'observed' ? createBackendRoleRouteChoice(input.backend.id, event.leadModel, event.effort) : null;
        if (status !== 'observed') errors.push(`Review runtime receipt ${status}; execution route is not proven.`);
        else observedModel = event.leadModel;
      }
      if (event.type === 'text') text += event.text;
      if (event.type === 'done' && typeof event.cost === 'number') approximateCost = event.cost;
      if (event.type === 'error') {
        if (isRuntimeQuotaLimitError(event)) quotaError = event.error;
        else errors.push(event.error);
      }
      input.onEvent?.(input.backend, event);
    }, {
      threadId: sessionThreadId,
      ...(readOnly ? { permissionMode: 'plan' as const } : {}),
      ...(externalReview ? { toolProfile: 'propose' as const } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.thinkingEffort ? { thinkingEffort: input.thinkingEffort } : {}),
      reviewUsage,
      ...(input.freshSession ? { freshSession: true } : {}),
      signal: turnController.signal,
    });
  } catch (error) {
    if (isRuntimeQuotaLimitError(error)) quotaError = message(error);
    else {
      const errorMessage = message(error);
      if (isReviewerSessionBusyMessage(errorMessage)) unavailableReason = 'session_busy';
      errors.push(errorMessage);
    }
  } finally {
    unbindAbortController();
    input.signal?.removeEventListener('abort', forwardAbort);
  }
  // Claude Code can emit a terminal subscription denial as ordinary assistant
  // text and then exit successfully. Treat that observed frame as exhaustion so
  // the review crosses houses once instead of re-queueing the same dead backend.
  if (!quotaError && errors.length === 0 && isRuntimeQuotaLimitError(text)) {
    quotaError = text;
    text = '';
  }
  const outcome = turnController.signal.aborted
    ? 'failed'
    : quotaError
      ? 'quota_discarded'
      : errors.length > 0 ? 'failed' : 'completed';
  try {
    finishReviewTurn({ laneId: input.laneId, reviewTurnId, outcome });
  } catch (error) {
    errors.push(`Review turn finalization failed: ${message(error)}`);
  }
  // Every review turn is recorded in usage with its payer and cost basis (#3742). A turn whose calls
  // wrote their own rows is recorded by those; one that ended before any call gets a turn row.
  recordReviewTurnUsage({ ...reviewUsage, repoPath: lane?.repoPath ?? input.repoPath, backend: input.backend.id,
    model: observedModel ?? input.model ?? null, reportedCostUsd: approximateCost });
  return { text, errors, quotaError, reviewTurnId, unavailableReason, approximateCost, observedRoute };
}

export async function runReviewerTurnWithQuotaFallback(input: {
  laneId: string;
  repoPath: string;
  threadId: string;
  /** Backend session pool identity; audit events keep the attempt-specific threadId. */
  sessionThreadId?: string;
  surface: 'auto-review' | 'merge-gate-review' | 'packet-explainer' | 'buyin-doc';
  prompt: string | ((backend: OrchestratorBackendId) => string);
  /** HEAD this turn's prompt and diff describe. */
  expectedHeadSha?: string | null;
  /** Internal format-repair constraint, never accepted from a public review caller. */
  formatRetryRejecting?: boolean;
  onEvent?: (backend: OrchestratorBackend, event: OrchestratorEvent) => void;
  initialBackend?: OrchestratorBackend;
  backendResolver?: (backend: OrchestratorBackendId) => OrchestratorBackend;
  readOnly?: boolean;
  signal?: AbortSignal;
}): Promise<ReviewFallbackTurnResult> {
  const backendResolver = input.backendResolver ?? getOrchestratorBackend;
  // #3742: a CLI reviewer that is not installed hands the review to o8's own Pi.
  const route = input.initialBackend ? null : resolveReviewRoute(input.laneId);
  const initialBackend = input.initialBackend ?? backendResolver(route!.backend);
  const defaults = getOperatorDefaultsSync();
  const override = process.env.O8_REVIEW_MODEL?.trim();
  const modelForBackend = (backend: OrchestratorBackendId) => {
    if (backend === 'claude') return defaults.values.orchestratorModel;
    if (backend === 'codex') return resolveOrchestratorModelSync();
    if (backend === 'opencode') return defaults.values.opencodeOrchestratorModel;
    if (backend === 'pi') return route?.model ?? null;
    return null;
  };
  const requestedRoute = createBackendRoleRouteChoice(
    initialBackend.id,
    override ?? modelForBackend(initialBackend.id),
    defaults.values.thinkingEffort,
  );
  let effectiveRoute: RoleRouteChoice | null = null;
  const refuse = (reason: string, reviewTurnId: string | null = null): ReviewFallbackTurnResult => {
    recordRoleRoutingReceiptSafely({
      receiptKey: `review:${reviewTurnId ?? input.threadId}`,
      role: 'review',
      repoPath: input.repoPath,
      contextType: input.surface,
      contextId: input.laneId,
      requested: requestedRoute,
      effective: null,
      sources: {
        backend: defaults.sources.reviewerBackend,
        runtime: 'derived',
        model: override !== undefined ? 'env' : 'derived',
        effort: defaults.sources.thinkingEffort,
      },
      reason,
      status: 'refused',
    });
    return { ok: false, backend: initialBackend.id, text: '', errors: [reason], fallback: null,
      reviewTurnId, unavailableReason: null, approximateCost: null };
  };
  if (override !== undefined && !isCodexModelId(override)) {
    return refuse('O8_REVIEW_MODEL must be a supported Codex model ID.');
  }
  if (override !== undefined && initialBackend.id !== 'codex') {
    return refuse('O8_REVIEW_MODEL requires a Codex initial reviewer backend.');
  }
  const finalize = (result: ReviewFallbackTurnResult): ReviewFallbackTurnResult => {
    const fallbackReason = result.fallback ? buildCrossHouseFallbackMessage(result.fallback) : null;
    recordRoleRoutingReceiptSafely({
      receiptKey: `review:${result.reviewTurnId ?? input.threadId}`,
      role: 'review',
      repoPath: input.repoPath,
      contextType: input.surface,
      contextId: input.laneId,
      requested: requestedRoute,
      effective: effectiveRoute,
      sources: {
        backend: defaults.sources.reviewerBackend,
        runtime: defaults.values.reviewerBackend === 'follow' ? 'derived' : defaults.sources.reviewerBackend,
        model: override !== undefined && !result.fallback && effectiveRoute?.model === override
          ? 'env' : effectiveRoute?.model ? 'derived' : 'runtime-default',
        effort: effectiveRoute?.effort === defaults.values.thinkingEffort ? defaults.sources.thinkingEffort : 'derived',
      },
      reason: `${route?.reason ? `${route.reason} ` : ''}${result.ok
        ? `${input.surface} completed on ${result.backend}. ${effectiveRoute ? 'Backend turn receipt observed.' : 'No unambiguous backend turn receipt observed.'}`
        : `${input.surface} did not complete on ${result.backend}: ${result.errors.join('; ') || result.unavailableReason || 'unknown failure'}`}`,
      fallbackReason,
      status: result.ok
        ? result.fallback ? 'fallback' : 'selected'
        : result.unavailableReason ? 'refused' : 'failed',
    });
    return result;
  };
  const promptFor = (backend: OrchestratorBackendId) => (
    typeof input.prompt === 'function' ? input.prompt(backend) : input.prompt
  );
  // Pi works only inside its workspace, so a Pi review runs in the lane worktree it reviews.
  // The buy-in doc runs after the merge and writes into the repository itself.
  const piWorkspace = input.surface === 'buyin-doc' ? input.repoPath
    : getLane(input.laneId)?.worktreePath || input.repoPath;
  const first = await runAttempt({
    readOnly: input.readOnly,
    backend: initialBackend,
    laneId: input.laneId,
    surface: input.surface,
    repoPath: initialBackend.id === 'pi' ? piWorkspace : input.repoPath,
    threadId: input.threadId,
    sessionThreadId: input.sessionThreadId,
    prompt: promptFor(initialBackend.id),
    expectedHeadSha: input.expectedHeadSha,
    formatRetryRejecting: input.formatRetryRejecting,
    ...(initialBackend.id === 'codex' ? {
      model: requestedRoute.model ?? undefined, thinkingEffort: defaults.values.thinkingEffort,
    } : {}),
    ...(initialBackend.id === 'pi' ? { model: route?.model, freshSession: true } : {}),
    onEvent: input.onEvent,
    signal: input.signal,
  });
  effectiveRoute = first.observedRoute;
  if (first.unavailableReason) {
    return finalize({
      ok: false,
      backend: initialBackend.id,
      text: '',
      errors: first.errors,
      fallback: null,
      reviewTurnId: first.reviewTurnId,
      unavailableReason: first.unavailableReason,
      approximateCost: first.approximateCost,
    });
  }
  if (!first.quotaError) {
    return finalize({
      ok: first.errors.length === 0,
      backend: initialBackend.id,
      text: first.text,
      errors: first.errors,
      fallback: null,
      reviewTurnId: first.reviewTurnId,
      unavailableReason: null,
      approximateCost: first.approximateCost,
    });
  }

  const policyDecision = resolveCrossHouseFallback({
    role: 'review',
    backend: initialBackend.id,
    ...(override !== undefined ? { model: effectiveRoute?.model ?? requestedRoute.model } : {}),
    subscriptionProfile: getOperatorDefaultsSync().values.subscriptionProfile,
  });
  if (!policyDecision) {
    return finalize({
      ok: false,
      backend: initialBackend.id,
      text: '',
      errors: [first.quotaError],
      fallback: null,
      reviewTurnId: first.reviewTurnId,
      unavailableReason: null,
      approximateCost: first.approximateCost,
    });
  }

  const decision = { ...policyDecision, fromModel: effectiveRoute?.model ?? requestedRoute.model ?? policyDecision.fromModel };
  recordLaneEvent(input.laneId, 'review_fallback', 'system', {
    surface: input.surface,
    status: decision.action === 'hold' ? 'held' : 'retrying',
    fromBackend: decision.fromBackend,
    toBackend: decision.toBackend,
    fromHouse: decision.fromHouse,
    toHouse: decision.toHouse,
    fromModel: decision.fromModel,
    toModel: decision.toModel,
    runtimeTier: decision.runtimeTier,
    note: buildCrossHouseFallbackMessage(decision),
  });
  if (decision.action === 'hold') {
    return finalize({
      ok: false,
      backend: initialBackend.id,
      text: '',
      errors: [first.quotaError],
      fallback: decision,
      reviewTurnId: first.reviewTurnId,
      unavailableReason: null,
      approximateCost: first.approximateCost,
    });
  }

  const fallbackBackend = backendResolver(decision.toBackend);
  const targetRoute = createBackendRoleRouteChoice(decision.toBackend, decision.toModel, defaults.values.thinkingEffort);
  if (fallbackBackend.id !== decision.toBackend || !isSupportedModelId(decision.toModel)
    || (decision.toBackend === 'codex' && !isCodexModelId(decision.toModel))
    || !targetRoute.runtime || validateRuntimeModelSelection(targetRoute.runtime, decision.toModel, 'Review fallback')) {
    return refuse('Review fallback model and backend must match the cross-house target.', first.reviewTurnId);
  }
  const second = await runAttempt({
    readOnly: input.readOnly,
    backend: fallbackBackend,
    laneId: input.laneId,
    surface: input.surface,
    repoPath: input.repoPath,
    threadId: input.threadId,
    sessionThreadId: input.sessionThreadId,
    prompt: promptFor(fallbackBackend.id),
    expectedHeadSha: input.expectedHeadSha,
    formatRetryRejecting: input.formatRetryRejecting,
    model: decision.toModel,
    ...(fallbackBackend.id === 'codex' ? { thinkingEffort: defaults.values.thinkingEffort } : {}),
    onEvent: input.onEvent,
    signal: input.signal,
  });
  effectiveRoute = second.observedRoute;
  if (second.unavailableReason) {
    return finalize({
      ok: false,
      backend: fallbackBackend.id,
      text: '',
      errors: second.errors,
      fallback: decision,
      reviewTurnId: second.reviewTurnId,
      unavailableReason: second.unavailableReason,
      approximateCost: second.approximateCost ?? first.approximateCost,
    });
  }
  if (second.quotaError) {
    recordLaneEvent(input.laneId, 'review_fallback', 'system', {
      surface: input.surface,
      status: 'fallback_exhausted',
      fromBackend: initialBackend.id,
      toBackend: fallbackBackend.id,
      note: `${decision.toHouse} subscription also exhausted; review remains incomplete and merge stays blocked.`,
    });
  }
  const errors = second.quotaError ? [second.quotaError, ...second.errors] : second.errors;
  return finalize({
    ok: errors.length === 0,
    backend: fallbackBackend.id,
    text: errors.length === 0 ? second.text : '',
    errors,
    fallback: decision,
    reviewTurnId: second.reviewTurnId,
    unavailableReason: null,
    approximateCost: second.approximateCost ?? first.approximateCost,
  });
}
