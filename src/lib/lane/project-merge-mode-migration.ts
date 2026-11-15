import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const projectMergeModeKey = (id: string) => `project-merge-mode:${id}`;
export const projectMergeModeMigrationMarker = 'migration:project-merge-mode:carry-over-v1';

/** Runs before the DB singleton is published. Values and marker commit together. */
export function carryOverProjectMergeModes(sqlite: Database.Database, dataDir: string, existingDb: boolean) {
  sqlite.transaction(() => {
    if (sqlite.prepare('SELECT 1 FROM app_state WHERE key = ?').get(projectMergeModeMigrationMarker)) return;
    const insert = sqlite.prepare('INSERT OR IGNORE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)');
    if (!existingDb) { insert.run(projectMergeModeMigrationMarker, 'done', Date.now()); return; }
    const ids = new Set<string>();
    const add = (value: unknown) => { if (typeof value === 'string' && value) ids.add(value); };
    if (existingDb) {
      for (const row of sqlite.prepare('SELECT id FROM projects').all() as { id: string }[]) add(row.id);
      for (const row of sqlite.prepare('SELECT DISTINCT project_id AS id FROM lanes').all() as { id: string }[]) add(row.id);
      add('default');
    }
    // Legacy inventory is best-effort, as in its existing readers. SQLite identities
    // and the legacy default still retain their effective choice if JSON is unreadable.
    let inventoryReadable = true;
    for (const [file, field] of [['projects.json', 'projects'], ['repos.json', 'repos']] as const) {
      try {
        const parsed = JSON.parse(readFileSync(join(dataDir, file), 'utf8'));
        if (!parsed || !Array.isArray(parsed[field])) throw new Error('Invalid inventory.');
        for (const row of parsed[field]) {
          if (!row || typeof row.id !== 'string') continue;
          if (file === 'repos.json') add(`repo:${row.id}`);
          else { add(row.id); add(row.sqliteProjectId); }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          inventoryReadable = false;
          console.warn('[merge-policy] Legacy inventory unavailable; carry-over will retry after repair.');
        }
      }
    }
    const mode = 'direct';
    for (const id of ids) insert.run(projectMergeModeKey(id), mode, Date.now());
    if (inventoryReadable) insert.run(projectMergeModeMigrationMarker, 'done', Date.now());
  }).immediate();
}

/** A failed transaction retains the legacy fallback until the next startup retries. */
export function initializeProjectMergeModes(sqlite: Database.Database, dataDir: string, existingDb: boolean) {
  try { carryOverProjectMergeModes(sqlite, dataDir, existingDb); }
  catch { console.warn('[merge-policy] Carry-over pending; existing merge choices remain effective.'); }
}
