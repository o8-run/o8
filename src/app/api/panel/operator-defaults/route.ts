import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { parseKnowledgeSources } from '@/lib/operator/knowledge-source-defaults';
import { NextResponse } from 'next/server';
import { changeNextWindowPreference, nextWindowError } from '@/lib/next/app-window';

import {
  CODEX_MODEL_IDS,
  isCodexModelId,
  isSupportedModelId,
  SUPPORTED_MODEL_IDS,
} from '@/lib/models';
import {
  applyOperatorDefaultsToml,
  getOperatorDefaults,
  getOperatorDefaultsTomlState,
  isCollideAggregator,
  isBrainRoutingMode,
  isOrchestratorBackendSetting,
  isPrLinkDestination,
  isRequireApproval,
  isReviewerBackendSetting,
  isSubscriptionProfile,
  isWorkspaceManifestPolicy,
  OPERATOR_DEFAULTS_FALLBACK,
  updateOperatorDefaults,
  type OperatorDefaults,
  type OverlapGateMode,
} from '@/lib/operator/defaults';
import {
  isBroadcastCommentaryMode,
  isBroadcastVoiceClockTime,
  isBroadcastVoiceQuietHoursMode,
} from '@/lib/operator/broadcast-commentary-defaults';
import { isReviewReadyNotifications } from '@/lib/operator/presentation-defaults';
import { isJudgmentProvider, JUDGMENT_PROVIDER_VALUES_MESSAGE } from '@/lib/operator/judgment-default';
import { isJudgmentAllowance, isJudgmentBetaEndDate, JUDGMENT_ALLOWANCE_EXPECTED, JUDGMENT_BETA_END_DATE_EXPECTED } from '@/lib/operator/judgment-allowance-default';
import { resolveJudgmentPath } from '@/lib/judgment/route';
import { getEntitlementSync } from '@/lib/entitlement/store';
import { isDispatchRuntime, isParallelCap } from '@/lib/operator/defaults-env';
import { isWorkerStartMode } from '@/lib/operator/worker-start-mode';
import { isExecutionCarrierId } from '@/lib/runtimes/shared/execution-carrier';
import { projectAgentRoleRoutes } from '@/lib/operator/role-routing';
import { listRoleRoutingReceipts } from '@/lib/operator/role-routing-ledger';
import {
  assertRoutingTomlCompatibility,
} from '@/lib/operator/routing-compatibility';
import { isThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { withStoragePressurePolicyLock } from '@/lib/orchestrator/storage-pressure-policy-lock';
import { SettingsTomlConflictError } from '@/lib/settings/operator-defaults-store';
import { mergeNativeSettingsToml, readNativeSettings, updateNativeSettings } from '@/lib/settings/native-settings';
import { validateCredentialSafeUrl } from '@/lib/settings/credential-safe-url';
import { resolveApfsDependencyImagesOverride } from '@/lib/workspace/dependency-image-policy';
import {
  getDispatchableRuntimeAvailability,
  getRuntimeAuthSnapshot,
  invalidateRuntimeAuthCache,
} from '@/lib/runtimes/shared/auth-detect';
import { assertThreecodeWorkerModelAvailable } from '@/lib/runtimes/threecode-model-catalogue';
import { parseOperatorDefaultsToml } from '@/lib/settings/toml';
import { readBuiltInAgentRuntime, readOnboardingRuntimeSetup } from '@/lib/setup/built-in-agent-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' };
function effectiveOverride() {
  return {
    apfsDependencyImages: resolveApfsDependencyImagesOverride(),
  };
}

function response(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: NO_STORE_HEADERS,
  });
}

type OperatorDefaultsData = Awaited<ReturnType<typeof getOperatorDefaults>>;
type OperatorDefaultsTomlState = Awaited<ReturnType<typeof getOperatorDefaultsTomlState>>;
type CliAuthSnapshot = Awaited<ReturnType<typeof getRuntimeAuthSnapshot>>;
type DispatchableRuntimeInventory = Awaited<ReturnType<typeof getDispatchableRuntimeAvailability>>;

function operatorDefaultsPayload(
  data: OperatorDefaultsData,
  settingsToml: OperatorDefaultsTomlState,
  cliAuth: CliAuthSnapshot,
  dispatchableRuntimes: DispatchableRuntimeInventory,
) {
  return {
    ...operatorDefaultsValuesPayload(data, settingsToml),
    cliAuth,
    dispatchableRuntimes,
    roleRoutes: projectAgentRoleRoutes({
      values: data.values,
      sources: data.sources,
      dispatchableRuntimes,
      managedBrainEligible: getEntitlementSync().flags['proxy.inference'] === true,
    }),
  };
}

