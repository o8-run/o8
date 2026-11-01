import 'server-only';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { listBotMembers } from '@/lib/agents/bot-membership-store';
import { AgentBusError, postAgentMessage, readAgentInbox } from '@/lib/agents/service';
import { findAgentPresence } from '@/lib/agents/store';
import { readAgentMessageByRequestId } from '@/lib/agents/message-history';
import type { AgentMessage, BotMemberBinding } from '@/lib/agents/types';
import { getSqlite } from '@/lib/db';
import { bindNetworkExchange, listNetworkThreads } from './network-store';
import { projectNetworkThread } from './network-projection';

/** Explicit local delivery reference. It does not authenticate or enroll a session. */
export function requireNetworkMcpBinding(bindingId: string, sqlite: Database.Database = getSqlite()) {
  const binding = listBotMembers(sqlite).flatMap(member => member.bindings).find(item => item.id === bindingId);
  const current = binding && findAgentPresence({ agentId: binding.agentId }, sqlite);
  if (!binding || !current || current.name !== binding.agentName || current.repo !== binding.repo
    || current.runtime !== binding.runtime || current.sessionKey !== binding.sessionKey) {
    throw new AgentBusError('The explicitly configured local binding is unavailable or changed.', 'network_binding_unavailable', 409);
  }
  return binding;
}
export function listNetworkMcpTeam(bindingId: string) {
  const self = requireNetworkMcpBinding(bindingId);
  return { schema: 'o8/network.team/v1', self: { memberId: self.memberId, bindingId: self.id }, repo: self.repo,
    members: listBotMembers().map(member => ({ id: member.id, house: member.house, name: member.name,
      homeThreadId: member.homeThreadId, bindings: member.bindings.filter(b => b.repo === self.repo) })) };
}
function projection(threadId: string) {
  try { projectNetworkThread(threadId); return { threadId, state: 'ready' as const }; }
  catch { return { threadId, state: 'pending' as const }; }
}
function snapshot(binding: BotMemberBinding) {
  const { live: _live, createdAt: _createdAt, ...participant } = binding;
  return participant;
}
function sendResult(message: AgentMessage, threadId: string) {
  return { schema: 'o8/network.send/v1', message,
    receipt: { stage: 'accepted', messageId: message.id, sequence: message.sequence,
      delivery: message.delivery, deliveryNote: message.deliveryNote, processing: 'unknown' },
    projection: projection(threadId) };
}
export async function sendNetworkMcpMessage(bindingId: string, args: Record<string, unknown>) {
  const requestId = `network-mcp:${createHash('sha256').update(JSON.stringify([bindingId, args.requestId])).digest('hex')}`;
  const prior = readAgentMessageByRequestId(requestId);
  if (prior) {
    const thread = listNetworkThreads().find(item => item.conversationId === prior.conversation?.id);
    const sender = thread?.participants.find(item => item.id === bindingId);
    const target = thread?.participants.find(item => item.id === args.to);
    const original = getSqlite().prepare('SELECT requested_close FROM agent_messages WHERE client_request_id = ?').get(requestId) as { requested_close: number };
    const recipientMatches = args.to === 'operator' ? prior.to === 'operator' : target?.agentName === prior.to
      && target.runtime === prior.refs.identities?.to?.runtime && target.sessionKey === prior.refs.identities?.to?.sessionKey;
    if (!sender || sender.agentName !== prior.from || sender.runtime !== prior.refs.identities?.from?.runtime
      || sender.sessionKey !== prior.refs.identities?.from?.sessionKey || !recipientMatches || prior.text !== (args.text as string).trim()
      || prior.conversation?.replyToId !== (typeof args.replyToId === 'string' ? args.replyToId.trim() : null)
      || Boolean(original.requested_close) !== Boolean(args.close)) {
      throw new AgentBusError('Request ID was already used for a different message.', 'agent_request_conflict', 409);
    }
    return sendResult(prior, thread!.threadId);
  }
  const self = requireNetworkMcpBinding(bindingId);
  const to = args.to as string;
  const target = to === 'operator' ? null : requireNetworkMcpBinding(to);
  if (target && (target.repo !== self.repo || target.agentId === self.agentId)) {
    throw new AgentBusError('Select a distinct explicit binding in this repository.', 'network_recipient_mismatch', 409);
  }
  if (!target && !args.replyToId) throw new AgentBusError('An operator reply needs the latest message id.', 'network_operator_reply_required', 400);
  const participants = [self, ...(target ? [target] : [])].sort((a, b) => a.id.localeCompare(b.id)).map(snapshot);
  let threadId = '';
  const message = await postAgentMessage({ fromAgentId: self.agentId, repo: self.repo,
    to: target?.agentName ?? 'operator', text: args.text, requestId, replyToId: args.replyToId, close: args.close },
  { role: 'operator' }, undefined, getSqlite(), undefined, {
    expectedTarget: target ? { agentId: target.agentId, name: target.agentName, repo: target.repo,
      runtime: target.runtime, sessionKey: target.sessionKey } : undefined,
    beforePersist: () => {
      requireNetworkMcpBinding(bindingId);
      if (target) requireNetworkMcpBinding(target.id);
    },
    afterPersist: accepted => { threadId = bindNetworkExchange(accepted, participants).threadId; },
  });
  return sendResult(message, threadId);
}
export function checkNetworkMcpInbox(bindingId: string, args: Record<string, unknown>) {
  const sqlite = getSqlite();
  const page = sqlite.transaction(() => {
    const self = requireNetworkMcpBinding(bindingId, sqlite);
    return readAgentInbox({ agent: null, agentId: self.agentId,
      cursor: typeof args.cursor === 'string' ? args.cursor : null, limit: typeof args.limit === 'number' ? args.limit : 50 }, { role: 'operator' }, sqlite);
  }).immediate();
  const threads = listNetworkThreads();
  const projections = new Map<string, ReturnType<typeof projection>>();
  const messages = page.messages.map(message => {
    const thread = threads.find(t => t.conversationId === message.conversation?.id);
    if (thread && !projections.has(thread.threadId)) projections.set(thread.threadId, projection(thread.threadId));
    return { ...message, threadId: thread?.threadId ?? null };
  });
  return { schema: 'o8/network.inbox/v1', messages, cursor: page.cursor, hasMore: page.hasMore,
    acknowledgement: { stage: 'target-session-inbox-read', throughCursor: page.cursor, processing: 'unknown' },
    projections: [...projections.values()] };
}
