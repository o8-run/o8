import 'server-only';

import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { getSqlite } from '@/lib/db';
import { ensureV45BroadcastFocusSchema } from '@/lib/db/v45-broadcast-focus-migration';
import { ensureV76BotMembershipSchema } from '@/lib/db/v76-bot-membership-migration';
import { parseMessageRefs } from './message-refs';
import type { AgentConversationReceipt, AgentMessage, AgentMessageRefs, AgentPresence } from './types';
import { normalizeAgentBusRepoPath, reconcilePersistedAgentBusRepoPaths } from './repo-paths';

export type { AgentMessage, AgentMessageRefs, AgentPresence } from './types';
export { normalizeAgentBusRepoPath } from './repo-paths';
export const AGENT_MESSAGE_TEXT_MAX_LENGTH = 4_000;
export const AGENT_CONVERSATION_DEFAULT_LIMIT = 8;
export const AGENT_CONVERSATION_EXTENSION = 4;
export const AGENT_CONVERSATION_MAX_LIMIT = 24;
export const AGENT_PRESENCE_TTL_MS = 6 * 60_000;
// Re-wake after a bounded delay so a lost queued turn cannot silence a target indefinitely.
export const AGENT_NATIVE_WAKE_TTL_MS = 15 * 60_000;

export type AgentPresenceWriteResult = AgentPresence & {
  adoptedLegacy?: true;
  tookOverStale?: true;
};

export class AgentPresenceWriteConflictError extends Error {
  readonly code = 'foreign_identity';
  readonly status = 409;

  constructor(readonly owner: AgentPresence, attemptedSessionKey: string | null) {
    super(
      `This status line is owned by @${owner.name} (${owner.sessionKey}); your session is ${attemptedSessionKey}.`,
    );
    this.name = 'AgentPresenceWriteConflictError';
  }
}

export class AgentConversationError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = 'AgentConversationError';
  }
}

interface PresenceRow {
  agent_id: string;
  name: string;
  repo_path: string;
  worktree_path: string | null;
  runtime: string;
  session_key: string | null;
  lane_id: string | null;
  packet_id: string | null;
  last_seen: string;
}

export interface MessageRow {
  sequence: number;
  id: string;
  from_agent: string;
  to_agent: string;
  repo_path: string;
  text: string;
  refs_json: string;
  conversation_id: string | null;
  reply_to_id: string | null;
  turn_index: number | null;
  closes_conversation: number;
  requested_close: number;
  client_request_id: string | null;
  delivery_status: 'native' | 'poll' | 'failed';
  delivery_note: string | null;
  created_at: string;
}