function operatorDefaultsValuesPayload(
  data: OperatorDefaultsData,
  settingsToml: OperatorDefaultsTomlState,
) {
  return {
    ...data,
    nextWindowError: nextWindowError(),
    judgmentPath: resolveJudgmentPath(data.values.judgmentProvider),
    effectiveOverride: effectiveOverride(),
    settingsToml,
    recentRoleReceipts: listRoleRoutingReceipts({ limit: 60 }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isWorkerRuntimeList(value: unknown): value is OperatorDefaults['workerRuntimes'] {
  return Array.isArray(value) && value.length > 0 && value.every(isDispatchRuntime);
}

function parseStorageReserveRatio(value: unknown): number {
  if (typeof value === 'number') return value;
  return typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
}

function workspaceStorageValidationError(body: Record<string, unknown>): string | null {
  if (body.storageReserveRatio !== undefined) {
    const parsed = parseStorageReserveRatio(body.storageReserveRatio);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      return 'storageReserveRatio must be between 0 and 1.';
    }
  }
  if (body.storageReserveFloorGb !== undefined) {
    const parsed = typeof body.storageReserveFloorGb === 'number'
      ? body.storageReserveFloorGb
      : Number(body.storageReserveFloorGb);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 10000) {
      return 'storageReserveFloorGb must be greater than 0 and no more than 10000.';
    }
  }
  if (body.workspaceParkingMode !== undefined
    && body.workspaceParkingMode !== 'manual'
    && body.workspaceParkingMode !== 'pressure') {
    return 'workspaceParkingMode must be "manual" or "pressure".';
  }
  return null;
}

function normalizeUpdate(body: Record<string, unknown>): Partial<OperatorDefaults> {
  const update: Partial<OperatorDefaults> = {};

  if (body.subscriptionProfile !== undefined) {
    if (!isSubscriptionProfile(body.subscriptionProfile)) {
      throw new Error('subscriptionProfile must be one of "both", "claude-only", "codex-only".');
    }
    update.subscriptionProfile = body.subscriptionProfile;
  }

  if (body.parallelCap !== undefined) {
    const raw = body.parallelCap;
    const parsed = typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number(raw)
        : Number.NaN;
    if (!isParallelCap(parsed)) {
      throw new Error('parallelCap must be a positive safe integer.');
    }
    update.parallelCap = parsed;
  }

  for (const field of ['meteredPacketCostCapUsd', 'meteredPacketInputTokenCap'] as const) {
    if (body[field] === undefined) continue;
    const parsed = typeof body[field] === 'number' ? body[field] : Number(body[field]);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${field} must be greater than 0.`);
    update[field] = field === 'meteredPacketInputTokenCap' ? Math.round(parsed) : parsed;
  }

  for (const field of [
    'uiLoopMaxIterations',
    'uiLoopMaxMinutes',
    'uiLoopMaxDiffBytes',
    'uiLoopMaxDiffFiles',
    'uiLoopPreviewTimeoutMs',
  ] as const) {
    if (body[field] === undefined) continue;
    const parsed = typeof body[field] === 'number' ? body[field] : Number(body[field]);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`${field} must be a positive integer.`);
    }
    update[field] = parsed;
  }

  if (body.overlapGate !== undefined) {
    if (body.overlapGate !== 'advisory' && body.overlapGate !== 'strict') {
      throw new Error('overlapGate must be "advisory" or "strict".');
    }
    update.overlapGate = body.overlapGate as OverlapGateMode;
  }

  if (body.healBotEnabled !== undefined) {
    if (typeof body.healBotEnabled !== 'boolean') {
      throw new Error('healBotEnabled must be boolean.');
    }
    update.healBotEnabled = body.healBotEnabled;
  }

  if (body.supervisorAutoEscalate !== undefined) {
    if (typeof body.supervisorAutoEscalate !== 'boolean') {
      throw new Error('supervisorAutoEscalate must be boolean.');
    }
    update.supervisorAutoEscalate = body.supervisorAutoEscalate;
  }

  if (body.codexAppThreads !== undefined) {
    if (typeof body.codexAppThreads !== 'boolean') {
      throw new Error('codexAppThreads must be boolean.');
    }
    update.codexAppThreads = body.codexAppThreads;
  }
  if (body.reviewContinuation !== undefined) {
    if (typeof body.reviewContinuation !== 'boolean') {
      throw new Error('reviewContinuation must be boolean.');
    }
    update.reviewContinuation = body.reviewContinuation;
  }

  if (body.broadcastCommentary !== undefined) {
    if (!isBroadcastCommentaryMode(body.broadcastCommentary)) {
      throw new Error('broadcastCommentary must be "off" or "interval".');
    }
    update.broadcastCommentary = body.broadcastCommentary;
  }

  if (body.broadcastVoice !== undefined) {
    if (body.broadcastVoice !== 'off' && body.broadcastVoice !== 'on') {
      throw new Error('broadcastVoice must be "off" or "on".');
    }
    update.broadcastVoice = body.broadcastVoice;
  }

  if (body.broadcastVoiceQuietHours !== undefined) {
    if (!isBroadcastVoiceQuietHoursMode(body.broadcastVoiceQuietHours)) {
      throw new Error('broadcastVoiceQuietHours must be "off" or "on".');
    }
    update.broadcastVoiceQuietHours = body.broadcastVoiceQuietHours;
  }

  for (const field of ['broadcastVoiceQuietStart', 'broadcastVoiceQuietEnd'] as const) {
    if (body[field] === undefined) continue;
    if (!isBroadcastVoiceClockTime(body[field])) {
      throw new Error(`${field} must be a local time in HH:MM format.`);
    }
    update[field] = body[field];
  }

  for (const field of [
    'broadcastVoiceAttention',
    'broadcastVoiceApprovals',
    'broadcastVoiceReviews',
    'broadcastVoiceFailures',
    'broadcastVoiceCompletions',
    'broadcastVoiceCalendar',
    'broadcastVoiceTimeCheckins',
  ] as const) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'boolean') throw new Error(`${field} must be boolean.`);
    update[field] = body[field];
  }

  for (const [field, maximum] of [
    ['broadcastCommentaryIntervalMinutes', 1_440],
    ['broadcastCommentaryMinNewEvents', 100],
    ['broadcastCommentaryMaxPerHour', 60],
    ['broadcastVoiceLullMinutes', 1_440],
    ['broadcastVoiceCalendarLeadMinutes', 1_440],
  ] as const) {
    if (body[field] === undefined) continue;
    const value = body[field];
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
      throw new Error(`${field} must be an integer from 1 through ${maximum}.`);
    }
    update[field] = Number(value);
  }

  if (body.presentationQuietMode !== undefined) {
    if (typeof body.presentationQuietMode !== 'boolean') {
      throw new Error('presentationQuietMode must be boolean.');
    }
    update.presentationQuietMode = body.presentationQuietMode;
  }

  if (body.notificationsReviewReady !== undefined) {
    if (!isReviewReadyNotifications(body.notificationsReviewReady)) {
      throw new Error('notificationsReviewReady must be "off" or "on".');
    }
    update.notificationsReviewReady = body.notificationsReviewReady;
  }

  if (body.apfsDependencyImages !== undefined) {
    if (typeof body.apfsDependencyImages !== 'boolean') {
      throw new Error('apfsDependencyImages must be boolean.');
    }
    update.apfsDependencyImages = body.apfsDependencyImages;
  }

  if (body.thinkingEffort !== undefined) {
    if (!isThinkingEffort(body.thinkingEffort)) {
      throw new Error('thinkingEffort must be a valid effort level.');
    }
    update.thinkingEffort = body.thinkingEffort;
  }

  if (body.promptCachingEnabled !== undefined) {
    if (typeof body.promptCachingEnabled !== 'boolean') {
      throw new Error('promptCachingEnabled must be boolean.');
    }
    update.promptCachingEnabled = body.promptCachingEnabled;
  }
  if (body.autoTitleInferenceEnabled !== undefined) {
    if (typeof body.autoTitleInferenceEnabled !== 'boolean') {
      throw new Error('autoTitleInferenceEnabled must be boolean.');
    }
    update.autoTitleInferenceEnabled = body.autoTitleInferenceEnabled;
  }

  if (body.requireApproval !== undefined) {
    if (!isRequireApproval(body.requireApproval)) {
      throw new Error('requireApproval must be one of "high-risk", "surface", "always", "never".');
    }
    update.requireApproval = body.requireApproval;
  }

  if (body.orchestratorModel !== undefined) {
    const model = typeof body.orchestratorModel === 'string' ? body.orchestratorModel.trim() : '';
    if (!isSupportedModelId(model)) {
      throw new Error(`orchestratorModel ${JSON.stringify(model)} is unsupported; valid values are ${SUPPORTED_MODEL_IDS.map((value) => JSON.stringify(value)).join(', ')}.`);
    }
    update.orchestratorModel = model;
  }

  // ACP model pins. Forwarded as-is — updateOperatorDefaults owns the real
  // validation (isPlausibleAcpModelId, null = clear the pin). These were
  // missing from this normalizer at first, so the Settings pickers' field-level
  // save 400'd with "No supported fields" while the TOML path worked — the
  // reachability trap: the setting existed everywhere except the path the UI
  // actually posts through (live-hit on the shipped build, 2026-08-05).
  for (const key of ['opencodeOrchestratorModel', 'opencodeWorkerModel', 'threecodeWorkerModel'] as const) {
    if (body[key] === undefined) continue;
    if (body[key] !== null && typeof body[key] !== 'string') {
      throw new Error(`${key} must be a model id string or null.`);
    }
    update[key] = body[key] as string | null;
  }

  if (body.defaultDispatchRuntime !== undefined) {
    // Single-source guard (mirrors the orchestratorBackend pattern below): a
    // hand-rolled list here silently rejected cursor/grok/pi even though the
    // dispatch layer + tier validator accept them (2026-07-09).
    if (!isDispatchRuntime(body.defaultDispatchRuntime)) {
      throw new Error('defaultDispatchRuntime must name a dispatchable runtime.');
    }
    update.defaultDispatchRuntime = body.defaultDispatchRuntime;
  }

  if (body.workerExecutionCarrier !== undefined) {
    if (body.workerExecutionCarrier !== null && !isExecutionCarrierId(body.workerExecutionCarrier)) {
      throw new Error('workerExecutionCarrier must be "ori" or null.');
    }
    update.workerExecutionCarrier = body.workerExecutionCarrier;
  }

  if (body.workerStartMode !== undefined) {
    if (!isWorkerStartMode(body.workerStartMode)) {
      throw new Error('workerStartMode must be one of "autonomous", "huddle", or "adaptive".');
    }
    update.workerStartMode = body.workerStartMode;
  }

  if (isWorkerRuntimeList(body.workerRuntimes)) {
    update.workerRuntimes = [...new Set(body.workerRuntimes)];
  }

  if (body.codexWorkerEffort !== undefined) {
    if (!isThinkingEffort(body.codexWorkerEffort)) {
      throw new Error('codexWorkerEffort must be a valid effort level.');
    }
    update.codexWorkerEffort = body.codexWorkerEffort;
  }

  if (body.claudeWorkerEffort !== undefined) {
    if (!isThinkingEffort(body.claudeWorkerEffort)) {
      throw new Error('claudeWorkerEffort must be a valid effort level.');
    }
    update.claudeWorkerEffort = body.claudeWorkerEffort;
  }

  if (body.brainCodexModel !== undefined) {
    const model = typeof body.brainCodexModel === 'string' ? body.brainCodexModel.trim() : '';
    if (!isCodexModelId(model)) {
      throw new Error(`brainCodexModel ${JSON.stringify(model)} is unsupported; valid values are ${CODEX_MODEL_IDS.map((value) => JSON.stringify(value)).join(', ')}.`);
    }
    update.brainCodexModel = model;
  }

  if (body.brainCodexEffort !== undefined) {
    if (!isThinkingEffort(body.brainCodexEffort)) {
      throw new Error('brainCodexEffort must be a valid effort level.');
    }
    update.brainCodexEffort = body.brainCodexEffort;
  }

  if (body.brainRoutingMode !== undefined) {
    if (!isBrainRoutingMode(body.brainRoutingMode)) {
      throw new Error('brainRoutingMode must be "auto" or "subscription".');
    }
    update.brainRoutingMode = body.brainRoutingMode;
  }

  if (body.defaultDispatchModel !== undefined) {
    // Any string is valid; '' clears it back to the runtime default. Use the
    // `ollama:<model>` / `lmstudio:<model>` convention to dispatch local.
    if (typeof body.defaultDispatchModel !== 'string') {
      throw new Error('defaultDispatchModel must be a string.');
    }
    update.defaultDispatchModel = body.defaultDispatchModel.trim();
  }

  if (body.localInferenceBaseUrl !== undefined) {
    if (typeof body.localInferenceBaseUrl !== 'string') {
      throw new Error('localInferenceBaseUrl must be a string.');
    }
    update.localInferenceBaseUrl = validateCredentialSafeUrl(body.localInferenceBaseUrl, 'localInferenceBaseUrl');
  }

  if (body.localEmbedModel !== undefined) {
    if (typeof body.localEmbedModel !== 'string') {
      throw new Error('localEmbedModel must be a string.');
    }
    update.localEmbedModel = body.localEmbedModel.trim();
  }

  if (body.localChatModel !== undefined) {
    if (typeof body.localChatModel !== 'string') {
      throw new Error('localChatModel must be a string.');
    }
    update.localChatModel = body.localChatModel.trim();
  }

  for (const field of ['experimentalOpencode', 'experimentalGemini', 'experimentalChat', 'experimentalCanvas', 'experimentalNext', 'nativeBrowserView'] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') throw new Error(`${field} must be boolean.`);
    update[field] = value;
  }

  if (body.classAComposer !== undefined) {
    const raw = body.classAComposer;
    if (raw !== 'auto' && raw !== 'haiku-cli' && raw !== 'sonnet-cli' && raw !== 'fastest') {
      throw new Error('classAComposer must be one of "auto", "haiku-cli", "sonnet-cli", "fastest".');
    }
    update.classAComposer = raw;
  }

  if (body.inAppOrchestratorEnabled !== undefined) {
    if (typeof body.inAppOrchestratorEnabled !== 'boolean') {
      throw new Error('inAppOrchestratorEnabled must be boolean.');
    }
    update.inAppOrchestratorEnabled = body.inAppOrchestratorEnabled;
  }
  if (body.knowledgeSources !== undefined) update.knowledgeSources = parseKnowledgeSources(body.knowledgeSources);
  if (body.brainUseClaudeCli !== undefined) {
    if (typeof body.brainUseClaudeCli !== 'boolean') {
      throw new Error('brainUseClaudeCli must be boolean.');
    }
    update.brainUseClaudeCli = body.brainUseClaudeCli;
  }

  if (body.brainWarmupEnabled !== undefined) {
    if (typeof body.brainWarmupEnabled !== 'boolean') {
      throw new Error('brainWarmupEnabled must be boolean.');
    }
    update.brainWarmupEnabled = body.brainWarmupEnabled;
  }

  if (body.workersUseBrain !== undefined) {
    const raw = body.workersUseBrain;
    if (raw !== 'off' && raw !== 'auto' && raw !== 'all') {
      throw new Error('workersUseBrain must be one of "off", "auto", "all".');
    }
    update.workersUseBrain = raw;
  }

  if (body.judgmentProvider !== undefined) {
    if (!isJudgmentProvider(body.judgmentProvider)) {
      throw new Error(`judgmentProvider must be ${JUDGMENT_PROVIDER_VALUES_MESSAGE}.`);
    }
    update.judgmentProvider = body.judgmentProvider;
  }

  if (body.judgmentManagedDailyAllowance !== undefined) {
    if (body.judgmentManagedDailyAllowance !== null && !isJudgmentAllowance(body.judgmentManagedDailyAllowance)) {
      throw new Error(`judgmentManagedDailyAllowance must be ${JUDGMENT_ALLOWANCE_EXPECTED}.`);
    }
    update.judgmentManagedDailyAllowance = body.judgmentManagedDailyAllowance;
  }

  if (body.judgmentBetaEndDate !== undefined) {
    if (body.judgmentBetaEndDate !== null && !isJudgmentBetaEndDate(body.judgmentBetaEndDate)) {
      throw new Error(`judgmentBetaEndDate must be ${JUDGMENT_BETA_END_DATE_EXPECTED}.`);
    }
    update.judgmentBetaEndDate = body.judgmentBetaEndDate;
  }

  if (body.judgmentManagedOptionVisible !== undefined) {
    if (typeof body.judgmentManagedOptionVisible !== 'boolean') {
      throw new Error('judgmentManagedOptionVisible must be boolean.');
    }
    update.judgmentManagedOptionVisible = body.judgmentManagedOptionVisible;
  }

  if (body.workspaceManifestPolicy !== undefined) {
    if (!isWorkspaceManifestPolicy(body.workspaceManifestPolicy)) {
      throw new Error('workspaceManifestPolicy must be one of "disabled", "one-approval", "auto".');
    }
    update.workspaceManifestPolicy = body.workspaceManifestPolicy;
  }

  if (body.crossHouseWorkerFallback !== undefined) {
    if (typeof body.crossHouseWorkerFallback !== 'boolean') {
      throw new Error('crossHouseWorkerFallback must be boolean.');
    }
    update.crossHouseWorkerFallback = body.crossHouseWorkerFallback;
  }

  if (body.orchestratorBackend !== undefined) {
    const raw = body.orchestratorBackend;
    // Single-source guard from defaults.ts — a hand-rolled list here silently
    // rejected the fable backend when Slice 1 widened the union (dogfood 2026-07-02).
    if (!isOrchestratorBackendSetting(raw)) {
      throw new Error('orchestratorBackend must be one of "auto", "codex", "claude", "openclaw", "hermes", "collide", "fable", "o8".');
    }
    update.orchestratorBackend = raw;
  }

  if (body.reviewerBackend !== undefined) {
    const raw = body.reviewerBackend;
    if (!isReviewerBackendSetting(raw)) {
      throw new Error('reviewerBackend must be one of "follow", "codex", "claude".');
    }
    update.reviewerBackend = raw;
  }

  if (body.packetExplainerEnabled !== undefined) {
    if (typeof body.packetExplainerEnabled !== 'boolean') {
      throw new Error('packetExplainerEnabled must be boolean.');
    }
    update.packetExplainerEnabled = body.packetExplainerEnabled;
  }

  if (body.quizGateEnabled !== undefined) {
    if (typeof body.quizGateEnabled !== 'boolean') {
      throw new Error('quizGateEnabled must be boolean.');
    }
    update.quizGateEnabled = body.quizGateEnabled;
  }

  if (body.buyinDocEnabled !== undefined) {
    if (typeof body.buyinDocEnabled !== 'boolean') {
      throw new Error('buyinDocEnabled must be boolean.');
    }
    update.buyinDocEnabled = body.buyinDocEnabled;
  }

  if (body.updateAutoApply !== undefined) {
    const raw = body.updateAutoApply;
    if (raw !== 'off' && raw !== 'idle') {
      throw new Error('updateAutoApply must be one of "off", "idle".');
    }
    update.updateAutoApply = raw;
  }

  if (body.collideAggregator !== undefined) {
    const raw = body.collideAggregator;
    if (!isCollideAggregator(raw)) {
      throw new Error('collideAggregator must be one of "auto", "claude", "codex".');
    }
    update.collideAggregator = raw;
  }

  if (body.productTelemetryEnabled !== undefined) {
    if (typeof body.productTelemetryEnabled !== 'boolean') {
      throw new Error('productTelemetryEnabled must be boolean.');
    }
    update.productTelemetryEnabled = body.productTelemetryEnabled;
  }

  if (body.telemetryConsentAnswered !== undefined) {
    if (typeof body.telemetryConsentAnswered !== 'boolean') {
      throw new Error('telemetryConsentAnswered must be boolean.');
    }
    if (
      body.telemetryConsentAnswered
      && (typeof body.productTelemetryEnabled !== 'boolean' || typeof body.crashReportsEnabled !== 'boolean')
    ) {
      throw new Error('Answering telemetry consent requires both productTelemetryEnabled and crashReportsEnabled.');
    }
    update.telemetryConsentAnswered = body.telemetryConsentAnswered;
  }

  if (body.telemetryOptIn !== undefined) {
    if (typeof body.telemetryOptIn !== 'boolean') {
      throw new Error('telemetryOptIn must be boolean.');
    }
    update.telemetryOptIn = body.telemetryOptIn;
  }

  if (body.telemetryIngestUrl !== undefined) {
    if (typeof body.telemetryIngestUrl !== 'string') {
      throw new Error('telemetryIngestUrl must be a string.');
    }
    update.telemetryIngestUrl = validateCredentialSafeUrl(body.telemetryIngestUrl, 'telemetryIngestUrl');
  }

  if (body.crashReportsEnabled !== undefined) {
    if (typeof body.crashReportsEnabled !== 'boolean') {
      throw new Error('crashReportsEnabled must be boolean.');
    }
    update.crashReportsEnabled = body.crashReportsEnabled;
  }

  if (body.branchPrefix !== undefined) {
    // Any string is accepted; the store sanitizes it to a branch-safe segment
    // and rejects a value that cleans to empty.
    if (typeof body.branchPrefix !== 'string') {
      throw new Error('branchPrefix must be a string.');
    }
    update.branchPrefix = body.branchPrefix;
  }

  if (body.commitAttributionEnabled !== undefined) {
    if (typeof body.commitAttributionEnabled !== 'boolean') {
      throw new Error('commitAttributionEnabled must be boolean.');
    }
    update.commitAttributionEnabled = body.commitAttributionEnabled;
  }

  if (body.prLinkDestination !== undefined) {
    if (!isPrLinkDestination(body.prLinkDestination)) {
      throw new Error('prLinkDestination must be "in-app" or "browser".');
    }
    update.prLinkDestination = body.prLinkDestination;
  }

  if (body.worktreeMaxCount !== undefined) {
    const raw = body.worktreeMaxCount;
    const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error('worktreeMaxCount must be a non-negative number (0 = unbounded).');
    }
    update.worktreeMaxCount = Math.floor(parsed);
  }

  if (body.worktreeMaxTotalGb !== undefined) {
    const raw = body.worktreeMaxTotalGb;
    const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error('worktreeMaxTotalGb must be a non-negative number (0 = unbounded).');
    }
    update.worktreeMaxTotalGb = parsed;
  }

  if (body.storageReserveRatio !== undefined) {
    const parsed = parseStorageReserveRatio(body.storageReserveRatio);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) update.storageReserveRatio = parsed;
  }

  if (body.storageReserveFloorGb !== undefined) {
    const parsed = typeof body.storageReserveFloorGb === 'number'
      ? body.storageReserveFloorGb
      : Number(body.storageReserveFloorGb);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 10000) update.storageReserveFloorGb = parsed;
  }

  if (body.workspaceParkingMode === 'manual' || body.workspaceParkingMode === 'pressure') {
    update.workspaceParkingMode = body.workspaceParkingMode;
  }

  const validateTier = (raw: unknown, name: string): OperatorDefaults['targetingTriage'] => {
    if (!raw || typeof raw !== 'object') throw new Error(`${name} must be an object { runtime, model, effort }.`);
    const o = raw as Record<string, unknown>;
    if (!isDispatchRuntime(o.runtime)) {
      throw new Error(`${name}.runtime must name a dispatchable runtime.`);
    }
    if (typeof o.model !== 'string') throw new Error(`${name}.model must be a string ('' = runtime default).`);
    if (!isThinkingEffort(o.effort)) throw new Error(`${name}.effort must be a valid thinking effort.`);
    return { runtime: o.runtime, model: o.model, effort: o.effort };
  };
  if (body.targetingTriage !== undefined) update.targetingTriage = validateTier(body.targetingTriage, 'targetingTriage');
  if (body.targetingAction !== undefined) update.targetingAction = validateTier(body.targetingAction, 'targetingAction');

  return update;
}

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  try {
    if (query.get('include') === 'presentation') {
      const { values } = await getOperatorDefaults();
      return response({ values: { presentationQuietMode: values.presentationQuietMode, notificationsReviewReady: values.notificationsReviewReady } });
    }
    if (query.get('include') === 'native') return response(await readNativeSettings());
    if (query.get('include') === 'setup-built-in') return response({ builtInAgent: await readBuiltInAgentRuntime() });
    if (query.get('refresh') === 'runtime') invalidateRuntimeAuthCache();
    if (query.get('include') === 'values') {
      const [data, settingsToml] = await Promise.all([
        getOperatorDefaults(),
        getOperatorDefaultsTomlState(),
      ]);
      return response(operatorDefaultsValuesPayload(data, settingsToml));
    }
    const [data, settingsToml, cliAuth] = await Promise.all([
      getOperatorDefaults(),
      getOperatorDefaultsTomlState(),
      getRuntimeAuthSnapshot(),
    ]);
    const dispatchableRuntimes = await getDispatchableRuntimeAvailability(cliAuth);
    if (query.get('include') === 'setup') {
      return response({ ...operatorDefaultsPayload(data, settingsToml, cliAuth, dispatchableRuntimes), ...await readOnboardingRuntimeSetup(data, dispatchableRuntimes) });
    }
    return response(operatorDefaultsPayload(data, settingsToml, cliAuth, dispatchableRuntimes));
  } catch (error) {
    console.error('[panel-operator-defaults] Failed to load operator defaults:', query.get('include') === 'native' ? 'Native settings unavailable.' : error);
    return response({ error: 'Failed to load operator defaults.' }, 500);
  }
}

export async function POST(request: Request) {
  const native = new URL(request.url).searchParams.get('include') === 'native';
  try {
    const body = await request.json().catch(() => null);
    if (!isRecord(body)) {
      return response({ error: 'Invalid request body.' }, 400);
    }
    const sourceUpdate = body.knowledgeSources ?? (typeof body.settingsToml === 'string' ? parseOperatorDefaultsToml(body.settingsToml).knowledgeSources : undefined);
    if ((sourceUpdate !== undefined || (body.settingsToml !== undefined && (await getOperatorDefaults()).values.knowledgeSources.length > 0)) && resolveRequestPrincipalContext(request).role !== 'operator') return response({ error: 'Knowledge sources require an operator credential.' }, 403);
    if (body.settingsToml !== undefined) {
      if (typeof body.settingsToml !== 'string') {
        return response({ error: 'settingsToml must be a string.' }, 400);
      }
      if (typeof body.settingsTomlRevision !== 'string' || !body.settingsTomlRevision) {
        return response({ error: 'settingsTomlRevision is required to save settings.toml.' }, 400);
      }
      if (native) body.settingsToml = await mergeNativeSettingsToml(body.settingsToml, body.settingsTomlRevision);
      assertRoutingTomlCompatibility(body.settingsToml as string, OPERATOR_DEFAULTS_FALLBACK);
      const tomlModel = parseOperatorDefaultsToml(body.settingsToml as string).threecodeWorkerModel;
      if (tomlModel) {
        await assertThreecodeWorkerModelAvailable(tomlModel);
      }
      const [updated, cliAuth] = await Promise.all([
        changeNextWindowPreference(parseOperatorDefaultsToml(body.settingsToml as string).experimentalNext ?? false, () => (
          withStoragePressurePolicyLock(() => applyOperatorDefaultsToml(body.settingsToml as string, body.settingsTomlRevision as string))
        )),
        getRuntimeAuthSnapshot(),
      ]);
      const [settingsToml, dispatchableRuntimes] = await Promise.all([
        getOperatorDefaultsTomlState(),
        getDispatchableRuntimeAvailability(cliAuth),
      ]);
      return response(native ? { ok: true } : operatorDefaultsPayload(updated, settingsToml, cliAuth, dispatchableRuntimes));
    }
    if (body.workerRuntimes !== undefined && !isWorkerRuntimeList(body.workerRuntimes)) {
      return response({ error: 'workerRuntimes must contain at least one dispatchable runtime.' }, 400);
    }
    const storageValidationError = workspaceStorageValidationError(body);
    if (storageValidationError) return response({ error: storageValidationError }, 400);

    const update = normalizeUpdate(body);
    if (Object.keys(update).length === 0) {
      return response({ error: 'No supported fields in request body.' }, 400);
    }
    if (update.threecodeWorkerModel) await assertThreecodeWorkerModelAvailable(update.threecodeWorkerModel);
    const [updated, cliAuth] = await Promise.all([
      changeNextWindowPreference(update.experimentalNext, () => withStoragePressurePolicyLock(() => native ? updateNativeSettings(update, body.settingsTomlRevision) : updateOperatorDefaults(update))),
      getRuntimeAuthSnapshot(),
    ]);
    const [settingsToml, dispatchableRuntimes] = await Promise.all([
      getOperatorDefaultsTomlState(),
      getDispatchableRuntimeAvailability(cliAuth),
    ]);
    return response(native ? { ok: true } : operatorDefaultsPayload(updated, settingsToml, cliAuth, dispatchableRuntimes));
  } catch (error) {
    const message = native ? (error instanceof SettingsTomlConflictError ? 'Settings changed. Reload before saving.' : 'Settings update refused. Check the declared settings and try again.') : error instanceof Error ? error.message : 'Failed to update operator defaults.';
    console.error('[panel-operator-defaults] Failed to update operator defaults:', message);
    return response({ error: message }, error instanceof SettingsTomlConflictError ? 409 : 400);
  }
}
