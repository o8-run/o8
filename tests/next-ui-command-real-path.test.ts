import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { NextRequest } from 'next/server';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

let reference: Awaited<ReturnType<typeof startParityReference>>;
let api: Server;
let apiUrl: string;
const sockets: WebSocket[] = [];
const frames: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  reference = await startParityReference();
  vi.stubEnv('CORTEX_REALTIME_INTERNAL_ORIGIN', reference.url.replace('ws:', 'http:').replace('/ws', ''));
  vi.stubEnv('WS_TOKEN', reference.token);
  // A missing route is a real 404 on the baseline, rather than an import failure.
  const routePath = resolve('src/app/api/next/ui-command/route.ts');
  const route = existsSync(routePath)
    ? await import(routePath) as { POST: (req: NextRequest) => Promise<Response> }
    : null;
  api = createServer(async (request, response) => {
    if (!route || request.url !== '/api/next/ui-command' || request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const result = await route.POST(new NextRequest(`${apiUrl}${request.url}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks),
    }));
    response.writeHead(result.status, Object.fromEntries(result.headers)).end(await result.text());
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const address = api.address();
  if (!address || typeof address === 'string') throw new Error('missing API fixture port');
  apiUrl = `http://127.0.0.1:${address.port}`;
  for (let i = 0; i < 2; i++) {
    const socket = new WebSocket(`${reference.url}?token=${reference.token}`);
    sockets.push(socket);
    // Both connections receive each frame, without a subscription.
    socket.on('message', (raw) => frames.push(JSON.parse(String(raw))));
    await once(socket, 'open');
  }
}, 60_000);

afterAll(async () => {
  for (const socket of sockets) socket.terminate();
  if (api?.listening) await new Promise<void>((done) => api.close(() => done()));
  await reference?.stop();
  vi.unstubAllEnvs();
});

function post(body: unknown, internal = false, token = reference.token) {
  return fetch(internal
    ? reference.url.replace('ws:', 'http:').replace('/ws', '/internal/ui-command')
    : `${apiUrl}/api/next/ui-command`, {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe('shell UI commands through the API and real WebSocket server', () => {
  it.each([
    ['open-settings', undefined],
    ['voice-toggle', {}],
    ['symon-ui', { event: 'o8:ui-command', data: { surface: 'settings' } }],
    ['ink-mark', { event: 'strokes', data: { strokes: [[0.1, 0.2]] } }],
  ])('delivers %s to connected clients with the exact native frame', async (kind, payload) => {
    const response = await post({ kind, ...(payload === undefined ? {} : { payload }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, recipients: 2 });
    await vi.waitFor(() => {
      expect(frames.filter((frame) => frame.type === 'ui-command' && frame.kind === kind))
        .toEqual(Array(2).fill({ type: 'ui-command', kind, payload: payload ?? {} }));
    });
  });

  it.each([
    { kind: 'unknown', payload: {} },
    { kind: 'open-settings', payload: null },
    { kind: 'open-settings', payload: [] },
    { kind: 'open-settings', payload: 'settings' },
    null,
    [],
  ])('rejects invalid commands without broadcasting: %j', async (body) => {
    const before = frames.filter((frame) => frame.type === 'ui-command').length;
    expect((await post(body)).status).toBe(400);
    expect((await post(body, true)).status).toBe(400);
    expect(frames.filter((frame) => frame.type === 'ui-command')).toHaveLength(before);
  });

  it('bounds UTF-8 request bytes at both handlers without trusting Content-Length', async () => {
    const body = { kind: 'symon-ui', payload: { text: '界'.repeat(24_000) } };
    expect((await post(body)).status).toBe(413);
    expect((await post(body, true)).status).toBe(413);
  });

  it('retains the internal bearer gate', async () => {
    expect((await post({ kind: 'open-settings' }, true, 'wrong-token')).status).toBe(401);
  });

  it('rejects malformed JSON', async () => {
    for (const url of [`${apiUrl}/api/next/ui-command`,
      reference.url.replace('ws:', 'http:').replace('/ws', '/internal/ui-command')]) {
      expect((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${reference.token}` }, body: '{' })).status)
        .toBe(400);
    }
  });
});
