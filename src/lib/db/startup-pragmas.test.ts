import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { ACTIVE_CACHE_KIB, configureSqlite, RESTING_CACHE_KIB, setSqliteResting } from './startup-pragmas';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('shrinks the page cache at rest and restores it on wake', () => {
  const dir = mkdtempSync(join(tmpdir(), 'o8-pragmas-'));
  dirs.push(dir);
  const sqlite = new Database(join(dir, 'fixture.db'));
  try {
    configureSqlite(sqlite);
    expect(sqlite.pragma('cache_size', { simple: true })).toBe(-ACTIVE_CACHE_KIB);
    setSqliteResting(sqlite, true);
    expect(sqlite.pragma('cache_size', { simple: true })).toBe(-RESTING_CACHE_KIB);
    setSqliteResting(sqlite, false);
    expect(sqlite.pragma('cache_size', { simple: true })).toBe(-ACTIVE_CACHE_KIB);
  } finally {
    sqlite.close();
  }
});
