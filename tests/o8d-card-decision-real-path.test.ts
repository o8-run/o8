import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, expect, it, vi } from 'vitest';

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
  requestRealtimeRefresh: vi.fn(async () => {}),
  publishArtifactRecorded: vi.fn(async () => {}),
  publishCortexChange: vi.fn(async () => {}),
}));

// The operator credential the handler's own principal check reads.
const dataDir = process.env.CORTEX_IDE_DATA_DIR!;
const TOKEN = 'card-decision-fixture-operator-token-0123456789';
writeFileSync(join(dataDir, 'ws-token'), `${TOKEN}\n`, 'utf-8');
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'o8-card-decision-')));
execFileSync('git', ['init', '-q', '-b', 'main', repo]);

const create = await import('@/app/api/task-artifacts/route');
const { matchNativeHttpRoute, nativeSurfaceRoutes } = await import('@/lib/ws-server/native-http-registry');
const { writePersistedLlmChat } = await import('@/lib/llm/chat-history-store');
const { listQueuedComposerSends } = await import('@/lib/orchestrator/composer-queue');

afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

const ROUTING = { backend: 'codex', model: 'gpt-5.5', effort: 'medium', permissionMode: 'full', mode: 'fleet', pickedMode: 'fast', collide: false };
const request = (url: string, body?: unknown) => new NextRequest(url, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { host: 'localhost:3001', authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

it('registers the production card decision GET and POST for the native mission card', async () => {
  const route = nativeSurfaceRoutes.session.find(route => route.path === '/api/task-artifacts/[id]/decision');
  expect(route, 'session card decision registration').toBeDefined();
  expect(route!.methods).toEqual(['GET', 'POST']);
  const handlers = await import('@/app/api/task-artifacts/[id]/decision/route');
  expect(await route!.load()).toMatchObject({ GET: handlers.GET, POST: handlers.POST });
  for (const method of ['PATCH', 'PUT', 'DELETE']) {
    expect(matchNativeHttpRoute('/api/task-artifacts/tart-fixture/decision', method)).toBeUndefined();
  }
});

it('decides a lead card through the registered handlers and queues it for the lead', async () => {
  const threadId = `thoughts-card-native-${Date.now()}`;
  writePersistedLlmChat(threadId, { repoPath: repo, messages: [
    { id: 'u1', role: 'user', content: 'Ship it?', timestamp: Date.now() - 1_000 },
  ] });
  const created = await create.POST(request('http://localhost:3001/api/task-artifacts',
    { title: 'Ship the fixture?', threadId, repoPath: repo, card: { kind: 'approve', body: 'Ready.' } }));
  expect(created.status).toBe(201);
  const id = ((await created.json()) as { result: { artifact: { id: string } } }).result.artifact.id;

  const handlers = await nativeSurfaceRoutes.session.find(route => route.path === '/api/task-artifacts/[id]/decision')!
    .load() as { GET: typeof import('@/app/api/task-artifacts/[id]/decision/route').GET; POST: typeof import('@/app/api/task-artifacts/[id]/decision/route').POST };
  const url = `http://localhost:3001/api/task-artifacts/${id}/decision`;
  const params = { params: Promise.resolve({ id }) };
  const decided = await handlers.POST(request(url, { actionId: 'approve', nonce: `nonce-${Date.now()}`, routing: ROUTING }), params);
  expect(decided.status).toBe(200);
  const body = await decided.json() as { result: { deliverVia: string; action: { id: string } } };
  expect(body.result.deliverVia).toBe('queue');
  expect(listQueuedComposerSends({ repoPath: repo, threadId })).toEqual([
    expect.objectContaining({ id: body.result.action.id, intent: 'send-next' }),
  ]);
  const read = await handlers.GET(request(url), { params: Promise.resolve({ id }) });
  expect(await read.json()).toMatchObject({ result: { card: { id, state: 'decided' } } });
});
