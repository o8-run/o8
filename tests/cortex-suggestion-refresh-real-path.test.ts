import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { WebSocket, type RawData } from 'ws';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

type Result = { isError: boolean; content: Array<{ text: string }> };
type Event = { stream?: string; channel?: string; event?: string; data?: { mutation?: { action?: string; runtime?: string; status?: string }; events?: Event[] } };
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-suggestion-refresh-')));
const children: ChildProcessWithoutNullStreams[] = [];
let server: Awaited<ReturnType<typeof startParityReference>>;
let receiver: WebSocket;
let origin: string;
let database: typeof import('@/lib/db');
const received: Event[] = [];
const reads: Array<Promise<unknown>> = [];
const mutations = () => received.filter(event => event.data?.mutation?.action === 'project-create-from-suggestion');
function cache(id: string) {
  writeFileSync(join(root, 'project-suggestions.json'), JSON.stringify({ cacheKey: 'fixture', generatedAt: Date.now(),
    suggestions: [{ id, suggestedName: `Suggested ${id}`, rationale: 'Fixture rationale', repoIds: ['fixture-repo'],
      detectedRoles: { 'fixture-repo': 'backend' }, confidence: 'high', evidence: [] }] }));
}
function callClient(frontDoor = true) {
  const env: NodeJS.ProcessEnv = { ...process.env, CORTEX_IDE_DATA_DIR: root, O8_DATA_DIR: root,
    CORTEX_IDE_DB_PATH: join(root, 'cortex-ide.db'), O8_API_FRONT_DOOR: frontDoor ? '1' : undefined, O8_MCP_NODE22_CHECKED: '1', O8_MCP_TOOL_LOADING: 'full' };
  // Exercise the profile's published ports and credential, not a test override.
  for (const key of ['PORT', 'WS_PORT', 'O8_API_PORT', 'O8_WS_PORT', 'CORTEX_IDE_PORT', 'CORTEX_API_BASE', 'CORTEX_REALTIME_INTERNAL_ORIGIN', 'WS_TOKEN', 'O8_DEV_FRONTEND_URL']) delete env[key];
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/lib/mcp/cortex-mcp-server.ts'], { cwd: process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child); child.stderr.resume();
  let id = 0;
  const pending = new Map<number, (result: Result) => void>();
  createInterface({ input: child.stdout }).on('line', line => {
    if (!line.startsWith('{')) return;
    const reply = JSON.parse(line); pending.get(reply.id)?.(reply.result);
  });
  return (suggestionId: string) => new Promise<Result>((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Suggestion fixture timeout')); }, 15000);
    pending.set(requestId, result => { clearTimeout(timer); pending.delete(requestId); resolve(result); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/call',
      params: { name: 'cortex_create_project_from_suggestion', arguments: { suggestionId } } }) + '\n');
  });
}
async function barrier() {
  const pong = new Promise<void>(resolve => {
    const listen = (raw: RawData) => { if (JSON.parse(String(raw)).channel === 'pong') { receiver.off('message', listen); resolve(); } };
    receiver.on('message', listen);
  });
  receiver.send(JSON.stringify({ type: 'ping' })); await pong; await Promise.all(reads);
}
function stored(result: Result, id: string) {
  expect(result.isError).toBe(false);
  const value = JSON.parse(result.content[0].text);
  expect(value).toMatchObject({ memberCount: 1, projectId: expect.any(String), slug: expect.any(String) });
  expect(database.getSqlite().prepare('SELECT name, description FROM projects WHERE id = ?').get(value.projectId))
    .toEqual({ name: `Suggested ${id}`, description: 'Fixture rationale' });
  expect(database.getSqlite().prepare('SELECT role, suggestion_origin FROM project_repos WHERE project_id = ?').get(value.projectId))
    .toEqual({ role: 'backend', suggestion_origin: 'ai-semantic' });
  expect(JSON.parse(readFileSync(join(root, 'project-suggestions.json'), 'utf8')).suggestions).toEqual([]);
  return value;
}
beforeAll(async () => {
  server = await startParityReference({ directory: root, productFrontDoor: true, nativeHttp: true,
    o8d: Boolean(process.env.O8D_TEST_BINARY), binary: process.env.O8D_TEST_BINARY });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  if (process.env.O8D_TEST_BINARY) expect((await (await fetch(origin + '/health')).json()).delivery.transport).toBe('o8d');
  // The launcher owns these files. Publish its Next-off arrangement: both
  // public ports name o8d when that backend was explicitly supplied.
  writeFileSync(join(root, 'api-port'), new URL(origin).port);
  writeFileSync(join(root, 'ws-port'), new URL(origin).port);
  expect(readFileSync(join(root, 'ws-port'), 'utf8').trim()).toBe(new URL(origin).port);
  vi.stubEnv('O8_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DB_PATH', join(root, 'cortex-ide.db'));
  database = await import('@/lib/db');
  receiver = new WebSocket(server.url + '?token=' + encodeURIComponent(server.token));
  receiver.on('message', raw => {
    const frame = JSON.parse(String(raw));
    for (const event of frame.data?.events ?? []) {
      received.push(event);
      if (event.data?.mutation?.action === 'project-create-from-suggestion') reads.push((async () => {
        const response = await fetch(origin + '/api/projects', { headers: { authorization: 'Bearer ' + server.token } });
        expect(response.status).toBe(200); return response.json();
      })());
    }
  });
  await once(receiver, 'open');
  receiver.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions: [{ stream: 'global' }] }));
  await barrier();
  // Verify the published public port forwards authenticated internal ingress
  // with Next stopped. Local runs can reuse a cached o8d, without compiling it.
  const response = await fetch(origin + '/internal/realtime', { method: 'POST', headers: { authorization: 'Bearer ' + server.token, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'mutation', mutation: { mutationId: 'transport-fixture', action: 'fixture-transport', source: 'server', runtime: 'fixture', status: 'completed', createdAt: new Date().toISOString(), settledAt: new Date().toISOString() }, refreshTargets: ['global'] }) });
  expect(response.ok).toBe(true); await barrier();
  expect(received.some(event => event.data?.mutation?.action === 'fixture-transport')).toBe(true);
}, 60000);
afterAll(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
  if (receiver) { receiver.terminate(); }
  await server?.stop(); database?.closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});
