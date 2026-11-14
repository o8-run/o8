import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';

const root = mkdtempSync(join(tmpdir(), 'project-merge-policy-'));
process.env.CORTEX_IDE_DATA_DIR = root;
process.env.O8_DATA_DIR = root;
process.env.CORTEX_IDE_DB_PATH = join(root, 'test.db');
process.env.WS_TOKEN = 'operator-policy-fixture';
const { createProject } = await import('@/lib/projects/store');
const { currentLaneMergePolicy } = await import('@/lib/lane/dogfood-guard');
const { getSqlite } = await import('@/lib/db');
afterAll(() => { getSqlite().close(); rmSync(root, { recursive: true, force: true }); });

it('fresh persisted project is PR-first', () => {
  const project = createProject({ name: 'Fresh' });
  expect(currentLaneMergePolicy(project.id).mode).toBe('pr_only');
});

it('carries all old choices atomically and never recalculates them after restart', async () => {
  const { carryOverProjectMergeModes, projectMergeModeKey } = await import('@/lib/lane/project-merge-mode-migration');
  const dbPath = join(root, 'legacy.db');
  let sqlite = new Database(dbPath);
  sqlite.exec(`CREATE TABLE projects(id TEXT); INSERT INTO projects VALUES ('old'), ('saved');
    CREATE TABLE lanes(project_id TEXT); CREATE TABLE app_state(key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
    INSERT INTO app_state VALUES ('project-merge-mode:saved', 'pr_only', 1);
    CREATE TRIGGER fail_second BEFORE INSERT ON app_state WHEN NEW.key = 'project-merge-mode:default'
    BEGIN SELECT RAISE(ABORT, 'fixture interruption'); END;`);
  expect(() => carryOverProjectMergeModes(sqlite, root, true)).toThrow('fixture interruption');
  expect(sqlite.prepare('SELECT value FROM app_state WHERE key = ?').get(projectMergeModeKey('old'))).toBeUndefined();
  sqlite.exec('DROP TRIGGER fail_second');
  carryOverProjectMergeModes(sqlite, root, true);
  sqlite.close();
  writeFileSync(join(root, '.dogfood-pr-only'), '');
  sqlite = new Database(dbPath);
  carryOverProjectMergeModes(sqlite, root, true);
  expect(sqlite.prepare('SELECT value FROM app_state WHERE key = ?').get(projectMergeModeKey('old'))).toEqual({ value: 'direct' });
  expect(sqlite.prepare('SELECT value FROM app_state WHERE key = ?').get(projectMergeModeKey('saved'))).toEqual({ value: 'pr_only' });
  sqlite.close();
  unlinkSync(join(root, '.dogfood-pr-only'));
});

it('fresh lane refuses direct integration at the remote merge entry point', async () => {
  const { createLane, getLane } = await import('@/lib/lane/registry');
  const { performRemoteCustomerMerge } = await import('@/lib/lane/commands-remote-merge');
  const project = createProject({ name: 'PR lane' });
  const lane = createLane({ projectId: project.id, repoPath: root, branch: 'feature', runtime: 'codex' });
  const result = await performRemoteCustomerMerge(lane, { verb: 'merge', laneId: lane.id }, 'user');
  expect(result).toMatchObject({ ok: false, reason: 'pr_only' });
  expect(result.note).toContain('pull request');
  const { dispatch } = await import('@/lib/lane/commands');
  expect(await dispatch({ verb: 'merge', laneId: lane.id, actor: 'user' })).toMatchObject({ ok: false, reason: 'pr_only' });
  expect(getLane(lane.id)?.status).toBe(lane.status);
});

it('operator opt-in persists only for the selected project; worker and device cannot opt in', async () => {
  const { createHash } = await import('node:crypto');
  writeFileSync(join(root, 'worker-token'), 'worker-policy-fixture-token');
  writeFileSync(join(root, 'mobile-device-tokens'), `${createHash('sha256').update('device-policy-fixture-token').digest('hex')}\n`);
  const { PATCH } = await import('@/app/api/projects/[id]/route');
  const { PATCH: panelPatch } = await import('@/app/api/panel/projects/[id]/route');
  const project = createProject({ name: 'Opt in' });
  const other = createProject({ name: 'Stay PR' });
  const patch = (token: string, id = project.id) => PATCH(new NextRequest(`http://localhost/api/projects/${id}`, {
    method: 'PATCH', headers: { host: 'localhost', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ mergeMode: 'direct' }),
  }), { params: Promise.resolve({ id }) });
  expect((await patch('worker-policy-fixture-token')).status).toBe(403);
  expect((await patch('device-policy-fixture-token')).status).toBe(403);
  for (const token of ['worker-policy-fixture-token', 'device-policy-fixture-token']) {
    const request = new NextRequest(`http://localhost/api/panel/projects/${project.id}`, {
      method: 'PATCH', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ mergeMode: 'direct' }),
    });
    expect((await panelPatch(request, { params: Promise.resolve({ id: project.id }) })).status).toBe(403);
  }
  expect(currentLaneMergePolicy(project.id).mode).toBe('pr_only');
  expect((await patch('operator-policy-fixture')).status).toBe(200);
  expect(currentLaneMergePolicy(project.id).mode).toBe('direct');
  expect(currentLaneMergePolicy(other.id).mode).toBe('pr_only');
  const { closeDb } = await import('@/lib/db'); closeDb();
  expect(currentLaneMergePolicy(project.id).mode).toBe('direct');
  writeFileSync(join(root, '.dogfood-pr-only'), '');
  expect(currentLaneMergePolicy(project.id).mode).toBe('pr_only');
  unlinkSync(join(root, '.dogfood-pr-only'));
});


it('existing project without a saved mode retains direct through database startup', async () => {
  const old = createProject({ name: 'Existing before upgrade' });
  const sqlite = getSqlite();
  sqlite.prepare("DELETE FROM app_state WHERE key = 'project-merge-mode:carry-over-v1'").run();
  sqlite.exec(`CREATE TRIGGER interrupt_carry_over BEFORE INSERT ON app_state
    WHEN NEW.key = 'project-merge-mode:default' BEGIN SELECT RAISE(ABORT, 'upgrade interruption'); END;`);
  const { closeDb } = await import('@/lib/db'); closeDb();
  expect(() => currentLaneMergePolicy(old.id)).toThrow('upgrade interruption');
  const inspect = new Database(join(root, 'test.db'));
  expect(inspect.prepare('SELECT value FROM app_state WHERE key = ?').get(`project-merge-mode:${old.id}`)).toBeUndefined();
  inspect.exec('DROP TRIGGER interrupt_carry_over'); inspect.close();
  expect(currentLaneMergePolicy(old.id).mode).toBe('direct');
  closeDb();
  expect(currentLaneMergePolicy(old.id).mode).toBe('direct');
  const fresh = createProject({ name: 'After upgrade' });
  expect(currentLaneMergePolicy(fresh.id).mode).toBe('pr_only');
});


it('retains an imported legacy project choice when its SQLite identity is created', () => {
  getSqlite().prepare('INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('project-merge-mode:legacy-import', 'direct', Date.now());
  const imported = createProject({ name: 'Imported project', mergeModeSourceProjectId: 'legacy-import' });
  expect(currentLaneMergePolicy(imported.id).mode).toBe('direct');
  expect(currentLaneMergePolicy(createProject({ name: 'Unrelated new project' }).id).mode).toBe('pr_only');
});
