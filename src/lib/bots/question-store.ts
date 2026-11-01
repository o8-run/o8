import 'server-only';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getSqlite } from '@/lib/db';
import { ensureV78BotQuestionSchema } from '@/lib/db/v78-bot-question-migration';
import { readAgentConversationMessages, readAgentMessageByRequestId } from '@/lib/agents/message-history';
import type { AgentMessage } from '@/lib/agents/types';
import { ensureAgentBusSchema } from '@/lib/agents/store';
import { bindNetworkExchange, findNetworkThread } from './network-store';
import { BotNetworkError, type NetworkParticipant } from './network-types';
import { botTextPrefix } from './text';

interface QuestionRow {
  id: string;
  bus_request_id: string;
  binding_id: string;
  thread_id: string;
  question_message_id: string;
  created_at: string;
}
function read(row: QuestionRow | undefined, sqlite: Database.Database) {
  if (!row) return null;
  const message = readAgentMessageByRequestId(row.bus_request_id, sqlite);
  const thread = findNetworkThread(row.thread_id, sqlite);
  if (!message || !thread || message.id !== row.question_message_id || message.to.toLowerCase() !== 'operator'
    || message.conversation?.id !== thread.conversationId) {
    throw new BotNetworkError('The saved question or its exchange is unavailable.', 'network_question_unavailable', 503);
  }
  const answer = readAgentConversationMessages(thread.conversationId!, sqlite).find(candidate =>
    candidate.from.toLowerCase() === 'operator' && candidate.conversation?.replyToId === message.id) ?? null;
  return { id: row.id, requestId: row.bus_request_id, bindingId: row.binding_id, threadId: row.thread_id,
    message, answer, status: answer ? 'answered' as const : 'pending' as const };
}
export function findNetworkQuestionByRequestId(requestId: string, sqlite: Database.Database = getSqlite()) {
  ensureV78BotQuestionSchema(sqlite);
  return read(sqlite.prepare('SELECT * FROM bot_network_questions WHERE bus_request_id = ?').get(requestId) as QuestionRow | undefined, sqlite);
}
export function findNetworkQuestionForThread(threadId: string, sqlite: Database.Database = getSqlite()) {
  ensureV78BotQuestionSchema(sqlite);
  return read(sqlite.prepare('SELECT * FROM bot_network_questions WHERE thread_id = ?').get(threadId) as QuestionRow | undefined, sqlite);
}
/** A correlation guard for the question owner; no Settle/park behavior is changed here. */
export function hasPendingNetworkQuestion(threadId: string, sqlite: Database.Database = getSqlite()) {
  return findNetworkQuestionForThread(threadId, sqlite)?.status === 'pending';
}
/** Called inside the existing bus admission transaction, before any history projection. */
export function recordNetworkQuestion(requestId: string, participant: NetworkParticipant, message: AgentMessage, sqlite: Database.Database = getSqlite()) {
  ensureV78BotQuestionSchema(sqlite);
  const prior = findNetworkQuestionByRequestId(requestId, sqlite);
  if (prior) {
    if (prior.bindingId !== participant.id || prior.message.id !== message.id) {
      throw new BotNetworkError('Question request id belongs to a different accepted message.', 'network_question_conflict');
    }
    return prior;
  }
  const thread = bindNetworkExchange(message, [participant], sqlite);
  const id = `question-${createHash('sha256').update(requestId).digest('hex')}`;
  sqlite.prepare('INSERT INTO bot_network_questions(id,bus_request_id,binding_id,thread_id,question_message_id,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, requestId, participant.id, thread.threadId, message.id, message.timestamp);
  sqlite.prepare('UPDATE bot_network_threads SET title = ? WHERE thread_id = ?').run(`${participant.agentName} asks you`, thread.threadId);
  return findNetworkQuestionByRequestId(requestId, sqlite)!;
}

/** A bounded preview feed; the canonical thread retains the full question and answer. */
export function pendingNetworkQuestionCards(repoPath?: string, sqlite: Database.Database = getSqlite()) {
  ensureV78BotQuestionSchema(sqlite);
  // The bus is lazily initialized on older installations.
  ensureAgentBusSchema(sqlite);
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_agent_question_answers ON agent_messages(reply_to_id,from_agent,to_agent)');
  // The bus already validates reverse participants using its own name rules.
  // Correlation plus the operator sender identifies the answer, including a
  // case-only name change. Preview and predicate use one database snapshot.
  const rows = sqlite.prepare(`SELECT q.id,q.thread_id,q.created_at,t.repo_path,
      question.text,question.from_agent FROM bot_network_questions q
    JOIN bot_network_threads t ON t.thread_id = q.thread_id
    JOIN agent_messages question ON question.id = q.question_message_id AND question.client_request_id = q.bus_request_id
      AND question.conversation_id = t.conversation_id AND question.to_agent = 'operator' COLLATE NOCASE
    WHERE (? IS NULL OR t.repo_path = ?) AND NOT EXISTS (
      SELECT 1 FROM agent_messages answer WHERE answer.reply_to_id = q.question_message_id
        AND answer.from_agent = 'operator' COLLATE NOCASE AND answer.conversation_id = question.conversation_id
    ) ORDER BY q.created_at,q.id LIMIT 65`).all(repoPath ?? null, repoPath ?? null) as Array<{
      id: string; thread_id: string; created_at: string; repo_path: string; text: string; from_agent: string;
    }>;
  return { questions: rows.slice(0, 64).map(row => ({
    id: row.id, threadId: row.thread_id, sessionKey: `llm-chat:${row.thread_id}`,
    status: 'pending', title: `${row.from_agent} asks you`, repoPath: row.repo_path,
    text: row.text.length > 1200 ? botTextPrefix(row.text, 1200) + '…' : row.text,
    createdAt: row.created_at,
  })), questionsTruncated: rows.length > 64 };
}
