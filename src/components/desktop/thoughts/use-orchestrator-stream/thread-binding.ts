import { useRef } from 'react';

/** Keep a synchronously minted thread while the parent commits its binding. */
export function useOrchestratorThreadBinding(threadId: string | null, allowUnboundRecovery = true) {
  const threadIdRef = useRef<string | null>(threadId);
  // A first send can mint before the parent's state lands. A null render must
  // not erase that identity or let another conversation enter during the gap.
  if (threadId) threadIdRef.current = threadId;
  const allowUnboundRecoveryRef = useRef(allowUnboundRecovery);
  allowUnboundRecoveryRef.current = allowUnboundRecovery;
  return { threadIdRef, allowUnboundRecoveryRef };
}
