import { parseKnowledgeSources } from '@/lib/operator/knowledge-source-defaults';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parse, stringify } from 'smol-toml';

import { isPlausibleAcpModelId } from '@/lib/orchestrator/acp-model-id';
import { isPlausibleThreecodeModelId } from '@/lib/runtimes/threecode-model-catalogue';

import {
  CODEX_MODEL_IDS,
  isCodexModelId,
  isSupportedModelId,
  SUPPORTED_MODEL_IDS,
} from '@/lib/models';
import type { OperatorDefaults } from '@/lib/operator/defaults';
import { isBroadcastVoiceClockTime } from '@/lib/operator/broadcast-commentary-defaults';
import {
  isClassAComposer,
  isBrainRoutingMode,
  isCollideAggregator,
  isDispatchRuntime,
  isParallelCap,
  isOrchestratorBackendSetting,
  isPrLinkDestination,
  isReviewerBackendSetting,
  isWorkersUseBrain,
  isWorkspaceManifestPolicy,
  sanitizeBranchPrefix,
} from '@/lib/operator/defaults-env';
import { isJudgmentProvider, JUDGMENT_PROVIDER_VALUES_MESSAGE } from '@/lib/operator/judgment-default';
import { isJudgmentAllowance, isJudgmentBetaEndDate, JUDGMENT_ALLOWANCE_EXPECTED, JUDGMENT_BETA_END_DATE_EXPECTED } from '@/lib/operator/judgment-allowance-default';
import { isSubscriptionProfile } from '@/lib/operator/subscription-profile';
import { isTargetingTier } from '@/lib/operator/targeting-tier';
import { isWorkerStartMode } from '@/lib/operator/worker-start-mode';
import { isThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { AUTHENTICATED_ENDPOINT_GUIDANCE, credentialBearingUrlPart } from './credential-safe-url';
import { isExecutionCarrierId } from '@/lib/runtimes/shared/execution-carrier';

type TomlRecord = Record<string, unknown>;

interface TomlField<T> {
  path: readonly [string, ...string[]];
  parse: (value: unknown, key: string) => T;
  /**
   * How the value is written back to TOML, when that differs from `parse`.
   * TOML has no null, so a nullable field whose value is null would be dropped
   * by stringify and then vanish from the reparsed key set. Such fields
   * serialize null as "" and parse "" back to null.
   */
  serialize?: (value: T) => unknown;
}

function invalid(key: string, expected: string): never {
  throw new SettingsTomlValidationError(key, expected);
}

function booleanField(...path: [string, ...string[]]): TomlField<boolean> {
  return {
    path,
    parse: (value, tomlKey) => typeof value === 'boolean' ? value : invalid(tomlKey, 'a boolean'),
  };
}

function stringField(section: string, key: string, options: { nonEmpty?: boolean } = {}): TomlField<string> {
  return {
    path: [section, key],
    parse: (value, tomlKey) => {
      if (typeof value !== 'string') return invalid(tomlKey, 'a string');
      const trimmed = value.trim();
      if (options.nonEmpty && !trimmed) return invalid(tomlKey, 'a non-empty string');
      return trimmed;
    },
  };
}

function clockTimeField(section: string, key: string): TomlField<string> {
  return {
    path: [section, key],
    parse: (value, tomlKey) => isBroadcastVoiceClockTime(value)
      ? value
      : invalid(tomlKey, 'a local time in HH:MM format'),
  };
}

function orchestratorModelField(section: string, key: string): TomlField<OperatorDefaults['orchestratorModel']> {
  return {
    path: [section, key],
    parse: (value, tomlKey) => {
      if (typeof value !== 'string') return invalid(tomlKey, 'a supported model id string');
      const trimmed = value.trim();
      return isSupportedModelId(trimmed)
        ? trimmed
        : invalid(tomlKey, `a supported model id; received ${JSON.stringify(trimmed)}; valid values are ${SUPPORTED_MODEL_IDS.map((model) => JSON.stringify(model)).join(', ')}`);
    },
  };
}

function codexModelField(section: string, key: string): TomlField<OperatorDefaults['brainCodexModel']> {
  return {
    path: [section, key],
    parse: (value, tomlKey) => {
      if (typeof value !== 'string') return invalid(tomlKey, 'a supported Codex model id string');
      const trimmed = value.trim();
      return isCodexModelId(trimmed)
        ? trimmed
        : invalid(tomlKey, `a supported Codex model id; received ${JSON.stringify(trimmed)}; valid values are ${CODEX_MODEL_IDS.map((model) => JSON.stringify(model)).join(', ')}`);
    },
  };
}

/**
 * A DISCOVERED model id (opencode/ACP). Unlike orchestratorModelField this
 * cannot check membership in SUPPORTED_MODEL_IDS — the valid set lives in the
 * operator's agent, not in this repo — so it validates shape only. An empty
 * string means "no pin, use the agent's own default" and parses to null.
 */
function acpModelIdField(section: string, key: string): TomlField<string | null> {
  return {
    path: [section, key],
    // "" is the on-disk spelling of "unset" — see TomlField.serialize.
    serialize: (value) => value ?? '',
    parse: (value, tomlKey) => {
      if (value === null) return null;
      if (typeof value !== 'string') return invalid(tomlKey, 'a model id string');
      const trimmed = value.trim();
      if (!trimmed) return null;
      return isPlausibleAcpModelId(trimmed)
        ? trimmed
        : invalid(tomlKey, `a model id shaped provider/model, optionally with a /low or /high suffix; received ${JSON.stringify(trimmed)}`);
    },
  };
}

function threecodeModelIdField(section: string, key: string): TomlField<string | null> {
  return {
    path: [section, key],
    serialize: (value) => value ?? '',
    parse: (value, tomlKey) => {
      if (value === null) return null;
      if (typeof value !== 'string') return invalid(tomlKey, 'a configured 3code model id string');
      const trimmed = value.trim();
      if (!trimmed) return null;
      return isPlausibleThreecodeModelId(trimmed)
        ? trimmed
        : invalid(tomlKey, 'a configured 3code model id string');
    },
  };
}

function executionCarrierField(section: string, key: string): TomlField<OperatorDefaults['workerExecutionCarrier']> {
  return {
    path: [section, key],
    serialize: (value) => value ?? '',
    parse: (value, tomlKey) => value === '' || value === null
      ? null
      : isExecutionCarrierId(value) ? value : invalid(tomlKey, '"ori" or an empty string'),
  };
}

function credentialSafeUrlField(section: string, key: string): TomlField<string> {
  return {
    path: [section, key],
    parse: (value, tomlKey) => {
      if (typeof value !== 'string') return invalid(tomlKey, 'a string URL');
      const trimmed = value.trim();
      const part = credentialBearingUrlPart(trimmed);
      return part
        ? invalid(tomlKey, `a URL without credential-bearing ${part}; ${AUTHENTICATED_ENDPOINT_GUIDANCE}`)
        : trimmed;
    },
  };
}

function numberField(
  section: string,
  key: string,
  expected: string,
  accept: (value: number) => boolean,
  normalize: (value: number) => number = (value) => value,
): TomlField<number> {
  return {
    path: [section, key],
    parse: (value, tomlKey) => typeof value === 'number' && Number.isFinite(value) && accept(value)
      ? normalize(value)
      : invalid(tomlKey, expected),
  };
}

/** A nullable field whose null is written as "" (TOML has no null). */
function nullableField<T>(
  section: string,
  key: string,
  expected: string,
  predicate: (value: unknown) => value is T,
): TomlField<T | null> {
  return {
    path: [section, key],
    serialize: (value) => value ?? '',
    parse: (value, tomlKey) => value === '' || value === null
      ? null
      : predicate(value) ? value : invalid(tomlKey, `${expected} (write "" for null)`),
  };
}

function enumField<T>(
  section: string,
  key: string,
  expected: string,
  predicate: (value: unknown) => value is T,
): TomlField<T> {
  return {
    path: [section, key],
    parse: (value, tomlKey) => predicate(value) ? value : invalid(tomlKey, expected),
  };
}

function dispatchRuntimeListField(section: string, key: string): TomlField<OperatorDefaults['workerRuntimes']> {
  return {
    path: [section, key],
    parse: (value, tomlKey) => Array.isArray(value) && value.length > 0 && value.every(isDispatchRuntime)
      ? [...new Set(value)]
      : invalid(tomlKey, 'a non-empty array of dispatchable runtime names'),
  };
}

function branchPrefixField(section: string, key: string): TomlField<string> {
  return {
    path: [section, key],
    parse: (value, tomlKey) => {
      if (typeof value !== 'string') return invalid(tomlKey, 'a branch-safe string');
      const trimmed = value.trim();
      const sanitized = sanitizeBranchPrefix(trimmed);
      return sanitized && sanitized === trimmed
        ? trimmed
        : invalid(tomlKey, 'a non-empty branch-safe prefix');
    },
  };
}

function targetingTierField(section: string, key: string): TomlField<OperatorDefaults['targetingTriage']> {
  return {
    path: [section, key],
    parse: (value, tomlKey) => isTargetingTier(value)
      ? value
      : invalid(tomlKey, 'a table with dispatchable runtime, string model, and valid thinking effort'),
  };
}

/**
 * The exhaustive config-as-code contract. `satisfies` fails at compile time if
 * OperatorDefaults gains a key without a TOML mapping; the runtime coverage
 * test guards the same seam when this object is changed through untyped code.
 */
export const OPERATOR_DEFAULTS_TOML_MAPPING = {
  knowledgeSources: { path: ['brain', 'knowledge_sources'], parse: parseKnowledgeSources },
  subscriptionProfile: enumField('operator', 'subscription_profile', 'one of "both", "claude-only", or "codex-only"', isSubscriptionProfile),
  parallelCap: numberField('operator', 'parallel_cap', 'a positive safe integer', isParallelCap),
  meteredPacketCostCapUsd: numberField('operator', 'metered_packet_cost_cap_usd', 'a number greater than 0', (value) => value > 0),
  meteredPacketInputTokenCap: numberField('operator', 'metered_packet_input_token_cap', 'an integer greater than 0', (value) => Number.isInteger(value) && value > 0),
  uiLoopMaxIterations: numberField('uiLoop', 'max_iterations', 'an integer greater than 0', (value) => Number.isSafeInteger(value) && value > 0),
  uiLoopMaxMinutes: numberField('uiLoop', 'max_minutes', 'an integer greater than 0', (value) => Number.isSafeInteger(value) && value > 0),
  uiLoopMaxDiffBytes: numberField('uiLoop', 'max_diff_bytes', 'an integer greater than 0', (value) => Number.isSafeInteger(value) && value > 0),
  uiLoopMaxDiffFiles: numberField('uiLoop', 'max_diff_files', 'an integer greater than 0', (value) => Number.isSafeInteger(value) && value > 0),
  uiLoopPreviewTimeoutMs: numberField('uiLoop', 'preview_timeout_ms', 'an integer greater than 0', (value) => Number.isSafeInteger(value) && value > 0),
  overlapGate: enumField('operator', 'overlap_gate', '"advisory" or "strict"', (value): value is OperatorDefaults['overlapGate'] => value === 'advisory' || value === 'strict'),
  healBotEnabled: booleanField('operator', 'heal_bot_enabled'),
  supervisorAutoEscalate: booleanField('operator', 'supervisor_auto_escalate'),
  reviewContinuation: booleanField('review', 'continuation_enabled'),
  broadcastCommentary: enumField('broadcast', 'commentary', '"off" or "interval"', (value): value is OperatorDefaults['broadcastCommentary'] => value === 'off' || value === 'interval'),
  broadcastCommentaryIntervalMinutes: numberField('broadcast', 'interval_minutes', 'an integer from 1 through 1440', (value) => Number.isInteger(value) && value >= 1 && value <= 1_440),
  broadcastCommentaryMinNewEvents: numberField('broadcast', 'min_new_events', 'an integer from 1 through 100', (value) => Number.isInteger(value) && value >= 1 && value <= 100),
  broadcastCommentaryMaxPerHour: numberField('broadcast', 'max_per_hour', 'an integer from 1 through 60', (value) => Number.isInteger(value) && value >= 1 && value <= 60),
  broadcastVoice: enumField('broadcast', 'voice', '"off" or "on"', (value): value is OperatorDefaults['broadcastVoice'] => value === 'off' || value === 'on'),
  broadcastVoiceLullMinutes: numberField('broadcast', 'voice_lull_minutes', 'an integer from 1 through 1440', (value) => Number.isInteger(value) && value >= 1 && value <= 1_440),
  broadcastVoiceQuietHours: enumField('broadcast', 'voice_quiet_hours', '"off" or "on"', (value): value is OperatorDefaults['broadcastVoiceQuietHours'] => value === 'off' || value === 'on'),
  broadcastVoiceQuietStart: clockTimeField('broadcast', 'voice_quiet_start'),
  broadcastVoiceQuietEnd: clockTimeField('broadcast', 'voice_quiet_end'),
  broadcastVoiceAttention: booleanField('broadcast', 'voice_attention'),
  broadcastVoiceApprovals: booleanField('broadcast', 'voice_approvals'),
  broadcastVoiceReviews: booleanField('broadcast', 'voice_reviews'),
  broadcastVoiceFailures: booleanField('broadcast', 'voice_failures'),
  broadcastVoiceCompletions: booleanField('broadcast', 'voice_completions'),
  broadcastVoiceCalendar: booleanField('broadcast', 'voice_calendar'),
  broadcastVoiceCalendarLeadMinutes: numberField('broadcast', 'voice_calendar_lead_minutes', 'an integer from 1 through 1440', (value) => Number.isInteger(value) && value >= 1 && value <= 1_440),
  broadcastVoiceTimeCheckins: booleanField('broadcast', 'voice_time_checkins'),
  presentationQuietMode: booleanField('presentation', 'quiet_mode'),
  notificationsReviewReady: enumField('notifications', 'review_ready', '"off" or "on"', (value): value is OperatorDefaults['notificationsReviewReady'] => value === 'off' || value === 'on'),
  apfsDependencyImages: booleanField('git', 'apfs_dependency_images'),
  thinkingEffort: enumField('models', 'thinking_effort', 'a valid thinking effort', isThinkingEffort),
  promptCachingEnabled: booleanField('models', 'prompt_caching_enabled'),
  autoTitleInferenceEnabled: booleanField('chat', 'auto_title_inference_enabled'),
  mergeTestReplayEnabled: booleanField('review', 'merge_test_replay_enabled'),
  requireApproval: enumField('review', 'require_approval', 'one of "high-risk", "surface", "always", or "never"', (value): value is OperatorDefaults['requireApproval'] => value === 'high-risk' || value === 'surface' || value === 'always' || value === 'never'),
  orchestratorModel: orchestratorModelField('models', 'orchestrator_model'),
  opencodeOrchestratorModel: acpModelIdField('models', 'opencode_orchestrator_model'),
  opencodeWorkerModel: acpModelIdField('models', 'opencode_worker_model'),
  threecodeWorkerModel: threecodeModelIdField('models', 'threecode_worker_model'),
  defaultDispatchRuntime: enumField('models', 'default_dispatch_runtime', 'a dispatchable runtime name', isDispatchRuntime),
  workerExecutionCarrier: executionCarrierField('models', 'worker_execution_carrier'),
  workerStartMode: enumField('operator', 'worker_start_mode', 'one of "autonomous", "huddle", or "adaptive"', isWorkerStartMode),
  workerRuntimes: dispatchRuntimeListField('models', 'worker_runtimes'),
  codexWorkerEffort: enumField('models', 'codex_worker_effort', 'a valid thinking effort', isThinkingEffort),
  claudeWorkerEffort: enumField('models', 'claude_worker_effort', 'a valid thinking effort', isThinkingEffort),
  brainCodexModel: codexModelField('brain', 'codex_model'),
  brainCodexEffort: enumField('brain', 'codex_effort', 'a valid thinking effort', isThinkingEffort),
  defaultDispatchModel: stringField('models', 'default_dispatch_model'),
  localInferenceBaseUrl: credentialSafeUrlField('local_models', 'inference_base_url'),
  localEmbedModel: stringField('local_models', 'embed_model'),
  localChatModel: stringField('local_models', 'chat_model'),
  experimentalOpencode: booleanField('experimental', 'opencode_enabled'),
  experimentalGemini: booleanField('experimental', 'gemini_enabled'),
  experimentalChat: booleanField('experimental', 'chat_enabled'),
  experimentalCanvas: booleanField('experimental', 'canvas_enabled'),
  nativeBrowserView: booleanField('experimental', 'native_browser_view'),
  classAComposer: enumField('brain', 'class_a_composer', 'one of "auto", "haiku-cli", "sonnet-cli", or "fastest"', isClassAComposer),
  brainRoutingMode: enumField('brain', 'routing_mode', 'one of "auto" or "subscription"', isBrainRoutingMode),
  inAppOrchestratorEnabled: booleanField('orchestrator', 'legacy_claude_enabled'),
  symonVoiceSubscriptionOnly: booleanField('symon', 'voice', 'subscriptionOnly'),
  brainUseClaudeCli: booleanField('brain', 'use_claude_cli'),
  brainWarmupEnabled: booleanField('brain', 'warmup_enabled'),
  workersUseBrain: enumField('brain', 'workers_use_brain', 'one of "off", "auto", or "all"', isWorkersUseBrain),
  judgmentProvider: enumField('judgment', 'provider', JUDGMENT_PROVIDER_VALUES_MESSAGE, isJudgmentProvider),
  judgmentManagedDailyAllowance: nullableField('judgment', 'managed_daily_allowance', JUDGMENT_ALLOWANCE_EXPECTED, isJudgmentAllowance),
  judgmentBetaEndDate: nullableField('judgment', 'beta_end_date', JUDGMENT_BETA_END_DATE_EXPECTED, isJudgmentBetaEndDate),
  judgmentManagedOptionVisible: booleanField('judgment', 'managed_option_visible'),
  workspaceManifestPolicy: enumField('operator', 'workspace_manifest_policy', 'one of "disabled", "one-approval", or "auto"', isWorkspaceManifestPolicy),
  crossHouseWorkerFallback: booleanField('models', 'cross_house_worker_fallback'),
  codexAppThreads: booleanField('orchestrator', 'codex_app_threads'),
  orchestratorBackend: enumField('orchestrator', 'backend', 'a supported orchestrator backend', isOrchestratorBackendSetting),
  reviewerBackend: enumField('review', 'backend', 'one of "follow", "codex", or "claude"', isReviewerBackendSetting),
  packetExplainerEnabled: booleanField('review', 'packet_explainer_enabled'),
  quizGateEnabled: booleanField('review', 'quiz_gate_enabled'),
  buyinDocEnabled: booleanField('review', 'buyin_doc_enabled'),
  targetingTriage: targetingTierField('targeting', 'triage'),
  targetingAction: targetingTierField('targeting', 'action'),
  updateAutoApply: enumField('operator', 'update_auto_apply', '"off" or "idle"', (value): value is OperatorDefaults['updateAutoApply'] => value === 'off' || value === 'idle'),
  collideAggregator: enumField('orchestrator', 'collide_aggregator', 'one of "auto", "claude", or "codex"', isCollideAggregator),
  productTelemetryEnabled: nullableField('telemetry', 'product_enabled', 'a boolean', (value): value is boolean => typeof value === 'boolean'),
  telemetryConsentAnswered: booleanField('telemetry', 'consent_answered'),
  telemetryOptIn: booleanField('telemetry', 'crash_log_opt_in'),
  telemetryIngestUrl: credentialSafeUrlField('telemetry', 'ingest_url'),
  crashReportsEnabled: booleanField('telemetry', 'sentry_enabled'),
  branchPrefix: branchPrefixField('git', 'branch_prefix'),
  commitAttributionEnabled: booleanField('git', 'commit_attribution_enabled'),
  prLinkDestination: enumField('git', 'pr_link_destination', '"in-app" or "browser"', isPrLinkDestination),
  worktreeMaxCount: numberField('git', 'worktree_max_count', 'an integer between 0 and 1000', (value) => Number.isInteger(value) && value >= 0 && value <= 1000),
  worktreeMaxTotalGb: numberField('git', 'worktree_max_total_gb', 'a number between 0 and 10000', (value) => value >= 0 && value <= 10000),
  storageReserveRatio: numberField('git', 'storage_reserve_ratio', 'a number between 0 and 1', (value) => value >= 0 && value <= 1),
  storageReserveFloorGb: numberField('git', 'storage_reserve_floor_gb', 'a number greater than 0 and no more than 10000', (value) => value > 0 && value <= 10000),
  workspaceParkingMode: enumField('git', 'workspace_parking_mode', '"manual" or "pressure"', (value): value is OperatorDefaults['workspaceParkingMode'] => value === 'manual' || value === 'pressure'),
} satisfies { [K in keyof OperatorDefaults]: TomlField<OperatorDefaults[K]> };

export const OPERATOR_DEFAULTS_TOML_KEYS = Object.freeze(
  Object.keys(OPERATOR_DEFAULTS_TOML_MAPPING) as Array<keyof OperatorDefaults>,
);

const EXPLICIT_OPT_IN_FLAG_KEYS = [
  'broadcastCommentary',
  'broadcastVoice',
  'apfsDependencyImages',
  'mergeTestReplayEnabled',
  'packetExplainerEnabled',
  'quizGateEnabled',
  'buyinDocEnabled',
  'productTelemetryEnabled',
  'telemetryOptIn',
  'crashReportsEnabled',
] as const satisfies ReadonlyArray<keyof OperatorDefaults>;

/** Settings-backed feature switches whose off state can hide shipped behavior. */
export const OPERATOR_EXPERIMENTAL_OR_OPT_IN_FLAG_KEYS = Object.freeze([
  ...OPERATOR_DEFAULTS_TOML_KEYS.filter((key) => OPERATOR_DEFAULTS_TOML_MAPPING[key].path[0] === 'experimental'),
  ...EXPLICIT_OPT_IN_FLAG_KEYS,
].filter((key, index, keys) => keys.indexOf(key) === index));

export function getOperatorDefaultsTomlKey(key: keyof OperatorDefaults): string {
  return OPERATOR_DEFAULTS_TOML_MAPPING[key].path.join('.');
}

export class SettingsTomlParseError extends Error {
  constructor(message: string) {
    super(`settings.toml could not be parsed: ${message}`);
    this.name = 'SettingsTomlParseError';
  }
}

export class SettingsTomlValidationError extends Error {
  readonly key: string;

  constructor(key: string, expected: string) {
    super(`${key} expected ${expected}.`);
    this.name = 'SettingsTomlValidationError';
    this.key = key;
  }
}

function isRecord(value: unknown): value is TomlRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseDocument(raw: string): TomlRecord {
  try {
    const parsed = parse(raw);
    if (!isRecord(parsed)) throw new Error('the document root must be a table');
    return parsed;
  } catch (error) {
    if (error instanceof SettingsTomlParseError) throw error;
    const message = error instanceof Error ? error.message : 'unknown syntax error';
    throw new SettingsTomlParseError(message);
  }
}

function readPath(document: TomlRecord, field: TomlField<unknown>): unknown {
  let value: unknown = document;
  for (let index = 0; index < field.path.length; index += 1) {
    if (!isRecord(value)) invalid(field.path.slice(0, index).join('.'), 'a table');
    value = value[field.path[index]];
    if (value === undefined) return undefined;
  }
  return value;
}

function writePath(document: TomlRecord, field: TomlField<unknown>, value: unknown): void {
  let table = document;
  for (let index = 0; index < field.path.length - 1; index += 1) {
    const segment = field.path[index];
    const current = table[segment];
    if (current !== undefined && !isRecord(current)) {
      invalid(field.path.slice(0, index + 1).join('.'), 'a table');
    }
    const child = current ?? {};
    table[segment] = child;
    table = child as TomlRecord;
  }
  const key = field.path[field.path.length - 1];
  const existingValue = table[key];
  table[key] = isRecord(existingValue) && isRecord(value)
    ? { ...existingValue, ...value }
    : value;
}

export function parseOperatorDefaultsToml(raw: string): Partial<OperatorDefaults> {
  const document = parseDocument(raw);
  const values: Partial<OperatorDefaults> = {};

  for (const operatorKey of OPERATOR_DEFAULTS_TOML_KEYS) {
    // Double cast: `serialize` makes TomlField contravariant in T, so a direct
    // widening cast is (correctly) rejected. The loop only ever pairs a field
    // with its own key, so erasing the parameter type here is sound.
    const field = OPERATOR_DEFAULTS_TOML_MAPPING[operatorKey] as unknown as TomlField<unknown>;
    const rawValue = readPath(document, field);
    if (rawValue === undefined) continue;
    const tomlKey = field.path.join('.');
    (values as Record<string, unknown>)[operatorKey] = field.parse(rawValue, tomlKey);
  }

  return values;
}

/**
 * Re-parsing the existing document keeps every unknown key/table in the object
 * passed to smol-toml. smol-toml does not expose comment AST nodes, so comments
 * cannot survive a GUI-originated stringify; direct editor saves remain exact.
 */
export function serializeOperatorDefaultsToml(
  values: Partial<OperatorDefaults>,
  existingRaw?: string,
): string {
  const document = existingRaw === undefined ? {} : parseDocument(existingRaw);
  for (const operatorKey of OPERATOR_DEFAULTS_TOML_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(values, operatorKey)) continue;
    const field = OPERATOR_DEFAULTS_TOML_MAPPING[operatorKey] as unknown as TomlField<unknown>;
    const tomlKey = field.path.join('.');
    const parsed = field.parse(values[operatorKey], tomlKey);
    writePath(document, field, field.serialize ? field.serialize(parsed) : parsed);
  }
  return stringify(document);
}

/** A strict schema projection: unknown tables, nested fields and comments never leave the server. */
export function projectOperatorDefaultsToml(raw: string): { text: string; additionalSettingsSet: boolean } {
  const values = parseOperatorDefaultsToml(raw);
  for (const key of ['targetingTriage', 'targetingAction'] as const) {
    const tier = values[key];
    if (tier) values[key] = { runtime: tier.runtime, model: tier.model, effort: tier.effort };
  }
  const text = serializeOperatorDefaultsToml(values);
  const hasAdditional = (stored: unknown, declared: unknown): boolean => {
    if (!isRecord(stored)) return false;
    return Object.entries(stored).some(([key, value]) => !isRecord(declared)
      || !Object.hasOwn(declared, key) || hasAdditional(value, declared[key]));
  };
  return { text, additionalSettingsSet: hasAdditional(parseDocument(raw), parseDocument(text)) };
}

export async function writeFileAtomic(
  filePath: string,
  content: string,
  beforeRename?: () => Promise<void>,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx' });
    await beforeRename?.();
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}
