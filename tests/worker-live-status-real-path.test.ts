import { once } from 'node:events';
import { createServer } from 'node:http';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const { panelGateMiddleware } = await import('@/middleware');
const lanesRoute = await import('@/app/api/lanes/route');
const { createLane, getLane } = await import('@/lib/lane/registry');
const { getSqlite } = await import('@/lib/db');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { mintReadOnlyWorkerToken } = await import('@/lib/auth/read-only-worker-token');
const { getOrCreateLocalWorkerToken } = await import('@/lib/auth/worker-token');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { runStatus } = await import('../cli/src/commands/status');

const packetId = 'pkt-live-status-worker';
const workerToken = mintPacketWorkerToken(packetId);
const lanes = ['running', 'reviewing', 'paused', 'failed', 'completed', 'archived'].map((status, index) => {
  const lane = createLane({
    repoPath: '/tmp/live-status-repo', branch: `fixture/${index}`, runtime: 'codex',
    label: 'Private task description', sessionKey: `private-session-${index}`,
    packetId: index === 0 ? packetId : `pkt-live-status-${index}`,
  });
  getSqlite().prepare('UPDATE lanes SET status = ?, worktree_path = ?, writer_token = ?, created_at = ? WHERE id = ?')
    .run(status, `/tmp/live-status-checkout-${index}`, `fixture-private-writer-${index}`, `2026-01-01T00:00:0${index}.000Z`, lane.id);
  return getLane(lane.id)!;
});
const expectedLanes = lanes.slice(0, 4).map(({ id, packetId, status, worktreePath }) => (
  { id, packetId, status, worktreePath }
));
let base: string;
const requests: string[] = [];
function request(path: string, token: string | null = workerToken, method = 'GET') {
  return new NextRequest(new URL(path, base), {
    method, headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}
const server = createServer((incoming, outgoing) => {
  requests.push(incoming.url!);
  const req = new NextRequest(new URL(incoming.url!, base), {
    method: incoming.method, headers: incoming.headers as Record<string, string>,
  });
  void (async () => {
    const gate = panelGateMiddleware(req);
    const res = gate.status !== 200 ? gate
      : req.nextUrl.pathname === '/api/lanes' ? await lanesRoute.GET(req)
        : Response.json({});
    outgoing.writeHead(res.status, { 'content-type': 'application/json' });
    outgoing.end(await res.text());
  })().catch(() => outgoing.writeHead(500).end());
});

beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind.');
  base = `http://127.0.0.1:${address.port}`;
  vi.stubEnv('O8_API_PORT', String(address.port));
  vi.stubEnv('O8_WORKER_TOKEN', workerToken);
  vi.stubEnv('O8_WORKER_PACKET_ID', packetId);
  vi.stubEnv('O8_API_TOKEN', getOrCreateWsToken());
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('packet worker live status through persisted lanes and HTTP', () => {
  it('runs o8 status in a worker environment using only the minimal live view', async () => {
    requests.length = 0;
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await runStatus({ human: false, verbose: false })).toBe(0);
    const payload = JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join(''));
    expect(payload).toEqual({ schema: 'o8/cli/worker-status/v1', activeLanes: expectedLanes });
    expect(requests).toEqual(['/api/lanes?view=live']);
  });

  it('ignores broadening query parameters and returns only ids, states and checkout paths across packets', async () => {
    const before = getSqlite().prepare('SELECT * FROM lanes ORDER BY id').all();
    const eventsBefore = getSqlite().prepare('SELECT * FROM lane_events ORDER BY id').all();
    const req = request('/api/lanes?view=live&active=false&includeCost=true&packetId=other');
    expect(panelGateMiddleware(req).status).toBe(200);
    const res = await lanesRoute.GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await res.json()).toEqual({ lanes: expectedLanes });
    expect(getSqlite().prepare('SELECT * FROM lanes ORDER BY id').all()).toEqual(before);
    expect(getSqlite().prepare('SELECT * FROM lane_events ORDER BY id').all()).toEqual(eventsBefore);
  });

  it('keeps operator status reads and mutations denied at the middleware', () => {
    for (const [path, method] of [
      ['/api/operator/status', 'GET'], ['/api/orchestrator/status', 'GET'],
      ['/api/orchestrator/steer-packet', 'POST'], ['/api/lanes', 'POST'],
    ]) {
      expect(panelGateMiddleware(request(path, workerToken, method)).status).toBe(403);
    }
  });

  it('refuses absent, unknown, revoked, unbound and zero-capability credentials in the handler', async () => {
    const revoked = mintPacketWorkerToken('pkt-live-status-revoked');
    getSqlite().prepare('UPDATE worker_tokens SET revoked_at = ? WHERE packet_id = ?')
      .run(new Date().toISOString(), 'pkt-live-status-revoked');
    for (const token of [null, 'fixture-unknown-bearer', revoked,
      getOrCreateLocalWorkerToken(), mintReadOnlyWorkerToken('live-status-read-only')]) {
      expect((await lanesRoute.GET(request('/api/lanes?view=live', token))).status).toBe(403);
    }
  });

  it('supports human worker output with each lane id, state and checkout path', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await runStatus({ human: true, verbose: false })).toBe(0);
    const text = output.mock.calls.map(([chunk]) => String(chunk)).join('');
    for (const lane of expectedLanes) {
      expect(text).toContain(lane.id);
      expect(text).toContain(lane.status);
      expect(text).toContain(lane.worktreePath!);
    }
    expect(text).not.toContain('Private task description');
  });
});
