import { isThinkingEffort, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

// API family support is separate from CLI catalog support; wire ids stay unchanged.
const OPENAI_REASONING_MODELS = new Set(['o3', 'o3-mini', 'o4-mini']);
const ANTHROPIC_BUDGET_MODELS = new Set([
  'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
  'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5',
]);

/** Dated provider snapshots inherit effort support from their exact model family. */
export function nativeApiModelFamily(provider: string, model: string): string {
  const suffix = provider === 'openai' ? /-\d{4}-\d{2}-\d{2}$/
    : provider === 'anthropic' ? /-\d{8}$/ : null;
  return typeof model === 'string' && suffix ? model.replace(suffix, '') : model;
}

export function nativeApiEffortError(provider: string, model: string, raw: unknown): string | null {
  if (raw === undefined) return null;
  if (!isThinkingEffort(raw)) return 'invalid_effort';
  if (raw === 'adaptive') return null;
  const family = nativeApiModelFamily(provider, model);
  // Operator is a managed service tier, with its existing server-enforced policy.
  if (provider === 'operator') return raw === 'low' || raw === 'high' ? null : 'effort_unsupported_model';
  if (provider === 'openai' && OPENAI_REASONING_MODELS.has(family)
    && ['low', 'medium', 'high'].includes(raw)) return null;
  if (provider === 'anthropic' && ANTHROPIC_BUDGET_MODELS.has(family) && raw !== 'ultra') return null;
  return 'effort_unsupported_model';
}

export function applyNativeApiEffort(body: Record<string, unknown>, provider: string, effort: ThinkingEffort | null): void {
  if (provider === 'openai' && effort && effort !== 'adaptive') body.reasoning_effort = effort;
}
