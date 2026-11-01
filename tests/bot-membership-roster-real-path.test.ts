import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, expect, it } from 'vitest';
import Database from 'better-sqlite3';

const root = mkdtempSync(join(tmpdir(), 'o8-bot-membership-roster-'));
const token = 'local-membership-operator-fixture-0123456789';
mkdirSync(join(root, 'profiles'));
writeFileSync(join(root, 'ws-token'), token);
Object.assign(process.env, { O8_DATA_DIR: root, CORTEX_IDE_DATA_DIR: root,
  CORTEX_IDE_DB_PATH: join(root, 'membership.db'), O8_GROK_AGENT_DATA: join(root, 'profiles') });

const { getSqlite, closeDb, getDbPath, DB_SCHEMA_VERSION } = await import('@/lib/db');
const { GET } = await import('@/app/api/bots/route');
const bootTables = getSqlite().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('bot_members','bot_member_bindings','bot_member_sources') ORDER BY name").all();

afterAll(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });

it('normal boot creates membership and repeats the additive migration with existing boot markers', () => {
  const expected = [{ name: 'bot_member_bindings' }, { name: 'bot_member_sources' }, { name: 'bot_members' }];
  expect(bootTables).toEqual(expected);
  expect(existsSync(join(root, `.db-migrated-v${DB_SCHEMA_VERSION}`))).toBe(true);
  closeDb();
  const legacy = new Database(getDbPath());
  legacy.exec('DROP TABLE bot_member_sources; DROP TABLE bot_member_bindings; DROP TABLE bot_members');
  legacy.close();
  expect(getSqlite().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('bot_members','bot_member_bindings','bot_member_sources') ORDER BY name").all()).toEqual(expected);
});

it('GET /api/bots projects durable membership from an on-disk database across a restart', async () => {
  const db = getSqlite();
  // An existing membership database is a read-path fixture, independent of
  // whichever initializer the current application version provides.
  db.exec(`CREATE TABLE IF NOT EXISTS bot_members (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    house TEXT NOT NULL, display_name TEXT NOT NULL, icon_key TEXT, home_thread_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  db.prepare(`INSERT INTO bot_members(id,house,display_name,icon_key,home_thread_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).run('bot-durable', 'claude', 'Local build bot', 'claude-code',
    'thoughts-local-home', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
  const request = () => new NextRequest('http://localhost/api/bots', {
    headers: { authorization: `Bearer ${token}` },
  });
  const expected = { id: 'bot-durable', house: 'claude', name: 'Local build bot',
    icon: { key: 'claude-code' }, mainThread: { kind: 'o8-thread', id: 'thoughts-local-home' }, status: 'unknown' };
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect((await response.json()).bots).toEqual([expected]);
  closeDb();
  expect(getSqlite().prepare('SELECT id FROM bot_members').all()).toEqual([{ id: 'bot-durable' }]);
  expect((await (await GET(request())).json()).bots).toEqual([expected]);
});
