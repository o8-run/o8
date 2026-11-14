import type Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const projectMergeModeKey = (id: string) => `project-merge-mode:${id}`;
const marker = 'project-merge-mode:carry-over-v1';

/** Runs before the DB singleton is published. Values and marker commit together. */
export function carryOverProjectMergeModes(sqlite: Database.Database, dataDir: string, existingDb: boolean) {
  sqlite.transaction(() => {
    if (sqlite.prepare('SELECT 1 FROM app_state WHERE key = ?').get(marker)) return;
    const ids = new Set<string>();
    const add = (value: unknown) => { if (typeof value === 'string' && value) ids.add(value); };
    if (existingDb) {
      for (const row of sqlite.prepare('SELECT id FROM projects').all() as { id: string }[]) add(row.id);
      for (const row of sqlite.prepare('SELECT DISTINCT project_id AS id FROM lanes').all() as { id: string }[]) add(row.id);
      add('default');
    }
    // Legacy and virtual projects may not have a SQLite project row yet. Read failures
    // other than absence abort initialization, rather than applying a new default.
    for (const [file, field] of [['projects.json', 'projects'], ['repos.json', 'repos']] as const) {
      let parsed;
      try { parsed = JSON.parse(readFileSync(join(dataDir, file), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (!parsed || !Array.isArray(parsed[field])) throw new Error('Invalid legacy project inventory.');
      for (const row of parsed[field]) {
        if (file === 'repos.json') add(`repo:${row.id}`);
        else { add(row.id); add(row.sqliteProjectId); }
      }
    }
    const mode = existsSync(join(dataDir, '.dogfood-pr-only')) ? 'pr_only' : 'direct';
    const insert = sqlite.prepare('INSERT OR IGNORE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)');
    for (const id of ids) insert.run(projectMergeModeKey(id), mode, Date.now());
    insert.run(marker, 'done', Date.now());
  }).immediate();
}
