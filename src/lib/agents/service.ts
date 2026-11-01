import 'server-only';

import type Database from 'better-sqlite3';

import type { RequestPrincipalContext } from '@/lib/auth/principal';
import { codename } from '@/lib/agents/codename';
import { isAgentInboxWakePending } from '@/lib/agents/inbox-wake';
import { getSqlite } from '@/lib/db';
import { projectNetworkConversation } from '@/lib/bots/network-projection';
import { findLaneByPacket, getLane } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import {
  type AgentInboxWakeSeams,
  type AgentMessageDeliverySeams,
  defaultAgentMessageDeliverySeams,
  deliverAgentMessage,
} from './delivery';
import {
  availableAutomaticAgentName,
  type LiveAgentPresenceSeams,
  defaultLiveAgentPresenceSeams,
  reconcileAllLiveAgentPresence,
  reconcileLiveAgentPresence,
} from './live-presence';
import {
  AGENT_MESSAGE_TEXT_MAX_LENGTH,
  AgentConversationError,
  AgentPresenceWriteConflictError,
  type AgentMessageRefs,
  type AgentPresence,
  type AgentPresenceWriteResult,
  acknowledgeAgentInbox,
  claimAgentInboxWake,
  findAgentPresence,
  getAgentInboxCursor,
  isPresenceLive,
  listAgentInbox,
  listAgentPresence,
  listAgentPresenceAcrossRepos,
  listRecentAgentMessages,
  listRecentAgentMessagesAcrossRepos,
  listAgentConversations,
  normalizeAgentBusRepoPath,
  persistAgentMessage,
  releaseAgentInboxWake,
  updateAgentMessageDelivery,
  updateAgentConversation,
  upsertAgentPresence,
} from './store';

const LABEL_MAX_LENGTH = 160;

export class AgentBusError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AgentBusError';
  }
}

function objectInput(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentBusError('A JSON object is required.', code, 400);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, maxLength = LABEL_MAX_LENGTH): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentBusError(`${name} is required.`, `invalid_${name}`, 400);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new AgentBusError(`${name} must be at most ${maxLength} characters.`, `invalid_${name}`, 400);
  }
  return normalized;
}

function optionalString(value: unknown, name: string, maxLength = LABEL_MAX_LENGTH): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new AgentBusError(`${name} must be a string.`, `invalid_${name}`, 400);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new AgentBusError(`${name} must be at most ${maxLength} characters.`, `invalid_${name}`, 400);
  }
  return normalized || null;
}

function lanePresence(lane: Lane, lastSeen: string): AgentPresence {
  return {
    agentId: lane.id,
    name: codename(lane.id),
    repo: lane.repoPath,
    worktreePath: lane.worktreePath,
    runtime: lane.runtime,
    sessionKey: lane.sessionKey,
    laneId: lane.id,
    packetId: lane.packetId,
    lastSeen,
  };
}

export function heartbeatAgentPresence(
  lane: Lane,
  heartbeatAt: number,
  sqlite: Database.Database = getSqlite(),
): AgentPresence {
  return upsertAgentPresence(lanePresence(lane, new Date(heartbeatAt).toISOString()), sqlite);
}

function requireBusPrincipal(principal: RequestPrincipalContext): void {
  if (principal.role !== 'operator' && principal.role !== 'worker') {
    throw new AgentBusError(
      'Agent messaging requires an operator or packet-bound worker credential.',
      'agent_bus_forbidden',
      403,
    );
  }
  if (principal.role === 'worker' && !principal.packetId) {
    throw new AgentBusError('Worker credential is not packet-bound.', 'agent_bus_packet_required', 403);
  }
}

function workerLane(principal: RequestPrincipalContext): Lane | null {
  return principal.role === 'worker' && principal.packetId
    ? findLaneByPacket(principal.packetId)
    : null;
}

function messageRefs(body: Record<string, unknown>, lane: Lane | null): AgentMessageRefs {
  const refs = body.refs && typeof body.refs === 'object' && !Array.isArray(body.refs)
    ? body.refs as Record<string, unknown>
    : {};
  return {
    laneId: lane?.id ?? optionalString(refs.laneId, 'laneId'),
    packetId: lane?.packetId ?? optionalString(refs.packetId, 'packetId'),
  };
}

