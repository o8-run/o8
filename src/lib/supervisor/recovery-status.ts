import type { AgentStatusEntry, WatchedAgent } from './agent-supervisor-types';
export { readOwnedRecoveryState, readOwnedCompletionState } from '@/lib/runtimes/shared/owned-session/automatic-recovery';

export function resolveStatus(
  agent: AgentStatusEntry | undefined,
  watched: WatchedAgent,
  now: number,
): string {
  if (!agent) {
    // Not in fleet — if recently registered, may not have appeared yet
    const age = now - watched.registeredAt;
    if (age < 30_000) return 'launching';
    // Old and missing — treat as finished or failed
    return 'finished';
  }

  const status = agent.status;
  if (status === 'running') return 'running';
  if (status === 'failed' || status === 'blocked') return 'failed';
  if (status === 'reviewing') return 'finished';
  if (status === 'waiting') return 'waiting';
  if (status === 'idle') return 'finished';
  return status;
}
