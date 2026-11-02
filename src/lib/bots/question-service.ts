import 'server-only';
import { createHash } from 'node:crypto';
import { postAgentMessage } from '@/lib/agents/service';
import { requireNetworkMcpBinding } from './network-mcp-service';
import { projectNetworkThread } from './network-projection';
import { findNetworkQuestionByRequestId, recordNetworkQuestion } from './question-store';
import { BotNetworkError } from './network-types';

function receipt(question: NonNullable<ReturnType<typeof findNetworkQuestionByRequestId>>) {
  let projection;
  try { projectNetworkThread(question.threadId); projection = { threadId: question.threadId, state: 'ready' as const }; }
  catch { projection = { threadId: question.threadId, state: 'pending' as const }; }
  return { schema: 'o8/network.question/v1', question: {
    id: question.id, threadId: question.threadId, messageId: question.message.id,
    text: question.message.text, status: question.status, createdAt: question.message.timestamp,
    answer: question.answer ? { messageId: question.answer.id, text: question.answer.text, acceptedAt: question.answer.timestamp } : null,
  }, receipt: { stage: 'accepted', messageId: question.message.id, sequence: question.message.sequence,
    delivery: question.message.delivery, processing: 'unknown' }, projection };
}
/** A durable asynchronous question; retrying the same identity retrieves its current answer. */
export async function askNetworkMcpUser(bindingId: string, args: Record<string, unknown>) {
  const text = typeof args.question === 'string' ? args.question.trim() : '';
  if (!text || text.length > 4000 || typeof args.requestId !== 'string' || !args.requestId.trim()) {
    throw new BotNetworkError('A question and stable requestId are required.', 'invalid_network_question', 400);
  }
  const requestId = `network-question:${createHash('sha256').update(JSON.stringify([bindingId, args.requestId])).digest('hex')}`;
  const prior = findNetworkQuestionByRequestId(requestId);
  if (prior) {
    if (prior.bindingId !== bindingId || prior.message.text !== text) {
      throw new BotNetworkError('Question requestId already belongs to a different question.', 'network_question_conflict');
    }
    return receipt(prior);
  }
  const self = requireNetworkMcpBinding(bindingId);
  const { live: _live, createdAt: _createdAt, ...participant } = self;
  await postAgentMessage({ fromAgentId: self.agentId, repo: self.repo, to: 'operator', text, requestId },
    { role: 'operator' }, undefined, undefined, undefined, {
      operatorQuestion: true,
      beforePersist: () => { requireNetworkMcpBinding(bindingId); },
      afterPersist: message => { recordNetworkQuestion(requestId, participant, message); },
    });
  return receipt(findNetworkQuestionByRequestId(requestId)!);
}
