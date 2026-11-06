import type { ModelRate as BundledRate } from '@/lib/cost/rate-table';
import type { ModelRate, RateTable, TokenRates } from './history-readers/usagePricing';

const perToken = (usdPerMillion: number) => usdPerMillion / 1_000_000;

function tokenRates(rate: Omit<BundledRate, 'longPrompt'>): TokenRates {
  const cacheWrite = rate.cacheWriteUsdPerMillion ?? rate.inputUsdPerMillion;
  return {
    inputCostPerToken: perToken(rate.inputUsdPerMillion),
    outputCostPerToken: perToken(rate.outputUsdPerMillion),
    cacheReadCostPerToken: perToken(rate.cacheReadUsdPerMillion ?? rate.inputUsdPerMillion),
    cacheCreationCostPerToken: perToken(cacheWrite),
    cacheCreation1hCostPerToken: perToken(rate.cacheWrite1hUsdPerMillion ?? cacheWrite),
  };
}

/**
 * Usage history's rates when no LiteLLM snapshot is available, from o8's own
 * rate table: 1-hour cache writes, the long-prompt tier, and fast mode from
 * the model's `-fast` entry.
 */
export function createBundledRateTable(rates: Readonly<Record<string, BundledRate>>): RateTable {
  return new Map(Object.entries(rates).map(([model, rate]): [string, ModelRate] => {
    const fast = rates[`${model}-fast`];
    const long = rate.longPrompt;
    return [model, {
      ...tokenRates(rate),
      fast: fast ? tokenRates(fast) : null,
      ultrafast: null,
      longPrompt: long ? { ...tokenRates(long), aboveTokens: long.aboveTokens } : null,
    }];
  }));
}
