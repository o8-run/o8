import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { getSqlite } from '@/lib/db';
import { ensureV77BotNetworkThreadSchema } from '@/lib/db/v77-bot-network-thread-migration';
import { listBotMembers } from '@/lib/agents/bot-membership-store';
import { AGENT_MESSAGE_TEXT_MAX_LENGTH, getAgentConversation, normalizeAgentBusRepoPath } from '@/lib/agents/store';
import { readAgentConversationMessages, readAgentMessageByRequestId } from '@/lib/agents/message-history';
import type { AgentMessage } from '@/lib/agents/types';
import { getCanonicalChatHistoryPath, readPersistedLlmChat, withCanonicalChatHistoryLock } from '@/lib/llm/chat-history-store';
import { BotNetworkError, type BotNetworkThread, type NetworkParticipant, type NetworkSendIntent } from './network-types';

interface ThreadRow { thread_id: string; repo_path: string; conversation_id: string | null; participants_json: string; title: string; created_at: string }
interface SendRow { thread_id: string; client_id: string; bus_request_id: string; text: string; reply_to_id: string | null; agent_message_id: string | null; created_at: number; status: NetworkSendIntent['status'] }
const threadView = (r: ThreadRow): BotNetworkThread => ({ threadId: r.thread_id, repoPath: r.repo_path, conversationId: r.conversation_id,
  participants: JSON.parse(r.participants_json) as NetworkParticipant[], title: r.title, createdAt: r.created_at });
const sendView = (r: SendRow): NetworkSendIntent => ({ threadId: r.thread_id, clientId: r.client_id, requestId: r.bus_request_id,
  text: r.text, replyToId: r.reply_to_id, messageId: r.agent_message_id, createdAt: r.created_at, status: r.status });

export function findNetworkThread(threadId: string, sqlite: Database.Database = getSqlite()): BotNetworkThread | null {
  ensureV77BotNetworkThreadSchema(sqlite);
  const row = sqlite.prepare('SELECT * FROM bot_network_threads WHERE thread_id = ?').get(threadId) as ThreadRow | undefined;
  return row ? threadView(row) : null;
}
export function isNetworkThread(threadId: string, sqlite: Database.Database = getSqlite()): boolean {
  return Boolean(findNetworkThread(threadId, sqlite) || readPersistedLlmChat(threadId)?.history.source === 'bot-network');
}
export function listNetworkThreads(sqlite: Database.Database = getSqlite()): BotNetworkThread[] {
  ensureV77BotNetworkThreadSchema(sqlite);
  return (sqlite.prepare('SELECT * FROM bot_network_threads ORDER BY created_at,thread_id').all() as ThreadRow[]).map(threadView);
}
function sameNames(actual: string[], expected: string[]) {
  return JSON.stringify(actual.map(s => s.toLowerCase()).sort()) === JSON.stringify(expected.map(s => s.toLowerCase()).sort());
}
function assertConversation(thread: BotNetworkThread, conversationId: string, sqlite: Database.Database) {
  const conversation = getAgentConversation(conversationId, sqlite);
  const expected = thread.participants.length === 1 ? ['operator', thread.participants[0].agentName] : thread.participants.map(p => p.agentName);
  if (!conversation || conversation.repo !== thread.repoPath || !sameNames(conversation.participants, expected)) {
    throw new BotNetworkError('The recorded exchange does not match this thread repository and participants.', 'network_exchange_mismatch');
  }
}

