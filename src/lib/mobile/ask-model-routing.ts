import { MODEL_IDS } from '@/lib/models';

export const MOBILE_ASK_MODEL_IDS = [
  'auto',
  'claude-sonnet',
  'claude-haiku',
  'claude-opus',
  'claude-fable',
  'codex-terra-xhigh',
  'codex-astra-xhigh',
  'codex-sol-xhigh',
  'managed-free',
] as const;

export type MobileAskModelId = typeof MOBILE_ASK_MODEL_IDS[number];

export const MOBILE_ASK_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export type MobileAskEffort = typeof MOBILE_ASK_EFFORTS[number];

export interface MobileAskReadiness {
  claude: boolean;
  codex: boolean;
}

export interface MobileAskModel {
  id: MobileAskModelId;
  label: string;
  detail: string;
  available: boolean;
}

export type MobileAskRoute =
  | {
    kind: 'claude';
    requestedModel: 'auto' | keyof typeof CLAUDE_CLI_MODELS;
    cliModel: string;
    effort: MobileAskEffort;
  }
  | {
    kind: 'codex';
    requestedModel: 'auto' | keyof typeof CODEX_CLI_MODELS;
    cliModel: typeof MODEL_IDS.codexWorkerDefault | typeof MODEL_IDS.codexDefault | typeof MODEL_IDS.codexCliDefault;
    effort: MobileAskEffort;
  }
  | {
    kind: 'managed';
    requestedModel: MobileAskModelId;
    fallback: boolean;
  };

const MOBILE_ASK_MODEL_ID_SET = new Set<string>(MOBILE_ASK_MODEL_IDS);
const MOBILE_ASK_EFFORT_SET = new Set<string>(MOBILE_ASK_EFFORTS);

const CLAUDE_CLI_MODELS = {
  'claude-sonnet': MODEL_IDS.claudeQaDefault,
  'claude-haiku': MODEL_IDS.claudeHaikuQaDefault,
  // Opus 5 is already accepted as a Claude model hint by runtime routing, but
  // is intentionally not the repository-wide orchestrator default yet.
  'claude-opus': MODEL_IDS.raw.anthropicClaudeOpus5,
  'claude-fable': MODEL_IDS.raw.anthropicClaudeFable5,
} as const;

const CODEX_CLI_MODELS = {
  'codex-terra-xhigh': MODEL_IDS.codexWorkerDefault,
  'codex-astra-xhigh': MODEL_IDS.codexDefault,
  'codex-sol-xhigh': MODEL_IDS.codexCliDefault,
} as const;

const MODEL_COPY: Record<MobileAskModelId, Omit<MobileAskModel, 'id' | 'available'>> = {
  auto: {
    label: 'Auto',
    detail: 'Claude Sonnet 5, then Codex GPT-5.6 Terra, then managed free.',
  },
  'claude-sonnet': {
    label: 'Claude Sonnet 5',
    detail: 'Uses the signed-in Claude Code CLI on this desktop.',
  },
  'claude-haiku': {
    label: 'Claude Haiku 4.5',
    detail: 'Uses the signed-in Claude Code CLI on this desktop.',
  },
  'claude-opus': {
    label: 'Claude Opus 5',
    detail: 'Uses the signed-in Claude Code CLI on this desktop.',
  },
  'claude-fable': {
    label: 'Claude Fable',
    detail: 'Uses the signed-in Claude Code CLI on this desktop.',
  },
  'codex-terra-xhigh': {
    label: 'Codex GPT-5.6 Terra',
    detail: 'Uses the signed-in Codex CLI on this desktop.',
  },
  'codex-astra-xhigh': {
    label: 'Codex GPT-6 Astra',
    detail: 'Uses the signed-in Codex CLI on this desktop.',
  },
  'codex-sol-xhigh': {
    label: 'Codex GPT-6.1 Sol',
    detail: 'Uses the signed-in Codex CLI on this desktop.',
  },
  'managed-free': {
    label: 'Managed free',
    detail: 'Uses the o8 managed free inference tier.',
  },
};

/**
 * The phone can only select one of the public model ids. Unknown values are
 * treated as Auto so arbitrary upstream or CLI model names never cross the
 * desktop trust boundary.
 */