function normalizedAgentAlias(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function presenceMatchesRuntimeAlias(presence: AgentPresence, target: string): boolean {
  const runtime = normalizedAgentAlias(presence.runtime);
  return target === runtime || target === runtime.split('-')[0];
}

function resolveAgentTarget(
  to: string,
  repo: string | null,
  sqlite: Database.Database,
): AgentPresence | null {
  const exact = findAgentPresence({ name: to, repo }, sqlite);
  if (exact && isPresenceLive(exact)) return exact;
  if (!repo) return exact;

  const alias = normalizedAgentAlias(to);
  const candidates = listAgentPresence(repo, {}, sqlite)
    .filter((presence) => presenceMatchesRuntimeAlias(presence, alias));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new AgentBusError(
      `Agent name ${to} is ambiguous in that repository. Use one of: ${candidates.map((candidate) => candidate.name).join(', ')}.`,
      'agent_target_ambiguous',
      409,
    );
  }
  return exact;
}

function projectNetworkMessage(message: import('./types').AgentMessage, sqlite: Database.Database) {
  try {
    if (message.conversation) projectNetworkConversation(message.conversation.id, sqlite);
  } catch (error) {
    // Acceptance belongs to the bus. A later history read repairs this projection.
    console.warn('[bot-network] Accepted message awaits transcript projection:', error instanceof Error ? error.message : String(error));
  }
  return message;
}

/** Internal admission fence for a saved local delivery context; never read from the wire. */
export interface AgentMessageAdmission {
  expectedTarget?: Pick<AgentPresence, 'agentId' | 'name' | 'repo' | 'runtime' | 'sessionKey'>;
  beforePersist?: () => void;
  /** Local routing metadata in the same SQLite transaction; never file projection. */
  afterPersist?: (message: import('./types').AgentMessage) => void;
}
function assertExpectedTarget(target: AgentPresence | null, expected: NonNullable<AgentMessageAdmission['expectedTarget']>) {
  if (!target || target.agentId !== expected.agentId || target.name !== expected.name || target.repo !== expected.repo
    || target.runtime !== expected.runtime || target.sessionKey !== expected.sessionKey) {
    throw new AgentBusError('The recorded recipient session is unavailable or changed.', 'agent_target_context_changed', 409);
  }
}

