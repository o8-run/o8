import { listQueuedComposerSends } from '@/lib/orchestrator/composer-queue';
import type { InboxSubject } from './settlement-state';
import { InboxMutationError } from './subjects';
import { mutateInboxSettlement } from './store';

export async function assertInboxComposerQueueEmpty(subject: InboxSubject): Promise<void> {
  if (subject.kind !== 'conversation' || !subject.workspace) return;
  let queued: Awaited<ReturnType<typeof listQueuedComposerSends>>;
  try { queued = await listQueuedComposerSends({ repoPath: subject.workspace, threadId: subject.id }); }
  catch { throw new InboxMutationError('Queue owner unavailable.', 503); }
  if (queued.length) throw new InboxMutationError('Thread has a queued message. Send it or remove it before settling.', 409);
}

/** Revert through the established path if a send arrived across the commit. */
export async function recheckInboxComposerQueueAfterCommit(subject: InboxSubject): Promise<void> {
  try { await assertInboxComposerQueueEmpty(subject); }
  catch (error) {
    mutateInboxSettlement(subject, 'unsettle', () => {});
    throw error;
  }
}

/** Queue ownership is separate: check before and after the synchronous commit. */
export async function withInboxComposerQueueGuard<T>(subject: InboxSubject, commit: () => T): Promise<T> {
  await assertInboxComposerQueueEmpty(subject);
  const result = commit();
  await recheckInboxComposerQueueAfterCommit(subject);
  return result;
}
