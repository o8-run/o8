import { describe, expect, it } from 'vitest';
import { modelRateTable } from '@/lib/cost/rate-table';
import { createBundledRateTable } from './bundled-rates';
import { parseRateTable, priceUsage, type PricedRecord, type RateTable } from './history-readers/usagePricing';
import { parseClaudeRecord } from './history-readers/usageTranscripts';

// LiteLLM's published Claude Haiku 5.5 and Sonnet 5.5 rates (USD per token), as in
// model_prices_and_context_window.json on 2026-11-06, cost fields only.
const litellm = {
  'claude-haiku-5-5': {
    input_cost_per_token: 1e-7, output_cost_per_token: 5e-7,
    cache_read_input_token_cost: 1e-8, cache_creation_input_token_cost: 1.25e-7,
    cache_creation_input_token_cost_above_1hr: 2e-7,
    input_cost_per_token_above_100k_tokens: 5e-7, output_cost_per_token_above_100k_tokens: 2.5e-6,
    cache_read_input_token_cost_above_100k_tokens: 5e-8,
    cache_creation_input_token_cost_above_100k_tokens: 6.25e-7,
    cache_creation_input_token_cost_above_1hr_above_100k_tokens: 1e-6,
  },
  'claude-sonnet-5-5': {
    input_cost_per_token: 2e-6, output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1e-7, cache_creation_input_token_cost: 2.5e-6,
    cache_creation_input_token_cost_above_1hr: 4e-6,
  },
  // A 1M-window model LiteLLM still lists with a 200K tier; Anthropic bills
  // Claude 4.6 and later at standard rates across the window.
  'claude-sonnet-4-6': {
    input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5,
    input_cost_per_token_above_200k_tokens: 6e-6, output_cost_per_token_above_200k_tokens: 2.25e-5,
  },
};

const record = (model: string, totals: Partial<PricedRecord['totals']>, oneHour?: number): PricedRecord => ({
  model, speed: 'standard', reportedCostUsd: null,
  totals: { uncachedInputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0, ...totals },
  ...(oneHour === undefined ? {} : { cacheCreation1hTokens: oneHour }),
});
const cost = (table: RateTable, priced: PricedRecord) => priceUsage(table, priced).costUsd;
// Per million tokens, as the pricing page states them.
const usd = (millions: Record<string, [tokens: number, rate: number]>) =>
  Object.values(millions).reduce((sum, [tokens, rate]) => sum + tokens * rate / 1_000_000, 0);

describe.each([
  ['LiteLLM snapshot', () => parseRateTable(litellm)],
  ['bundled rates', () => createBundledRateTable(modelRateTable.rates)],
])('usage history pricing tiers (%s)', (_, table) => {
  it('bills a Haiku 5.5 prompt over 100,000 tokens at the long-prompt rates', () => {
    const at = (uncached: number) => cost(table(), record('claude-haiku-5-5',
      { uncachedInputTokens: uncached, cachedInputTokens: 40_000, cacheCreationTokens: 10_000, outputTokens: 2_000 }));
    expect(at(50_000)).toBeCloseTo(usd({ input: [50_000, 0.1], read: [40_000, 0.01], write: [10_000, 0.125], output: [2_000, 0.5] }), 12);
    expect(at(50_001)).toBeCloseTo(usd({ input: [50_001, 0.5], read: [40_000, 0.05], write: [10_000, 0.625], output: [2_000, 2.5] }), 12);
  });

  it('bills 1-hour cache writes at the 1-hour rate', () => {
    const write = (model: string, oneHour?: number) => cost(table(), record(model, { cacheCreationTokens: 10_000 }, oneHour));
    expect(write('claude-sonnet-5-5', 4_000)).toBeCloseTo(usd({ m5: [6_000, 2.5], h1: [4_000, 4] }), 12);
    expect(write('claude-sonnet-5-5')).toBeCloseTo(usd({ m5: [10_000, 2.5] }), 12);
    // Haiku 5.5 over 100,000 tokens: the long prompt's 1-hour rate.
    expect(cost(table(), record('claude-haiku-5-5', { uncachedInputTokens: 95_000, cacheCreationTokens: 10_000 }, 10_000)))
      .toBeCloseTo(usd({ input: [95_000, 0.5], h1: [10_000, 1] }), 12);
  });
});

describe('usage history pricing tiers', () => {
  it('leaves LiteLLM tiers other than 100K unpriced, since Claude 4.6+ bills its 1M window at standard rates', () => {
    expect(cost(parseRateTable(litellm), record('claude-sonnet-4-6', { uncachedInputTokens: 300_000, outputTokens: 1_000 })))
      .toBeCloseTo(usd({ input: [300_000, 3], output: [1_000, 15] }), 12);
  });

  it('bundled rates price fast mode from the -fast entries', () => {
    const fast = { ...record('claude-opus-5-5', { uncachedInputTokens: 1_000_000, outputTokens: 1_000_000 }), speed: 'fast' as const };
    const priced = priceUsage(createBundledRateTable(modelRateTable.rates), fast);
    expect(priced.costUsd).toBeCloseTo(8 + 40, 9);
    expect(priced.speedPremiumUsd).toBeCloseTo(48 - (4 + 20), 9);
  });

  it('reads the 1-hour share of a Claude Code cache write', () => {
    const line = (cacheCreation?: object) => parseClaudeRecord({
      type: 'assistant', timestamp: '2026-11-05T12:00:00Z', sessionId: 's', requestId: 'r',
      message: { id: 'm', model: 'claude-sonnet-5-5', usage: {
        input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 10_000, output_tokens: 5,
        ...(cacheCreation ? { cache_creation: cacheCreation } : {}),
      } },
    });
    expect(line({ ephemeral_5m_input_tokens: 6_000, ephemeral_1h_input_tokens: 4_000 })?.cacheCreation1hTokens).toBe(4_000);
    expect(line({ ephemeral_5m_input_tokens: 10_000, ephemeral_1h_input_tokens: 0 })).not.toHaveProperty('cacheCreation1hTokens');
    expect(line()).not.toHaveProperty('cacheCreation1hTokens');
  });
});
