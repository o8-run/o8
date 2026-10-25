import { createBroadcastRedactionContext } from '@/lib/broadcast/redaction';
import type { OutputRedactionContext } from '@/lib/acp/output-redaction';

/** Reuse live server credential authority once for an entire response or save. */
export function viewerRedactionPolicy(): OutputRedactionContext {
  const context = createBroadcastRedactionContext();
  return {
    knownValues: [...context.environmentValues, ...(context.operatorToken ? [context.operatorToken] : [])],
    activeCredentialHashes: context.activeDeviceTokenHashes,
  };
}
