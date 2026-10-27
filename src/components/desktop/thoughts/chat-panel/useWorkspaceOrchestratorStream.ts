import { useOrchestratorStream } from '../useOrchestratorStream';
import type { OrchestratorStreamOptions } from '../use-orchestrator-stream/types';

/** A fresh workspace owns its draft until a send or history load binds a thread. */
export function useWorkspaceOrchestratorStream(repoPath: string | null, {
  scopeTabId, suppressAutoRestore, ...options
}: OrchestratorStreamOptions & { scopeTabId?: string; suppressAutoRestore: boolean }) {
  return useOrchestratorStream(repoPath, {
    ...options,
    allowUnboundRecovery: !scopeTabId || !suppressAutoRestore,
  });
}
