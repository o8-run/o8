import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

// Codex's own thread table: many archived=0 rows, an index on each column.
function codexHome(rows: Array<{ id: string; archived: number; updatedAt: number }>) {
  const home = mkdtempSync(join(tmpdir(), 'o8-codex-live-'));
  homes.push(home);
  const db = new Database(join(home, 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, body TEXT);
    CREATE INDEX idx_threads_archived ON threads(archived);
    CREATE INDEX idx_threads_updated_at ON threads(updated_at);`);
  const insert = db.prepare('INSERT INTO threads (id, archived, updated_at, body) VALUES (?, ?, ?, ?)');
  for (const row of rows) insert.run(row.id, row.archived, row.updatedAt, 'x'.repeat(200));
  db.close();
  return home;
}

describe('live Codex sessions', () => {
  it('finds recent threads through the updated_at index, not by reading every unarchived thread', async () => {
    const now = Math.floor(Date.now() / 1000);
    const rows = Array.from({ length: 500 }, (_, index) => ({ id: `old-${index}`, archived: 0, updatedAt: now - 30 * 86_400 }));
    rows.push({ id: 'recent', archived: 0, updatedAt: now - 60 }, { id: 'recent-archived', archived: 1, updatedAt: now - 60 });
    vi.stubEnv('CODEX_HOME', codexHome(rows));
    const plans: string[] = [];
    const prepare = Database.prototype.prepare;
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
      if (/FROM threads/.test(sql)) {
        plans.push(...(prepare.call(this, `EXPLAIN QUERY PLAN ${sql}`).all(0) as Array<{ detail: string }>).map((row) => row.detail));
      }
      return prepare.call(this, sql);
    });
    const { isCodexSessionLive } = await import('./live-sessions');

    expect(isCodexSessionLive('codex:recent')).toBe(true);
    expect(isCodexSessionLive('codex:recent-archived')).toBe(false);
    expect(isCodexSessionLive('codex:old-1')).toBe(false);
    expect(plans.join('\n')).toContain('idx_threads_updated_at');
    expect(plans.join('\n')).not.toContain('idx_threads_archived');
  });
});
