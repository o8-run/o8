import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ launch: vi.fn() }));

vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: (handler: unknown) => handler,
}));
vi.mock('@/lib/runtime/actions', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/runtime/actions')>();
  return { ...original, launchRuntimeSurface: h.launch };
});

const dataDir = mkdtempSync(join(tmpdir(), 'o8-next-fetch-runtime-action-'));
const token = 'next-fetch-runtime-action-token';
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'ws-token'), `${token}\n`, { mode: 0o600 });
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { panelGateMiddleware } = await import('@/middleware');
const runtimeActionRoute = await import('@/app/api/runtime/action/route');
const runtimeLaunchRoute = await import('@/app/api/runtime/launch/route');

let server: Server;
let origin = '';
let observedAuthorization = '';
const observedLaunchStatuses: number[] = [];

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', origin);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) headers.append(name, item);
      } else if (typeof value === 'string') {
        headers.set(name, value);
      }
    }
    observedAuthorization = headers.get('authorization') ?? '';
    const gatedRequest = new NextRequest(url, {
      method: request.method,
      headers,
    });
    const gate = panelGateMiddleware(gatedRequest);
    if (gate.status !== 200) {
      response.writeHead(gate.status, { 'Content-Type': 'application/json' });
      response.end(await gate.text());
      return;
    }

    const route = url.pathname === '/api/runtime/launch'
      ? runtimeLaunchRoute
      : runtimeActionRoute;
    const routeResponse = await route.POST(new NextRequest(url, {
      method: request.method,
      headers,
      body,
    }));
    if (url.pathname === '/api/runtime/launch') observedLaunchStatuses.push(routeResponse.status);
    response.writeHead(routeResponse.status, Object.fromEntries(routeResponse.headers.entries()));
    response.end(Buffer.from(await routeResponse.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  origin = `http://127.0.0.1:${address.port}`;
  process.env.NEXT_ORIGIN = origin;
});

