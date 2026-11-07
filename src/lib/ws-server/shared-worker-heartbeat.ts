import { reconcileSharedWorkerReturns, recoverSharedWorkerReturns, type SharedWorkerReturnHooks } from '@/lib/orchestrator/shared-worker-returns';
import { recoverSharedWorkerParentBindings, settleSharedCheckoutTeams } from '@/lib/orchestrator/shared-worker-recovery';
import type { BoundChatContinuationHooks } from './bound-chat-continuation';
import { runSharedWorkerChatReturn } from './shared-worker-chat-return';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';

export type SharedWorkerHeartbeatHooks = Pick<SharedWorkerReturnHooks, 'readTranscript' | 'isBusy'> & {
  registerAbort: BoundChatContinuationHooks['registerAbort'];
  publish: (threadId: string, sessionName: string, event: string, data: Record<string, unknown>) => void;
};
export function createSharedWorkerHeartbeat(input: SharedWorkerHeartbeatHooks): () => void {
  recoverSharedWorkerParentBindings();
  recoverSharedWorkerReturns();
  let settling: Promise<void> | undefined;
  const settle = () => settling ??= settleSharedCheckoutTeams()
    .catch(() => console.warn('[shared-checkout] Membership repair failed.'))
    .finally(() => { settling = undefined; });
  void settle();
  return () => {
    void settle();
    void reconcileSharedWorkerReturns({ ...input, changed: surfaceId => {
      void publishRealtimeMutation({ mutation: { mutationId: `worker-return-${surfaceId}-${Date.now()}`,
        source: 'server', action: 'worker-return', status: 'completed', surfaceId,
        createdAt: new Date().toISOString() } });
    }, run: batch => runSharedWorkerChatReturn(batch, {
      registerAbort: input.registerAbort,
      publish: (sessionName, event, data) => input.publish(batch.origin.threadId, sessionName, event, data),
    }) }).catch(error => console.warn('[worker-return] Reconciliation failed:', error));
  };
}