interface ConversationRow {
  id: string;
  repo_path: string;
  participant_a: string;
  participant_b: string;
  turn_count: number;
  turn_limit: number;
  last_message_id: string | null;
  closed_at: string | null;
  closed_reason: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentConversation {
  id: string;
  repo: string;
  participants: [string, string];
  turnCount: number;
  turnLimit: number;
  remainingTurns: number;
  lastMessageId: string | null;
  status: 'open' | 'closed';
  closedReason: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

interface InboxStateRow {
  acknowledged_sequence: number;
  native_wake_session_key: string | null;
  native_wake_through_sequence: number;
  native_wake_at: string | null;
}

function expandBroadcastTextLimit(sqlite: Database.Database): void {
  const row = sqlite.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'broadcast_events'
  `).get() as { sql: string | null } | undefined;
  const original = row?.sql ?? '';
  if (!original.includes('BETWEEN 1 AND 2000')) return;
  const replacement = original
    .replace(/CREATE TABLE\s+["`\[]?broadcast_events["`\]]?/i, 'CREATE TABLE broadcast_events_agent_bus')
    .replace('BETWEEN 1 AND 2000', 'BETWEEN 1 AND 4000');
  sqlite.transaction(() => {
    sqlite.exec(replacement);
    sqlite.exec(`
      INSERT INTO broadcast_events_agent_bus
        (sequence, id, kind, actor, audience, text, lane_id, packet_id, metadata_json, created_at)
      SELECT sequence, id, kind, actor, audience, text, lane_id, packet_id, metadata_json, created_at
      FROM broadcast_events;
      DROP TABLE broadcast_events;
      ALTER TABLE broadcast_events_agent_bus RENAME TO broadcast_events;
      CREATE INDEX idx_broadcast_events_kind_created ON broadcast_events(kind, created_at);
    `);
  })();
}

export function ensureAgentBusSchema(sqlite: Database.Database = getSqlite()): void {
  ensureV45BroadcastFocusSchema(sqlite);
  ensureV76BotMembershipSchema(sqlite);
  expandBroadcastTextLimit(sqlite);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_presence (
      agent_id TEXT PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE,
      repo_path TEXT NOT NULL,
      worktree_path TEXT,
      runtime TEXT NOT NULL,
      session_key TEXT,
      lane_id TEXT,
      packet_id TEXT,
      last_seen TEXT NOT NULL,
      UNIQUE(repo_path, name)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_presence_repo_seen
      ON agent_presence(repo_path, last_seen);
    CREATE INDEX IF NOT EXISTS idx_agent_presence_seen
      ON agent_presence(last_seen DESC, name ASC);
    CREATE INDEX IF NOT EXISTS idx_agent_presence_packet
      ON agent_presence(packet_id);

    CREATE TABLE IF NOT EXISTS agent_messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
      refs_json TEXT NOT NULL DEFAULT '{}',
      conversation_id TEXT,
      reply_to_id TEXT,
      turn_index INTEGER,
      closes_conversation INTEGER NOT NULL DEFAULT 0,
      requested_close INTEGER NOT NULL DEFAULT 0,
      client_request_id TEXT,
      delivery_status TEXT NOT NULL CHECK (delivery_status IN ('native', 'poll', 'failed')),
      delivery_note TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_messages_inbox
      ON agent_messages(repo_path, to_agent, sequence);

    CREATE TABLE IF NOT EXISTS agent_conversations (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      participant_a TEXT NOT NULL COLLATE NOCASE,
      participant_b TEXT NOT NULL COLLATE NOCASE,
      turn_count INTEGER NOT NULL CHECK (turn_count BETWEEN 0 AND 24),
      turn_limit INTEGER NOT NULL CHECK (turn_limit BETWEEN 1 AND 24),
      last_message_id TEXT,
      closed_at TEXT,
      closed_reason TEXT,
      summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_conversations_repo_updated
      ON agent_conversations(repo_path, updated_at DESC);

    CREATE TABLE IF NOT EXISTS agent_inbox_state (
      repo_path TEXT NOT NULL,
      agent_name TEXT NOT NULL COLLATE NOCASE,
      acknowledged_sequence INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged_sequence >= 0),
      native_wake_id TEXT,
      native_wake_session_key TEXT,
      native_wake_through_sequence INTEGER NOT NULL DEFAULT 0 CHECK (native_wake_through_sequence >= 0),
      native_wake_at TEXT,
      PRIMARY KEY(repo_path, agent_name)
    );

    CREATE TABLE IF NOT EXISTS agent_bus_migrations (
      name TEXT PRIMARY KEY
    );
  `);
  // Legacy pending wakes retain their TTL/ACK behavior; only new claims get an ID.
  sqlite.transaction(() => {
    const columns = sqlite.pragma('table_info(agent_inbox_state)') as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'native_wake_id')) sqlite.exec('ALTER TABLE agent_inbox_state ADD COLUMN native_wake_id TEXT');
  }).immediate();
  const messageColumns = new Set((sqlite.pragma('table_info(agent_messages)') as Array<{ name: string }>).map((column) => column.name));
  for (const [name, definition] of [
    ['conversation_id', 'TEXT'],
    ['reply_to_id', 'TEXT'],
    ['turn_index', 'INTEGER'],
    ['closes_conversation', 'INTEGER NOT NULL DEFAULT 0'],
    ['requested_close', 'INTEGER NOT NULL DEFAULT 0'],
    ['client_request_id', 'TEXT'],
  ] as const) {
    if (!messageColumns.has(name)) sqlite.exec(`ALTER TABLE agent_messages ADD COLUMN ${name} ${definition}`);
  }
  if (!messageColumns.has('requested_close')) {
    sqlite.exec(`
      UPDATE agent_messages SET requested_close = 1
      WHERE closes_conversation = 1 AND EXISTS (
        SELECT 1 FROM agent_conversations AS conversation
        WHERE conversation.id = agent_messages.conversation_id
          AND conversation.last_message_id = agent_messages.id
          AND conversation.closed_reason = 'agent_final'
      );
    `);
  }
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_messages_conversation
      ON agent_messages(conversation_id, turn_index);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_request
      ON agent_messages(client_request_id) WHERE client_request_id IS NOT NULL;
  `);
  sqlite.prepare(`
    UPDATE agent_messages
    SET delivery_status = 'poll'
    WHERE delivery_status = 'failed'
  `).run();
  sqlite.transaction(() => {
    const applied = sqlite.prepare(`
      SELECT 1 FROM agent_bus_migrations WHERE name = 'canonical_repo_paths_v1'
    `).get();
    if (applied) return;
    reconcilePersistedAgentBusRepoPaths(sqlite);
    sqlite.prepare(`
      INSERT INTO agent_bus_migrations (name) VALUES ('canonical_repo_paths_v1')
    `).run();
  })();
}
function mapPresence(row: PresenceRow): AgentPresence {
  return {
    agentId: row.agent_id,
    name: row.name,
    repo: row.repo_path,
    worktreePath: row.worktree_path,
    runtime: row.runtime,
    sessionKey: row.session_key,
    laneId: row.lane_id,
    packetId: row.packet_id,
    lastSeen: row.last_seen,
  };
}
function mapConversation(row: ConversationRow): AgentConversation {
  return {
    id: row.id,
    repo: row.repo_path,
    participants: [row.participant_a, row.participant_b],
    turnCount: row.turn_count,
    turnLimit: row.turn_limit,
    remainingTurns: Math.max(0, row.turn_limit - row.turn_count),
    lastMessageId: row.last_message_id,
    status: row.closed_at ? 'closed' : 'open',
    closedReason: row.closed_reason,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getAgentConversation(
  id: string,
  sqlite: Database.Database = getSqlite(),
): AgentConversation | null {
  ensureAgentBusSchema(sqlite);
  const row = sqlite.prepare('SELECT * FROM agent_conversations WHERE id = ?').get(id) as ConversationRow | undefined;
  return row ? mapConversation(row) : null;
}

export function listAgentConversations(
  repo: string,
  limit: number,
  sqlite: Database.Database = getSqlite(),
): AgentConversation[] {
  ensureAgentBusSchema(sqlite);
  return (sqlite.prepare(`
    SELECT * FROM agent_conversations WHERE repo_path = ? ORDER BY updated_at DESC LIMIT ?
  `).all(normalizeAgentBusRepoPath(repo), limit) as ConversationRow[]).map(mapConversation);
}

export function mapMessage(row: MessageRow, sqlite: Database.Database): AgentMessage {
  const conversation = row.conversation_id
    ? sqlite.prepare('SELECT * FROM agent_conversations WHERE id = ?').get(row.conversation_id) as ConversationRow | undefined
    : undefined;
  const receipt: AgentConversationReceipt | null = conversation && row.turn_index !== null ? {
    id: conversation.id,
    replyToId: row.reply_to_id,
    turnIndex: row.turn_index,
    turnLimit: conversation.turn_limit,
    remainingTurns: Math.max(0, conversation.turn_limit - conversation.turn_count),
    status: conversation.closed_at ? 'closed' : 'open',
    closedReason: conversation.closed_reason,
    lastMessageId: conversation.last_message_id ?? row.id,
  } : null;
  return {
    schema: 'o8/agents.message-event/v1',
    kind: 'message',
    sequence: row.sequence,
    id: row.id,
    from: row.from_agent,
    to: row.to_agent,
    repo: row.repo_path,
    text: row.text,
    refs: parseMessageRefs(row.refs_json),
    conversation: receipt,
    delivery: row.delivery_status,
    deliveryNote: row.delivery_note,
    timestamp: row.created_at,
  };
}

export function upsertAgentPresence(
  input: Omit<AgentPresence, 'repo'> & { repo: string },
  sqlite: Database.Database = getSqlite(),
): AgentPresenceWriteResult {
  ensureAgentBusSchema(sqlite);
  const repo = normalizeAgentBusRepoPath(input.repo);
  let adoptedLegacy = false;
  let tookOverStale = false;
  sqlite.transaction(() => {
    const existing = sqlite.prepare('SELECT * FROM agent_presence WHERE agent_id = ?')
      .get(input.agentId) as PresenceRow | undefined;
    if (existing && existing.session_key !== input.sessionKey) {
      const owner = mapPresence(existing);
      if (existing.session_key === null) {
        adoptedLegacy = true;
      } else if (!isPresenceLive(owner)) {
        tookOverStale = true;
      } else {
        throw new AgentPresenceWriteConflictError(owner, input.sessionKey);
      }
    }
    sqlite.prepare(`
      INSERT INTO agent_presence
        (agent_id, name, repo_path, worktree_path, runtime, session_key, lane_id, packet_id, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        name = excluded.name,
        repo_path = excluded.repo_path,
        worktree_path = excluded.worktree_path,
        runtime = excluded.runtime,
        session_key = excluded.session_key,
        lane_id = excluded.lane_id,
        packet_id = excluded.packet_id,
        last_seen = excluded.last_seen
    `).run(
      input.agentId,
      input.name,
      repo,
      input.worktreePath,
      input.runtime,
      input.sessionKey,
      input.laneId,
      input.packetId,
      input.lastSeen,
    );
  })();
  return {
    ...input,
    repo,
    ...(adoptedLegacy ? { adoptedLegacy: true as const } : {}),
    ...(tookOverStale ? { tookOverStale: true as const } : {}),
  };
}

export function findAgentPresence(
  input: { agentId?: string | null; name?: string | null; repo?: string | null },
  sqlite: Database.Database = getSqlite(),
): AgentPresence | null {
  ensureAgentBusSchema(sqlite);
  const repo = input.repo ? normalizeAgentBusRepoPath(input.repo) : null;
  let row: PresenceRow | undefined;
  if (input.agentId) {
    row = sqlite.prepare('SELECT * FROM agent_presence WHERE agent_id = ?')
      .get(input.agentId) as PresenceRow | undefined;
  } else if (input.name && repo) {
    row = sqlite.prepare('SELECT * FROM agent_presence WHERE repo_path = ? AND name = ? COLLATE NOCASE')
      .get(repo, input.name) as PresenceRow | undefined;
  } else if (input.name) {
    const rows = sqlite.prepare('SELECT * FROM agent_presence WHERE name = ? COLLATE NOCASE ORDER BY last_seen DESC')
      .all(input.name) as PresenceRow[];
    if (rows.length === 1) row = rows[0];
  }
  return row ? mapPresence(row) : null;
}

export function listAgentPresence(
  repo: string,
  options: { now?: Date; includeStale?: boolean } = {},
  sqlite: Database.Database = getSqlite(),
): AgentPresence[] {
  ensureAgentBusSchema(sqlite);
  const normalizedRepo = normalizeAgentBusRepoPath(repo);
  const rows = sqlite.prepare(`
    SELECT * FROM agent_presence WHERE repo_path = ? ORDER BY last_seen DESC, name ASC
  `).all(normalizedRepo) as PresenceRow[];
  if (options.includeStale) return rows.map(mapPresence);
  const cutoff = (options.now ?? new Date()).getTime() - AGENT_PRESENCE_TTL_MS;
  return rows.filter((row) => Date.parse(row.last_seen) >= cutoff).map(mapPresence);
}

export function listAgentPresenceAcrossRepos(
  options: { now?: Date; includeStale?: boolean } = {},
  sqlite: Database.Database = getSqlite(),
): AgentPresence[] {
  ensureAgentBusSchema(sqlite);
  if (options.includeStale) {
    const rows = sqlite.prepare(`
      SELECT * FROM agent_presence ORDER BY last_seen DESC, name ASC
    `).all() as PresenceRow[];
    return rows.map(mapPresence);
  }
  const cutoff = new Date((options.now ?? new Date()).getTime() - AGENT_PRESENCE_TTL_MS).toISOString();
  const rows = sqlite.prepare(`
    SELECT * FROM agent_presence
    WHERE last_seen >= ?
    ORDER BY last_seen DESC, name ASC
  `).all(cutoff) as PresenceRow[];
  return rows.map(mapPresence);
}

export function isPresenceLive(presence: AgentPresence, now = Date.now()): boolean {
  const seen = Date.parse(presence.lastSeen);
  return Number.isFinite(seen) && now - seen <= AGENT_PRESENCE_TTL_MS;
}

export function persistAgentMessage(
  input: {
    from: string;
    to: string;
    repo: string;
    text: string;
    refs: AgentMessageRefs;
    replyToId?: string | null;
    close?: boolean;
    requestId?: string | null;
  },
  sqlite: Database.Database = getSqlite(),
): { message: AgentMessage; created: boolean } {
  ensureAgentBusSchema(sqlite);
  const timestamp = new Date().toISOString();
  const id = `message-${randomUUID()}`;
  const repo = normalizeAgentBusRepoPath(input.repo);
  const result = sqlite.transaction((): { id: string; created: boolean } => {
    if (input.requestId) {
      const prior = sqlite.prepare('SELECT * FROM agent_messages WHERE client_request_id = ?')
        .get(input.requestId) as MessageRow | undefined;
      if (prior) {
        const same = prior.repo_path === repo
          && prior.from_agent.toLowerCase() === input.from.toLowerCase()
          && prior.to_agent.toLowerCase() === input.to.toLowerCase()
          && prior.text === input.text
          && prior.reply_to_id === (input.replyToId ?? null)
          && Boolean(prior.requested_close) === Boolean(input.close);
        if (!same) throw new AgentConversationError('Request ID was already used for a different message.', 'agent_request_conflict', 409);
        return { id: prior.id, created: false };
      }
    }

    let conversationId: string;
    let turnIndex: number;
    let closesConversation = Boolean(input.close);
    if (input.replyToId) {
      const prior = sqlite.prepare('SELECT * FROM agent_messages WHERE id = ?')
        .get(input.replyToId) as MessageRow | undefined;
      if (!prior || !prior.conversation_id) {
        throw new AgentConversationError('Reply target is not a threaded agent message.', 'agent_reply_not_found', 404);
      }
      const conversation = sqlite.prepare('SELECT * FROM agent_conversations WHERE id = ?')
        .get(prior.conversation_id) as ConversationRow | undefined;
      if (!conversation || conversation.repo_path !== repo || prior.repo_path !== repo) {
        throw new AgentConversationError('Reply belongs to a different repository.', 'agent_reply_repo_mismatch', 403);
      }
      if (conversation.last_message_id !== prior.id) {
        throw new AgentConversationError('A newer turn already exists. Reply to the latest message.', 'agent_reply_stale', 409);
      }
      if (conversation.closed_at || conversation.turn_count >= conversation.turn_limit) {
        throw new AgentConversationError('This conversation is closed.', 'agent_conversation_closed', 409);
      }
      if (prior.to_agent.toLowerCase() !== input.from.toLowerCase()
        || prior.from_agent.toLowerCase() !== input.to.toLowerCase()) {
        throw new AgentConversationError('Only the addressed participant can reply to the previous sender.', 'agent_reply_participant_mismatch', 403);
      }
      conversationId = conversation.id;
      turnIndex = conversation.turn_count + 1;
      closesConversation ||= turnIndex >= conversation.turn_limit;
    } else {
      conversationId = `conversation-${randomUUID()}`;
      turnIndex = 1;
      sqlite.prepare(`
        INSERT INTO agent_conversations
          (id, repo_path, participant_a, participant_b, turn_count, turn_limit, last_message_id,
           closed_at, closed_reason, summary, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, ?, NULL, NULL, NULL, NULL, ?, ?)
      `).run(conversationId, repo, input.from, input.to, AGENT_CONVERSATION_DEFAULT_LIMIT, timestamp, timestamp);
    }
    sqlite.prepare(`
      INSERT INTO agent_messages
        (id, from_agent, to_agent, repo_path, text, refs_json, conversation_id, reply_to_id,
         turn_index, closes_conversation, requested_close, client_request_id, delivery_status, delivery_note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'poll', NULL, ?)
    `).run(
      id, input.from, input.to, repo, input.text, JSON.stringify(input.refs), conversationId,
      input.replyToId ?? null, turnIndex, closesConversation ? 1 : 0, input.close ? 1 : 0, input.requestId ?? null, timestamp,
    );
    sqlite.prepare(`
      UPDATE agent_conversations
      SET turn_count = ?, last_message_id = ?, closed_at = ?, closed_reason = ?, summary = ?, updated_at = ?
      WHERE id = ?
    `).run(
      turnIndex,
      id,
      closesConversation ? timestamp : null,
      closesConversation ? (input.close ? 'agent_final' : 'budget_exhausted') : null,
      input.close ? input.text : null,
      timestamp,
      conversationId,
    );
    sqlite.prepare(`
      INSERT INTO broadcast_events
        (id, kind, actor, audience, text, lane_id, packet_id, metadata_json, created_at)
      VALUES (?, 'conversation', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `broadcast-${randomUUID()}`,
      input.from,
      input.to,
      input.text,
      input.refs.laneId,
      input.refs.packetId,
      JSON.stringify({ agentMessageId: id, conversationId, replyToId: input.replyToId ?? null, turnIndex, repoPath: repo, from: input.from, to: input.to, refs: input.refs }),
      timestamp,
    );
    return { id, created: true };
  }).immediate();
  const row = sqlite.prepare('SELECT * FROM agent_messages WHERE id = ?').get(result.id) as MessageRow;
  return { message: mapMessage(row, sqlite), created: result.created };
}

export function updateAgentMessageDelivery(
  id: string,
  delivery: AgentMessage['delivery'],
  note: string | null,
  sqlite: Database.Database = getSqlite(),
): AgentMessage {
  sqlite.prepare(`
    UPDATE agent_messages SET delivery_status = ?, delivery_note = ?
    WHERE id = ? AND (delivery_status <> 'native' OR COALESCE(delivery_note, '') <> 'Read from the durable inbox by the target session.')
  `).run(delivery, note, id);
  return mapMessage(sqlite.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as MessageRow, sqlite);
}
function ensureAgentInboxState(
  agent: AgentPresence,
  sqlite: Database.Database,
): InboxStateRow {
  const repo = agent.repo;
  sqlite.prepare(`
    INSERT OR IGNORE INTO agent_inbox_state
      (repo_path, agent_name, acknowledged_sequence, native_wake_session_key,
       native_wake_through_sequence, native_wake_at)
    VALUES (?, ?, 0, NULL, 0, NULL)
  `).run(repo, agent.name);
  return sqlite.prepare(`
    SELECT acknowledged_sequence, native_wake_session_key,
           native_wake_through_sequence, native_wake_at
    FROM agent_inbox_state
    WHERE repo_path = ? AND agent_name = ? COLLATE NOCASE
  `).get(repo, agent.name) as InboxStateRow;
}

export function getAgentInboxCursor(
  agent: AgentPresence,
  sqlite: Database.Database = getSqlite(),
): number {
  ensureAgentBusSchema(sqlite);
  return ensureAgentInboxState(agent, sqlite).acknowledged_sequence;
}

export function claimAgentInboxWake(
  input: { agent: AgentPresence; throughSequence: number; now?: Date },
  sqlite: Database.Database = getSqlite(),
): string | null {
  ensureAgentBusSchema(sqlite);
  if (!input.agent.sessionKey || input.throughSequence <= 0) return null;
  const repo = input.agent.repo;
  const now = input.now ?? new Date();
  return sqlite.transaction(() => {
    const state = ensureAgentInboxState(input.agent, sqlite);
    const wakeAt = state.native_wake_at ? Date.parse(state.native_wake_at) : Number.NaN;
    const wakeIsFresh = state.native_wake_session_key === input.agent.sessionKey
      && state.acknowledged_sequence < state.native_wake_through_sequence
      && Number.isFinite(wakeAt)
      && now.getTime() - wakeAt < AGENT_NATIVE_WAKE_TTL_MS;
    if (wakeIsFresh) {
      sqlite.prepare(`
        UPDATE agent_inbox_state
        SET native_wake_through_sequence = MAX(native_wake_through_sequence, ?)
        WHERE repo_path = ? AND agent_name = ? COLLATE NOCASE
      `).run(input.throughSequence, repo, input.agent.name);
      return null;
    }
    // Ownership must survive coalescing and distinguish same-millisecond claims.
    const reservationId = randomUUID();
    sqlite.prepare(`
      UPDATE agent_inbox_state
      SET native_wake_id = ?, native_wake_session_key = ?, native_wake_through_sequence = ?, native_wake_at = ?
      WHERE repo_path = ? AND agent_name = ? COLLATE NOCASE
    `).run(
      reservationId, input.agent.sessionKey,
      input.throughSequence,
      now.toISOString(),
      repo,
      input.agent.name,
    );
    return reservationId;
  })();
}

export function releaseAgentInboxWake(
  agent: AgentPresence,
  reservationId: string,
  sqlite: Database.Database = getSqlite(),
): void {
  ensureAgentBusSchema(sqlite);
  if (!agent.sessionKey || !reservationId) return;
  sqlite.prepare(`
    UPDATE agent_inbox_state
    SET native_wake_id = NULL, native_wake_session_key = NULL, native_wake_through_sequence = 0, native_wake_at = NULL
    WHERE repo_path = ? AND agent_name = ? COLLATE NOCASE
      AND native_wake_session_key = ? AND native_wake_id = ?
  `).run(agent.repo, agent.name, agent.sessionKey, reservationId);
}

export function listAgentInbox(
  input: { agent: AgentPresence; after: number; limit: number; includeDelivered?: boolean },
  sqlite: Database.Database = getSqlite(),
): { messages: AgentMessage[]; cursor: number; hasMore: boolean } {
  ensureAgentBusSchema(sqlite);
  const rows = sqlite.prepare(`
    SELECT * FROM agent_messages
    WHERE repo_path = ? AND to_agent = ? COLLATE NOCASE AND sequence > ?
    ${input.includeDelivered === false ? "AND delivery_status <> 'native'" : ''}
    ORDER BY sequence ASC LIMIT ?
  `).all(input.agent.repo, input.agent.name, input.after, input.limit + 1) as MessageRow[];
  const hasMore = rows.length > input.limit;
  const messages = rows.slice(0, input.limit).map((row) => mapMessage(row, sqlite));
  return {
    messages,
    cursor: messages.at(-1)?.sequence ?? input.after,
    hasMore,
  };
}

export function acknowledgeAgentInbox(
  input: { agent: AgentPresence; throughSequence: number },
  sqlite: Database.Database = getSqlite(),
): void {
  ensureAgentBusSchema(sqlite);
  if (input.throughSequence <= 0) return;
  const repo = input.agent.repo;
  sqlite.transaction(() => {
    ensureAgentInboxState(input.agent, sqlite);
    sqlite.prepare(`
      UPDATE agent_messages
      SET
        delivery_status = 'native',
        delivery_note = CASE
          WHEN delivery_status = 'native' THEN delivery_note
          ELSE 'Read from the durable inbox by the target session.'
        END
      WHERE repo_path = ?
        AND to_agent = ? COLLATE NOCASE
        AND sequence <= ?
    `).run(repo, input.agent.name, input.throughSequence);
    sqlite.prepare(`
      UPDATE agent_inbox_state
      SET
        acknowledged_sequence = MAX(acknowledged_sequence, ?),
        native_wake_id = CASE WHEN native_wake_through_sequence <= ? THEN NULL ELSE native_wake_id END,
        native_wake_session_key = CASE
          WHEN native_wake_through_sequence <= ? THEN NULL
          ELSE native_wake_session_key
        END,
        native_wake_through_sequence = CASE
          WHEN native_wake_through_sequence <= ? THEN 0
          ELSE native_wake_through_sequence
        END,
        native_wake_at = CASE
          WHEN native_wake_through_sequence <= ? THEN NULL
          ELSE native_wake_at
        END
      WHERE repo_path = ? AND agent_name = ? COLLATE NOCASE
    `).run(
      input.throughSequence,
      input.throughSequence,
      input.throughSequence,
      input.throughSequence,
      input.throughSequence,
      repo,
      input.agent.name,
    );
  })();
}

export function listRecentAgentMessages(
  repo: string,
  limit: number,
  sqlite: Database.Database = getSqlite(),
): AgentMessage[] {
  ensureAgentBusSchema(sqlite);
  const rows = sqlite.prepare(`
    SELECT * FROM agent_messages
    WHERE repo_path = ?
    ORDER BY sequence DESC LIMIT ?
  `).all(normalizeAgentBusRepoPath(repo), limit) as MessageRow[];
  return rows.map((row) => mapMessage(row, sqlite));
}

export function listRecentAgentMessagesAcrossRepos(
  limit: number,
  sqlite: Database.Database = getSqlite(),
): AgentMessage[] {
  ensureAgentBusSchema(sqlite);
  const rows = sqlite.prepare(`
    SELECT * FROM agent_messages
    ORDER BY sequence DESC LIMIT ?
  `).all(limit) as MessageRow[];
  return rows.map((row) => mapMessage(row, sqlite));
}

export function updateAgentConversation(
  input: { id: string; repo: string; action: 'close' | 'extend'; summary?: string | null },
  sqlite: Database.Database = getSqlite(),
): AgentConversation {
  ensureAgentBusSchema(sqlite);
  const repo = normalizeAgentBusRepoPath(input.repo);
  return sqlite.transaction(() => {
    const row = sqlite.prepare('SELECT * FROM agent_conversations WHERE id = ?').get(input.id) as ConversationRow | undefined;
    if (!row || row.repo_path !== repo) {
      throw new AgentConversationError('Conversation was not found in this repository.', 'agent_conversation_not_found', 404);
    }
    const now = new Date().toISOString();
    if (input.action === 'close') {
      if (row.closed_at) return mapConversation(row);
      sqlite.prepare(`
        UPDATE agent_conversations SET closed_at = ?, closed_reason = 'operator_stop', summary = ?, updated_at = ? WHERE id = ?
      `).run(now, input.summary ?? null, now, input.id);
    } else {
      if (!row.closed_at) {
        throw new AgentConversationError('Only a closed conversation can be extended.', 'agent_conversation_open', 409);
      }
      const nextLimit = Math.min(AGENT_CONVERSATION_MAX_LIMIT, row.turn_count + AGENT_CONVERSATION_EXTENSION);
      if (nextLimit <= row.turn_count) {
        throw new AgentConversationError('This conversation has reached the maximum turn limit.', 'agent_conversation_max_limit', 409);
      }
      sqlite.prepare(`
        UPDATE agent_conversations
        SET turn_limit = ?, closed_at = NULL, closed_reason = NULL, summary = NULL, updated_at = ?
        WHERE id = ?
      `).run(nextLimit, now, input.id);
    }
    return mapConversation(sqlite.prepare('SELECT * FROM agent_conversations WHERE id = ?').get(input.id) as ConversationRow);
  }).immediate();
}