/** Local configuration only. A binding is copied, never inferred from discovery or a display name. */
export function createNetworkThread(input: { bindingIds: string[]; conversationId?: string; threadId?: string }, sqlite: Database.Database = getSqlite()): BotNetworkThread {
  ensureV77BotNetworkThreadSchema(sqlite);
  if (!Array.isArray(input.bindingIds) || ![1, 2].includes(input.bindingIds.length)
    || new Set(input.bindingIds).size !== input.bindingIds.length) throw new BotNetworkError('Select one local binding, or two for an existing peer exchange.', 'invalid_network_bindings', 400);
  const bindings = listBotMembers(sqlite).flatMap(m => m.bindings);
  const participants = input.bindingIds.map(id => {
    const binding = bindings.find(b => b.id === id);
    if (!binding) throw new BotNetworkError('An explicitly recorded local session binding is required.', 'network_binding_missing');
    const { live: _live, createdAt: _createdAt, ...snapshot } = binding;
    return snapshot;
  });
  const repoPath = normalizeAgentBusRepoPath(participants[0].repo);
  if (participants.some(p => normalizeAgentBusRepoPath(p.repo) !== repoPath || p.agentName.toLowerCase() === 'operator')
    || new Set(participants.map(p => p.agentName.toLowerCase())).size !== participants.length) throw new BotNetworkError('A network exchange requires distinct participants in one repository.', 'network_repository_mismatch');
  if (participants.length === 2 && !input.conversationId) throw new BotNetworkError('Create a peer exchange through the agent bus before binding its transcript.', 'network_exchange_required');
  const threadId = input.threadId ?? `thoughts-network-${randomUUID()}`;
  if (!/^thoughts-[A-Za-z0-9_-]{1,80}$/.test(threadId)) throw new BotNetworkError('A canonical thoughts thread id is required.', 'invalid_network_thread', 400);
  const thread: BotNetworkThread = { threadId, repoPath, conversationId: input.conversationId ?? null, participants,
    title: participants.map(p => p.agentName).join(' and '), createdAt: new Date().toISOString() };
  if (thread.conversationId) assertConversation(thread, thread.conversationId, sqlite);
  return withCanonicalChatHistoryLock(threadId, () => sqlite.transaction(() => {
    const prior = findNetworkThread(threadId, sqlite);
    if (prior && JSON.stringify(prior.participants.map(p => p.id)) === JSON.stringify(input.bindingIds)
      && (input.conversationId === undefined || prior.conversationId === input.conversationId)) return prior;
    if (prior || existsSync(getCanonicalChatHistoryPath(threadId))) throw new BotNetworkError('That thread already exists. Open it by its saved id.', 'network_thread_exists');
    sqlite.prepare('INSERT INTO bot_network_threads(thread_id,repo_path,conversation_id,participants_json,title,created_at) VALUES (?,?,?,?,?,?)')
      .run(threadId, repoPath, thread.conversationId, JSON.stringify(participants), thread.title, thread.createdAt);
    return thread;
  }).immediate());
}
export function requireNetworkThread(threadId: string, sqlite: Database.Database = getSqlite()): BotNetworkThread {
  const thread = findNetworkThread(threadId, sqlite);
  if (!thread) throw new BotNetworkError('This network thread has no available local binding.', 'network_thread_unavailable');
  return thread;
}

/** Called inside local bus admission: only SQLite metadata, with file projection after commit. */
export function bindNetworkExchange(message: AgentMessage, participants: NetworkParticipant[], sqlite: Database.Database = getSqlite()): BotNetworkThread {
  ensureV77BotNetworkThreadSchema(sqlite);
  const conversationId = message.conversation?.id;
  if (!conversationId || ![1, 2].includes(participants.length)) throw new BotNetworkError('A bounded local exchange is required.', 'network_exchange_required');
  // Older/interrupted native sends can have a committed bus message but no
  // association yet. Their saved intent owns the original thread; recover it
  // before a peer reply claims the exchange for a newly generated thread.
  const interrupted = sqlite.prepare(`SELECT sends.* FROM bot_network_sends sends
    JOIN agent_messages message ON message.client_request_id = sends.bus_request_id
    WHERE message.conversation_id = ? AND sends.status = 'pending' AND sends.agent_message_id IS NULL`)
    .all(conversationId) as SendRow[];
  for (const row of interrupted) {
    const accepted = readAgentMessageByRequestId(row.bus_request_id, sqlite)!;
    completeNetworkSend(sendView(row), accepted, sqlite);
  }
  const prior = listNetworkThreads(sqlite).find(t => t.conversationId === conversationId);
  if (prior) return prior;
  const threadId = `thoughts-network-${createHash('sha256').update(conversationId).digest('hex').slice(0, 40)}`;
  const thread: BotNetworkThread = { threadId, conversationId, repoPath: message.repo,
    participants, title: participants.map(p => p.agentName).join(' and '), createdAt: message.timestamp };
  assertConversation(thread, conversationId, sqlite);
  if (findNetworkThread(threadId, sqlite) || existsSync(getCanonicalChatHistoryPath(threadId))) {
    throw new BotNetworkError('The generated exchange thread id is already in use.', 'network_thread_exists');
  }
  sqlite.prepare('INSERT INTO bot_network_threads(thread_id,repo_path,conversation_id,participants_json,title,created_at) VALUES (?,?,?,?,?,?)')
    .run(threadId, thread.repoPath, conversationId, JSON.stringify(participants), thread.title, thread.createdAt);
  return thread;
}
export function listNetworkSendIntents(threadId: string, sqlite: Database.Database = getSqlite()): NetworkSendIntent[] {
  ensureV77BotNetworkThreadSchema(sqlite);
  return (sqlite.prepare('SELECT * FROM bot_network_sends WHERE thread_id = ? ORDER BY created_at,client_id').all(threadId) as SendRow[]).map(sendView);
}

