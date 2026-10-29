import { readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import type { VoiceBinding, VoiceTerminal } from '@/lib/next/voice-host';
import { composerQueueRepoKey, readComposerSend } from '@/lib/orchestrator/composer-queue';
import { findLeadThreadBinding } from '@/lib/orchestrator/lead-lifecycle';
import { findLeadTurnByKey, getLeadStatus } from '@/lib/orchestrator/lead-status';

/** Read durable execution evidence, never infer completion from queue admission. */
export function readVoiceQueueReceipt(target: VoiceBinding, queueItemId: string) {
  const item = readComposerSend(queueItemId);
  if (!item || item.intent !== 'send-next' || item.threadId !== target.threadId
    || item.repoPath !== composerQueueRepoKey(target.repoPath)
    || !item.id.startsWith(`next-${target.nonce}-`)) return null;
  const terminal = (outcome: VoiceTerminal['outcome'], text: string): VoiceTerminal => ({ queueItemId, outcome, text });
  if (item.status === 'held' || item.status === 'cancelled') {
    return { item, terminal: terminal('held', item.reason ?? 'The queued request is held. Inspect the conversation before retrying.') };
  }
  if (item.status !== 'applied' || item.admittedAt === null) return { item, terminal: null };
  const assistant = readPersistedLlmChat(item.threadId)?.history.messages.find(message =>
    message.role === 'assistant' && message.id === `assistant-queued-${item.id}`);
  if (assistant) {
    const outcome = assistant.receipt?.terminal?.outcome;
    if (!outcome) return { item, terminal: null };
    return { item, terminal: terminal(outcome === 'completed' ? 'completed' : outcome === 'failed' ? 'failed' : 'held', assistant.content) };
  }
  const lead = findLeadThreadBinding(item.threadId);
  const admitted = lead && lead.repo_path === item.repoPath && findLeadTurnByKey(lead.id, `composer-queue:${item.id}`);
  if (!admitted) return { item, terminal: null };
  // requestedTurn follows this admitted turn's root through worker continuations.
  const receipt = getLeadStatus(admitted.lead_id, 0, admitted.id);
  const turn = receipt.requestedTurn;
  const status = turn?.status;
  if (!status || ['queued', 'running', 'waiting_workers'].includes(status)) return { item, terminal: null };
  return { item, terminal: terminal(status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'held',
    turn?.resultText ?? turn?.outcome?.summary ?? turn?.error ?? '') };
}

/** Caption links use an actual transcript row, separately from queue correlation. */
export function readVoiceQueueTranscriptId(target: VoiceBinding, queueItemId: string): string | undefined {
  const messages = readPersistedLlmChat(target.threadId)?.history.messages ?? [];
  const boundId = `review-user-assistant-queued-${queueItemId}`;
  if (messages.some(message => message.role === 'user' && message.id === boundId)) return boundId;
  const lead = findLeadThreadBinding(target.threadId);
  const turn = lead && lead.repo_path === composerQueueRepoKey(target.repoPath) && findLeadTurnByKey(lead.id, `composer-queue:${queueItemId}`);
  const leadId = turn ? `lead-user-${turn.root_turn_id ?? turn.id}` : undefined;
  return messages.some(message => message.role === 'user' && message.id === leadId) ? leadId : undefined;
}
