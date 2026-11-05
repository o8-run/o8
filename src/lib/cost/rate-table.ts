export interface ModelRate {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheReadUsdPerMillion?: number;
  cacheWriteUsdPerMillion?: number;
  cacheWrite1hUsdPerMillion?: number;
  /** Every rate above, for a request whose prompt passes `aboveTokens`. */
  longPrompt?: { aboveTokens: number } & Omit<ModelRate, 'longPrompt'>;
}

export interface ModelRateTable {
  rateTableVersion: string;
  observedOn: `${number}-${number}-${number}`;
  rates: Record<string, ModelRate>;
}

/**
 * Original rates were consolidated on 2026-08-28. Opus 5.5 and Fable 5.1
 * were added from https://platform.claude.com/docs/en/about-claude/pricing
 * on 2026-09-26. GPT-6.1 Sol was added on 2026-09-29 (#2950).
 * Sonnet 5.5 and Haiku 5.5 were added, and Sonnet 5 and Haiku 4.5 corrected,
 * from the same page on 2026-11-05. This does not claim the other entries
 * were refreshed.
 */
export const modelRateTable = {
  rateTableVersion: '2026-11-05.1',
  observedOn: '2026-11-05',
  rates: {
    'claude-opus-5-5': {
      inputUsdPerMillion: 4,
      outputUsdPerMillion: 20,
      cacheReadUsdPerMillion: 0.2,
      cacheWriteUsdPerMillion: 5,
      cacheWrite1hUsdPerMillion: 8,
    },
    'claude-fable-5-1': {
      inputUsdPerMillion: 10,
      outputUsdPerMillion: 50,
      cacheReadUsdPerMillion: 0.25,
      cacheWriteUsdPerMillion: 12.5,
      cacheWrite1hUsdPerMillion: 20,
    },
    'claude-opus-4-8': {
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 25,
      cacheReadUsdPerMillion: 0.5,
      cacheWriteUsdPerMillion: 6.25,
      cacheWrite1hUsdPerMillion: 10,
    },
    'claude-opus-4-8-fast': {
      inputUsdPerMillion: 30,
      outputUsdPerMillion: 150,
      cacheReadUsdPerMillion: 3,
      cacheWriteUsdPerMillion: 37.5,
      cacheWrite1hUsdPerMillion: 60,
    },
    'claude-opus-4-7': {
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 25,
      cacheReadUsdPerMillion: 0.5,
      cacheWriteUsdPerMillion: 6.25,
      cacheWrite1hUsdPerMillion: 10,
    },
    'claude-opus-4-7-fast': {
      inputUsdPerMillion: 30,
      outputUsdPerMillion: 150,
      cacheReadUsdPerMillion: 3,
      cacheWriteUsdPerMillion: 37.5,
      cacheWrite1hUsdPerMillion: 60,
    },
    'claude-opus-4-6': {
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 25,
      cacheReadUsdPerMillion: 0.5,
      cacheWriteUsdPerMillion: 6.25,
      cacheWrite1hUsdPerMillion: 10,
    },
    'claude-opus-4-6-fast': {
      inputUsdPerMillion: 30,
      outputUsdPerMillion: 150,
      cacheReadUsdPerMillion: 3,
      cacheWriteUsdPerMillion: 37.5,
      cacheWrite1hUsdPerMillion: 60,
    },
    'claude-sonnet-5-5': {
      inputUsdPerMillion: 2,
      outputUsdPerMillion: 10,
      cacheReadUsdPerMillion: 0.1,
      cacheWriteUsdPerMillion: 2.5,
      cacheWrite1hUsdPerMillion: 4,
    },
    'claude-sonnet-5': {
      inputUsdPerMillion: 2,
      outputUsdPerMillion: 10,
      cacheReadUsdPerMillion: 0.2,
      cacheWriteUsdPerMillion: 2.5,
      cacheWrite1hUsdPerMillion: 4,
    },
    'claude-sonnet-4-6': {
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 15,
      cacheReadUsdPerMillion: 0.3,
      cacheWriteUsdPerMillion: 3.75,
      cacheWrite1hUsdPerMillion: 6,
    },
    'claude-sonnet-4-5': {
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 15,
      cacheReadUsdPerMillion: 0.3,
      cacheWriteUsdPerMillion: 3.75,
      cacheWrite1hUsdPerMillion: 6,
    },
    // A prompt's length counts every input token, cache reads and writes included.
    'claude-haiku-5-5': {
      inputUsdPerMillion: 0.1,
      outputUsdPerMillion: 0.5,
      cacheReadUsdPerMillion: 0.01,
      cacheWriteUsdPerMillion: 0.125,
      cacheWrite1hUsdPerMillion: 0.2,
      longPrompt: {
        aboveTokens: 100_000,
        inputUsdPerMillion: 0.5,
        outputUsdPerMillion: 2.5,
        cacheReadUsdPerMillion: 0.05,
        cacheWriteUsdPerMillion: 0.625,
        cacheWrite1hUsdPerMillion: 1,
      },
    },
    'claude-haiku-4-5': {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 5,
      cacheReadUsdPerMillion: 0.1,
      cacheWriteUsdPerMillion: 1.25,
      cacheWrite1hUsdPerMillion: 2,
    },
    'gpt-6.1-sol': {
      inputUsdPerMillion: 2,
      outputUsdPerMillion: 10,
      cacheReadUsdPerMillion: 0.1,
      cacheWriteUsdPerMillion: 2.5,
    },
    'gpt-5.6-sol': {
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 30,
      cacheReadUsdPerMillion: 0.5,
    },
    'gpt-5.6-terra': {
      inputUsdPerMillion: 2.5,
      outputUsdPerMillion: 15,
      cacheReadUsdPerMillion: 0.25,
    },
    'gpt-5.6-luna': {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 6,
      cacheReadUsdPerMillion: 0.1,
    },
    'gpt-5.5': {
      inputUsdPerMillion: 2.5,
      outputUsdPerMillion: 15,
      cacheReadUsdPerMillion: 0.25,
    },
    'gpt-5.4-mini': {
      inputUsdPerMillion: 0.75,
      outputUsdPerMillion: 4.5,
      cacheReadUsdPerMillion: 0.075,
    },
    'gpt-5.4-nano': {
      inputUsdPerMillion: 0.2,
      outputUsdPerMillion: 1.25,
      cacheReadUsdPerMillion: 0.02,
    },
    'gpt-5.4': {
      inputUsdPerMillion: 2.5,
      outputUsdPerMillion: 15,
      cacheReadUsdPerMillion: 0.25,
    },
    'gpt-5.2-pro': {
      inputUsdPerMillion: 21,
      outputUsdPerMillion: 168,
      cacheReadUsdPerMillion: 2.1,
    },
    'gpt-5.2-codex': {
      inputUsdPerMillion: 1.5,
      outputUsdPerMillion: 6,
      cacheReadUsdPerMillion: 0.15,
    },
    'gpt-5.2': {
      inputUsdPerMillion: 2,
      outputUsdPerMillion: 8,
      cacheReadUsdPerMillion: 0.2,
    },
    'gemini-3-pro': {
      inputUsdPerMillion: 1.25,
      outputUsdPerMillion: 10,
      cacheReadUsdPerMillion: 0.3125,
    },
    'gemini-2-5-pro': {
      inputUsdPerMillion: 1.25,
      outputUsdPerMillion: 10,
      cacheReadUsdPerMillion: 0.3125,
    },
    'gemini-2-5-flash': {
      inputUsdPerMillion: 0.075,
      outputUsdPerMillion: 0.30,
      cacheReadUsdPerMillion: 0.019,
    },
    'gemini-1-5-flash': {
      inputUsdPerMillion: 0.075,
      outputUsdPerMillion: 0.30,
      cacheReadUsdPerMillion: 0.019,
    },
    'cursor-agent': {
      inputUsdPerMillion: 1.25,
      outputUsdPerMillion: 10,
      cacheWriteUsdPerMillion: 1.25,
    },
    'opencode/gpt-5-nano': { inputUsdPerMillion: 0.05, outputUsdPerMillion: 0.20 },
    'opencode/gpt-5-mini': { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.60 },
    'opencode/gpt-5': { inputUsdPerMillion: 1.0, outputUsdPerMillion: 4.0 },
    'anthropic/claude-sonnet-4-20250514': { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
    'anthropic/claude-haiku-4-20250514': { inputUsdPerMillion: 0.8, outputUsdPerMillion: 4 },
    'anthropic/claude-opus-4-20250514': { inputUsdPerMillion: 15, outputUsdPerMillion: 75 },
    'google/gemini-2.5-pro': { inputUsdPerMillion: 1.25, outputUsdPerMillion: 10 },
    'google/gemini-2.5-flash': { inputUsdPerMillion: 0.075, outputUsdPerMillion: 0.30 },
    'openai/gpt-4o': { inputUsdPerMillion: 2.5, outputUsdPerMillion: 10 },
    'openai/gpt-4o-mini': { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.60 },
    'openai/gpt-5-nano': { inputUsdPerMillion: 0.05, outputUsdPerMillion: 0.20 },
    'openrouter/anthropic/claude-haiku': { inputUsdPerMillion: 0.8, outputUsdPerMillion: 4 },
    'openrouter/anthropic/claude-sonnet': { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
    'brain/openai/gpt-6-luna': { inputUsdPerMillion: 0.10, outputUsdPerMillion: 0.50 },
    'brain/google/gemini-2.5-flash-lite': { inputUsdPerMillion: 0.10, outputUsdPerMillion: 0.40 },
    'brain/openai/gpt-5.4-nano': { inputUsdPerMillion: 0.20, outputUsdPerMillion: 1.25 },
    'brain/x-ai/grok-4.3': { inputUsdPerMillion: 1.25, outputUsdPerMillion: 2.50 },
  },
} as const satisfies ModelRateTable;

export type ResolvedRate = ModelRate & { modelKey: string };

/** The rates for one request: a model's long-prompt rates once its prompt passes their threshold. */
export function requestRate(rate: ResolvedRate, promptTokens: number): ResolvedRate {
  const long = rate.longPrompt;
  if (!long || promptTokens <= long.aboveTokens) return rate;
  const { aboveTokens: _threshold, ...rates } = long;
  return { ...rates, longPrompt: long, modelKey: rate.modelKey };
}

/** Codex usage includes cached input in inputTokens; the surcharge is per request. */
export function codexUsageCostUsd(rate: ResolvedRate, usage: {
  inputTokens: number; cachedInputTokens: number; outputTokens: number;
}): number {
  const longContext = usage.inputTokens > 272_000
    && ['gpt-6.1-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5', 'gpt-5.4'].includes(rate.modelKey);
  const cached = Math.min(usage.inputTokens, usage.cachedInputTokens);
  return ((usage.inputTokens - cached) * rate.inputUsdPerMillion * (longContext ? 2 : 1)
    + cached * (rate.cacheReadUsdPerMillion ?? 0) * (longContext ? 2 : 1)
    + usage.outputTokens * rate.outputUsdPerMillion * (longContext ? 1.5 : 1)) / 1_000_000;
}

function resolved(modelKey: keyof typeof modelRateTable.rates): ResolvedRate {
  return { modelKey, ...modelRateTable.rates[modelKey] };
}

function resolveAnthropicRate(model: string): ResolvedRate | null {
  const normalized = model.trim().toLowerCase();
  if (!normalized || normalized === '<synthetic>') return null;
  const fast = normalized.includes('fast');
  if (normalized.includes('opus-5-5')) return fast ? null : resolved('claude-opus-5-5');
  if (normalized.includes('fable-5-1')) return fast ? null : resolved('claude-fable-5-1');
  if (normalized.includes('opus-4-8')) return resolved(fast ? 'claude-opus-4-8-fast' : 'claude-opus-4-8');
  if (normalized.includes('opus-4-7')) return resolved(fast ? 'claude-opus-4-7-fast' : 'claude-opus-4-7');
  if (normalized.includes('opus-4-6')) return resolved(fast ? 'claude-opus-4-6-fast' : 'claude-opus-4-6');
  if (normalized.includes('sonnet-5-5')) return resolved('claude-sonnet-5-5');
  if (normalized.includes('sonnet-5')) return resolved('claude-sonnet-5');
  if (normalized.includes('sonnet-4-6')) return resolved('claude-sonnet-4-6');
  if (normalized.includes('sonnet-4-5') || normalized.includes('sonnet-4')) return resolved('claude-sonnet-4-5');
  if (normalized.includes('haiku-5-5')) return resolved('claude-haiku-5-5');
  if (normalized.includes('haiku-4-5') || normalized.includes('haiku')) return resolved('claude-haiku-4-5');
  return null;
}

function resolveCodexRate(model: string): ResolvedRate | null {
  const normalized = model.trim().toLowerCase();
  if (normalized.includes('gpt-6.1-sol')) return resolved('gpt-6.1-sol');
  if (normalized.includes('gpt-5.6-sol')) return resolved('gpt-5.6-sol');
  if (normalized.includes('gpt-5.6-terra')) return resolved('gpt-5.6-terra');
  if (normalized.includes('gpt-5.6-luna')) return resolved('gpt-5.6-luna');
  if (normalized.includes('gpt-5.5')) return resolved('gpt-5.5');
  if (normalized.includes('gpt-5.4-mini')) return resolved('gpt-5.4-mini');
  if (normalized.includes('gpt-5.4-nano')) return resolved('gpt-5.4-nano');
  if (normalized.includes('gpt-5.4')) return resolved('gpt-5.4');
  if (normalized.includes('gpt-5.2-pro')) return resolved('gpt-5.2-pro');
  if (normalized.includes('gpt-5.2-codex')) return resolved('gpt-5.2-codex');
  if (normalized.includes('gpt-5.2')) return resolved('gpt-5.2');
  return null;
}

function resolveGeminiRate(model: string): ResolvedRate {
  const normalized = model.trim().toLowerCase();
  if (/gemini-3(?:[.-]\d+)?-pro/i.test(normalized)) return resolved('gemini-3-pro');
  if (/gemini-2[.-]5-pro/i.test(normalized)) return resolved('gemini-2-5-pro');
  if (/gemini-2[.-]5-flash/i.test(normalized)) return resolved('gemini-2-5-flash');
  if (/gemini-1[.-]5-flash/i.test(normalized)) return resolved('gemini-1-5-flash');
  // This parser intentionally falls back to the pessimistic Pro rate.
  return resolved('gemini-3-pro');
}

function resolveOpenCodeRate(model: string): ResolvedRate | null {
  if (!Object.hasOwn(modelRateTable.rates, model) || model.startsWith('brain/')) return null;
  const allowed = new Set([
    'opencode/gpt-5-nano',
    'opencode/gpt-5-mini',
    'opencode/gpt-5',
    'anthropic/claude-sonnet-4-20250514',
    'anthropic/claude-haiku-4-20250514',
    'anthropic/claude-opus-4-20250514',
    'google/gemini-2.5-pro',
    'google/gemini-2.5-flash',
    'openai/gpt-4o',
    'openai/gpt-4o-mini',
    'openai/gpt-5-nano',
    'openrouter/anthropic/claude-haiku',
    'openrouter/anthropic/claude-sonnet',
  ]);
  return allowed.has(model) ? resolved(model as keyof typeof modelRateTable.rates) : null;
}

function resolveBrainRate(model: string): ResolvedRate {
  const key = `brain/${model}`;
  if (Object.hasOwn(modelRateTable.rates, key)) {
    return resolved(key as keyof typeof modelRateTable.rates);
  }
  // The Brain intentionally falls back to the priciest seeded chain entry.
  return resolved('brain/x-ai/grok-4.3');
}

/**
 * Provider-specific lookup preserves each former parser fallback:
 * Claude/Codex/OpenCode return null for unknown models, Gemini uses Pro,
 * Cursor always uses its fixed estimate, and the Brain uses its worst case.
 */
export function resolveRate(provider: string, model: string | null | undefined): ResolvedRate | null {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = model ?? '';
  if (normalizedProvider === 'anthropic' || normalizedProvider === 'claude-code') {
    return resolveAnthropicRate(normalizedModel);
  }
  if (normalizedProvider === 'openai' || normalizedProvider === 'codex') {
    return resolveCodexRate(normalizedModel);
  }
  if (normalizedProvider === 'google' || normalizedProvider === 'gemini') {
    return resolveGeminiRate(normalizedModel);
  }
  if (normalizedProvider === 'cursor') return resolved('cursor-agent');
  if (normalizedProvider === 'opencode') return resolveOpenCodeRate(normalizedModel);
  if (normalizedProvider === 'brain' || normalizedProvider === 'openrouter') return resolveBrainRate(normalizedModel);
  return null;
}
