import { COMPOSER_MODE_DIRECTIVES } from '@/lib/orchestrator/composer-wire';
import { codexSupportsReasoningEffort } from '@/lib/codex/reasoning-effort';
import {
  isThinkingEffort,
  THINKING_EFFORT_LABELS,
  type ThinkingEffort,
} from '@/lib/orchestrator/thinking-effort';
import { parseLocalModel } from '@/lib/codex/local-model';
import { MODEL_IDS } from '@/lib/models';
import { getRuntimeCapability, type OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import {
  WORKER_START_OPTIONS,
  type WorkerStartMode,
} from '@/lib/operator/worker-start-mode';
import type { OrchestratorBackendSetting } from '../operator-defaults';

export const COMPOSER_SELECTOR_V1_STORAGE_KEY = 'o8:composer-selector-v1';
export const COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY = 'o8:orchestrator:thinking-effort-by-model';
export const COMPOSER_EFFORT_MIGRATION_STORAGE_KEY = `${COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY}:migrated`;
export const LEGACY_COMPOSER_EFFORT_STORAGE_KEY = 'o8:orchestrator:thinking-effort';

export type ComposerSelectorMode = 'solo' | 'multitask' | 'fast' | 'moa' | 'fusion';
export type ComposerEffortMap = Partial<Record<string, ThinkingEffort>>;
export type ComposerProviderMark = import('./provider-marks').ProviderMark;

export const COMPOSER_PROVIDER_MARK_TABLE = {
  leadModelFamilies: [
    { pattern: /^ollama:/i, mark: 'ollama' },
    { pattern: /deepseek/i, mark: 'deepseek' },
    { pattern: /(?:^|\/)gemini|google\//i, mark: 'gemini' },
    { pattern: /(?:^|\/)grok|x-ai\//i, mark: 'x' },
    { pattern: /(?:^|\/)claude|anthropic\//i, mark: 'anthropic' },
    { pattern: /(?:^|\/)gpt-|openai\//i, mark: 'openai' },
  ],
  leadBackends: {
    auto: 'terminal',
    codex: 'openai',
    claude: 'anthropic',
    openclaw: 'terminal',
    hermes: 'terminal',
    collide: 'terminal',
    fable: 'anthropic',
    o8: 'o8',
    opencode: 'opencode',
    pi: 'terminal',
    muse: 'terminal',
    acp: 'terminal',
  },
  workerRuntimes: {
    codex: 'openai',
    cloud: 'openai',
    'claude-code': 'anthropic',
    gemini: 'gemini',
    antigravity: 'antigravity',
    magnitude: 'terminal',
    opencode: 'opencode',
    'copilot-cli': 'copilot',
    crush: 'terminal',
    openhands: 'terminal',
    goose: 'terminal',
    qwen: 'terminal',
    qoder: 'terminal',
    kimi: 'terminal',
    aider: 'terminal',
    '3code': 'threecode',
    pi: 'pi',
    'pi-builtin': 'pi',
    cursor: 'cursor',
    grok: 'x',
    'prime-agent': 'terminal',
    'deepseek-harness': 'deepseek',
    hermes: 'terminal',
    muse: 'terminal',
  },
} as const satisfies {
  leadModelFamilies: readonly { pattern: RegExp; mark: ComposerProviderMark }[];
  leadBackends: Record<OrchestratorBackendSetting, ComposerProviderMark>;
  workerRuntimes: Record<OrchestratorRuntime, ComposerProviderMark>;
};

export function providerMarkForLead(
  backend: OrchestratorBackendSetting,
  modelId: string,
): ComposerProviderMark {
  return COMPOSER_PROVIDER_MARK_TABLE.leadModelFamilies
    .find(({ pattern }) => pattern.test(modelId))?.mark
    ?? COMPOSER_PROVIDER_MARK_TABLE.leadBackends[backend];
}

export function providerMarkForRuntime(runtime: OrchestratorRuntime): ComposerProviderMark {
  return COMPOSER_PROVIDER_MARK_TABLE.workerRuntimes[runtime];
}

export function composerRuntimeLabel(runtime: OrchestratorRuntime): string {
  return runtime === 'opencode' ? 'OpenCode' : getRuntimeCapability(runtime).label;
}

export function composerEffortConsequence(
  backend: OrchestratorBackendSetting,
  effort: ThinkingEffort,
): string {
  return THINKING_EFFORT_LABELS[effort].detail;
}

export function isHotComposerEffort(effort: ThinkingEffort): boolean {
  return effort === 'xhigh' || effort === 'max' || effort === 'ultra';
}

export interface ComposerSelectorModeSpec {
  id: ComposerSelectorMode;
  long: string;
  short: string;
  sublabel: string;
  placeholder: string;
  directive: string;
}

export const COMPOSER_SELECTOR_MODES: readonly ComposerSelectorModeSpec[] = [
  {
    id: 'solo',
    long: 'Solo',
    short: 'Solo',
    sublabel: 'Works alone, nothing is dispatched',
    placeholder: 'Ask anything · delegation is off',
    directive: COMPOSER_MODE_DIRECTIVES.solo,
  },
  {
    id: 'multitask',
    long: 'Worktrees',
    short: 'Worktrees',
    sublabel: 'Give delegated workers separate checkouts',
    placeholder: 'Ask anything · workers use isolated worktrees',
    directive: COMPOSER_MODE_DIRECTIVES.multitask,
  },
  {
    id: 'fast',
    long: 'Shared',
    short: 'Shared',
    sublabel: 'Workers share this checkout with separate file scopes',
    placeholder: 'Ask anything · workers share this checkout',
    directive: COMPOSER_MODE_DIRECTIVES.fast,
  },
  {
    id: 'moa',
    long: 'Compare plans',
    short: 'MoA',
    sublabel: 'Two independent plans, then synthesis and workers',
    placeholder: 'Two independent plans, then synthesis and workers…',
    directive: COMPOSER_MODE_DIRECTIVES.moa,
  },
  {
    id: 'fusion',
    long: 'Fusion',
    short: 'Fusion',
    sublabel: 'Sub-agents and every runtime’s workers, in parallel',
    placeholder: 'Sub-agents and every runtime’s workers, in parallel…',
    directive: COMPOSER_MODE_DIRECTIVES.fusion,
  },
];

/** Visible choices; the advanced execution modes remain available internally. */
export const VISIBLE_COMPOSER_SELECTOR_MODES = ['fast', 'multitask'] as const;

const BASE_EFFORTS: readonly ThinkingEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_RANK: Record<ThinkingEffort, number> = {
  low: 0,
  medium: 1,
  adaptive: 2,
  high: 3,
  xhigh: 4,
  max: 5,
  ultra: 6,
};

export interface ResolveComposerSelectorInput {
  mode: ComposerSelectorMode;
  leadModelId: string;
  leadModelLabel: string;
  leadBackend: OrchestratorBackendSetting;
  inSessionEffortByModel: ComposerEffortMap;
  threadEffortByModel: ComposerEffortMap;
  operatorDefaultEffort: ThinkingEffort;
  adaptiveEnabled: boolean;
  ultraEnabled?: boolean;
  inSessionSettings?: ComposerSelectorSettingState;
  threadSettings?: ComposerSelectorSettingState;
  operatorDefaultSettings?: ComposerSelectorSettingState;
  workerRuntimeLabel?: string;
  workerModelLabel?: string | null;
  clampNotice?: ComposerEffortClampNotice | null;
}

export interface ComposerSelectorSettingState {
  mode?: ComposerSelectorMode;
  workerRuntime?: OrchestratorRuntime;
  workerModel?: string | null;
  workerStartMode?: WorkerStartMode;
}

function resolveSelectorSetting<K extends keyof ComposerSelectorSettingState>(
  key: K,
  ...sources: Array<ComposerSelectorSettingState | undefined>
): ComposerSelectorSettingState[K] | undefined {
  for (const source of sources) {
    if (source && Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  }
  return undefined;
}

export interface ComposerEffortClampNotice {
  modelId: string;
  from: ThinkingEffort;
}

export interface ComposerLeadCatalogueOption {
  backend: OrchestratorBackendSetting;
  model?: string;
  value: string;
  label: string;
}

export interface ResolvedComposerSelectorState {
  mode: ComposerSelectorMode;
  modeLabel: string;
  modeShortLabel: string;
  modeSublabel: string;
  modeDirective: string;
  orchestrationMode: 'single' | 'fleet' | 'fusion';
  effort: ThinkingEffort;
  effortClampedFrom: ThinkingEffort | null;
  effortOptions: readonly ThinkingEffort[];
  lockedEffortOptions: readonly ThinkingEffort[];
  leadModelId: string;
  leadModelLabel: string;
  leadBackend: OrchestratorBackendSetting;
  workerRuntime: OrchestratorRuntime | null;
  workerRuntimeLabel: string;
  workerModel: string | null;
  workerModelLabel: string | null;
  workerStartMode: WorkerStartMode | null;
  workerStartModeLabel: string | null;
  workerStartModeShortLabel: string | null;
  atRestText: string;
  chipTitle: string;
}

export function readComposerSelectorV1Flag(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(COMPOSER_SELECTOR_V1_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

export function resolveEffectiveComposerLeadModelId(
  backend: OrchestratorBackendSetting | undefined,
  modelId: string | undefined,
  defaultDispatchModel?: string,
): string | undefined {
  const configuredModel = modelId?.trim();
  if (backend === 'codex') {
    if (configuredModel && !/^claude/i.test(configuredModel)) return configuredModel;
    const dispatchModel = defaultDispatchModel?.trim();
    return dispatchModel && parseLocalModel(dispatchModel) ? dispatchModel : MODEL_IDS.codexDefault;
  }
  return configuredModel || undefined;
}

export function resolveComposerLeadCatalogueLabel(
  backend: OrchestratorBackendSetting,
  modelId: string,
  fallbackLabel: string,
  options: readonly ComposerLeadCatalogueOption[],
): string {
  return options.find((option) => (
    option.backend === backend && (option.model ?? option.value) === modelId
  ))?.label ?? fallbackLabel;
}

export function composerSelectorModeSpec(mode: ComposerSelectorMode): ComposerSelectorModeSpec {
  return COMPOSER_SELECTOR_MODES.find((entry) => entry.id === mode) ?? COMPOSER_SELECTOR_MODES[0];
}

export function composerSupportsFastMode(backend: OrchestratorBackendSetting): boolean {
  // Both bundled lead IDs receive the thread-bound cortex delegation surface.
  // ACP-only leads do not yet carry that surface, so do not infer support from installation.
  return backend === 'codex' || backend === 'claude' || backend === 'fable'
    || backend === 'pi' || backend === 'o8';
}

export function defaultComposerMode(backend: OrchestratorBackendSetting = 'codex'): ComposerSelectorMode {
  return composerSupportsFastMode(backend) ? 'fast' : 'solo';
}

export function cycleComposerSelectorMode(
  mode: ComposerSelectorMode,
  direction = 1,
  backend?: OrchestratorBackendSetting,
): ComposerSelectorMode {
  const index = VISIBLE_COMPOSER_SELECTOR_MODES.findIndex(entry => entry === mode);
  if (index < 0) return !backend || composerSupportsFastMode(backend) ? 'fast' : 'multitask';
  for (let step = 1; step <= VISIBLE_COMPOSER_SELECTOR_MODES.length; step += 1) {
    const candidate = VISIBLE_COMPOSER_SELECTOR_MODES[
      (index + direction * step + VISIBLE_COMPOSER_SELECTOR_MODES.length * step) % VISIBLE_COMPOSER_SELECTOR_MODES.length
    ];
    if (candidate !== 'fast' || !backend || composerSupportsFastMode(backend)) return candidate;
  }
  return mode;
}

export function resolveComposerSelectorExecutionMode(mode: ComposerSelectorMode): 'single' | 'fleet' | 'fusion' {
  if (mode === 'solo') return 'single';
  if (mode === 'fusion') return 'fusion';
  return 'fleet';
}

export function supportedEffortsForLead(
  backend: OrchestratorBackendSetting,
  modelId: string,
  _adaptiveEnabled: boolean,
  ultraEnabled = false,
): readonly ThinkingEffort[] {
  // The o8 lead has one managed setting (#2999), so it offers no effort control (#3660).
  if (backend === 'o8') return [];
  if (backend !== 'claude' && backend !== 'fable' && backend !== 'codex' && backend !== 'auto') return [];
  // Adaptive is a provider thinking mode, not a manual effort level.
  const base = [...BASE_EFFORTS];
  const supportsUltra = backend === 'codex' && codexSupportsReasoningEffort(modelId, 'ultra');
  if (backend === 'codex') {
    const withoutUnsupported = base.filter((effort) => effort !== 'adaptive' && codexSupportsReasoningEffort(modelId, effort));
    return ultraEnabled && supportsUltra ? [...withoutUnsupported, 'ultra'] : withoutUnsupported;
  }
  return base;
}

export function clampEffortToLead(
  effort: ThinkingEffort,
  options: readonly ThinkingEffort[],
): { effort: ThinkingEffort; clampedFrom: ThinkingEffort | null } {
  if (options.length === 0) return { effort: 'adaptive', clampedFrom: effort === 'adaptive' ? null : effort };
  if (options.includes(effort)) return { effort, clampedFrom: null };
  const fallback = [...options].sort((left, right) => {
    const leftDistance = Math.abs(EFFORT_RANK[left] - EFFORT_RANK[effort]);
    const rightDistance = Math.abs(EFFORT_RANK[right] - EFFORT_RANK[effort]);
    return leftDistance - rightDistance || EFFORT_RANK[right] - EFFORT_RANK[left];
  })[0];
  return { effort: fallback, clampedFrom: effort };
}

export function resolveSupportedEffortChange(
  requested: ThinkingEffort,
  current: ThinkingEffort,
  supported: readonly ThinkingEffort[],
): { effort: ThinkingEffort; accepted: boolean } {
  if (supported.includes(requested)) return { effort: requested, accepted: true };
  if (supported.length === 0) return { effort: current, accepted: false };
  return { effort: clampEffortToLead(requested, supported).effort, accepted: false };
}

export function setModelEffort(
  efforts: ComposerEffortMap,
  modelId: string,
  effort: ThinkingEffort,
): ComposerEffortMap {
  return { ...efforts, [modelId]: effort };
}

export function resolveComposerSelectorState(input: ResolveComposerSelectorInput): ResolvedComposerSelectorState {
  const storedEffort = input.inSessionEffortByModel[input.leadModelId]
    ?? input.threadEffortByModel[input.leadModelId];
  // The o8 lead always sends Low; a saved effort from the old two-tier picker never applies.
  const requestedEffort = input.leadBackend === 'o8'
    ? 'low'
    : storedEffort ?? input.operatorDefaultEffort;
  const effortOptions = supportedEffortsForLead(
    input.leadBackend,
    input.leadModelId,
    input.adaptiveEnabled,
    input.ultraEnabled,
  );
  const lockedEffortOptions: readonly ThinkingEffort[] = [];
  const clamped = input.leadBackend === 'o8'
    ? { effort: 'low' as const, clampedFrom: null }
    : clampEffortToLead(requestedEffort, effortOptions);
  const effort = clamped.effort;
  const clampedFrom = clamped.clampedFrom
    ?? (input.clampNotice?.modelId === input.leadModelId ? input.clampNotice.from : null);
  const settingSources = [
    input.inSessionSettings,
    input.threadSettings,
    input.operatorDefaultSettings,
  ];
  const resolvedSettings = {
    mode: resolveSelectorSetting('mode', ...settingSources) ?? input.mode,
    workerRuntime: resolveSelectorSetting('workerRuntime', ...settingSources) ?? null,
    workerModel: resolveSelectorSetting('workerModel', ...settingSources) ?? null,
    workerStartMode: resolveSelectorSetting('workerStartMode', ...settingSources) ?? null,
  };
  const mode = composerSelectorModeSpec(resolvedSettings.mode === 'fast' && !composerSupportsFastMode(input.leadBackend)
    ? 'solo' : resolvedSettings.mode);
  const workerRuntimeLabel = resolvedSettings.workerRuntime
    ? composerRuntimeLabel(resolvedSettings.workerRuntime)
    : input.workerRuntimeLabel?.trim() || '';
  const workerModel = resolvedSettings.workerModel?.trim() || null;
  const workerModelLabel = workerModel
    ? workerModel.slice(workerModel.lastIndexOf('/') + 1)
    : input.workerModelLabel?.trim() || null;
  const workerStartOption = WORKER_START_OPTIONS.find((option) => (
    option.value === resolvedSettings.workerStartMode
  )) ?? null;
  const workerTail = workerModelLabel
    ? `${workerRuntimeLabel} · ${workerModelLabel}`
    : workerRuntimeLabel;
  const leadText = input.leadBackend === 'o8'
    ? input.leadModelLabel
    : `${input.leadModelLabel} · ${THINKING_EFFORT_LABELS[effort].short}`;
  const atRestText = `${leadText} / workers ${workerTail}`;
  return {
    mode: mode.id,
    modeLabel: mode.long,
    modeShortLabel: mode.short,
    modeSublabel: mode.sublabel,
    modeDirective: mode.directive,
    orchestrationMode: resolveComposerSelectorExecutionMode(mode.id),
    effort,
    effortClampedFrom: clampedFrom,
    effortOptions,
    lockedEffortOptions,
    leadModelId: input.leadModelId,
    leadModelLabel: input.leadModelLabel,
    leadBackend: input.leadBackend,
    workerRuntime: resolvedSettings.workerRuntime,
    workerRuntimeLabel,
    workerModel,
    workerModelLabel,
    workerStartMode: resolvedSettings.workerStartMode,
    workerStartModeLabel: workerStartOption?.long ?? null,
    workerStartModeShortLabel: workerStartOption?.short ?? null,
    atRestText,
    chipTitle: clampedFrom
      ? `${atRestText}. ${THINKING_EFFORT_LABELS[clampedFrom].long} is unsupported for ${input.leadModelLabel}; clamped to ${THINKING_EFFORT_LABELS[effort].long}.`
      : atRestText,
  };
}

function threadEffortStorageKey(threadId: string): string {
  return `${COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY}:thread:${threadId}`;
}

function readEffortMapAtKey(key: string): ComposerEffortMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, ThinkingEffort] => (
      Boolean(entry[0]) && isThinkingEffort(entry[1])
    )));
  } catch {
    return {};
  }
}

function writeEffortMapAtKey(key: string, efforts: ComposerEffortMap): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(efforts));
  } catch {
    // Storage is an optional preference seam; in-session state stays authoritative.
  }
}

