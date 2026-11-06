import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, expect, it } from 'vitest';

const directory = mkdtempSync(join(tmpdir(), 'o8-tasks-read-only-'));
process.env.CORTEX_IDE_DATA_DIR = directory;
process.env.O8_DATA_DIR = directory;
process.env.CORTEX_IDE_DB_PATH = join(directory, 'cortex-ide.db');
process.env.WS_TOKEN = 'tasks-read-only-fixture';

const { getSqlite, closeDb } = await import('@/lib/db');
const { createLane } = await import('@/lib/lane/registry');
const { listReposFresh } = await import('@/lib/repos/registry');
const projects = await import('@/lib/repos/projects');
const { GET } = await import('@/app/api/tasks/route');
const sqlite = getSqlite();
const ledgerPath = join(directory, 'projects.json');

afterAll(() => { closeDb(); rmSync(directory, { recursive: true, force: true }); });

function snapshot() {
  const files = readdirSync(directory, { recursive: true }).map(String).sort()
    .filter((name) => !/^cortex-ide\.db(?:-|$)/.test(name))
    .map((name) => {
      const file = join(directory, name);
      const info = statSync(file);
      return { name, mtime: info.mtimeMs, content: info.isFile() ? readFileSync(file).toString('base64') : null };
    });
  // Compare rows, allowing only the shared cold-database schema bootstrap.
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  const rows = tables.flatMap(({ name }) => {
    const records = sqlite.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
    return records.length ? [{ name, records }] : [];
  });
  return { files, rows };
}

function request(query = '') {
  return new NextRequest(`http://localhost/api/tasks${query}`, {
    headers: { authorization: `Bearer ${process.env.WS_TOKEN}` },
  });
}

it('GET leaves the cold ledger and database rows unchanged, including project context and task briefs', async () => {
  expect(existsSync(ledgerPath)).toBe(false);
  const cold = snapshot();
  const empty = await GET(request());
  expect(empty.status).toBe(200);
  expect(await empty.json()).toMatchObject({ schema: 'o8/task.pool/v1', tasks: [] });
  expect(existsSync(ledgerPath), 'GET must not create projects.json').toBe(false);
  expect(snapshot()).toEqual(cold);

  const repoPath = join(directory, 'repo');
  mkdirSync(repoPath);
  writeFileSync(join(directory, 'repos.json'), JSON.stringify({ version: 1, repos: [{
    id: 'fixture-repo', name: 'Fixture repo', localPath: repoPath, isGitRepo: false,
    defaultBranch: 'main', addedAt: new Date().toISOString(),
  }] }));
  await listReposFresh();
  const lane = createLane({ repoPath, projectId: 'repo:fixture-repo', branch: 'fixture/task', runtime: 'codex' });
  const populated = snapshot();
  const response = await GET(request(`?includeDone=true&includeBrief=true&repoPath=${encodeURIComponent(repoPath)}`));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.tasks).toHaveLength(1);
  expect(body.tasks[0]).toMatchObject({ id: lane.id, repoPath, project: { id: 'repo:fixture-repo', name: 'Fixture repo' } });
  expect(body.tasks[0].taskBrief).toContain('Fixture repo');
  expect(existsSync(ledgerPath), 'project context must not bootstrap the ledger').toBe(false);
  expect(snapshot()).toEqual(populated);
});

it('startup initialization persists the default ledger once and preserves an existing ledger', async () => {
  await projects.initializeProjectsLedger();
  expect(existsSync(ledgerPath)).toBe(true);
  expect(JSON.parse(readFileSync(ledgerPath, 'utf8'))).toMatchObject({
    activeProjectId: 'default', projects: [{ id: 'default', repoPaths: [join(directory, 'repo')] }],
  });
  expect(sqlite.prepare("SELECT value FROM app_state WHERE key = 'active_project_id'").get()).toEqual({ value: 'default' });
  const before = snapshot();
  await projects.initializeProjectsLedger();
  expect(snapshot()).toEqual(before);
  const response = await GET(request('?includeDone=true&includeBrief=true'));
  expect(response.status).toBe(200);
  expect((await response.json()).tasks[0].project.id).toBe('repo:fixture-repo');
  expect(snapshot()).toEqual(before);
});
