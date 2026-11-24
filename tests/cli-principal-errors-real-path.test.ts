import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { apiFetch, CliError, EXIT, type ApiRequestOptions } from '../cli/src/api';
import type { ResolvedConfig } from '../cli/src/config';

vi.mock('@clerk/nextjs/server', () => ({ clerkMiddleware: (handler: unknown) => handler }));
const dataDir = mkdtempSync(join(tmpdir(), 'o8-cli-principals-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
writeFileSync(join(dataDir, 'ws-token'), 'synthetic-operator-fixture-token\n');
const { panelGateMiddleware } = await import('@/middleware');
const scope = await import('@/app/api/lanes/[id]/scope/route');
const { createLane } = await import('@/lib/lane/registry');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { getSqlite } = await import('@/lib/db');
const ownPacket = 'pkt-cli-principal-own';
const ownLane = createLane({ repoPath: dataDir, branch: 'agent/own', runtime: 'codex', packetId: ownPacket });
const foreignLane = createLane({ repoPath: dataDir, branch: 'agent/foreign', runtime: 'codex', packetId: 'pkt-cli-principal-foreign' });
const token = mintPacketWorkerToken(ownPacket);
let server: Server;
let config: ResolvedConfig;
let scopeCalls = 0;

beforeAll(async () => {
  server = createServer(async (incoming, outgoing) => {
    try {
      // Model the server-stamped client address: normal packet CLI calls are
      // local; authentication negatives explicitly exercise a remote client.
      const url = new URL(incoming.url!, 'http://localhost');
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : value);
      }
      headers.set('host', 'localhost');
      headers.set('x-o8-client-addr', url.searchParams.has('fixtureRemote') ? '192.0.2.10' : '127.0.0.1');
      const request = new NextRequest(url, { method: incoming.method, headers });
      let response: Response = panelGateMiddleware(request);
      if (response.status === 200) {
        const id = request.nextUrl.pathname.split('/')[3];
        scopeCalls += 1;
        response = await scope.GET(request, { params: Promise.resolve({ id }) });
      }
      outgoing.writeHead(response.status, { 'content-type': 'application/json' });
      outgoing.end(await response.text());
    } catch {
      outgoing.writeHead(500); outgoing.end('{}');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  config = {
    apiPort: address.port, apiBase: `http://127.0.0.1:${address.port}`, token,
    workerPacketId: ownPacket, source: { port: 'env', token: 'worker' }, dataDir,
  };
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  getSqlite().close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function refusal(path: string, cfg = config, options: ApiRequestOptions = {}): Promise<CliError> {
  try { await apiFetch(cfg, path, options); } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error('Expected refusal');
}

describe('CLI HTTP -> real middleware/scoped route with persisted packet principal', () => {
  it('reads its assigned packet through the normal route', async () => {
    const result = await apiFetch(config, `/api/lanes/${ownLane.id}/scope`);
    expect(result).toMatchObject({ status: 200, data: { packetId: ownPacket, laneId: ownLane.id } });
  });

  it.each(['/api/orchestrator/status', '/api/orchestrator/merge'])('explains worker capability refusal for %s without credential repair', async path => {
    const before = scopeCalls;
    const error = await refusal(path, config, { method: path === '/api/orchestrator/merge' ? 'POST' : 'GET' });
    expect(error).toMatchObject({ code: 'forbidden', exit: EXIT.UNAUTHORIZED });
    expect(error.message).toContain('Worker token is not authorized for this endpoint.');
    expect(error.hint).toContain('assigned packet');
    expect(error.hint).not.toMatch(/O8_API_TOKEN|ws-token|refresh/i);
    expect(scopeCalls).toBe(before);
  });

  it('preserves structured foreign-packet refusal without expanding access', async () => {
    const error = await refusal(`/api/lanes/${foreignLane.id}/scope`);
    expect(error.code).toBe('forbidden');
    expect(error.message).toContain(`Worker credential for packet ${ownPacket} cannot address packet pkt-cli-principal-foreign.`);
    expect(error.hint).toContain('assigned packet');
  });

  it.each([null, 'wrong-fixture-bearer'])('keeps absent/invalid bearer %s as authentication refusal', async bearer => {
    const before = scopeCalls;
    const error = await refusal(`/api/lanes/${ownLane.id}/scope?fixtureRemote=1`, { ...config, token: bearer });
    expect(error).toMatchObject({ code: 'unauthorized', exit: EXIT.UNAUTHORIZED });
    expect(error.message).toContain('(401)');
    expect(scopeCalls).toBe(before);
  });
});
