import { createServer, get, Agent, type Server } from 'node:http';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

// The WS listener as o8d sees it with native session reads on: every response
// is marked to close first (src/ws-server.ts), then the native routes answer.
const bridgeKey = 'fixture-bridge-key';
let server: Server;
let origin: string;
let authorization: string;

beforeAll(async () => {
  vi.stubEnv('O8_WS_O8D', '1');
  vi.stubEnv('O8D_NATIVE_SESSION_READS', '1');
  const { getOrCreateWsToken } = await import('@/lib/ws-auth');
  authorization = `Bearer ${getOrCreateWsToken()}`;
  const { handleNativeHttp } = await import('@/lib/ws-server/native-http-routes');
  server = createServer(async (req, res) => {
    res.setHeader('Connection', 'close');
    if (!await handleNativeHttp(req, res, undefined, req.headers['x-o8d-bridge'] === bridgeKey)) res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Listener did not bind');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  vi.unstubAllEnvs();
});

function read(agent: Agent, path: string, headers: Record<string, string>) {
  return new Promise<{ status: number | undefined; connection: string | undefined; port: number | undefined }>((resolve, reject) => {
    const request = get(origin + path, { agent, headers: { authorization, ...headers } }, response => {
      response.resume();
      response.once('end', () => resolve({ status: response.statusCode, connection: response.headers.connection,
        port: request.socket?.localPort }));
      response.once('error', reject);
    });
    request.once('error', reject);
  });
}

it('keeps the bridge admission backhaul open across reads, and closes every other response', async () => {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const admit = { 'x-o8d-bridge': bridgeKey, 'x-o8d-session-read': 'authorize' };
    const admissions = [];
    for (let i = 0; i < 3; i++) admissions.push(await read(agent, '/api/v2/chat-history?tabId=thoughts-admission', admit));
    for (const admission of admissions) {
      expect(admission.status).toBe(204);
      expect(admission.connection).not.toBe('close');
    }
    // o8d's pooled client reuses one loopback socket for every admission.
    expect(new Set(admissions.map(admission => admission.port)).size).toBe(1);

    // Without the bridge key the authorize header is not an admission: the read
    // runs as a tunnelled TS request and its socket still closes.
    const spoofed = await read(agent, '/api/v2/chat-history?tabId=thoughts-admission',
      { 'x-o8d-bridge': 'spoofed', 'x-o8d-session-read': 'authorize' });
    expect(spoofed.status).toBe(200);
    expect(spoofed.connection).toBe('close');
    const plain = await read(agent, '/api/v2/chat-history?tabId=thoughts-admission', { 'x-o8d-bridge': bridgeKey });
    expect(plain.status).toBe(200);
    expect(plain.connection).toBe('close');
    // A refused admission closes too.
    const refused = await new Promise<{ status: number | undefined; connection: string | undefined }>((resolve, reject) => {
      get(`${origin}/api/v2/chat-history?tabId=thoughts-admission`, { agent, headers: admit }, response => {
        response.resume();
        response.once('end', () => resolve({ status: response.statusCode, connection: response.headers.connection }));
      }).once('error', reject);
    });
    expect(refused.status).toBe(401);
    expect(refused.connection).toBe('close');
  } finally { agent.destroy(); }
});