afterAll(async () => {
  delete process.env.NEXT_ORIGIN;
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

describe('ws-server runtime action transport', () => {
  it('keeps conflict reads and Symon turns on Next while registered native producers use WS', async () => {
    const seen: Array<{ path: string; method: string; body: string; authorization: string }> = [];
    const next = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      seen.push({ path: request.url!, method: request.method!, body, authorization: request.headers.authorization ?? '' });
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"owner":"next"}');
    });
    const { handleNativeHttp } = await import('./native-http-routes');
    const native = createServer(async (request, response) => {
      if (!await handleNativeHttp(request, response)) response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Unregistered native route"}');
    });
    await new Promise<void>(resolve => next.listen(0, '127.0.0.1', resolve));
    await new Promise<void>(resolve => native.listen(0, '127.0.0.1', resolve));
    const nextPort = (next.address() as { port: number }).port;
    const nativePort = (native.address() as { port: number }).port;
    vi.stubEnv('O8_NEXT_O8D', '1');
    vi.stubEnv('O8_WS_PORT', String(nativePort));
    vi.stubEnv('NEXT_ORIGIN', `http://127.0.0.1:${nextPort}`);
    try {
      const { fetchNextJson } = await import('./next-fetch');
      await expect(fetchNextJson('/api/worktrees/conflicts', { searchParams: new URLSearchParams({ repoPath: dataDir }) })).resolves.toEqual({ owner: 'next' });
      const turn = { sessionId: 'fixture-turn', text: 'Fixture request', requestId: 'fixture-request' };
      await expect(fetchNextJson('/api/mobile/symon/text-turn', { method: 'POST', body: turn })).resolves.toEqual({ owner: 'next' });
      expect(seen).toEqual([
        { path: `/api/worktrees/conflicts?${new URLSearchParams({ repoPath: dataDir })}`, method: 'GET', body: '', authorization: `Bearer ${token}` },
        { path: '/api/mobile/symon/text-turn', method: 'POST', body: JSON.stringify(turn), authorization: `Bearer ${token}` },
      ]);
      await expect(fetchNextJson('/api/setup/identity')).resolves.not.toEqual({ owner: 'next' });
      // A method the native registration does not serve still belongs to Next.
      await expect(fetchNextJson('/api/setup/identity', { method: 'POST', body: {} })).resolves.toEqual({ owner: 'next' });
      vi.stubEnv('O8_NEXT_O8D', '0');
      await expect(fetchNextJson('/api/setup/identity')).resolves.toEqual({ owner: 'next' });
    } finally {
      vi.unstubAllEnvs();
      next.closeAllConnections();
      native.closeAllConnections();
      await Promise.all([new Promise<void>(resolve => next.close(() => resolve())), new Promise<void>(resolve => native.close(() => resolve()))]);
    }
  });

  it('keeps generic read payloads shape-agnostic', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ revision: 7, packets: [] }), { status: 200 }));
    try {
      const { fetchNextJson } = await import('./next-fetch');
      await expect(fetchNextJson<{ revision: number; packets: unknown[] }>('/api/command-center/snapshot'))
        .resolves.toEqual({ revision: 7, packets: [] });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('crosses the real middleware and route with operator auth and rejects route failures', async () => {
    const { fetchRuntimeAction } = await import('./next-fetch');

    await expect(fetchRuntimeAction({
      action: 'interrupt',
      surfaceId: 'missing-runtime-surface',
      clientMutationId: 'runtime-action-transport-test',
    })).rejects.toThrow(/not found|unavailable|failed|surface/i);
    expect(observedAuthorization).toBe(`Bearer ${token}`);
  });

  it('polls an idempotent in-progress action to its exact terminal receipt', async () => {
    let requestCount = 0;
    const inProgressServer = createServer((_request, response) => {
      requestCount += 1;
      const inProgress = requestCount === 1;
      response.writeHead(inProgress ? 202 : 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(inProgress
        ? {
            ok: true,
            action: 'interrupt',
            surfaceId: 'codex-owned:still-stopping',
            runtime: 'codex',
            status: 'queued',
            note: 'The original interrupt is still in progress.',
            inProgress: true,
          }
        : {
            ok: true,
            action: 'interrupt',
            surfaceId: 'codex-owned:still-stopping',
            runtime: 'codex',
            status: 'completed',
            note: 'The original interrupt completed.',
          }));
    });
    await new Promise<void>((resolve) => inProgressServer.listen(0, '127.0.0.1', resolve));
    const address = inProgressServer.address();
    if (!address || typeof address === 'string') throw new Error('in-progress server did not bind');
    process.env.NEXT_ORIGIN = `http://127.0.0.1:${address.port}`;

    try {
      const { fetchRuntimeAction } = await import('./next-fetch');
      await expect(fetchRuntimeAction({
        action: 'interrupt',
        surfaceId: 'codex-owned:still-stopping',
        clientMutationId: 'runtime-action-still-stopping',
      })).resolves.toMatchObject({ status: 'completed' });
      expect(requestCount).toBe(2);
    } finally {
      process.env.NEXT_ORIGIN = origin;
      await new Promise<void>((resolve) => inProgressServer.close(() => resolve()));
    }
  });

  it('reuses the exact correlated action body across an ambiguous transport retry', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        action: 'interrupt',
        surfaceId: 'codex-owned:transport-retry',
        runtime: 'codex',
        status: 'completed',
        note: 'Interrupted once.',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    try {
      const { fetchRuntimeAction } = await import('./next-fetch');
      const request = fetchRuntimeAction({
        action: 'interrupt',
        surfaceId: 'codex-owned:transport-retry',
        clientMutationId: 'runtime-action-transport-retry',
      });
      await vi.advanceTimersByTimeAsync(500);

      await expect(request).resolves.toMatchObject({ status: 'completed' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const requestBodies = fetchMock.mock.calls.map(([, init]) => String(init?.body));
      expect(requestBodies[0]).toBe(requestBodies[1]);
    } finally {
      fetchMock.mockRestore();
      vi.useRealTimers();
    }
  });

  it('reuses exact action and launch bodies after incomplete success receipts', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        action: 'interrupt',
        surfaceId: 'codex-owned:receipt-retry',
        runtime: 'codex',
        status: 'completed',
        note: 'Interrupted once.',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        runtime: 'codex',
        surfaceId: 'codex-owned:launch-receipt-retry',
        note: 'Launched once.',
        cwd: dataDir,
        repoPath: dataDir,
        worktree: null,
        laneId: null,
      }), { status: 200 }));
    try {
      const { fetchRuntimeAction, fetchRuntimeLaunch } = await import('./next-fetch');
      const action = fetchRuntimeAction({
        action: 'interrupt',
        surfaceId: 'codex-owned:receipt-retry',
        clientMutationId: 'action-receipt-retry',
      });
      await vi.advanceTimersByTimeAsync(500);
      await expect(action).resolves.toMatchObject({ status: 'completed' });
      const launch = fetchRuntimeLaunch({
        runtime: 'codex',
        prompt: 'launch once',
        cwd: dataDir,
        clientMutationId: 'launch-receipt-retry',
      });
      await vi.advanceTimersByTimeAsync(500);
      await expect(launch).resolves.toMatchObject({ surfaceId: 'codex-owned:launch-receipt-retry' });
      expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(fetchMock.mock.calls[1]?.[1]?.body);
      expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(fetchMock.mock.calls[3]?.[1]?.body);
    } finally {
      fetchMock.mockRestore();
      vi.useRealTimers();
    }
  });

  it('crosses the real middleware and launch route with operator auth', async () => {
    const { fetchRuntimeLaunch } = await import('./next-fetch');

    await expect(fetchRuntimeLaunch({
      runtime: '' as never,
      prompt: 'retry',
      cwd: dataDir,
      clientMutationId: 'runtime-launch-transport-validation',
    })).rejects.toThrow('runtime is required');
    expect(observedAuthorization).toBe(`Bearer ${token}`);
  });

  it('reuses the exact correlated launch body across a transport retry', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        runtime: 'codex',
        clientMutationId: 'runtime-launch-transport-retry',
        surfaceId: 'codex-owned:transport-retry',
        note: 'Launched once.',
        cwd: dataDir,
        repoPath: dataDir,
        worktree: null,
        laneId: null,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    try {
      const { fetchRuntimeLaunch } = await import('./next-fetch');
      await expect(fetchRuntimeLaunch({
        runtime: 'codex',
        prompt: 'retry the transport only',
        cwd: dataDir,
        clientMutationId: 'runtime-launch-transport-retry',
      })).resolves.toMatchObject({ surfaceId: 'codex-owned:transport-retry' });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const requestBodies = fetchMock.mock.calls.map(([, init]) => String(init?.body));
      expect(requestBodies[0]).toBe(requestBodies[1]);
      expect(JSON.parse(requestBodies[0])).toMatchObject({
        runtime: 'codex',
        prompt: 'retry the transport only',
        clientMutationId: 'runtime-launch-transport-retry',
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('replays the same mutation after the owning request times out', async () => {
    vi.useFakeTimers();
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        runtime: 'codex',
        clientMutationId: 'runtime-launch-owner-timeout',
        surfaceId: 'codex-owned:owner-timeout',
        note: 'The original launch completed.',
        cwd: dataDir,
        repoPath: dataDir,
        worktree: null,
        laneId: null,
        replayed: true,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    try {
      const { fetchRuntimeLaunch } = await import('./next-fetch');
      const request = fetchRuntimeLaunch({
        runtime: 'codex',
        prompt: 'keep the original mutation after timeout',
        cwd: dataDir,
        clientMutationId: 'runtime-launch-owner-timeout',
      });
      await vi.advanceTimersByTimeAsync(500);

      await expect(request).resolves.toMatchObject({ surfaceId: 'codex-owned:owner-timeout' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const requestBodies = fetchMock.mock.calls.map(([, init]) => String(init?.body));
      expect(requestBodies[0]).toBe(requestBodies[1]);
    } finally {
      fetchMock.mockRestore();
      vi.useRealTimers();
    }
  });

  it('polls the real route with the same mutation while the owning launch is pending', async () => {
    const idempotency = await import('@/lib/orchestrator/idempotency-store');
    idempotency.__resetIdempotencyStoreForTests();
    observedLaunchStatuses.length = 0;
    let complete: ((result: Awaited<ReturnType<typeof h.launch>>) => void) | undefined;
    h.launch.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const body = {
      runtime: 'codex',
      prompt: 'hold the owning real-route launch open',
      cwd: dataDir,
      clientMutationId: 'runtime-launch-real-route-pending',
    };
    const owningRequest = runtimeLaunchRoute.POST(new NextRequest(`${origin}/api/runtime/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
    await vi.waitFor(() => expect(h.launch).toHaveBeenCalledTimes(1));

    const { fetchRuntimeLaunch } = await import('./next-fetch');
    const transportRequest = fetchRuntimeLaunch(body);
    await vi.waitFor(() => expect(observedLaunchStatuses).toContain(202));
    complete?.({
      ok: true,
      runtime: 'codex',
      clientMutationId: body.clientMutationId,
      surfaceId: 'codex-owned:real-route-pending',
      note: 'The original real-route launch completed.',
      cwd: dataDir,
      repoPath: dataDir,
      worktree: null,
      laneId: null,
    });

    expect((await owningRequest).status).toBe(200);
    await expect(transportRequest).resolves.toMatchObject({
      surfaceId: 'codex-owned:real-route-pending',
      replayed: true,
    });
    expect(observedLaunchStatuses).toEqual(expect.arrayContaining([202, 200]));
    expect(h.launch).toHaveBeenCalledTimes(1);
  });

  it('replays the same launch mutation after a safe in-progress receipt', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        runtime: 'codex',
        clientMutationId: 'runtime-launch-transport-in-progress',
        surfaceId: '',
        note: 'The original launch is still running.',
        cwd: dataDir,
        repoPath: dataDir,
        worktree: null,
        laneId: null,
        replayed: true,
        inProgress: true,
      }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        runtime: 'codex',
        clientMutationId: 'runtime-launch-transport-in-progress',
        surfaceId: 'codex-owned:settled-launch',
        note: 'The original launch completed.',
        cwd: dataDir,
        repoPath: dataDir,
        worktree: null,
        laneId: null,
        replayed: true,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    try {
      const { fetchRuntimeLaunch } = await import('./next-fetch');
      const request = fetchRuntimeLaunch({
        runtime: 'codex',
        prompt: 'wait for the original launch',
        cwd: dataDir,
        clientMutationId: 'runtime-launch-transport-in-progress',
      });
      await vi.advanceTimersByTimeAsync(500);

      await expect(request).resolves.toMatchObject({
        surfaceId: 'codex-owned:settled-launch',
        replayed: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const requestBodies = fetchMock.mock.calls.map(([, init]) => String(init?.body));
      expect(requestBodies[0]).toBe(requestBodies[1]);
    } finally {
      fetchMock.mockRestore();
      vi.useRealTimers();
    }
  });

  it('fails closed when a completed launch response has no surface id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      runtime: 'codex',
      clientMutationId: 'runtime-launch-empty-surface',
      surfaceId: '',
      note: 'Launch completed without a surface.',
      cwd: dataDir,
      repoPath: dataDir,
      worktree: null,
      laneId: null,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    try {
      const { fetchRuntimeLaunch } = await import('./next-fetch');
      await expect(fetchRuntimeLaunch({
        runtime: 'codex',
        prompt: 'require a real surface',
        cwd: dataDir,
        clientMutationId: 'runtime-launch-empty-surface',
      })).rejects.toThrow('without a surface');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('mints supervisor launch correlation before the retrying transport helper', () => {
    const source = readFileSync(join(process.cwd(), 'src/ws-server.ts'), 'utf8');
    const start = source.indexOf('async relaunchAgent(');
    const end = source.indexOf('broadcastAgentUpdate(', start);
    const section = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(section).toContain('relaunchSupervisedAgent(prompt, repoPath, taskName, retryOfSurfaceId)');
    const retrySource = readFileSync(join(process.cwd(), 'src/lib/supervisor/relaunch-agent.ts'), 'utf8');
    expect(retrySource).toContain('const clientMutationId = randomUUID()');
    expect(retrySource).toContain('fetchRuntimeLaunch(launchBody)');
  });
});
