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

/**
 * o8 and Pi run a leftover manual effort at their runtime default and say so in the receipt (#5466).
 * The other unmapped leads keep #4858's refusal of an independent pin.
 */
export function dropsStaleEffortPin(backend: string): boolean {
  return backend === 'o8' || backend === 'pi';
}
