import 'server-only';
import type Database from 'better-sqlite3';
import type { RequestPrincipalContext } from '@/lib/auth/principal';
import { getSqlite } from '@/lib/db';
import { findAgentPresence, normalizeAgentBusRepoPath } from '@/lib/agents/store';
import { readAgentMessageByRequestId } from '@/lib/agents/message-history';
import { AgentBusError, postAgentMessage } from '@/lib/agents/service';
import { BotNetworkError } from './network-types';
import { assertNetworkSendActive, completeNetworkSend, settleUnacceptedNetworkSend, listNetworkSendIntents, requireNetworkThread, reserveNetworkSend } from './network-store';
import { projectNetworkThread } from './network-projection';

export function networkComposerTarget(input: unknown, sqlite: Database.Database = getSqlite()) {
  const value = input as { threadId?: unknown; repoPath?: unknown } | null;
  if (!value || typeof value.threadId !== 'string' || typeof value.repoPath !== 'string') {
    throw new BotNetworkError('A saved network thread and repository are required.', 'invalid_network_target', 400);
  }
  const thread = requireNetworkThread(value.threadId, sqlite);
  if (normalizeAgentBusRepoPath(value.repoPath) !== thread.repoPath) throw new BotNetworkError('This reply belongs to another repository.', 'network_repository_mismatch');
  return thread;
}

/** Native human composition uses the existing operator bus path, never an agent's identity. */
export async function postNetworkComposerMessage(input: unknown, principal: RequestPrincipalContext, sqlite: Database.Database = getSqlite()) {
  if (principal.role !== 'operator') throw new BotNetworkError('Network composition requires the existing operator bus principal.', 'network_composer_forbidden', 403);
  const body = input as { id?: unknown; payload?: Record<string, unknown>; intent?: unknown } | null;
  const thread = networkComposerTarget(input, sqlite);
  if (!body || body.intent !== 'send-next' || typeof body.id !== 'string' || !body.payload
    || typeof body.payload.text !== 'string' || !Array.isArray(body.payload.images) || body.payload.images.length
    || body.payload.afterTaskId !== undefined) throw new BotNetworkError('Network replies accept plain text through their saved exchange.', 'invalid_network_payload', 400);
  const intent = reserveNetworkSend(thread.threadId, body.id, body.payload.text, sqlite);
  try {
    let message = readAgentMessageByRequestId(intent.requestId, sqlite);
    if (!message) {
      const target = thread.participants[0];
      const presence = findAgentPresence({ agentId: target.agentId }, sqlite);
      if (!presence || presence.repo !== target.repo || presence.name !== target.agentName
        || presence.runtime !== target.runtime || presence.sessionKey !== target.sessionKey) {
        throw new BotNetworkError('The recorded local session is unavailable. Its binding has not been replaced.', 'network_session_unavailable');
      }
      message = await postAgentMessage({ repo: thread.repoPath, to: target.agentName, text: intent.text,
        replyToId: intent.replyToId, requestId: intent.requestId }, principal, undefined, sqlite, undefined, {
          expectedTarget: { agentId: target.agentId, name: target.agentName, repo: thread.repoPath, runtime: target.runtime, sessionKey: target.sessionKey },
          beforePersist: () => assertNetworkSendActive(intent, sqlite),
        });
    }
    completeNetworkSend(intent, message, sqlite);
    projectNetworkThread(thread.threadId, sqlite);
    return { id: body.id, repoPath: thread.repoPath, threadId: thread.threadId, payload: body.payload,
      intent: 'send-next', status: 'applied', sequence: message.sequence, createdAt: intent.createdAt,
      updatedAt: Date.parse(message.timestamp), admittedAt: Date.parse(message.timestamp), message };
  } catch (error) {
    if ((error instanceof BotNetworkError || error instanceof AgentBusError) && error.status >= 400 && error.status < 500) {
      if (settleUnacceptedNetworkSend(intent, 'rejected', sqlite) || error.code === 'network_send_cancelled' || error.code === 'network_send_rejected') {
        throw new BotNetworkError(error.message, error.code, error.status);
      }
    }
    throw new BotNetworkError('Bus acceptance or transcript projection is unconfirmed. Retry this same message identity.', 'network_send_unconfirmed', 503);
  }
}

export function cancelNetworkComposerSend(input: unknown, principal: RequestPrincipalContext, sqlite: Database.Database = getSqlite()) {
  if (principal.role !== 'operator') throw new BotNetworkError('Network composition requires the existing operator bus principal.', 'network_composer_forbidden', 403);
  const thread = networkComposerTarget(input, sqlite);
  const id = (input as { id?: unknown }).id;
  const intent = listNetworkSendIntents(thread.threadId, sqlite).find(s => s.clientId === id);
  if (!intent || !settleUnacceptedNetworkSend(intent, 'cancelled', sqlite)) throw new BotNetworkError('This message is already accepted or was not found.', 'network_send_accepted');
  return { ok: true };
}
export async function retryNetworkComposerSend(input: unknown, principal: RequestPrincipalContext, sqlite: Database.Database = getSqlite()) {
  const thread = networkComposerTarget(input, sqlite);
  const intent = listNetworkSendIntents(thread.threadId, sqlite).find(s => s.clientId === (input as { id?: unknown }).id);
  if (!intent) throw new BotNetworkError('The original send was not found.', 'network_send_missing');
  return postNetworkComposerMessage({ ...input as object, intent: 'send-next', payload: { text: intent.text, wireMessage: intent.text, images: [], routing: { source: 'bot-network' } } }, principal, sqlite);
}

/** Explicit terminal receipts let a native retry retire only its own cached identity. */
export function readNetworkSendReceipt(input: unknown, sqlite: Database.Database = getSqlite()) {
  const value = input as { threadId?: unknown; id?: unknown } | null;
  if (!value || typeof value.threadId !== 'string' || typeof value.id !== 'string') return null;
  const intent = listNetworkSendIntents(value.threadId, sqlite).find(send => send.clientId === value.id);
  if (!intent) return null;
  const accepted = readAgentMessageByRequestId(intent.requestId, sqlite);
  const status = accepted ? 'accepted' : intent.status;
  if (status === 'pending') return null;
  return { id: intent.clientId, threadId: intent.threadId, status, ...(accepted ? { messageId: accepted.id } : {}) };
}

export function readNetworkComposerQueue(input: unknown, sqlite: Database.Database = getSqlite()) {
  const thread = networkComposerTarget(input, sqlite);
  projectNetworkThread(thread.threadId, sqlite);
  return { canSteer: false, steerableIds: [], items: listNetworkSendIntents(thread.threadId, sqlite).filter(s => s.status === 'pending' && !s.messageId).map(s => ({
    id: s.clientId, repoPath: thread.repoPath, threadId: thread.threadId, status: 'held', intent: 'send-next', sequence: s.createdAt,
    payload: { text: s.text, wireMessage: s.text, images: [], routing: { source: 'bot-network' } },
    createdAt: s.createdAt, updatedAt: s.createdAt, admittedAt: null,
    reason: 'This bus send is unconfirmed. Retry the original message identity.',
  })) };
}
