import { useLayoutEffect, useRef } from 'react';

/** Keep a synchronously minted thread while the parent commits its binding. */
export function useOrchestratorThreadBinding(threadId: string | null, allowUnboundRecovery = true) {
  const threadIdRef = useRef<string | null>(threadId);
  // A first send can mint before the parent's state lands. A null render must
  // not erase that identity or let another conversation enter during the gap.
  const allowUnboundRecoveryRef = useRef(allowUnboundRecovery);
  useLayoutEffect(() => {
    if (threadId) threadIdRef.current = threadId;
    allowUnboundRecoveryRef.current = allowUnboundRecovery;
  }, [allowUnboundRecovery, threadId]);
  return { threadIdRef, allowUnboundRecoveryRef };
}
