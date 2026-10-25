/** Dependency-free credential names shared with bootstrap and generic CLI checks. */
export const PROVIDER_ENV_KEYS = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'ELEVENLABS_API_KEY', 'GOOGLE_TTS_API_KEY'] as const;
export const PROVIDER_KEY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  GEMINI_API_KEY: ['GOOGLE_AI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY'],
  OPENAI_API_KEY: ['CODEX_API_KEY'],
  ANTHROPIC_API_KEY: ['ANTHROPIC_AUTH_TOKEN'],
};
// These aliases have no provider identity. Resolve the selected provider; never trust their literal value.
export const SCOPED_ALIASES: Record<string, string> = { O8_FABLE_ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY' };
export const GENERIC_ALIASES = ['LLM_API_KEY', 'GOOSE_API_KEY', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BEARER_TOKEN'];
export function providerCredentialName(name: string): boolean {
  return Object.hasOwn(SCOPED_ALIASES, name) || GENERIC_ALIASES.includes(name) || (PROVIDER_ENV_KEYS as readonly string[]).includes(name) || Object.values(PROVIDER_KEY_ALIASES).some(aliases => aliases.includes(name));
}
