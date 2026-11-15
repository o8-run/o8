import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, expect, it } from 'vitest';
const run = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), 'o8-policy-startup-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
async function start(data: string, order: string) {
  const { stdout } = await run(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'tests/fixtures/project-policy-startup.ts', order], {
    env: { ...process.env, O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data, CORTEX_IDE_DB_PATH: join(data, 'test.db'), HOME: data }, timeout: 30_000,
  });
  return JSON.parse(stdout.split('\n').find(line => line.startsWith('{"policy"'))!);
}
it.each(['ws-first', 'next-first'])('fresh %s startup keeps default PR-first', async order => {
  const data = mkdtempSync(join(root, order));
  expect((await start(data, order)).policy.mode).toBe('pr_only');
});
it('two simultaneous upgrade processes retain saved PR-only and legacy direct, including projectless lanes', async () => {
  const data = mkdtempSync(join(root, 'upgrade'));
  await start(data, 'seed');
  const db = new Database(join(data, 'test.db'));
  db.prepare("DELETE FROM app_state WHERE key = 'migration:project-merge-mode:carry-over-v1'").run();
  db.prepare("INSERT INTO projects (id,name,slug,created_at,updated_at) VALUES ('old','Old','old',1,1), ('saved','Saved','saved',1,1)").run();
  db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES ('project-merge-mode:saved','pr_only',1)").run();
  db.close();
  writeFileSync(join(data, '.dogfood-pr-only'), '');
  writeFileSync(join(data, 'projects.json'), '{corrupt');
  const results = await Promise.all([start(data, 'ws-first'), start(data, 'next-first')]);
  expect(results.map(result => result.policy.mode)).toEqual(['pr_only', 'pr_only']);
  const inspect = new Database(join(data, 'test.db'));
  const read = (id: string) => inspect.prepare('SELECT value FROM app_state WHERE key = ?').get(`project-merge-mode:${id}`);
  expect(read('default')).toEqual({ value: 'direct' });
  expect(read('old')).toEqual({ value: 'direct' });
  expect(read('saved')).toEqual({ value: 'pr_only' });
  inspect.close();
  unlinkSync(join(data, '.dogfood-pr-only'));
  const resumed = await start(data, 'next-first');
  expect(resumed.policy.mode).toBe('direct');
  expect(resumed.savedPolicy).toBe('pr_only');
  expect(resumed.projectlessPolicy).toBe('direct');
});

it('two simultaneous fresh processes cannot misclassify bootstrap JSON as an upgrade', async () => {
  const data = mkdtempSync(join(root, 'fresh-race'));
  const results = await Promise.all([start(data, 'ws-first'), start(data, 'next-first')]);
  expect(results.map(result => result.policy.mode)).toEqual(['pr_only', 'pr_only']);
});

it('corrupt inventory leaves the database open and preserves existing choices', async () => {
  const data = mkdtempSync(join(root, 'corrupt'));
  await start(data, 'seed');
  const db = new Database(join(data, 'test.db'));
  db.prepare("DELETE FROM app_state WHERE key = 'migration:project-merge-mode:carry-over-v1'").run();
  db.prepare("INSERT INTO projects (id,name,slug,created_at,updated_at) VALUES ('old','Old','old',1,1), ('saved','Saved','saved',1,1)").run();
  db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES ('project-merge-mode:saved','pr_only',1)").run(); db.close();
  writeFileSync(join(data, 'projects.json'), '{corrupt');
  const result = await start(data, 'next-first');
  expect(result.policy.mode).toBe('direct'); expect(result.oldPolicy).toBe('direct');
  expect(result.savedPolicy).toBe('pr_only'); expect(result.projectlessPolicy).toBe('direct');
});

it('an existing project from before app_state existed keeps direct integration', async () => {
  const data = mkdtempSync(join(root, 'old-schema'));
  const db = new Database(join(data, 'test.db'));
  db.exec(`CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    description TEXT, main_repo_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  ); INSERT INTO projects (id,name,slug,created_at,updated_at) VALUES ('old','Old','old',1,1);`);
  db.close();
  const result = await start(data, 'next-first');
  expect(result.oldPolicy).toBe('direct'); expect(result.policy.mode).toBe('direct');
});
