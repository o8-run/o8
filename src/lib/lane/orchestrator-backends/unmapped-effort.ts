import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

/** A model id may encode a variant; that does not map an independent effort pin. */
export function unmappedEffortError(effort: ThinkingEffort | undefined): OrchestratorEvent | null {
  if (!effort || effort === 'adaptive') return null;
  return {
    type: 'error',
    code: 'effort_unsupported_runtime',
    error: `This lead cannot apply the independent thinking effort "${effort}": its transport has no verified mapping. Omit the effort pin or select a supported model-encoded variant.`,
  };
}

/** These leads have no independent reasoning-effort transport, including legacy receipts. */
export function isUnmappedEffortLead(backend: string): boolean {
  return ['acp', 'hermes', 'opencode', 'pi', 'o8'].includes(backend);
}