export async function postAgentMessage(
  input: unknown,
  principal: RequestPrincipalContext,
  seams: AgentMessageDeliverySeams = defaultAgentMessageDeliverySeams,
  sqlite: Database.Database = getSqlite(),
  presenceSeams: LiveAgentPresenceSeams = defaultLiveAgentPresenceSeams,
  admission?: AgentMessageAdmission,
) {
  requireBusPrincipal(principal);
  const body = objectInput(input, 'invalid_agent_message');
  const lane = workerLane(principal);
  if (principal.role === 'worker' && !lane) {
    throw new AgentBusError('The worker packet has no active lane.', 'agent_bus_lane_not_found', 404);
  }
  const to = requiredString(body.to, 'to');
  const replyToId = optionalString(body.replyToId, 'replyToId', 200);
  let repo = optionalString(body.repo, 'repo', 2_000);
  let sender: AgentPresence | null = null;
  if (lane) {
    repo = normalizeAgentBusRepoPath(lane.repoPath);
    sender = upsertAgentPresence(lanePresence(lane, new Date().toISOString()), sqlite);
  } else if (typeof body.fromAgentId === 'string') {
    sender = findAgentPresence({ agentId: body.fromAgentId }, sqlite);
    if (!sender) {
      throw new AgentBusError('Sender has not joined presence.', 'agent_sender_not_found', 404);
    }
    if (sender.repo !== normalizeAgentBusRepoPath(sender.repo)) {
      throw new AgentBusError('Sender repository scope needs collision resolution.', 'agent_sender_repo_mismatch', 403);
    }
    if (repo && sender.repo !== repo && sender.repo !== normalizeAgentBusRepoPath(repo)) {
      throw new AgentBusError('Sender is not present in that repository.', 'agent_sender_repo_mismatch', 403);
    }
    repo = sender.repo;
  }
  if (repo) await reconcileLiveAgentPresence(repo, presenceSeams, sqlite);
  const target = admission?.expectedTarget ? findAgentPresence({ agentId: admission.expectedTarget.agentId }, sqlite) : replyToId && to.toLowerCase() === 'operator' && repo ? {
    agentId: 'operator',
    name: 'operator',
    repo: normalizeAgentBusRepoPath(repo),
    worktreePath: null,
    runtime: 'operator',
    sessionKey: null,
    laneId: null,
    packetId: null,
    lastSeen: new Date().toISOString(),
  } satisfies AgentPresence : resolveAgentTarget(to, repo, sqlite);
  if (admission?.expectedTarget) {
    assertExpectedTarget(target, admission.expectedTarget);
    if (target!.name !== to || target!.repo !== normalizeAgentBusRepoPath(repo!)) throw new AgentBusError('The expected target does not match the send address.', 'agent_target_context_changed', 409);
  }
  if (!target) {
    throw new AgentBusError(
      repo ? `No agent named ${to} is registered in that repository.` : `Agent name ${to} is absent or ambiguous.`,
      'agent_target_not_found',
      404,
    );
  }
  if (lane && target.repo !== normalizeAgentBusRepoPath(lane.repoPath)) {
    throw new AgentBusError('Workers can message only agents in their repository.', 'agent_repo_mismatch', 403);
  }
  const text = requiredString(body.text, 'text', AGENT_MESSAGE_TEXT_MAX_LENGTH);
  const requestId = optionalString(body.requestId, 'requestId', 200);
  if (body.close !== undefined && typeof body.close !== 'boolean') {
    throw new AgentBusError('close must be a boolean.', 'invalid_agent_close', 400);
  }
  if (replyToId && !sender && body.from !== undefined && body.from !== 'operator') {
    throw new AgentBusError('Operator replies must use the operator identity.', 'agent_reply_sender_forbidden', 403);
  }
  let persisted;
  try {
    const persist = () => persistAgentMessage({
      from: sender?.name ?? (replyToId ? 'operator' : optionalString(body.from, 'from') ?? 'operator'),
      to: target.name,
      repo: target.repo,
      text,
      refs: {
        ...messageRefs(body, lane),
        identities: {
          from: sender ? { runtime: sender.runtime, sessionKey: sender.sessionKey } : null,
          to: target.runtime === 'operator' ? null : { runtime: target.runtime, sessionKey: target.sessionKey },
        },
      },
      replyToId,
      requestId,
      close: body.close === true,
    }, sqlite);
    persisted = admission ? sqlite.transaction(() => {
      admission.beforePersist?.();
      if (admission.expectedTarget) assertExpectedTarget(findAgentPresence({ agentId: admission.expectedTarget.agentId }, sqlite), admission.expectedTarget);
      const accepted = persist();
      admission.afterPersist?.(accepted.message);
      return accepted;
    }).immediate() : persist();
  } catch (error) {
    if (error instanceof AgentConversationError) {
      throw new AgentBusError(error.message, error.code, error.status);
    }
    throw error;
  }
  let { message } = persisted;
  if (!persisted.created) return projectNetworkMessage(message, sqlite);
  if (target.runtime === 'operator') {
    return projectNetworkMessage(updateAgentMessageDelivery(message.id, 'poll', 'Available in the operator Handoffs view.', sqlite), sqlite);
  }
  if (!isPresenceLive(target)) return projectNetworkMessage(message, sqlite);
  const wakeSeams: AgentInboxWakeSeams = {
    claimCodexInboxWake: ({ target: wakeTarget, throughSequence }) => (
      claimAgentInboxWake({ agent: wakeTarget, throughSequence }, sqlite)
    ),
    releaseCodexInboxWake: (wakeTarget, reservationId) => releaseAgentInboxWake(wakeTarget, reservationId, sqlite),
    isCodexInboxWakePending: (wakeTarget, reservationId) => isAgentInboxWakePending(wakeTarget, reservationId, sqlite),
  };
  try {
    const result = await deliverAgentMessage(message, target, seams, wakeSeams);
    message = updateAgentMessageDelivery(message.id, result.delivery, result.note, sqlite);
  } catch (error) {
    message = updateAgentMessageDelivery(
      message.id,
      'poll',
      `Live delivery deferred; retained in the durable inbox. ${error instanceof Error ? error.message : String(error)}`,
      sqlite,
    );
  }
  return projectNetworkMessage(message, sqlite);
}

