import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, expect, it, vi } from 'vitest';
import { ensureV83RuntimeTablesSchema } from './v83-runtime-tables-migration';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-v83-runtime-tables-'));
const dbPath = path.join(dataDir, 'cortex-ide.db');
vi.stubEnv('O8_DATA_DIR', dataDir);
vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);
vi.stubEnv('CORTEX_IDE_DB_PATH', dbPath);
const { closeDb, getSqlite } = await import('@/lib/db');

afterAll(() => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try { closeDb(); } finally { log.mockRestore(); }
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

it('creates runtime tables at bootstrap so a second process never changes the schema', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  let bootstrapped: Database.Database;
  try { bootstrapped = getSqlite(); } finally { log.mockRestore(); }
  const version = bootstrapped.pragma('schema_version', { simple: true });
  const tables = new Set((bootstrapped.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map(row => row.name));
  for (const table of ['worktree_metadata_leases', 'worktree_maintenance_roots', 'supervisor_inbox', 'problem_dossiers',
    'problem_events', 'dependency_seed_images', 'dependency_seed_leases', 'knowledge_chunks']) {
    expect(tables).toContain(table);
  }
  expect((bootstrapped.prepare('PRAGMA table_info(mobile_live_activity_tokens)').all() as Array<{ name: string }>)
    .map(column => column.name)).toContain('remote_notification_token');

  // The worker runtime opens its own connection and runs the same schema code on first use.
  const runtime = new Database(bootstrapped.name);
  try {
    ensureV83RuntimeTablesSchema(runtime);
    expect(runtime.pragma('schema_version', { simple: true })).toBe(version);
  } finally { runtime.close(); }
});
