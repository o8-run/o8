import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

// Preserve the compatibility probe's real classic stdio/public-route boundary.
// All profiles and failures are disposable; no provider is dispatched.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-create-parity-')));
const token = 'fixture-project-create';
for (const [key, value] of Object.entries({ O8_DATA_DIR: root, CORTEX_IDE_DATA_DIR: root,
  CORTEX_IDE_DB_PATH: join(root, 'fixture.db'), WS_TOKEN: token })) vi.stubEnv(key, value);
const { POST, GET } = await import('@/app/api/projects/route');
const { getSqlite, closeDb } = await import('@/lib/db');
const { addRepo } = await import('@/lib/repos/registry');
type Result = { isError: boolean; content: Array<{ type: string; text: string }> };
type Call = (args: Record<string, unknown>) => Promise<Result>;
const children: ChildProcessWithoutNullStreams[] = [];
const hits: Array<{ bearer: string | undefined; marker: string | undefined; body: Record<string, unknown> }> = [];
let server: Server;
let origin: string;
let repoId: string;
let repo: string;
let classic: Call;
let frontDoor: Call;
let replyMode: 'normal' | 'drop' | 'incomplete' | 'invalid-json' = 'normal';
const rows = (id: string) => getSqlite().prepare('SELECT repo_id, role, suggestion_origin FROM project_repos WHERE project_id = ? ORDER BY repo_id').all(id);
const count = (name: string) => (getSqlite().prepare('SELECT count(*) AS n FROM projects WHERE name = ?').get(name) as { n: number }).n;

function client(enabled: boolean, apiBase = origin, bearer = token): Call {
  const env: NodeJS.ProcessEnv = { ...process.env, CORTEX_API_BASE: apiBase, WS_TOKEN: bearer,
    O8_MCP_NODE22_CHECKED: '1', O8_MCP_TOOL_LOADING: 'full' };
  if (enabled) env.O8_API_FRONT_DOOR = '1'; else delete env.O8_API_FRONT_DOOR;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/lib/mcp/cortex-mcp-server.ts'], {
    cwd: process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child); child.stderr.resume();
  let id = 0;
  const pending = new Map<number, (reply: Result) => void>();
  createInterface({ input: child.stdout }).on('line', line => {
    if (!line.startsWith('{')) return;
    const reply = JSON.parse(line) as { id: number; result: Result };
    pending.get(reply.id)?.(reply.result);
  });
  return args => new Promise<Result>((resolve, reject) => {
    const callId = ++id;
    const timer = setTimeout(() => { pending.delete(callId); reject(new Error('MCP create fixture timed out.')); }, 20_000);
    pending.set(callId, result => { clearTimeout(timer); pending.delete(callId); resolve(result); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: callId, method: 'tools/call',
      params: { name: 'cortex_create_project', arguments: args } }) + '\n');
  });
}
function unknown(result: Result) {
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/outcome.*unknown/i);
  expect(result.content[0].text).toContain('cortex_list_projects');
  expect(result.content[0].text).not.toMatch(/failed/i);
}

beforeAll(async () => {
  repo = join(root, 'repo'); mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.name=o8 test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  repoId = (await addRepo(repo)).id;
  getSqlite().exec(`CREATE TRIGGER fixture_create_repo_failure BEFORE INSERT ON project_repos
    WHEN NEW.repo_id = 'fixture-rejected-repo'
    BEGIN SELECT RAISE(ABORT, 'fixture repo add refused'); END;`);
  server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      if (request.method === 'POST') hits.push({ bearer: request.headers.authorization,
        marker: request.headers['x-o8-agent-tool'] as string | undefined, body: JSON.parse(body) });
      if (request.url !== '/api/projects') { response.writeHead(404).end(); return; }
      const req = new NextRequest(origin + request.url, { method: request.method,
        headers: { ...request.headers, 'x-o8-client-addr': '192.0.2.1' } as Record<string, string>, ...(body ? { body } : {}) });
      const result = request.method === 'GET' ? await GET(req) : await POST(req);
      const mode = replyMode; replyMode = 'normal';
      if (mode === 'drop') { response.destroy(); return; }
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(mode === 'incomplete' ? '{}' : mode === 'invalid-json' ? '{' : await result.text());
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port.');
  origin = `http://127.0.0.1:${address.port}`;
  classic = client(false); frontDoor = client(true);
});
afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
  }
  if (server) { const closed = once(server, 'close'); server.close(); await closed; }
  closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

