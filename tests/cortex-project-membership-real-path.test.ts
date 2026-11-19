import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-mcp-membership-')));
const repo = join(root, 'repo');
mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
execFileSync('git', ['-C', repo, '-c', 'user.name=o8 test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
for (const [key, value] of Object.entries({ O8_DATA_DIR: root, CORTEX_IDE_DATA_DIR: root,
  CORTEX_IDE_DB_PATH: join(root, 'fixture.db'), WS_TOKEN: 'fixture-project-membership-operator',
  O8_BUNDLED_MCP_PATH: '', O8_BUNDLED_MCP_DIR: '', O8_PACKAGED_APP: '' })) vi.stubEnv(key, value);

const { POST } = await import('@/app/api/projects/[id]/repos/route');
const { PATCH, DELETE } = await import('@/app/api/projects/[id]/repos/[repoId]/route');
const { createProject } = await import('@/lib/projects/store');
const { addRepo } = await import('@/lib/repos/registry');
const { getSqlite, closeDb } = await import('@/lib/db');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { buildToolRegistry } = await import('@/lib/mcp/tool-spine/build');
const { toCodexServersMap } = await import('@/lib/mcp/tool-spine/emit-codex');
const token = getOrCreateWsToken();
type Result = { isError?: boolean; content: Array<{ type: string; text: string }> };
const children: ChildProcessWithoutNullStreams[] = [];
const hits: Array<{ method: string; url: string; bearer: string | undefined; marker: string | undefined; body: unknown }> = [];
let server: Server;
let origin: string;
let repoId: string;
let dropReply = false;

function client(frontDoor: boolean, apiBase = origin) {
  const env: NodeJS.ProcessEnv = { ...process.env, CORTEX_API_BASE: apiBase, WS_TOKEN: token, O8_MCP_NODE22_CHECKED: '1', O8_MCP_TOOL_LOADING: 'full' };
  if (frontDoor) env.O8_API_FRONT_DOOR = '1';
  else delete env.O8_API_FRONT_DOOR;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/lib/mcp/cortex-mcp-server.ts'], {
    cwd: process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  let id = 0;
  let diagnostic = '';
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-8_000); });
  const pending = new Map<number, (result: Result) => void>();
  createInterface({ input: child.stdout }).on('line', line => {
    if (!line.startsWith('{')) return;
    const reply = JSON.parse(line) as { id: number; result: Result };
    pending.get(reply.id)?.(reply.result);
  });
  return (name: string, args: Record<string, unknown>) => new Promise<Result>((resolve, reject) => {
    const callId = ++id;
    const timer = setTimeout(() => { pending.delete(callId); reject(new Error(`MCP fixture timeout: ${diagnostic}`)); }, 20_000);
    pending.set(callId, result => { clearTimeout(timer); pending.delete(callId); resolve(result); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: callId, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
}
const add = 'cortex_add_repo_to_project';
const remove = 'cortex_remove_repo_from_project';
const role = 'cortex_set_repo_role';
const success = { isError: false, content: [{ type: 'text', text: '{"ok":true}' }] };
const link = (projectId: string) => getSqlite().prepare('SELECT role, suggestion_origin FROM project_repos WHERE project_id = ? AND repo_id = ?').get(projectId, repoId);
const writes = () => (getSqlite().prepare('SELECT count(*) AS n FROM fixture_membership_writes').get() as { n: number }).n;
function ledger(projectId: string): { repoPaths: string[] } | undefined {
  const file = join(root, 'projects.json');
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')).projects.find((row: { id: string }) => row.id === projectId);
}

beforeAll(async () => {
  repoId = (await addRepo(repo)).id;
  getSqlite().exec(`CREATE TABLE fixture_membership_writes (kind TEXT);
    CREATE TRIGGER fixture_membership_insert AFTER INSERT ON project_repos BEGIN INSERT INTO fixture_membership_writes VALUES ('insert'); END;
    CREATE TRIGGER fixture_membership_update AFTER UPDATE ON project_repos BEGIN INSERT INTO fixture_membership_writes VALUES ('update'); END;
    CREATE TRIGGER fixture_membership_delete AFTER DELETE ON project_repos BEGIN INSERT INTO fixture_membership_writes VALUES ('delete'); END;`);
  server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      hits.push({ method: request.method!, url: request.url!, bearer: request.headers.authorization,
        marker: request.headers['x-o8-agent-tool'] as string | undefined, body: body ? JSON.parse(body) : undefined });
      const match = request.url?.match(/^\/api\/projects\/([^/]+)\/repos(?:\/([^/]+))?$/);
      if (!match) { response.writeHead(404).end(); return; }
      const req = new NextRequest(origin + request.url, { method: request.method, headers: request.headers as Record<string, string>, ...(body ? { body } : {}) });
      const params = Promise.resolve({ id: decodeURIComponent(match[1]), repoId: decodeURIComponent(match[2] ?? '') });
      const result = request.method === 'POST' ? await POST(req, { params })
        : request.method === 'PATCH' ? await PATCH(req, { params }) : await DELETE(req, { params });
      if (dropReply) { dropReply = false; response.destroy(); return; }
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(await result.text());
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server missing address.');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  }
  if (server) { const closed = once(server, 'close'); server.close(); await closed; }
  closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

it('emits the front-door flag only to enabled cortex stdio entries', () => {
  vi.stubEnv('O8_API_FRONT_DOOR', '1');
  const enabled = toCodexServersMap(buildToolRegistry(repo)).cortex;
  if (enabled.type !== 'stdio') throw new Error('Expected cortex stdio entry.');
  expect(enabled.env?.O8_API_FRONT_DOOR).toBe('1');
  vi.stubEnv('O8_API_FRONT_DOOR', '0');
  const classic = toCodexServersMap(buildToolRegistry(repo)).cortex;
  if (classic.type !== 'stdio') throw new Error('Expected cortex stdio entry.');
  expect(classic.env).not.toHaveProperty('O8_API_FRONT_DOOR');
});

it('matches classic results through public routes, operator grants, SQLite and ledger sync', async () => {
  const classic = client(false);
  const frontDoor = client(true);
  const baseline: Result[] = [];
  for (const [call, native] of [[classic, false], [frontDoor, true]] as const) {
    const project = createProject({ name: native ? 'Front door fixture' : 'Classic fixture' });
    const args = { projectId: project.id, repoId };
    const start = hits.length;
    const results: Result[] = [];
    results.push(await call(add, { ...args, role: '  backend  ' }));
    expect(results.at(-1)).toEqual(success);
    if (native) expect(hits.length - start).toBe(1);
    expect(link(project.id)).toEqual({ role: 'backend', suggestion_origin: 'manual' });
    if (native) expect(ledger(project.id)?.repoPaths).toEqual([repo]);
    else expect(ledger(project.id)).toBeUndefined();
    results.push(await call(role, { ...args, role: '  reviewer  ' }));
    expect(link(project.id)).toMatchObject({ role: 'reviewer' });
    results.push(await call(role, { ...args, role: '  ' }));
    expect(link(project.id)).toMatchObject({ role: null });
    results.push(await call(role, args));
    expect(link(project.id)).toMatchObject({ role: null });
    results.push(await call(remove, args));
    expect(link(project.id)).toBeUndefined();
    if (native) expect(ledger(project.id)?.repoPaths).toEqual([]);
    results.push(await call(remove, args));
    expect(results.at(-1)).toEqual({ isError: false, content: [{ type: 'text', text: '{"ok":false}' }] });
    results.push(await call(role, args));
    expect(results.at(-1)).toEqual({ isError: true, content: [{ type: 'text', text: 'Project repo link not found.' }] });
    results.push(await call(add, { projectId: 'missing-project', repoId }));
    if (!native) {
      baseline.push(...results); expect(hits.length).toBe(start);
    } else {
      expect(results).toEqual(baseline);
      expect(hits.slice(start)).toHaveLength(8);
      expect(hits.slice(start).map(hit => hit.method)).toEqual(['POST', 'PATCH', 'PATCH', 'PATCH', 'DELETE', 'DELETE', 'PATCH', 'POST']);
      for (const hit of hits.slice(start)) { expect(hit.bearer).toBe(`Bearer ${token}`); expect(hit.marker).toBe('1'); }
      expect(hits[start].body).toEqual({ repoId, role: 'backend', suggestionOrigin: 'manual' });
      expect(hits.slice(start + 1, start + 4).map(hit => hit.body)).toEqual([{ role: 'reviewer' }, { role: null }, { role: null }]);
    }
  }
});

it('reports a lost reply as unknown after exactly one committed change, without retry or fallback', async () => {
  const call = client(true);
  const project = createProject({ name: 'Lost reply fixture' });
  for (const [tool, args] of [[add, {}], [role, { role: 'reviewer' }], [remove, {}]] as const) {
    const start = hits.length; const before = writes(); dropReply = true;
    const result = await call(tool, { projectId: project.id, repoId, ...args });
    expect(hits.length - start).toBe(1);
    expect(writes() - before).toBe(1);
    if (tool === add) expect(hits[start].body).toEqual({ repoId, role: null, suggestionOrigin: 'manual' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/outcome.*unknown/i);
    expect(result.content[0].text).toContain('cortex_list_projects');
    expect(result.content[0].text).not.toMatch(/failed/i);
    expect(ledger(project.id)?.repoPaths).toEqual(tool === remove ? [] : [repo]);
  }
});

it('never writes locally when the front door is offline', async () => {
  const closed = createServer(); closed.listen(0, '127.0.0.1'); await once(closed, 'listening');
  const address = closed.address(); if (!address || typeof address === 'string') throw new Error('No fixture port.');
  const stopped = once(closed, 'close'); closed.close(); await stopped;
  const call = client(true, `http://127.0.0.1:${address.port}`);
  const project = createProject({ name: 'Offline fixture' }); const before = writes();
  for (const tool of [add, role, remove]) {
    const result = await call(tool, { projectId: project.id, repoId, role: 'reviewer' });
    expect(result.isError).toBe(true); expect(result.content[0].text).toMatch(/outcome.*unknown/i);
    expect(result.content[0].text).toContain('cortex_list_projects');
  }
  expect(writes()).toBe(before); expect(link(project.id)).toBeUndefined();
});
