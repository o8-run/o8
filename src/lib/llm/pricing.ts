const TOKENS_PER_MILLION = 1_000_000;

export interface ModelPricingPerMillionUsd {
  input: number;
  output: number;
}

function normalizeModelLookup(model: string) {
  return model.trim().toLowerCase();
}

export function anthropicPricingForModel(model: string): ModelPricingPerMillionUsd | null {
  const normalizedModel = normalizeModelLookup(model);
  if (!normalizedModel) return null;
  if (normalizedModel.includes('claude-opus-5-5') || normalizedModel.includes('opus 5.5')) return { input: 4, output: 20 };
  if (normalizedModel.includes('claude-fable-5-1') || normalizedModel.includes('fable 5.1')) return { input: 10, output: 50 };
  if (normalizedModel.includes('claude-opus-4-8') || normalizedModel.includes('opus 4.8')) return { input: 5, output: 25 };
  if (normalizedModel.includes('claude-opus-4-7') || normalizedModel.includes('opus 4.7')) return { input: 5, output: 25 };
  if (normalizedModel.includes('claude-opus-4-6') || normalizedModel.includes('opus 4.6')) return { input: 15, output: 75 };
  if (normalizedModel.includes('claude-sonnet-5-5') || normalizedModel.includes('sonnet 5.5')) return { input: 2, output: 10 };
  // Sonnet 5's launch price is its standard price (Anthropic pricing page, 2026-11-05).
  if (normalizedModel.includes('claude-sonnet-5') || normalizedModel.includes('sonnet 5')) return { input: 2, output: 10 };
  if (normalizedModel.includes('claude-sonnet-4-6') || normalizedModel.includes('sonnet 4.6')) return { input: 3, output: 15 };
  if (
    normalizedModel.includes('claude-sonnet-4-5')
    || normalizedModel.includes('sonnet 4.5')
    || normalizedModel.includes('claude-sonnet-4')
    || normalizedModel.includes('sonnet 4')
  ) {
    return { input: 3, output: 15 };
  }
  // Prompts up to 100K tokens; src/lib/cost/rate-table.ts has the long-prompt rates.
  if (normalizedModel.includes('claude-haiku-5-5') || normalizedModel.includes('haiku 5.5')) return { input: 0.1, output: 0.5 };
  if (
    normalizedModel.includes('claude-haiku-4-5')
    || normalizedModel.includes('haiku 4.5')
    || normalizedModel.includes('claude-haiku')
    || normalizedModel.includes('haiku')
  ) {
    return { input: 1, output: 5 };
  }
  return null;
}

export function estimateAnthropicInputCostUsd(model: string, tokens: number): number | null {
  const pricing = anthropicPricingForModel(model);
  if (!pricing || !Number.isFinite(tokens) || tokens <= 0) return null;
  return (tokens * pricing.input) / TOKENS_PER_MILLION;
}