export function readAgentConversations(
  input: { repo: string | null; limit: number },
  principal: RequestPrincipalContext,
  sqlite: Database.Database = getSqlite(),
) {
  if (principal.role !== 'operator') {
    throw new AgentBusError('Conversation history requires an operator credential.', 'agent_conversations_forbidden', 403);
  }
  const repo = requiredString(input.repo, 'repo', 2_000);
  return { repo: normalizeAgentBusRepoPath(repo), conversations: listAgentConversations(repo, input.limit, sqlite) };
}

export function changeAgentConversation(
  input: unknown,
  principal: RequestPrincipalContext,
  sqlite: Database.Database = getSqlite(),
) {
  if (principal.role !== 'operator') {
    throw new AgentBusError('Only the operator can stop or extend a conversation.', 'agent_conversation_operator_required', 403);
  }
  const body = objectInput(input, 'invalid_agent_conversation');
  const id = requiredString(body.id, 'id', 200);
  const repo = requiredString(body.repo, 'repo', 2_000);
  if (body.action !== 'close' && body.action !== 'extend') {
    throw new AgentBusError('action must be close or extend.', 'invalid_agent_conversation_action', 400);
  }
  const summary = optionalString(body.summary, 'summary', AGENT_MESSAGE_TEXT_MAX_LENGTH);
  try {
    return updateAgentConversation({ id, repo, action: body.action, summary }, sqlite);
  } catch (error) {
    if (error instanceof AgentConversationError) {
      throw new AgentBusError(error.message, error.code, error.status);
    }
    throw error;
  }
}

export function joinAgentPresence(
  input: unknown,
  principal: RequestPrincipalContext,
  sqlite: Database.Database = getSqlite(),
): AgentPresenceWriteResult {
  if (principal.role !== 'operator') {
    throw new AgentBusError('Presence join requires an operator credential.', 'agent_presence_join_forbidden', 403);
  }
  const body = objectInput(input, 'invalid_agent_presence');
  const agentId = requiredString(body.agentId, 'agentId');
  const repo = requiredString(body.repo, 'repo', 2_000);
  const automatic = body.automatic === true;
  const name = automatic
    ? optionalString(body.name, 'name') ?? availableAutomaticAgentName(agentId, normalizeAgentBusRepoPath(repo), sqlite)
    : requiredString(body.name, 'name');
  try {
    return upsertAgentPresence({
      agentId,
      name,
      repo,
      worktreePath: optionalString(body.worktreePath, 'worktreePath', 2_000),
      runtime: requiredString(body.runtime, 'runtime'),
      sessionKey: optionalString(body.sessionKey, 'sessionKey', 500),
      laneId: null,
      packetId: null,
      lastSeen: new Date().toISOString(),
    }, sqlite);
  } catch (error) {
    if (error instanceof AgentPresenceWriteConflictError) {
      throw new AgentBusError(error.message, error.code, error.status);
    }
    throw error;
  }
}

export async function readAgentPresence(
  repo: string | null,
  principal: RequestPrincipalContext,
  includeStale = false,
  sqlite: Database.Database = getSqlite(),
  presenceSeams: LiveAgentPresenceSeams = defaultLiveAgentPresenceSeams,
): Promise<AgentPresence[]> {
  requireBusPrincipal(principal);
  if (includeStale && principal.role !== 'operator') {
    throw new AgentBusError('Presence history requires an operator credential.', 'agent_presence_history_forbidden', 403);
  }
  const lane = workerLane(principal);
  if (principal.role === 'worker' && !lane) {
    throw new AgentBusError('The worker packet has no active lane.', 'agent_bus_lane_not_found', 404);
  }
  const requestedRepo = normalizeAgentBusRepoPath(lane?.repoPath ?? requiredString(repo, 'repo', 2_000));
  if (lane && repo && normalizeAgentBusRepoPath(repo) !== normalizeAgentBusRepoPath(lane.repoPath)) {
    throw new AgentBusError('Workers can inspect only their repository.', 'agent_repo_mismatch', 403);
  }
  await reconcileLiveAgentPresence(requestedRepo, presenceSeams, sqlite);
  return listAgentPresence(requestedRepo, { includeStale }, sqlite);
}

