import { resolveRate } from '@/lib/cost/rate-table';

const TOKENS_PER_MILLION = 1_000_000;

export interface ModelPricingPerMillionUsd {
  input: number;
  output: number;
}

/** A Claude model's input and output price, from the one rate table. */
export function anthropicPricingForModel(model: string): ModelPricingPerMillionUsd | null {
  const rate = resolveRate('anthropic', model);
  return rate && { input: rate.inputUsdPerMillion, output: rate.outputUsdPerMillion };
}

export function estimateAnthropicInputCostUsd(model: string, tokens: number): number | null {
  const pricing = anthropicPricingForModel(model);
  if (!pricing || !Number.isFinite(tokens) || tokens <= 0) return null;
  return (tokens * pricing.input) / TOKENS_PER_MILLION;
}
