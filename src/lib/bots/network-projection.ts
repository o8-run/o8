import 'server-only';
import type Database from 'better-sqlite3';
import { getSqlite } from '@/lib/db';
import { readAgentConversationMessages } from '@/lib/agents/message-history';
import type { AgentMessage } from '@/lib/agents/types';
import { isOrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import { persistCanonicalChatHistoryRecord, readPersistedLlmChat, withCanonicalChatHistoryLock,
  type PersistedLlmChatMessage } from '@/lib/llm/chat-history-store';
import { findNetworkThread, listNetworkThreads, recoverNetworkSends } from './network-store';
import type { BotNetworkThread, NetworkMessageAuthor } from './network-types';
import { recordNetworkProjectionHealth } from './network-health';

function authorFor(message: AgentMessage, thread: BotNetworkThread): NetworkMessageAuthor {
  if (message.from.toLowerCase() === 'operator') return { kind: 'human', id: 'operator', name: 'You' };
  const identity = message.refs.identities?.from;
  const binding = identity && thread.participants.find(p => p.agentName.toLowerCase() === message.from.toLowerCase()
    && p.runtime === identity.runtime && p.sessionKey === identity.sessionKey);
  return { kind: 'bot', name: message.from,
    ...(identity ? { runtime: identity.runtime, sessionKey: identity.sessionKey } : {}),
    ...(binding ? { id: binding.memberId, agentId: binding.agentId } : {}) };
}
function projectMessage(message: AgentMessage, thread: BotNetworkThread): PersistedLlmChatMessage {
  const author = authorFor(message, thread);
  const runtime = message.refs.identities?.from?.runtime;
  return { id: `agent-message-${message.id}`, role: author.kind === 'human' ? 'user' : 'assistant', content: message.text,
    timestamp: Date.parse(message.timestamp), author, runtime,
    ...(runtime && isOrchestratorBackendId(runtime) ? { backend: runtime } : {}),
    network: { messageId: message.id, conversationId: message.conversation!.id, sequence: message.sequence,
      replyToId: message.conversation!.replyToId, from: message.from, to: message.to, delivery: message.delivery } };
}

/** Bus state is authoritative. The two durable stores do not share a transaction. */
export function projectNetworkThread(threadId: string, sqlite: Database.Database = getSqlite(), options: { waitForLock?: boolean } = {}): BotNetworkThread | null {
  if (!findNetworkThread(threadId, sqlite)) return null;
  try {
  return withCanonicalChatHistoryLock(threadId, () => {
    recoverNetworkSends(threadId, sqlite);
    const thread = findNetworkThread(threadId, sqlite)!;
    const messages = thread.conversationId ? readAgentConversationMessages(thread.conversationId, sqlite) : [];
    const existing = readPersistedLlmChat(threadId)?.history;
    const network = { conversationId: thread.conversationId, memberIds: thread.participants.map(p => p.memberId),
      canReply: thread.participants.length === 1, closed: messages.at(-1)?.conversation?.status === 'closed' };
    const record = { ...existing, source: 'bot-network' as const, network, repoPath: thread.repoPath,
      title: existing?.title || thread.title, messages: messages.map(m => projectMessage(m, thread)),
      savedAt: messages.at(-1)?.timestamp ?? thread.createdAt, orchestratorVisible: true };
    if (JSON.stringify(existing) !== JSON.stringify(record)) persistCanonicalChatHistoryRecord(threadId, record, record.savedAt);
    recordNetworkProjectionHealth(threadId, null);
    return thread;
  }, { timeoutMs: options.waitForLock === false ? 0 : undefined });
  } catch (error) {
    recordNetworkProjectionHealth(threadId, error);
    throw error;
  }
}
export function projectNetworkConversation(conversationId: string, sqlite: Database.Database = getSqlite()) {
  const thread = listNetworkThreads(sqlite).find(t => t.conversationId === conversationId);
  if (thread) projectNetworkThread(thread.threadId, sqlite);
}
export function projectAllNetworkThreads(sqlite: Database.Database = getSqlite()) {
  for (const thread of listNetworkThreads(sqlite)) {
    try { projectNetworkThread(thread.threadId, sqlite, { waitForLock: false }); }
    catch { /* Keep the remaining catalog available; health is exposed on this thread. */ }
  }
}
