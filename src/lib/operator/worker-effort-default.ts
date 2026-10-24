import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { resolveAdapterEffort, resolveEffortPin } from '@/lib/orchestrator/effort-pin';

export function resolveWorkerEffortDefault(options: {
  runtime: OrchestratorRuntime;
  explicitEffort?: ThinkingEffort | null;
  model?: string | null;
  codexWorkerEffort: ThinkingEffort;
  claudeWorkerEffort: ThinkingEffort;
}): ThinkingEffort | undefined {
  if (options.explicitEffort) return options.explicitEffort;
  const fallback = options.runtime === 'codex'
    ? options.codexWorkerEffort
    : options.runtime === 'claude-code'
      ? options.claudeWorkerEffort
      : 'adaptive';
  if (fallback === 'adaptive') return undefined;
  const pin = resolveEffortPin({ runtime: options.runtime, model: options.model ?? null, requestedEffort: fallback });
  if (pin.ok) return fallback;
  // A saved default can outlive a model switch. Explicit requests above retain
  // their identity and are refused by admission; inherited settings are normalized.
  return pin.code === 'effort_coerced'
    ? resolveAdapterEffort(options.runtime, options.model ?? null, fallback) as ThinkingEffort
    : undefined;
}