export async function readAllAgentPresence(
  principal: RequestPrincipalContext,
  sqlite: Database.Database = getSqlite(),
  presenceSeams: LiveAgentPresenceSeams = defaultLiveAgentPresenceSeams,
): Promise<AgentPresence[]> {
  if (principal.role !== 'operator') {
    throw new AgentBusError(
      'Fleet agent presence requires an operator credential.',
      'agent_presence_fleet_forbidden',
      403,
    );
  }
  await reconcileAllLiveAgentPresence(presenceSeams, sqlite);
  return listAgentPresenceAcrossRepos({}, sqlite);
}

/** Read persisted identities for transcript decoration without probing runtimes. */
export function readStoredAgentPresence(
  principal: RequestPrincipalContext,
  sqlite: Database.Database = getSqlite(),
): AgentPresence[] {
  if (principal.role !== 'operator') {
    throw new AgentBusError(
      'Fleet agent presence requires an operator credential.',
      'agent_presence_fleet_forbidden',
      403,
    );
  }
  return listAgentPresenceAcrossRepos({ includeStale: true }, sqlite);
}

function parseCursor(cursor: string | null): number {
  if (!cursor) return 0;
  try {
    const parsed = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  } catch {
    // Typed error below.
  }
  throw new AgentBusError('Inbox cursor is invalid.', 'invalid_agent_inbox_cursor', 400);
}

export function readAgentInbox(
  input: { agent: string | null; agentId: string | null; cursor: string | null; limit: number },
  principal: RequestPrincipalContext,
  sqlite: Database.Database = getSqlite(),
) {
  requireBusPrincipal(principal);
  const lane = workerLane(principal);
  const agent = lane
    ? findAgentPresence({ agentId: lane.id }, sqlite)
      ?? upsertAgentPresence(lanePresence(lane, new Date().toISOString()), sqlite)
    : findAgentPresence({ agentId: input.agentId, name: input.agent }, sqlite);
  if (!agent) throw new AgentBusError('Inbox agent was not found.', 'agent_inbox_not_found', 404);
  if (lane && agent.agentId !== lane.id) {
    throw new AgentBusError('Workers can read only their own inbox.', 'agent_inbox_forbidden', 403);
  }
  const acknowledgesDelivery = lane !== null || input.agentId !== null;
  const after = input.cursor
    ? parseCursor(input.cursor)
    : acknowledgesDelivery
      ? getAgentInboxCursor(agent, sqlite)
      : 0;
  const page = listAgentInbox({
    agent,
    after,
    limit: input.limit,
    includeDelivered: !acknowledgesDelivery,
  }, sqlite);
  if (acknowledgesDelivery) {
    acknowledgeAgentInbox({ agent, throughSequence: page.cursor }, sqlite);
  }
  return {
    agent,
    messages: acknowledgesDelivery
      ? page.messages.map((message) => message.delivery === 'native' ? message : {
        ...message,
        delivery: 'native' as const,
        deliveryNote: 'Read from the durable inbox by the target session.',
      })
      : page.messages,
    cursor: Buffer.from(String(page.cursor), 'utf8').toString('base64url'),
    hasMore: page.hasMore,
  };
}

export function readAgentExchanges(
  input: { repo: string | null; limit: number },
  principal: RequestPrincipalContext,
  sqlite: Database.Database = getSqlite(),
) {
  if (principal.role !== 'operator') {
    throw new AgentBusError(
      'Recent agent exchanges require an operator credential.',
      'agent_exchanges_forbidden',
      403,
    );
  }
  const repo = requiredString(input.repo, 'repo', 2_000);
  return {
    repo: normalizeAgentBusRepoPath(repo),
    messages: listRecentAgentMessages(repo, input.limit, sqlite),
  };
}

export function readAllAgentExchanges(
  limit: number,
  principal: RequestPrincipalContext,
  sqlite: Database.Database = getSqlite(),
) {
  if (principal.role !== 'operator') {
    throw new AgentBusError(
      'Recent agent exchanges require an operator credential.',
      'agent_exchanges_forbidden',
      403,
    );
  }
  return { messages: listRecentAgentMessagesAcrossRepos(limit, sqlite) };
}

export function laneForPresenceHeartbeat(laneId: string): Lane | null {
  return getLane(laneId);
}
