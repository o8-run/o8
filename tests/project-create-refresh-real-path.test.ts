import { once } from 'node:events';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { afterAll, expect, it, vi } from 'vitest';
import type { RealtimeMutationPublishRequest } from '@/lib/realtime/types';
import { hasRepoInventoryChange } from '@/lib/repos/inventory-change';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-create-refresh-')));
const token = 'fixture-create-refresh';
for (const [key, value] of Object.entries({ O8_DATA_DIR: root, CORTEX_IDE_DATA_DIR: root,
  CORTEX_IDE_DB_PATH: join(root, 'fixture.db'), WS_TOKEN: token, O8_API_FRONT_DOOR: '1', O8_NEXT_O8D: '0' })) vi.stubEnv(key, value);
const subscribers = new Set<WebSocket>();
const attempts: RealtimeMutationPublishRequest[] = [];
let unavailable = false;
// Only the realtime bridge/subscription plumbing is a fixture. The actual
// public dispatcher, auth, create handler, ledger sync and publisher run below.
const server = createServer((request, response) => {
  void (async () => {
    if (request.url === '/internal/realtime') {
      if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString()) as RealtimeMutationPublishRequest;
      attempts.push(payload);
      if (unavailable) { response.writeHead(503).end(); return; }
      if (payload.refreshTargets?.includes('global')) {
        // Existing native window consumes these global mutation event frames.
        const event = { stream: 'global', channel: 'mutation', event: 'mutation.settled', data: { mutation: payload.mutation } };
        for (const peer of subscribers) peer.send(JSON.stringify(event));
      }
      response.writeHead(204).end(); return;
    }
    const { handleNativeHttp } = await import('@/lib/ws-server/native-http-routes');
    if (!await handleNativeHttp(request, response, request.socket.localPort, false, request.socket.remoteAddress ?? null)) response.writeHead(404).end();
  })().catch(error => response.writeHead(500).end(String(error)));
});
const sockets = new WebSocketServer({ server });
sockets.on('connection', peer => {
  peer.on('message', data => {
    const message = JSON.parse(String(data));
    if (message.subscribe === 'global') { subscribers.add(peer); peer.send(JSON.stringify({ subscribed: true })); }
    if (message.barrier) peer.send(JSON.stringify({ barrier: true }));
  });
  peer.on('close', () => subscribers.delete(peer));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const port = String((server.address() as { port: number }).port);
const origin = `http://127.0.0.1:${port}`;
for (const key of ['PORT', 'O8_API_PORT', 'O8_WS_PORT']) vi.stubEnv(key, port);
vi.stubEnv('CORTEX_REALTIME_INTERNAL_ORIGIN', origin);
const { closeDb } = await import('@/lib/db');
const { listProjects } = await import('@/lib/projects/store');
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const received: Array<{ stream: string; channel: string; event: string; data: { mutation: RealtimeMutationPublishRequest['mutation'] } }> = [];
const reads: Array<Promise<unknown>> = [];
const receiver = new WebSocket(origin.replace('http:', 'ws:'));
receiver.on('message', raw => {
  const event = JSON.parse(String(raw));
  if (event.event !== 'mutation.settled') return;
  received.push(event);
  reads.push((async () => {
    const response = await fetch(origin + '/api/projects', { headers });
    expect(response.status).toBe(200);
    const ledger = JSON.parse(readFileSync(join(root, 'projects.json'), 'utf8'));
    return { ...await response.json(), ledger };
  })());
});
await once(receiver, 'open');
const subscribed = once(receiver, 'message'); receiver.send(JSON.stringify({ subscribe: 'global' })); await subscribed;
async function barrier() {
  const reply = new Promise<void>(resolve => {
    const listener = (raw: RawData) => { if (JSON.parse(String(raw)).barrier) { receiver.off('message', listener); resolve(); } };
    receiver.on('message', listener);
  });
  receiver.send(JSON.stringify({ barrier: true })); await reply; await Promise.all(reads);
}
const create = (body: unknown, bearer = token) => fetch(origin + '/api/projects', {
  method: 'POST', headers: { ...headers, authorization: `Bearer ${bearer}` }, body: JSON.stringify(body),
});
afterAll(async () => {
  const closed = once(receiver, 'close'); receiver.close(); await closed;
  await new Promise<void>(resolve => sockets.close(() => resolve()));
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

it('publishes exactly one accepted inventory event after the created project and ledger are readable', async () => {
  const before = received.length; const published = attempts.length;
  const response = await create({ name: 'Created inventory fixture', description: 'Fixture description' });
  expect(response.status).toBe(201);
  expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
  const { project } = await response.json();
  await barrier();
  expect(attempts.length - published).toBe(1); expect(received.length - before).toBe(1);
  const event = received[before];
  expect(event).toMatchObject({ stream: 'global', channel: 'mutation', event: 'mutation.settled', data: { mutation: {
    action: 'project-create', runtime: 'repo-registry', status: 'completed', source: 'server', settledAt: expect.any(String),
  } } });
  expect(attempts[published].refreshTargets).toEqual(['global']);
  // Same predicate fields as native thread_list.rs::repo_inventory_changed;
  // the merged #6555 receipt covers the actual native consumer, without a build.
  expect(hasRepoInventoryChange({ data: { events: [event] } })).toBe(true);
  expect(await reads[before]).toMatchObject({ projects: expect.arrayContaining([expect.objectContaining({ id: project.id })]),
    ledger: { projects: expect.arrayContaining([expect.objectContaining({ id: project.id })]) } });
});

it('publishes nothing for denied or invalid creates', async () => {
  const before = attempts.length; const heard = received.length; const projects = listProjects().length;
  expect((await create({ name: 'Denied' }, 'wrong-token')).status).toBe(401);
  for (const body of [{}, { name: ' ' }, { name: 'Bad shape', repos: ['invalid'] }, { name: 'Ambiguous', repos: [], repoIds: [] }]) {
    expect((await create(body)).status).toBe(400);
  }
  await barrier();
  expect(attempts.length).toBe(before); expect(received.length).toBe(heard); expect(listProjects()).toHaveLength(projects);
});

it('keeps a committed create successful when publication fails, with one attempt and no replay', async () => {
  const before = attempts.length; const heard = received.length; const projects = listProjects().length;
  unavailable = true;
  try {
    const response = await create({ name: 'Created while bridge unavailable' });
    expect(response.status).toBe(201);
    const { project } = await response.json();
    await barrier();
    expect(attempts.length - before).toBe(1); expect(received.length).toBe(heard);
    expect(listProjects()).toHaveLength(projects + 1);
    const readable = await (await fetch(origin + '/api/projects', { headers })).json();
    expect(readable.projects).toContainEqual(expect.objectContaining({ id: project.id }));
  } finally { unavailable = false; }
});