it.each(['array', 'map'] as const)('pairs %s roles before dropping whitespace IDs only in front-door mode', async shape => {
  for (const [call, enabled] of [[classic, false], [frontDoor, true]] as const) {
    const name = `${enabled ? 'Front door' : 'Classic'} ${shape} fixture`;
    const roles = shape === 'array' ? [' first ', ' second '] : { '  ': ' first ', [repoId]: ' second ' };
    const start = hits.length;
    const result = await call({ name: `  ${name}  `, description: ' description ', repoIds: ['  ', repoId], roles,
      slug: 'must-not-forward', mainRepoId: 'must-not-forward' });
    expect(result.isError).toBe(false);
    expect(hits.length - start).toBe(enabled ? 1 : 0);
    const value = JSON.parse(result.content[0].text) as { projectId: string; slug: string };
    const stored = getSqlite().prepare('SELECT id, slug, name, description FROM projects WHERE id = ?').get(value.projectId) as { id: string; slug: string; name: string; description: string };
    expect(result).toEqual({ isError: false, content: [{ type: 'text', text: JSON.stringify({ projectId: stored.id, slug: stored.slug }) }] });
    expect(stored).toMatchObject({ name, description: 'description' });
    expect(count(name)).toBe(1);
    expect(rows(value.projectId)).toEqual(enabled
      ? [{ repo_id: repoId, role: 'second', suggestion_origin: 'manual' }]
      : [{ repo_id: '  ', role: 'first', suggestion_origin: 'manual' }, { repo_id: repoId, role: 'second', suggestion_origin: 'manual' }]);
    if (enabled) {
      expect(hits[start]).toEqual({ bearer: `Bearer ${token}`, marker: '1',
        body: { name, description: ' description ', repoIds: [repoId], roles: ['second'] } });
      // Inspect the persisted ledger before GET can project any missing state.
      const ledger = JSON.parse(readFileSync(join(root, 'projects.json'), 'utf8'));
      expect(ledger.projects.find((row: { id: string }) => row.id === value.projectId).repoPaths).toEqual([repo]);
      const readable = await fetch(origin + '/api/projects', { headers: { authorization: `Bearer ${token}` } });
      expect(readable.status).toBe(200);
      expect((await readable.json()).projects).toContainEqual(expect.objectContaining({ id: value.projectId, name }));
    }
  }
});

it('retains the classic initial filter and normalizes empty roles and description before sending', async () => {
  const start = hits.length;
  const result = await frontDoor({ name: 'Filtered create fixture', description: 9,
    repoIds: ['', false, '  ', repoId], roles: ['first', '  '] });
  expect(result.isError).toBe(false);
  expect(hits.length - start).toBe(1);
  expect(hits[start].body).toEqual({ name: 'Filtered create fixture', description: null, repoIds: [repoId], roles: [null] });
  expect(rows(JSON.parse(result.content[0].text).projectId)).toEqual([{ repo_id: repoId, role: null, suggestion_origin: 'manual' }]);
});

it('validates empty names locally without a request or a project', async () => {
  const before = hits.length;
  for (const call of [classic, frontDoor]) {
    expect(await call({ name: '  ' })).toEqual({ isError: true, content: [{ type: 'text', text: 'name is required.' }] });
  }
  expect(hits.length).toBe(before); expect(count('')).toBe(0);
});

it.each(['drop', 'incomplete', 'invalid-json'] as const)('reports %s success replies as unknown without replaying creation', async mode => {
  const name = `Ambiguous ${mode} fixture`; const before = hits.length;
  replyMode = mode;
  try {
    const result = await frontDoor({ name, repoIds: [repoId] });
    unknown(result);
    expect(hits.length - before).toBe(1); expect(count(name)).toBe(1);
  } finally { replyMode = 'normal'; }
});

it('reports a real 500 after project creation and repo-add failure as unknown, with no replay', async () => {
  const name = 'Partial create fixture'; const before = hits.length;
  const result = await frontDoor({ name, repoIds: ['fixture-rejected-repo'] });
  unknown(result);
  expect(hits.length - before).toBe(1); expect(count(name)).toBe(1);
  const project = getSqlite().prepare('SELECT id FROM projects WHERE name = ?').get(name) as { id: string };
  expect(rows(project.id)).toEqual([]);
});

it('keeps a real 4xx refusal as a failed-create error and writes no project', async () => {
  const denied = client(true, origin, 'wrong-token'); const before = hits.length;
  const result = await denied({ name: 'Refused create fixture' });
  expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'Failed to create project: Unauthorized' }] });
  expect(hits.length - before).toBe(1); expect(count('Refused create fixture')).toBe(0);
});

it('reports offline creation as unknown and writes nothing locally', async () => {
  const closed = createServer(); closed.listen(0, '127.0.0.1'); await once(closed, 'listening');
  const address = closed.address(); if (!address || typeof address === 'string') throw new Error('No fixture port.');
  const stopped = once(closed, 'close'); closed.close(); await stopped;
  const offline = client(true, `http://127.0.0.1:${address.port}`);
  const name = 'Offline create fixture'; const before = hits.length;
  unknown(await offline({ name }));
  expect(hits.length).toBe(before); expect(count(name)).toBe(0);
});
