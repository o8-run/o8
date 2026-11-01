import type { MobileOrchestratorThread } from '@/lib/mobile/types';

const projectionErrors = new Map<string, string>();
export function recordNetworkProjectionHealth(threadId: string, error: unknown | null) {
  if (error === null) projectionErrors.delete(threadId);
  else projectionErrors.set(threadId, error instanceof Error ? error.message : 'Network transcript projection is unavailable.');
}
export function networkProjectionError(threadId: string) { return projectionErrors.get(threadId); }
export function applyNetworkProjectionHealth(thread: MobileOrchestratorThread): MobileOrchestratorThread {
  if (thread.source !== 'bot-network') return thread;
  const current = { ...thread };
  delete current.networkProjectionError;
  delete current.outcome;
  const error = networkProjectionError(thread.id);
  return { ...current, status: error ? 'failed' : thread.messageCount ? 'ready' : 'idle',
    ...(thread.networkQuestion?.status === 'pending' ? { outcome: 'asked' as const } : {}),
    ...(error ? { networkProjectionError: error } : {}) };
}
