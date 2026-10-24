import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { ensureV73ConversationPrContextSchema } from './v73-conversation-pr-context-migration';
import { ensureV74ConversationPrProvenanceSchema } from './v74-conversation-pr-provenance-migration';
it('upgrades legacy context links once and never resurrects a removed link', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE github_pull_requests (pull_request_id INTEGER PRIMARY KEY)');
    ensureV73ConversationPrContextSchema(db);
    db.prepare(`INSERT INTO conversation_pr_context(thread_id,host,repository_id,pull_request_id,number,repository_name,kind,source,created_at)
      VALUES ('thoughts-legacy','github.com',12,45,7,'fixture/repo','context','operator','2026-01-01')`).run();
    ensureV74ConversationPrProvenanceSchema(db);
    expect(db.prepare('SELECT id,kind,source,source_key FROM conversation_pr_context').all()).toEqual([{ id: 1, kind: 'context', source: 'operator', source_key: '' }]);
    db.exec('DELETE FROM conversation_pr_context');
    ensureV73ConversationPrContextSchema(db);
    ensureV74ConversationPrProvenanceSchema(db);
    expect(db.prepare('SELECT * FROM conversation_pr_context').all()).toEqual([]);
    expect(() => db.prepare(`INSERT INTO conversation_pr_context(thread_id,host,repository_id,pull_request_id,number,repository_name,kind,source,created_at)
      VALUES ('thoughts-fake','github.com',12,45,7,'fixture/repo','delivery','operator','2026-01-01')`).run()).toThrow(/CHECK/);
  } finally { db.close(); }
});