export function completeNetworkSend(intent: NetworkSendIntent, message: AgentMessage, sqlite: Database.Database = getSqlite()) {
  sqlite.transaction(() => {
    const thread = requireNetworkThread(intent.threadId, sqlite);
    const conversationId = message.conversation?.id;
    if (!conversationId || message.text !== intent.text || message.from.toLowerCase() !== 'operator'
      || message.conversation?.replyToId !== intent.replyToId) throw new BotNetworkError('The durable send receipt does not match this intent.', 'network_send_mismatch');
    assertConversation(thread, conversationId, sqlite);
    if (thread.conversationId && thread.conversationId !== conversationId) throw new BotNetworkError('This thread is already bound to another exchange.', 'network_exchange_conflict');
    sqlite.prepare('UPDATE bot_network_threads SET conversation_id = ? WHERE thread_id = ?').run(conversationId, thread.threadId);
    sqlite.prepare("UPDATE bot_network_sends SET agent_message_id = ?, status = 'accepted' WHERE thread_id = ? AND client_id = ? AND status IN ('pending','accepted')").run(message.id, intent.threadId, intent.clientId);
  }).immediate();
}
/** Reconcile accepted bus messages after interruption, without resending anything. */
export function recoverNetworkSends(threadId: string, sqlite: Database.Database = getSqlite()) {
  for (const intent of listNetworkSendIntents(threadId, sqlite).filter(s => s.status === 'pending' && !s.messageId)) {
    const message = readAgentMessageByRequestId(intent.requestId, sqlite);
    if (message) completeNetworkSend(intent, message, sqlite);
  }
}
export function reserveNetworkSend(threadId: string, clientId: string, text: string, sqlite: Database.Database = getSqlite()): NetworkSendIntent {
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(clientId) || typeof text !== 'string' || !text.trim() || text.trim().length > AGENT_MESSAGE_TEXT_MAX_LENGTH) {
    throw new BotNetworkError('A stable send id and 1–4000 characters of text are required.', 'invalid_network_send', 400);
  }
  recoverNetworkSends(threadId, sqlite);
  return sqlite.transaction(() => {
    const thread = requireNetworkThread(threadId, sqlite);
    if (thread.participants.length !== 1) throw new BotNetworkError('This is a peer exchange. Open an operator conversation to message a bot.', 'network_peer_read_only');
    const intents = listNetworkSendIntents(threadId, sqlite);
    const prior = intents.find(s => s.clientId === clientId);
    if (prior) {
      if (prior.status === 'cancelled' || prior.status === 'rejected') throw new BotNetworkError('This send was removed or refused. Use a fresh send identity to send again.', `network_send_${prior.status}`);
      if (prior.text !== text.trim()) throw new BotNetworkError('That send id already belongs to another message.', 'network_send_conflict');
      return prior;
    }
    if (intents.some(s => s.status === 'pending' && !s.messageId)) throw new BotNetworkError('An earlier send is unconfirmed. Retry its original identity.', 'network_send_pending');
    const messages = thread.conversationId ? readAgentConversationMessages(thread.conversationId, sqlite) : [];
    const latest = messages.at(-1);
    if (latest && (latest.to.toLowerCase() !== 'operator' || latest.conversation?.status === 'closed')) throw new BotNetworkError('Wait for the addressed reply, or open a new exchange if this one is closed.', 'network_reply_unavailable');
    const requestId = `network:${createHash('sha256').update(JSON.stringify([threadId, clientId])).digest('hex')}`;
    const intent: NetworkSendIntent = { threadId, clientId, requestId, text: text.trim(),
      replyToId: latest?.id ?? null, messageId: null, createdAt: Date.now(), status: 'pending' };
    sqlite.prepare('INSERT INTO bot_network_sends(thread_id,client_id,bus_request_id,text,reply_to_id,created_at) VALUES (?,?,?,?,?,?)')
      .run(threadId, clientId, intent.requestId, intent.text, intent.replyToId, intent.createdAt);
    return intent;
  }).immediate();
}

export function assertNetworkSendActive(intent: NetworkSendIntent, sqlite: Database.Database = getSqlite()) {
  const current = listNetworkSendIntents(intent.threadId, sqlite).find(s => s.clientId === intent.clientId);
  if (!current || current.requestId !== intent.requestId || current.text !== intent.text || current.replyToId !== intent.replyToId) {
    throw new BotNetworkError('This send was removed before bus acceptance.', 'network_send_cancelled');
  }
  if (current.status === 'cancelled' || current.status === 'rejected') throw new BotNetworkError('This send was removed or refused before bus acceptance.', `network_send_${current.status}`);
}
/** Cancellation and known nonacceptance share the bus admission transaction fence. */
export function settleUnacceptedNetworkSend(intent: NetworkSendIntent, status: 'cancelled' | 'rejected', sqlite: Database.Database = getSqlite()): boolean {
  return sqlite.transaction(() => {
    if (readAgentMessageByRequestId(intent.requestId, sqlite)) return false;
    const updated = sqlite.prepare("UPDATE bot_network_sends SET status = ? WHERE thread_id = ? AND client_id = ? AND bus_request_id = ? AND agent_message_id IS NULL AND status = 'pending'")
      .run(status, intent.threadId, intent.clientId, intent.requestId).changes > 0;
    return updated || (status === 'cancelled' && listNetworkSendIntents(intent.threadId, sqlite).find(s => s.clientId === intent.clientId)?.status === 'cancelled');
  }).immediate();
}
