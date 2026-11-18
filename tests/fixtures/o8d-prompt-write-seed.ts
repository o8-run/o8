import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getSqlite } from '../../src/lib/db';
const root = process.env.CORTEX_IDE_DATA_DIR!;
if (readFileSync(join(root, 'fixture-owner'), 'utf8') !== 'o8d-native-read/v1') throw Error('Owned fixture required');
const db = getSqlite();
for (const [id, body] of [['existing', 'preexisting fixture row'], ['conflict', 'other fixture row']]) {
  db.prepare(`INSERT INTO prompt_library (id,title,body,body_fingerprint,tags_json,scope,repo_path,source_kind,source_id,created_at,updated_at,last_used_at,use_count)
    VALUES (?,?,?,?,?,'global',NULL,'manual',NULL,10,20,NULL,0)`).run(id, 'fixture ' + id, body, createHash('sha256').update(body).digest('hex'), '["fixture"]');
}
