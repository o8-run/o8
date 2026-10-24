import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { replayNextRequests, sendNextRequest, type RecordedNextRequest } from '../scripts/lib/next-http-parity';

// Native replay uses production routes and stores. The separate SSE transport
// test supplies a held-open producer to test the adapter's flush behavior.
vi.mock('@clerk/nextjs/server', () => ({ clerkMiddleware: (handler: unknown) => handler }));
vi.mock('@/lib/runtime/inventory', () => ({ getRuntimeInventorySnapshot: async () => ({ agents: [] }) }));
const streaming = vi.hoisted(() => ({ release: () => {} }));
vi.mock('@/app/api/v2/proxy/llm/route', () => ({ POST: () => new Response(new ReadableStream({ start(controller) {
  let released = false;
  controller.enqueue(new TextEncoder().encode('data: first\n\n'));
  streaming.release = () => { if (released) return; released = true; controller.enqueue(new TextEncoder().encode('data: second\n\n')); controller.close(); };
} }), { headers: { 'content-type': 'text/event-stream' } }) }));
const directory = process.env.CORTEX_IDE_DATA_DIR!;
const repo = join(directory, 'fixture-repo');
const token = randomBytes(32).toString('hex');
writeFileSync(join(directory, 'ws-token'), token);
delete process.env.WS_TOKEN;
const { panelGateMiddleware } = await import('@/middleware');
const threads = await import('@/app/api/mobile/orchestrator/threads/route');
const history = await import('@/app/api/mobile/history/route');
const context = await import('@/app/api/v2/chat-history/route');
const state = await import('@/app/api/orchestrator/state/route');
const queue = await import('@/app/api/orchestrator/composer-queue/route');
const ws = await import('@/app/api/panel/ws-info/route');
const { getSqlite, closeDb } = await import('@/lib/db');
const { listMobileOrchestratorThreads } = await import('@/lib/mobile/orchestrator-thread-history');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { normalizeOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { enqueueComposerSend } = await import('@/lib/orchestrator/composer-queue');
const children: ChildProcess[] = [];
const binary = process.env.O8D_HTTP_TEST_BINARY ?? 'crates/o8d/target/debug/o8d';
type Handler = (request: NextRequest) => Response | Promise<Response>;
const routes: Record<string, Handler> = {
  '/api/mobile/orchestrator/threads': threads.GET, '/api/mobile/history': history.GET,
  '/api/v2/chat-history': context.GET, '/api/orchestrator/state': state.GET,
  '/api/orchestrator/composer-queue': queue.GET, '/api/panel/ws-info': ws.GET,
};
let reference = '';
let candidate = '';
let records: RecordedNextRequest[];
const server = createServer(async (incoming, outgoing) => {
  try {
    const request = new NextRequest(`${reference}${incoming.url}`, {
      headers: incoming.headers as Record<string, string>, method: incoming.method,
    });
    const gate = panelGateMiddleware(request);
    const response = gate.status !== 200 ? gate : await routes[request.nextUrl.pathname](request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(500).end('{"error":"fixture failure"}');
  }
});

async function start(dataDir = directory, extra: string[] = []) {
  const child = spawn(binary, ['--experimental-http', '--listen', '127.0.0.1:0', '--data-dir', dataDir, ...extra], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const [line] = await Promise.race([
    once(child.stdout!, 'data'),
    once(child, 'exit').then(() => { throw new Error('o8d read-only HTTP mode did not start'); }),
    once(child, 'error').then(() => { throw new Error('o8d binary unavailable'); }),
  ]);
  return `http://${JSON.parse(String(line)).listening}`;
}
beforeAll(async () => {
  if (!process.env.O8D_HTTP_TEST_BINARY) await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--all-features']);
  await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'tests/fixtures/next-client/Cargo.toml']);
  mkdirSync(join(directory, 'chat-history'), { recursive: true });
  mkdirSync(repo);
  await promisify(execFile)('git', ['init', '--quiet', repo]);
  getSqlite();
  listMobileOrchestratorThreads(); // Complete existing one-time repairs before seeding.
  const seeds = JSON.parse(readFileSync('native/o8-next/fixtures/sessions.json', 'utf8'));
  for (const seed of seeds) writeFileSync(join(directory, 'chat-history', `${seed.id}.json`), JSON.stringify({
    ...seed, repoPath: repo, repoName: 'fixture-repo', backend: 'claude', model: 'claude-code',
    savedAt: '2026-10-01T00:00:00.000Z', orchestratorVisible: true,
  }));
  writeFileSync(join(directory, 'chat-history', 'thoughts-archived.json'), JSON.stringify({ messages: [], archivedAt: '2026-01-01', backend: 'codex' }));
  writeFileSync(join(directory, 'chat-history', 'thoughts-openclaw.json'), JSON.stringify({ messages: [], backend: 'openclaw' }));
  writeOrchestratorControlPlaneState(normalizeOrchestratorMissionState({ missionId: 'fixture-mission', packets: [] }));
  enqueueComposerSend({ repoPath: repo, threadId: 'thoughts-review', id: 'fixture-queue-item', intent: 'send-next', payload: {
    text: 'Fixture queued message', wireMessage: 'Fixture queued message', images: [],
    routing: { backend: 'claude', model: 'claude-code', effort: 'medium', permissionMode: 'full', mode: 'single', pickedMode: 'solo', collide: false },
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  reference = `http://127.0.0.1:${address.port}`;
  process.env.O8_WS_PORT = String(address.port);
  writeFileSync(join(directory, 'ws-port'), String(address.port));
  records = JSON.parse(readFileSync('tests/fixtures/next-http/requests.json', 'utf8').replaceAll('$REPO', encodeURIComponent(repo)));
}, 180_000);
afterAll(async () => {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, 'exit');
    child.kill();
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3_000);
    await exited;
    clearTimeout(timeout);
  }
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeDb();
});

it('replays recorded o8 next requests through both real HTTP entry points', async () => {
  candidate = await start();
  expect(await replayNextRequests(reference, candidate, token, records)).toBe(records.length);
});

it('streams core-owned event responses before the handler finishes', async () => {
  const { serveNativeHttp } = await import('@/lib/ws-server/native-http-owner');
  const host = createServer((request, response) => { void serveNativeHttp(request, response); });
  host.listen(0, '127.0.0.1');
  await once(host, 'listening');
  const address = host.address();
  if (!address || typeof address === 'string') throw new Error('Missing streaming owner port');
  const response = fetch(`http://127.0.0.1:${address.port}/api/v2/proxy/llm`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}',
  });
  try {
    const opened = await Promise.race([response, new Promise<null>(resolve => setTimeout(() => resolve(null), 500))]);
    expect(opened, 'the owner must flush event headers and the first chunk before completion').not.toBeNull();
    const reader = opened!.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: first\n\n');
    streaming.release();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: second\n\n');
    await reader.cancel();
  } finally {
    streaming.release();
    await response.catch(() => {});
    host.closeAllConnections();
    await new Promise<void>(resolve => host.close(() => resolve()));
  }
});

