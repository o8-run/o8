import type Database from 'better-sqlite3';
export function ensureV74ConversationPrProvenanceSchema(db: Database.Database) {
  db.transaction(() => {
    const columns = db.prepare('PRAGMA table_info(conversation_pr_context)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'source_key')) {
      db.exec(`ALTER TABLE conversation_pr_context RENAME TO conversation_pr_context_v73;
        CREATE TABLE conversation_pr_context (
          id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL,
          host TEXT NOT NULL CHECK(host = 'github.com'), repository_id INTEGER NOT NULL CHECK(repository_id > 0),
          pull_request_id INTEGER NOT NULL CHECK(pull_request_id > 0), number INTEGER NOT NULL CHECK(number > 0),
          repository_name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('context','review','import','delivery')),
          source TEXT NOT NULL CHECK(source IN ('operator','packet')), source_key TEXT NOT NULL DEFAULT '',
          packet_id TEXT, lane_id TEXT, created_at TEXT NOT NULL,
          CHECK((kind = 'delivery' AND source = 'packet' AND packet_id IS NOT NULL AND lane_id IS NOT NULL AND source_key = lane_id AND source_key != '')
            OR (kind != 'delivery' AND source = 'operator' AND source_key = '' AND packet_id IS NULL AND lane_id IS NULL)),
          UNIQUE(thread_id,host,repository_id,pull_request_id,kind,source_key));
        INSERT INTO conversation_pr_context (id,thread_id,host,repository_id,pull_request_id,number,repository_name,kind,source,created_at)
          SELECT id,thread_id,host,repository_id,pull_request_id,number,repository_name,kind,source,created_at FROM conversation_pr_context_v73;
        DROP TABLE conversation_pr_context_v73;`);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_pr_delivery_source
      ON conversation_pr_context(source_key) WHERE source = 'packet';
      CREATE INDEX IF NOT EXISTS idx_conversation_pr_context_forward ON conversation_pr_context(thread_id,id);
      CREATE INDEX IF NOT EXISTS idx_conversation_pr_context_reverse ON conversation_pr_context(host,repository_id,pull_request_id,number,id);
      CREATE TABLE IF NOT EXISTS conversation_pr_delivery_intents (
        lane_id TEXT PRIMARY KEY, packet_id TEXT NOT NULL, thread_id TEXT NOT NULL, repository_name TEXT NOT NULL,
        number INTEGER NOT NULL CHECK(number > 0), provider_url TEXT NOT NULL, created_at TEXT NOT NULL);`);
  }).immediate();
}
