// Keep in sync with src-tauri/src/models.rs.

export const RAW_MODEL_IDS = {
  anthropicClaudeFable51: 'claude-fable-5-1',
  anthropicClaudeOpus55: 'claude-opus-5-5',
  anthropicClaudeFable5: 'claude-fable-5',
  anthropicClaudeFable5OneMillion: 'claude-fable-5[1m]',
  anthropicClaudeOpus5: 'claude-opus-5',
  anthropicClaudeOpus48: 'claude-opus-4-8',
  anthropicClaudeOpus47: 'claude-opus-4-7',
  anthropicClaudeOpus46: 'claude-opus-4-6',
  anthropicClaudeSonnet55: 'claude-sonnet-5-5',
  anthropicClaudeSonnet5: 'claude-sonnet-5',
  anthropicClaudeSonnet46: 'claude-sonnet-4-6',
  anthropicClaudeSonnet45: 'claude-sonnet-4-5',
  anthropicClaudeHaiku55: 'claude-haiku-5-5',
  anthropicClaudeHaiku45: 'claude-haiku-4-5',
  anthropicClaudeHaiku45Dated: 'claude-haiku-4-5-20251001',
  openAiGpt61Sol: 'gpt-6.1-sol',
  openAiGpt6Astra: 'gpt-6-astra',
  openAiGpt6Sol: 'gpt-6-sol',
  openAiGpt6Luna: 'gpt-6-luna',
  openAiGpt56Sol: 'gpt-5.6-sol',
  openAiGpt56Terra: 'gpt-5.6-terra',
  openAiGpt56Luna: 'gpt-5.6-luna',
  openAiGpt55: 'gpt-5.5',
  openAiGpt54: 'gpt-5.4',
  openAiGpt53Codex: 'gpt-5.3-codex',
  openAiGpt4o: 'gpt-4o',
  opencodeDeepseekV4FlashFree: 'opencode/deepseek-v4-flash-free',
  xaiGrok45: 'grok-4.5',
  gemini25Flash: 'gemini-2.5-flash',
  gemini3FlashPreview: 'gemini-3-flash-preview',
  gemini31ProPreview: 'gemini-3.1-pro-preview',
  gemini3ProPreview: 'gemini-3-pro-preview',
} as const;

export const SUPPORTED_MODEL_IDS = Object.freeze(
  [...new Set(Object.values(RAW_MODEL_IDS))],
);

export const CODEX_MODEL_IDS = Object.freeze([
  RAW_MODEL_IDS.openAiGpt61Sol,
  RAW_MODEL_IDS.openAiGpt6Astra,
  RAW_MODEL_IDS.openAiGpt6Sol,
  RAW_MODEL_IDS.openAiGpt6Luna,
  RAW_MODEL_IDS.openAiGpt56Sol,
  RAW_MODEL_IDS.openAiGpt56Terra,
  RAW_MODEL_IDS.openAiGpt56Luna,
  RAW_MODEL_IDS.openAiGpt55,
  RAW_MODEL_IDS.openAiGpt54,
  RAW_MODEL_IDS.openAiGpt53Codex,
  RAW_MODEL_IDS.openAiGpt4o,
]);

export function isSupportedModelId(value: unknown): value is ModelId {
  return typeof value === 'string' && (SUPPORTED_MODEL_IDS as readonly string[]).includes(value);
}

export function isCodexModelId(value: unknown): value is ModelId {
  return typeof value === 'string' && (CODEX_MODEL_IDS as readonly string[]).includes(value);
}

export const MODEL_IDS = {
  orchestratorDefault: RAW_MODEL_IDS.anthropicClaudeOpus55,
  // Orchestrator and worker defaults track their own model tiers.
  codexDefault: RAW_MODEL_IDS.openAiGpt6Astra,
  // Codex WORKER default (Sonnet-class) for dispatched packets.
  codexWorkerDefault: RAW_MODEL_IDS.openAiGpt56Terra,
  // Codex SCOUT / cheap tier (Haiku-class) for triage-style work.
  codexScoutDefault: RAW_MODEL_IDS.openAiGpt56Luna,
  codexCliDefault: RAW_MODEL_IDS.openAiGpt61Sol,
  claudeWorkerDefault: RAW_MODEL_IDS.anthropicClaudeSonnet5,
  claudeQaDefault: RAW_MODEL_IDS.anthropicClaudeSonnet5,
  claudeReviewDefault: RAW_MODEL_IDS.anthropicClaudeSonnet5,
  claudeHaikuQaDefault: RAW_MODEL_IDS.anthropicClaudeHaiku45Dated,
  fableDefault: RAW_MODEL_IDS.anthropicClaudeFable51,
  opencodeDefault: RAW_MODEL_IDS.opencodeDeepseekV4FlashFree,
  // Grok Build CLI worker default (Opus-class, cheaper for context) — sub-billed
  // via SuperGrok through the CLI adapter, not a metered API route.
  grokWorkerDefault: RAW_MODEL_IDS.xaiGrok45,
  mobileOpenAiDefault: RAW_MODEL_IDS.openAiGpt61Sol,
  mobileCliDefault: `cli:codex:${RAW_MODEL_IDS.openAiGpt61Sol}`,
  mobileGeminiDefault: RAW_MODEL_IDS.gemini25Flash,
  raw: RAW_MODEL_IDS,
} as const;

export const CROSS_HOUSE_MODEL_TIERS = {
  frontierOrchestrator: {
    anthropic: RAW_MODEL_IDS.anthropicClaudeOpus55,
    openai: RAW_MODEL_IDS.openAiGpt6Astra,
  },
  reviewMechanical: {
    anthropic: RAW_MODEL_IDS.anthropicClaudeSonnet5,
    openai: RAW_MODEL_IDS.openAiGpt56Terra,
  },
  scout: {
    anthropic: RAW_MODEL_IDS.anthropicClaudeHaiku45Dated,
    openai: RAW_MODEL_IDS.openAiGpt56Luna,
  },
} as const;

export type ModelId = typeof RAW_MODEL_IDS[keyof typeof RAW_MODEL_IDS];
