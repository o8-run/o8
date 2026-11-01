import type Database from 'better-sqlite3';

/** Durable local roster metadata, independent of presence TTL and bus cursors. */
export function ensureV76BotMembershipSchema(sqlite: Database.Database): void {
  sqlite.transaction(() => sqlite.exec(`
    CREATE TABLE IF NOT EXISTS bot_members (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      house TEXT NOT NULL,
      display_name TEXT NOT NULL,
      icon_key TEXT,
      home_thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bot_member_bindings (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES bot_members(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      runtime TEXT NOT NULL,
      session_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(repo_path, runtime, session_key)
    );
    CREATE INDEX IF NOT EXISTS idx_bot_member_bindings_member ON bot_member_bindings(member_id);
    CREATE TABLE IF NOT EXISTS bot_member_sources (
      source_id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES bot_members(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_bot_member_sources_member ON bot_member_sources(member_id);
  `)).immediate();
}
