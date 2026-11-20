import { readComposerSend } from '@/lib/orchestrator/composer-queue';
import { findLeadThreadBinding } from '@/lib/orchestrator/lead-lifecycle';
import { findLeadTurnByKey } from '@/lib/orchestrator/lead-status';
import type { ComposerQueueTarget } from '@/lib/orchestrator/composer-queue-types';

/** Correlate the actual admitted turn; an accepted queue row is not completion. */
export async function readVisualQueueReceipt(target: ComposerQueueTarget, id: string) {
  if (!/^visual-[A-Za-z0-9-]{1,96}$/.test(id)) throw new Error('Invalid visual request identity.');
  const item = await readComposerSend(id);
  if (!item || item.threadId !== target.threadId || item.repoPath !== target.repoPath) return null;
  if (!item.admittedAt) return { item, userMessageId: null };
  const lead = findLeadThreadBinding(target.threadId);
  if (!lead) return { item, userMessageId: `review-user-assistant-queued-${item.id}` };
  const turn = findLeadTurnByKey(lead.id, `composer-queue:${item.id}`);
  return { item, userMessageId: turn ? `lead-user-${turn.root_turn_id ?? turn.id}` : null };
}