export function normalizeMobileAskModelId(value: unknown): MobileAskModelId {
  return typeof value === 'string' && MOBILE_ASK_MODEL_ID_SET.has(value)
    ? value as MobileAskModelId
    : 'auto';
}

/** Saved selections use the historical xhigh fallback for stale values. */
export function normalizeMobileAskEffort(value: unknown): MobileAskEffort {
  return typeof value === 'string' && MOBILE_ASK_EFFORT_SET.has(value)
    ? value as MobileAskEffort
    : 'xhigh';
}

/** Explicit request pins are validated separately from saved-selection migration. */
export function mobileAskEffortError(model: unknown, effort: unknown): string | null {
  if (effort === undefined) return null;
  if (typeof effort !== 'string' || !MOBILE_ASK_EFFORT_SET.has(effort)) {
    return 'effort must be low, medium, high, or xhigh when provided.';
  }
  if (normalizeMobileAskModelId(model) === 'claude-opus' && effort === 'low') {
    return 'The selected Ask model does not support low effort. Choose another effort or model.';
  }
  return null;
}

/**
 * Normalize a saved choice after a model change. The request boundary refuses
 * this unsupported low combination rather than silently migrating an explicit pin.
 */
export function resolveMobileAskEffort(
  model: MobileAskModelId,
  value: unknown,
): MobileAskEffort {
  const effort = normalizeMobileAskEffort(value);
  return model === 'claude-opus' && effort === 'low' ? 'medium' : effort;
}

export function buildMobileAskModelCatalog(readiness: MobileAskReadiness): {
  models: MobileAskModel[];
  defaultModel: MobileAskModelId;
} {
  const availability: Record<MobileAskModelId, boolean> = {
    auto: true,
    'claude-sonnet': readiness.claude,
    'claude-haiku': readiness.claude,
    'claude-opus': readiness.claude,
    'claude-fable': readiness.claude,
    'codex-terra-xhigh': readiness.codex,
    'codex-astra-xhigh': readiness.codex,
    'codex-sol-xhigh': readiness.codex,
    'managed-free': true,
  };
  const defaultModel: MobileAskModelId = readiness.claude
    ? 'claude-sonnet'
    : readiness.codex
      ? 'codex-terra-xhigh'
      : 'managed-free';

  return {
    models: MOBILE_ASK_MODEL_IDS.map((id) => ({
      id,
      ...MODEL_COPY[id],
      available: availability[id],
    })),
    defaultModel,
  };
}

export function resolveMobileAskRoute(
  requestedValue: unknown,
  readiness: MobileAskReadiness,
  requestedEffort?: unknown,
): MobileAskRoute {
  const requestedModel = normalizeMobileAskModelId(requestedValue);
  const effort = resolveMobileAskEffort(requestedModel, requestedEffort);

  if (requestedModel === 'managed-free') {
    return { kind: 'managed', requestedModel, fallback: false };
  }
  if (requestedModel === 'auto') {
    if (readiness.claude) {
      return {
        kind: 'claude',
        requestedModel,
        cliModel: MODEL_IDS.claudeQaDefault,
        effort,
      };
    }
    if (readiness.codex) {
      return {
        kind: 'codex',
        requestedModel,
        cliModel: MODEL_IDS.codexWorkerDefault,
        effort,
      };
    }
    return { kind: 'managed', requestedModel, fallback: true };
  }
  if (requestedModel in CLAUDE_CLI_MODELS) {
    if (!readiness.claude) {
      return { kind: 'managed', requestedModel, fallback: true };
    }
    return {
      kind: 'claude',
      requestedModel: requestedModel as keyof typeof CLAUDE_CLI_MODELS,
      cliModel: CLAUDE_CLI_MODELS[requestedModel as keyof typeof CLAUDE_CLI_MODELS],
      effort,
    };
  }
  if (!readiness.codex) {
    return { kind: 'managed', requestedModel, fallback: true };
  }
  return {
    kind: 'codex',
    requestedModel: requestedModel as keyof typeof CODEX_CLI_MODELS,
    cliModel: CODEX_CLI_MODELS[requestedModel as keyof typeof CODEX_CLI_MODELS],
    effort,
  };
}
