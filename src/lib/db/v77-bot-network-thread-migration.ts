import type Database from 'better-sqlite3';

/** Network bindings and send intents are durable; canonical history is a replayable projection. */
export function ensureV77BotNetworkThreadSchema(sqlite: Database.Database): void {
  sqlite.transaction(() => {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS bot_network_threads (
      thread_id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      conversation_id TEXT UNIQUE,
      participants_json TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bot_network_sends (
      thread_id TEXT NOT NULL REFERENCES bot_network_threads(thread_id),
      client_id TEXT NOT NULL,
      bus_request_id TEXT NOT NULL UNIQUE,
      text TEXT NOT NULL,
      reply_to_id TEXT,
      agent_message_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      PRIMARY KEY(thread_id, client_id)
    );
  `);
  const columns = sqlite.pragma('table_info(bot_network_sends)') as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'status')) {
    sqlite.exec("ALTER TABLE bot_network_sends ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
    sqlite.prepare("UPDATE bot_network_sends SET status = 'accepted' WHERE agent_message_id IS NOT NULL").run();
  }
  }).immediate();
}
