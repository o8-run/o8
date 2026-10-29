import type Database from 'better-sqlite3';
import { addColumnTolerant, tableColumnExists } from './schema-columns';
import { compactComposerPayload, composerPayloadHash, withComposerPayloadRemoval } from '@/lib/orchestrator/composer-queue-ledger';

/** Also catches legacy writers on subsequent starts. Pending payloads stay intact. */
export function ensureV75ComposerQueueLedgerSchema(sqlite: Database.Database): void {
  for (const [name, type] of [['payload_hash', 'TEXT'], ['payload_bytes', 'INTEGER'], ['payload_compacted_at', 'INTEGER']]) {
    if (!tableColumnExists(sqlite, 'composer_send_queue', name)) {
      addColumnTolerant(sqlite, `ALTER TABLE composer_send_queue ADD COLUMN ${name} ${type}`);
    }
  }
  withComposerPayloadRemoval(sqlite, () => sqlite.transaction(() => {
    const next = sqlite.prepare(`SELECT sequence, payload_json, status, admitted_at, intent FROM composer_send_queue
      WHERE payload_hash IS NULL OR (payload_compacted_at IS NULL AND
        (status = 'cancelled' OR (status = 'applied' AND admitted_at IS NOT NULL))) ORDER BY sequence LIMIT 1`);
    const update = sqlite.prepare(`UPDATE composer_send_queue SET payload_hash = COALESCE(payload_hash, ?),
      payload_bytes = COALESCE(payload_bytes, ?), payload_json = ?, payload_compacted_at = ? WHERE sequence = ?`);
    // Read one payload at a time rather than loading an entire legacy image ledger.
    for (;;) {
      const row = next.get() as { sequence: number; payload_json: string; status: string; admitted_at: number | null; intent: string } | undefined;
      if (!row) break;
      const compact = row.status === 'cancelled' || (row.status === 'applied' && row.admitted_at !== null);
      update.run(composerPayloadHash(row.payload_json), Buffer.byteLength(row.payload_json),
        compact ? compactComposerPayload(row.payload_json, row.status === 'applied' && row.intent === 'steer-now') : row.payload_json,
        compact ? Date.now() : null, row.sequence);
    }
  }).immediate());
}
