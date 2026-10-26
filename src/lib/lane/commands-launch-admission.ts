import { appendEvent } from '@/lib/lane/registry';
import { assertOwnedActionGuard, withoutOwnedStartAdmission } from '@/lib/runtimes/shared/owned-session/action-admission';

/** No await on the admitted path: attachment follows its final guard synchronously.
 * A cancelled admission may retire only the exact surface its launch returned.
 */
export function assertLaunchAttachment(laneId: string, surfaceId?: string): Promise<never> | undefined {
  try { assertOwnedActionGuard(); }
  catch (error) {
    return (async () => {
      if (surfaceId) {
        let cleanup: 'confirmed' | 'queued' | 'unconfirmed' = 'unconfirmed';
        try {
          const { performRuntimeAction } = await import('@/lib/runtime/actions');
          // Cancellation fences spawning and attachment, never exact-surface
          // cleanup. Other runtime ownership/confirmation checks remain.
          const result = await withoutOwnedStartAdmission(() => performRuntimeAction({ action: 'stop', surfaceId }));
          if (result.ok && result.status === 'completed') cleanup = 'confirmed';
          else if (result.ok && result.status === 'queued') cleanup = 'queued';
        } catch { /* Lack of confirmation remains visible below. */ }
        appendEvent(laneId, 'task_dispatch_cleanup', 'system', { surfaceId, cleanup });
      }
      throw error;
    })();
  }
  return undefined;
}
