import 'server-only';
import type Database from 'better-sqlite3';
import { getSqlite } from '@/lib/db';
import { ensureAgentBusSchema, mapMessage, type MessageRow } from './store';

/** Exact durable selectors: projection never relies on a truncated recent-message list. */
export function readAgentMessageByRequestId(requestId: string, sqlite: Database.Database = getSqlite()) {
  ensureAgentBusSchema(sqlite);
  const row = sqlite.prepare('SELECT * FROM agent_messages WHERE client_request_id = ?').get(requestId) as MessageRow | undefined;
  return row ? mapMessage(row, sqlite) : null;
}

export function readAgentConversationMessages(conversationId: string, sqlite: Database.Database = getSqlite()) {
  ensureAgentBusSchema(sqlite);
  const rows = sqlite.prepare('SELECT * FROM agent_messages WHERE conversation_id = ? ORDER BY sequence').all(conversationId) as MessageRow[];
  return rows.map(row => mapMessage(row, sqlite));
}