export function readComposerEffortMaps(threadId: string | null, currentModelId: string): {
  global: ComposerEffortMap;
  thread: ComposerEffortMap;
} {
  const global = readEffortMapAtKey(COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY);
  if (!global[currentModelId] && typeof window !== 'undefined') {
    try {
      const migrated = window.localStorage.getItem(COMPOSER_EFFORT_MIGRATION_STORAGE_KEY) === '1';
      if (!migrated) {
        const legacy = window.localStorage.getItem(LEGACY_COMPOSER_EFFORT_STORAGE_KEY);
        if (isThinkingEffort(legacy)) {
          global[currentModelId] = legacy;
          writeEffortMapAtKey(COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY, global);
        }
        window.localStorage.setItem(COMPOSER_EFFORT_MIGRATION_STORAGE_KEY, '1');
      }
    } catch {
      // Ignore an unavailable migration source.
    }
  }
  return {
    global,
    thread: threadId ? readEffortMapAtKey(threadEffortStorageKey(threadId)) : {},
  };
}

export function writeComposerModelEffort(
  modelId: string,
  effort: ThinkingEffort,
  threadId: string | null,
): void {
  const global = setModelEffort(readEffortMapAtKey(COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY), modelId, effort);
  writeEffortMapAtKey(COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY, global);
  if (threadId) {
    const key = threadEffortStorageKey(threadId);
    writeEffortMapAtKey(key, setModelEffort(readEffortMapAtKey(key), modelId, effort));
  }
}

export function isComposerEffortShortcut(event: Pick<KeyboardEvent, 'altKey' | 'code' | 'key'>): boolean {
  return event.altKey && (event.code === 'KeyT' || event.key === 't' || event.key === 'T' || event.key === '†');
}

export function stepComposerEffort(
  current: ThinkingEffort,
  options: readonly ThinkingEffort[],
  direction: 1 | -1,
): ThinkingEffort {
  if (options.length === 0) return current;
  const index = Math.max(0, options.indexOf(current));
  return options[Math.max(0, Math.min(options.length - 1, index + direction))];
}