it('publishes once after consumption and the directly written project is readable in WS', async () => {
  cache('accepted'); const before = mutations().length;
  const result = await callClient()('accepted'); const value = stored(result, 'accepted');
  await barrier(); expect(mutations().length - before).toBe(1);
  expect(mutations().at(-1)).toMatchObject({ stream: 'global', channel: 'mutation', event: 'mutation.settled',
    data: { mutation: { runtime: 'repo-registry', status: 'completed' } } });
  expect(await reads.at(-1)).toMatchObject({ projects: expect.arrayContaining([expect.objectContaining({ id: value.projectId })]) });
});
it('publishes nothing for missing or consumed suggestions', async () => {
  const before = mutations().length; const call = callClient();
  for (const id of ['missing', 'accepted']) expect((await call(id)).isError).toBe(true);
  await barrier(); expect(mutations()).toHaveLength(before);
});
it.each([false, true])('preserves one consumption across two concurrent calls with front door %s', async frontDoor => {
  cache('concurrent'); const before = mutations().length; const call = callClient(frontDoor);
  const results = await Promise.all([call('concurrent'), call('concurrent')]);
  expect(results.filter(result => !result.isError)).toHaveLength(1);
  stored(results.find(result => !result.isError)!, 'concurrent');
  expect(results.find(result => result.isError)?.content[0].text).toContain('Suggestion not found');
  await barrier(); expect(mutations().length - before).toBe(1);
});
it('keeps the same successful reply and consumes once when WS is unreachable', async () => {
  cache('offline'); const before = mutations().length;
  const saved = ['api-port', 'ws-port'].map(file => [file, readFileSync(join(root, file), 'utf8')] as const);
  const absent = createServer();
  await new Promise<void>(resolve => absent.listen(0, '127.0.0.1', resolve));
  const deadPort = String((absent.address() as { port: number }).port);
  await new Promise<void>(resolve => absent.close(() => resolve()));
  // Front-door resolution deliberately aligns WS to api-port, so both
  // launcher-published ports must be unreachable for this fresh MCP child.
  for (const [file] of saved) writeFileSync(join(root, file), deadPort);
  try {
    const call = callClient(); const result = await call('offline'); const value = stored(result, 'offline');
    expect(result).toEqual({ isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] });
    expect((await call('offline')).isError).toBe(true);
    await barrier(); expect(mutations()).toHaveLength(before);
  } finally { for (const [file, value] of saved) writeFileSync(join(root, file), value); }
});
