import 'server-only';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getSqlite } from '@/lib/db';
import { AGENT_CONVERSATION_EXTENSION, AGENT_CONVERSATION_MAX_LIMIT, AgentConversationError,
  ensureAgentBusSchema, mapConversation, normalizeAgentBusRepoPath, type ConversationRow } from './store';

export function listInboxAgentConversations(input: {
  repo: string | null; status?: 'open' | 'closed'; limit: number; cursor?: string | null;
}, sqlite: Database.Database = getSqlite()) {
  ensureAgentBusSchema(sqlite);
  const cursor = input.cursor ? Number(input.cursor) : null;
  if (input.status === 'closed' && input.cursor) {
    throw new AgentConversationError('Settled history is a bounded recent listing.', 'invalid_agent_conversation_cursor', 400);
  }
  if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 1)) {
    throw new AgentConversationError('Invalid conversation cursor.', 'invalid_agent_conversation_cursor', 400);
  }
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (input.repo) { where.push('repo_path = ?'); args.push(normalizeAgentBusRepoPath(input.repo)); }
  if (input.status) where.push(`closed_at IS ${input.status === 'open' ? '' : 'NOT '}NULL`);
  if (cursor !== null) { where.push('rowid < ?'); args.push(cursor); }
  const order = input.status === 'closed' ? 'updated_at DESC, rowid DESC' : 'rowid DESC';
  const rows = sqlite.prepare(`SELECT *, rowid AS position FROM agent_conversations
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ?`)
    .all(...args, input.limit + 1) as Array<ConversationRow & { position: number }>;
  const page = rows.slice(0, input.limit);
  const more = rows.length > input.limit;
  return { conversations: page.map(mapConversation), nextCursor: input.status !== 'closed' && more ? String(page.at(-1)!.position) : null,
    ...(input.status === 'closed' ? { truncated: more } : {}) };
}

export function updateAgentConversation(
  input: { id: string; repo: string; action: 'close' | 'extend'; summary?: string | null },
  sqlite: Database.Database = getSqlite(),
) {
  ensureAgentBusSchema(sqlite);
  const repo = normalizeAgentBusRepoPath(input.repo);
  return sqlite.transaction(() => {
    const row = conversationRow(input.id, repo, sqlite);
    const now = new Date().toISOString();
    if (input.action === 'close') {
      if (row.closed_at) return mapConversation(row);
      sqlite.prepare(`UPDATE agent_conversations SET closed_at = ?, closed_reason = 'operator_stop', summary = ?,
        updated_at = ?, revision = revision + 1, manual_close_json = NULL WHERE id = ?`)
        .run(now, input.summary ?? null, now, input.id);
    } else {
      if (!row.closed_at) throw new AgentConversationError('Only a closed conversation can be extended.', 'agent_conversation_open', 409);
      const nextLimit = Math.min(AGENT_CONVERSATION_MAX_LIMIT, row.turn_count + AGENT_CONVERSATION_EXTENSION);
      if (nextLimit <= row.turn_count) throw new AgentConversationError('This conversation has reached the maximum turn limit.', 'agent_conversation_max_limit', 409);
      sqlite.prepare(`UPDATE agent_conversations SET turn_limit = ?, closed_at = NULL, closed_reason = NULL, summary = NULL,
        updated_at = ?, revision = revision + 1, manual_close_json = NULL WHERE id = ?`).run(nextLimit, now, input.id);
    }
    return mapConversation(conversationRow(input.id, repo, sqlite));
  }).immediate();
}

function conversationRow(id: string, repo: string, sqlite: Database.Database) {
  const row = sqlite.prepare('SELECT * FROM agent_conversations WHERE id = ? AND repo_path = ?').get(id, repo) as ConversationRow | undefined;
  if (!row) throw new AgentConversationError('Conversation was not found in this repository.', 'agent_conversation_not_found', 404);
  return row;
}
interface CloseReceipt {
  token: string; revision: number; clientMutationId: string;
}
interface SavedClose {
  receipt: CloseReceipt; summary: string | null; closedReason: string | null; undoneRevision?: number;
}
function savedClose(row: ConversationRow): SavedClose | null {
  return row.manual_close_json ? JSON.parse(row.manual_close_json) as SavedClose : null;
}

/** Reversibility belongs to this exact bus row; no parallel Inbox settlement is written. */
export function changeInboxAgentConversation(input: {
  id: string; repo: string; action: 'close' | 'undo-close'; clientMutationId?: string;
  expectedRevision?: number; undo?: unknown;
}, sqlite: Database.Database = getSqlite()) {
  ensureAgentBusSchema(sqlite);
  const repo = normalizeAgentBusRepoPath(input.repo);
  return sqlite.transaction(() => {
    const row = conversationRow(input.id, repo, sqlite);
    const saved = savedClose(row);
    if (input.action === 'close') {
      if (row.closed_at) {
        const own = saved && !saved.undoneRevision && saved.receipt.clientMutationId === input.clientMutationId
          && saved.receipt.revision === row.revision;
        return { conversation: mapConversation(row), undo: own ? saved.receipt : null };
      }
      if (input.expectedRevision !== row.revision) throw conflict();
      const receipt = { token: randomUUID(), revision: row.revision + 1, clientMutationId: input.clientMutationId! };
      const record: SavedClose = { receipt, summary: row.summary, closedReason: row.closed_reason };
      const now = new Date().toISOString();
      sqlite.prepare(`UPDATE agent_conversations SET closed_at = ?, closed_reason = 'operator_stop', updated_at = ?,
        revision = revision + 1, manual_close_json = ? WHERE id = ? AND revision = ?`)
        .run(now, now, JSON.stringify(record), row.id, row.revision);
      return { conversation: mapConversation(conversationRow(row.id, repo, sqlite)), undo: receipt };
    }
    const undo = input.undo as Partial<CloseReceipt> | null | undefined;
    if (!saved || !undo || undo.token !== saved.receipt.token || undo.revision !== saved.receipt.revision
      || undo.clientMutationId !== saved.receipt.clientMutationId) throw conflict();
    if (!row.closed_at && saved.undoneRevision === row.revision) return { conversation: mapConversation(row), undo: null };
    if (row.closed_reason !== 'operator_stop' || !row.closed_at || row.revision !== saved.receipt.revision
      || row.turn_count >= row.turn_limit) throw conflict();
    const record = { ...saved, undoneRevision: row.revision + 1 };
    sqlite.prepare(`UPDATE agent_conversations SET closed_at = NULL, closed_reason = ?, summary = ?, updated_at = ?,
      revision = revision + 1, manual_close_json = ? WHERE id = ? AND revision = ?`)
      .run(saved.closedReason, saved.summary, new Date().toISOString(), JSON.stringify(record), row.id, row.revision);
    return { conversation: mapConversation(conversationRow(row.id, repo, sqlite)), undo: null };
  }).immediate();
}
function conflict() {
  return new AgentConversationError('This exchange changed. Refresh before another action.', 'agent_conversation_changed', 409);
}