it('serves native inventory and queue writes with the Next listener stopped', async () => {
  unlinkSync(join(directory, '.transcript-order-repaired-v1'));
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Missing owner port');
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const owner = spawn(process.execPath, ['--import=./scripts/register-server-only-stub.mjs',
    '--import=tsx', 'src/ws-server.ts'], { env: { ...process.env,
    NODE_ENV: 'test', O8_NEXT_HTTP_OWNER: '1', O8_WS_O8D: '0', WS_TOKEN: undefined,
    O8_API_PORT: String(address.port), O8_WS_PORT: String(address.port), CORTEX_IDE_REVIEW_REPO_ROOT: repo,
    // This port has no Next listener. All state and commands must use the owner.
    NEXT_ORIGIN: 'http://127.0.0.1:1',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(owner);
  owner.stdout!.resume(); owner.stderr!.resume();
  const origin = `http://127.0.0.1:${address.port}`;
  const deadline = Date.now() + 90_000;
  while (true) {
    try { if ((await fetch(`${origin}/health`)).ok) break; } catch { /* startup */ }
    if (owner.exitCode !== null || Date.now() > deadline) throw new Error('Owner did not start');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const endpoint = await start(directory, ['--owner-upstream', `127.0.0.1:${address.port}`]);
  expect((await fetch(`${origin}/api/setup/status`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  expect(JSON.parse(readFileSync(join(directory, 'chat-history', 'thoughts-review.json'), 'utf8')).messages[1].id).toBe('review-3');
  expect((await fetch(`${origin}/api/broadcast/commentary?limit=100`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  const response = await sendNextRequest(endpoint, token, { name: 'native inventory', path: '/api/runtime/inventory?fresh=1' });
  expect(response.status).toBe(200);
  const probe = spawn('tests/fixtures/next-client/target/debug/o8-next-http-probe', [endpoint], {
    env: { ...process.env, O8_NEXT_API_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let probeError = '';
  probe.stdout!.on('data', chunk => { output += String(chunk); });
  probe.stderr!.on('data', chunk => { probeError += String(chunk).replaceAll(token, '[credential]'); });
  probe.stdin!.end([JSON.stringify({ op: 'exercise' }), JSON.stringify({ op: 'websocket' })].join('\n') + '\n');
  expect((await once(probe, 'exit'))[0], probeError).toBe(0);
  const nativeResults = output.trim().split('\n').map(line => JSON.parse(line));
  expect(nativeResults[0]).toEqual({ sessions: 3, messages: 100 });
  expect(nativeResults[1]).toMatchObject({ connected: true, pong: true, checkpoint: true, history: true, liveMutation: true });
  expect(nativeResults[1].checkpoints.global.length).toBeGreaterThan(0);
  expect(nativeResults[1].checkpoints.history.length).toBeGreaterThan(0);
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const response = await fetch(`${endpoint}/api/orchestrator/composer-queue`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
    });
    expect(response.status).toBe(400);
  }
  const target = { repoPath: repo, threadId: 'thoughts-long', id: 'fixture-owner-send' };
  const mutate = (method: string, body: unknown) => fetch(`${endpoint}/api/orchestrator/composer-queue`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const sent = await mutate('POST', { ...target, intent: 'send-next', payload: { text: 'Fixture owner send', wireMessage: 'Fixture owner send', images: [],
    routing: { backend: 'claude', model: 'claude-code', effort: 'medium', permissionMode: 'full', mode: 'single', pickedMode: 'solo', collide: false } } });
  expect(sent.status).toBe(200);
  expect((await sent.json()).item.status).toBe('queued');
  expect((await mutate('PATCH', target)).status).toBe(200);
  expect((await mutate('DELETE', target)).status).toBe(200);
  expect((await mutate('DELETE', target)).status).toBe(409);
  expect((await fetch(`${endpoint}/api/orchestrator/composer-queue`, { method: 'POST',
    headers: { authorization: `Bearer ${token}` }, body: 'x'.repeat(16 * 1024 * 1024 + 1) })).status).toBe(413);
  const oversizedInput = join(directory, 'chat-history', 'thoughts-input-bound.json');
  const { createLane, deleteLane } = await import('@/lib/lane/registry');
  const boundedLane = createLane({ repoPath: repo, branch: 'fixture/bounds', runtime: 'claude-code',
    sessionKey: 'llm-chat:thoughts-input-bound' });
  writeFileSync(oversizedInput, JSON.stringify({ id: 'thoughts-input-bound', messages: [], padding: 'x'.repeat(64 * 1024 * 1024) }));
  try {
    expect((await sendNextRequest(endpoint, token, { name: 'owner saved input bound',
      path: '/api/mobile/history?sessionKey=llm-chat:thoughts-input-bound&limit=100' })).status).toBe(503);
  } finally { unlinkSync(oversizedInput); deleteLane(boundedLane.id); }
  for (const [credential, expected] of [['', 401], ['invalid', 401], ['o8ro_fixture', 403]] as const) {
    expect((await fetch(`${endpoint}/api/runtime/inventory`, { headers: { authorization: `Bearer ${credential}`,
      'x-o8-client-addr': '127.0.0.1', 'x-o8d-profile': directory } })).status).toBe(expected);
  }
  const other = join(directory, 'owner-other-profile');
  mkdirSync(other);
  writeFileSync(join(other, 'ws-token'), token);
  const isolated = await start(other, ['--owner-upstream', `127.0.0.1:${address.port}`]);
  expect((await sendNextRequest(isolated, token, { name: 'owner profile boundary', path: '/api/runtime/inventory' })).status).toBe(403);
  mkdirSync(join(other, 'chat-history'));
  symlinkSync(join(directory, 'chat-history', 'thoughts-long.json'), join(other, 'chat-history', 'thoughts-long.json'));
  expect((await sendNextRequest(isolated, token, { name: 'owner symlink boundary', path: '/api/runtime/inventory' })).status).toBe(503);
  const replacement = randomBytes(32).toString('hex');
  writeFileSync(join(directory, 'ws-token'), replacement);
  try {
    expect((await sendNextRequest(endpoint, token, { name: 'rotation', path: '/api/runtime/inventory' })).status).toBe(401);
    expect((await sendNextRequest(endpoint, replacement, { name: 'rotation', path: '/api/runtime/inventory' })).status).toBe(200);
  } finally {
    writeFileSync(join(directory, 'ws-token'), token);
    const referencePort = new URL(reference).port;
    writeFileSync(join(directory, 'ws-port'), referencePort);
  }
  const closed = createServer().listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const closedAddress = closed.address();
  if (!closedAddress || typeof closedAddress === 'string') throw new Error('Missing closed owner port');
  await new Promise<void>(resolve => closed.close(() => resolve()));
  const disconnected = await start(directory, ['--owner-upstream', `127.0.0.1:${closedAddress.port}`]);
  expect((await sendNextRequest(disconnected, token, { name: 'owner unavailable', path: '/api/runtime/inventory' })).status).toBe(503);
  expect((await sendNextRequest(disconnected, token, records[0])).status).toBe(200);
  const exited = once(owner, 'exit');
  owner.kill();
  const timeout = setTimeout(() => owner.kill('SIGKILL'), 3_000);
  await exited;
  clearTimeout(timeout);
}, 120_000);

it.runIf(Boolean(process.env.O8_NEXT_OWNER_REFERENCE_MODE))('compares the production native client against a running Next server and the owner', async () => {
  const result = await promisify(execFile)(process.execPath, ['--import=tsx', 'scripts/bench/next-owner.ts'], {
    env: { ...process.env, O8_NEXT_OWNER_RUNS: process.env.O8_NEXT_OWNER_RUNS ?? '1', O8_NEXT_OWNER_SAMPLES: process.env.O8_NEXT_OWNER_SAMPLES ?? '1' }, timeout: 1_190_000,
  });
  expect(result.stdout).toContain('Next/owner parity passed');
}, 1_200_000);

it('reads committed WAL updates without changing persisted state', async () => {
  candidate ||= await start();
  getSqlite().prepare("UPDATE composer_send_queue SET reason = 'Committed WAL update' WHERE id = 'fixture-queue-item'").run();
  const files = readdirSync(directory).filter(file => !file.endsWith('-shm') && statSync(join(directory, file)).isFile());
  const digest = () => files.map(file => createHash('sha256').update(readFileSync(join(directory, file))).digest('hex'));
  const before = digest();
  expect(await replayNextRequests(reference, candidate, token, records.filter(r => r.name === 'queue'))).toBe(1);
  expect(digest()).toEqual(before);
});

it('keeps the selected data profile isolated and never creates a missing database', async () => {
  const other = join(directory, 'other-profile');
  mkdirSync(other);
  writeFileSync(join(other, 'ws-token'), token);
  const origin = await start(other);
  const result = await sendNextRequest(origin, token, records[0]);
  expect(result).toEqual({ status: 200, body: { threads: [] } });
  expect(existsSync(join(other, 'cortex-ide.db'))).toBe(false);
});

it('rechecks operator credential rotation and refuses every mutation', async () => {
  candidate ||= await start();
  const replacement = randomBytes(32).toString('hex');
  writeFileSync(join(directory, 'ws-token'), replacement);
  try {
    expect((await sendNextRequest(candidate, token, records[0])).status).toBe(401);
    expect((await sendNextRequest(candidate, replacement, records[0])).status).toBe(200);
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      expect((await fetch(`${candidate}/api/orchestrator/composer-queue`, {
        method, headers: { authorization: `Bearer ${replacement}` }, body: '{}',
      })).status).toBe(405);
    }
  } finally { writeFileSync(join(directory, 'ws-token'), token); }
});

it('requires compile/runtime opt-in and a numeric loopback listener', async () => {
  for (const args of [[], ['--experimental-http', '--listen', '0.0.0.0:0', '--data-dir', directory],
    ['--experimental-http', '--listen', '127.0.0.1:0', '--data-dir', directory, '--owner-upstream', '0.0.0.0:1']]) {
    await expect(promisify(execFile)(binary, args)).rejects.toThrow('o8d failed');
  }
});

it('replays the URL-based parity command with the original recording', async () => {
  candidate ||= await start();
  const result = await promisify(execFile)(process.execPath, ['--import=tsx', 'scripts/next-http-parity.ts',
    `--reference=${reference}`, `--candidate=${candidate}`, '--recording=tests/fixtures/next-http/requests.json',
    `--fixture-repo=${repo}`], { env: { ...process.env, O8_NEXT_API_TOKEN: token } });
  expect(result.stdout).toContain(`HTTP parity passed: ${records.length} requests`);
});

it('replays earlier pages, cursor refusals and the exact client limit', async () => {
  candidate ||= await start();
  const first = await sendNextRequest(reference, token, records.find(r => r.name === 'native transcript page')!);
  const cursor = (first.body as { page: { beforeCursor: string } }).page.beforeCursor;
  const earlier = { name: 'earlier history', path: `/api/mobile/history?sessionKey=llm-chat:thoughts-long&page=1&limit=100&before=${encodeURIComponent(cursor)}` };
  expect(await replayNextRequests(reference, candidate, token, [earlier,
    { name: 'stale cursor', path: `${earlier.path}invalid` },
    { name: 'negative limit', path: '/api/mobile/history?sessionKey=llm-chat:thoughts-long&limit=-1' },
  ])).toBe(3);
  writeFileSync(join(directory, 'chat-history', 'thoughts-oversized.json'), JSON.stringify({ messages: [
    { id: 'large', role: 'assistant', content: 'x'.repeat(16 * 1024 * 1024) },
  ] }));
  try {
    expect((await sendNextRequest(candidate, token, { name: 'bounded history',
      path: '/api/mobile/history?sessionKey=llm-chat:thoughts-oversized&limit=100' })).status).toBe(413);
  } finally { unlinkSync(join(directory, 'chat-history', 'thoughts-oversized.json')); }
});

it('refuses unsupported reconciliation and symlinks across profiles', async () => {
  candidate ||= await start();
  const file = join(directory, 'orchestrator-state.json');
  const saved = readFileSync(file, 'utf8');
  try {
    const payload = JSON.parse(saved);
    payload.mission.packets = [{ id: 'requires-reconciliation' }];
    writeFileSync(file, JSON.stringify(payload));
    expect((await sendNextRequest(candidate, token, { name: 'reconciliation', path: '/api/orchestrator/state' })).status).toBe(503);
  } finally { writeFileSync(file, saved); }
  const profile = join(directory, 'symlink-profile');
  mkdirSync(join(profile, 'chat-history'), { recursive: true });
  writeFileSync(join(profile, 'ws-token'), token);
  symlinkSync(join(directory, 'chat-history', 'thoughts-review.json'), join(profile, 'chat-history', 'thoughts-review.json'));
  symlinkSync(join(directory, 'cortex-ide.db'), join(profile, 'cortex-ide.db'));
  const origin = await start(profile);
  expect(await sendNextRequest(origin, token, records[0])).toEqual({ status: 200, body: { threads: [] } });
  expect((await sendNextRequest(origin, token, { name: 'cross-profile database', path: '/api/orchestrator/state' })).status).toBe(503);
});

it.runIf(Boolean(process.env.O8_NEXT_HTTP_BENCH_REPORT))('measures per-route HTTP latency and backend RSS', async () => {
  candidate ||= await start();
  const selected = ['sidebar', 'mission', 'native transcript page', 'context', 'queue', 'websocket information'];
  const results = [];
  const percentile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
  for (const name of selected) {
    const record = records.find(r => r.name === name)!;
    const times: number[][] = [[], []];
    for (let iteration = -10; iteration < 100; iteration++) {
      for (const index of iteration % 2 === 0 ? [0, 1] : [1, 0]) {
        const started = performance.now();
        const response = await sendNextRequest(index ? candidate : reference, token, record);
        if (iteration >= 0) times[index].push(performance.now() - started);
        expect(response.status).toBe(200);
      }
    }
    results.push({ name, reference: { p50: percentile(times[0], .5), p95: percentile(times[0], .95) },
      o8d: { p50: percentile(times[1], .5), p95: percentile(times[1], .95) } });
  }
  const status = readFileSync(`/proc/${children[0].pid}/status`, 'utf8');
  const rssKiB = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]);
  writeFileSync(process.env.O8_NEXT_HTTP_BENCH_REPORT!, JSON.stringify({ samples: 100, warmups: 10,
    reference: 'Vitest HTTP adapter using production Next handlers and middleware; not the Next server',
    o8dRssKiB: rssKiB, node: process.versions.node, results }, null, 2));
}, 120_000);
