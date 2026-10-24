import type { Model } from '@earendil-works/pi-ai';
/** Body fields the hosted endpoint accepts, plus stream_options and usage, which it strips first. */
export const MANAGED_INFERENCE_BODY_FIELDS: ReadonlySet<string> = new Set(['model', 'messages', 'max_tokens', 'stream',
  'temperature', 'top_p', 'tools', 'tool_choice', 'response_format', 'stop', 'stream_options', 'usage']);

/**
 * The managed model as Pi must describe it. The server accepts only model,
 * messages, max_tokens, stream, temperature, top_p, tools, tool_choice,
 * response_format and stop (it strips stream_options), so Pi must send
 * max_tokens, omit store, use the system role, and never add prompt cache
 * fields, even when PI_CACHE_RETENTION=long.
 */
export const O8_MANAGED_FLASH_LITE_MODEL: Model<'openai-completions'> = {
  id: 'google/gemini-2.5-flash-lite',
  name: 'Gemini 2.5 Flash Lite (o8 managed)',
  api: 'openai-completions',
  provider: 'o8-managed',
  baseUrl: 'https://api.o8.run/v1',
  reasoning: false,
  input: ['text'],
  contextWindow: 65_536,
  maxTokens: 4_096,
  cost: { input: 0.18, output: 0.72, cacheRead: 0, cacheWrite: 0 },
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
    supportsLongCacheRetention: false,
  },
};

/**
 * The managed model Pi runs on, as orchestrator and packet worker. The hosted
 * endpoint forwards it to OpenAI on paid plans and replaces it with its free
 * model on the free plan. Its Chat Completions accepts tools only with reasoning
 * effort none, which the endpoint sets, so Pi sends no reasoning field. The
 * request shape is the same as the Flash Lite model's.
 */
export const O8_MANAGED_PI_MODEL: Model<'openai-completions'> = {
  ...O8_MANAGED_FLASH_LITE_MODEL,
  id: 'openai/gpt-6-luna',
  name: 'GPT-6 Luna (o8 managed)',
  cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};
