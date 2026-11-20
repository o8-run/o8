import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { afterAll, expect, it, vi } from 'vitest';
import type { RealtimeMutationPublishRequest } from '@/lib/realtime/types';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-membership-refresh-')));
const repo = join(root, 'repo'); mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
execFileSync('git', ['-C', repo, '-c', 'user.name=o8 test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
const token = 'fixture-membership-refresh';
for (const [key, value] of Object.entries({ O8_DATA_DIR: root, CORTEX_IDE_DATA_DIR: root,
  CORTEX_IDE_DB_PATH: join(root, 'fixture.db'), WS_TOKEN: token })) vi.stubEnv(key, value);

// The bridge is fixture plumbing. Actual registry-loaded handlers and the real
// publisher produce the payload; only subscribed global receivers get it.
const subscribers = new Set<WebSocket>();
const attempts: RealtimeMutationPublishRequest[] = [];
let unavailable = false;
const { matchNativeHttpRoute } = await import('@/lib/ws-server/native-http-registry');
const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    if (request.url === '/internal/realtime') {
      if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
      const payload = JSON.parse(body) as RealtimeMutationPublishRequest;
      attempts.push(payload);
      if (unavailable) { response.writeHead(503).end(); return; }
      if (payload.refreshTargets?.includes('global')) {
        for (const peer of subscribers) peer.send(JSON.stringify(payload));
      }
      response.writeHead(204).end(); return;
    }
    const match = matchNativeHttpRoute(new URL(request.url!, origin).pathname, request.method);
    if (!match) { response.writeHead(404).end(); return; }
    const handlers = await match.route.load() as Record<string, (req: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>>;
    const result = await handlers[request.method!](new NextRequest(origin + request.url, {
      method: request.method, headers: request.headers as Record<string, string>, ...(body ? { body } : {}),
    }), { params: Promise.resolve(match.params!) });
    response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(await result.text());
  } catch (error) { response.writeHead(500).end(String(error)); }
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
const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port.');
const origin = `http://127.0.0.1:${address.port}`;
vi.stubEnv('CORTEX_REALTIME_INTERNAL_ORIGIN', origin);
const { createProject } = await import('@/lib/projects/store');
const { addRepo } = await import('@/lib/repos/registry');
const { closeDb } = await import('@/lib/db');
const entry = await addRepo(repo);
const project = createProject({ name: 'Membership refresh fixture' });
const projectPath = `/api/projects/${project.id}`;
const membership = `${projectPath}/repos/${entry.id}`;
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-o8-client-addr': '192.0.2.1' };
const received: RealtimeMutationPublishRequest[] = [];
const reads: Array<Promise<{ project: { repos: Array<{ repoId: string; role: string | null }> }; repoPaths: string[] }>> = [];
const receiver = new WebSocket(origin.replace('http:', 'ws:'));
receiver.on('message', raw => {
  const payload = JSON.parse(String(raw));
  if (payload.kind !== 'mutation') return;
  received.push(payload);
  // Start the authoritative read when notified, before the mutation caller
  // necessarily has its HTTP reply. The ledger must be committed too.
  reads.push((async () => {
    const response = await fetch(origin + projectPath, { headers });
    expect(response.status).toBe(200);
    const body = await response.json();
    const ledger = JSON.parse(readFileSync(join(root, 'projects.json'), 'utf8'));
    return { project: body.project, repoPaths: ledger.projects.find((row: { id: string }) => row.id === project.id).repoPaths };
  })());
});
await once(receiver, 'open');
const subscribed = once(receiver, 'message'); receiver.send(JSON.stringify({ subscribe: 'global' })); await subscribed;

async function barrier() {
  const reply = new Promise<void>(resolve => {
    const listener = (raw: RawData) => { if (JSON.parse(String(raw)).barrier) { receiver.off('message', listener); resolve(); } };
    receiver.on('message', listener);
  });
  receiver.send(JSON.stringify({ barrier: true })); await reply;
  await Promise.all(reads);
}
function mutate(path: string, method: string, body?: unknown, bearer = token) {
  return fetch(origin + path, { method, headers: { ...headers, authorization: `Bearer ${bearer}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
afterAll(async () => {
  const closed = once(receiver, 'close'); receiver.close(); await closed;
  await new Promise<void>(resolve => sockets.close(() => resolve()));
  const stopped = once(server, 'close'); server.close(); await stopped;
  closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

it('publishes one completed global inventory change after link, role update and unlink are readable', async () => {
  for (const [path, method, body, status, action, role] of [
    [`${projectPath}/repos`, 'POST', { repoId: entry.id, role: 'backend' }, 201, 'project-repo-add', 'backend'],
    [membership, 'PATCH', { role: 'reviewer' }, 200, 'project-repo-role-update', 'reviewer'],
    [membership, 'DELETE', undefined, 200, 'project-repo-remove', null],
  ] as const) {
    const start = received.length; const published = attempts.length;
    const response = await mutate(path, method, body);
    expect(response.status).toBe(status);
    const reply = await response.json();
    expect(reply).toMatchObject(method === 'DELETE' ? { ok: true } : { link: { projectId: project.id, repoId: entry.id, role } });
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
    await barrier();
    expect(attempts.length - published).toBe(1);
    expect(received.length - start).toBe(1);
    expect(received[start]).toMatchObject({ kind: 'mutation', refreshTargets: ['global'],
      mutation: { source: 'server', runtime: 'repo-registry', action, status: 'completed', settledAt: expect.any(String) } });
    const snapshot = await reads[start];
    expect(snapshot.project.repos).toMatchObject(method === 'DELETE' ? [] : [{ repoId: entry.id, role }]);
    expect(snapshot.repoPaths).toEqual(method === 'DELETE' ? [] : [repo]);
  }
  expect(new Set(received.map(item => item.mutation.mutationId)).size).toBe(3);
});

it('publishes nothing for refused or missing mutations', async () => {
  const before = received.length; const published = attempts.length;
  for (const [path, method, body, status, bearer] of [
    [`${projectPath}/repos`, 'POST', {}, 400, token],
    ['/api/projects/missing-project/repos', 'POST', { repoId: entry.id }, 404, token],
    [`${membership}-missing`, 'PATCH', { role: null }, 404, token],
    [`${membership}-missing`, 'DELETE', undefined, 404, token],
    [membership, 'PATCH', {}, 400, token],
    [`${projectPath}/repos`, 'POST', { repoId: entry.id }, 401, 'wrong-token'],
    [membership, 'PATCH', { role: null }, 401, 'wrong-token'],
    [membership, 'DELETE', undefined, 401, 'wrong-token'],
  ] as const) expect((await mutate(path, method, body, bearer)).status).toBe(status);
  await barrier(); expect(received.length).toBe(before); expect(attempts.length).toBe(published);
});

it('keeps the committed success when publication is unavailable, with one attempt and no replay', async () => {
  const published = attempts.length; const before = received.length;
  unavailable = true;
  try {
    const response = await mutate(`${projectPath}/repos`, 'POST', { repoId: entry.id, role: 'backend' });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ link: { repoId: entry.id, role: 'backend' } });
    const readable = await (await fetch(origin + projectPath, { headers })).json();
    expect(readable.project.repos).toMatchObject([{ repoId: entry.id, role: 'backend' }]);
    await barrier(); expect(attempts.length - published).toBe(1); expect(received.length).toBe(before);
  } finally { unavailable = false; }
});
