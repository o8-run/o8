import { createHash } from 'node:crypto';

import type { Socket } from 'node:net';

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import {
  O8_RELAY_SURFACE_HEADER,
  O8_WEB_MACHINE_SURFACE,
} from '@/lib/connect/web-machine-surface';
import { readCachedEntitlement, writeCachedEntitlement } from '@/lib/entitlement/license';
import type { Plan } from '@/lib/entitlement/types';
import {
  base58Encode,
  buildHttpReplay,
  chunkBase64,
  deriveRoutingId,
  httpCancelRequestId,
  passthroughCloseCode,
  RelayHttpRequestRegistry,
  relayConnectorEligible,
  RELAY_FORWARD_MARKER,
} from './relay-connector-protocol';
import { startRelayConnectorIfEnabled, type RelayConnector } from './relay-connector';

const connectors: RelayConnector[] = [];
const relayServers: WebSocketServer[] = [];

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for relay recovery');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function startRelay(onConnection?: (socket: WebSocket, index: number, authorization?: string) => void) {
  const sockets: WebSocket[] = [];
  const connectedAt: number[] = [];
  const authorizations: Array<string | undefined> = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  relayServers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  server.on('connection', (socket, request) => {
    expect(request.url).toBe('/mac');
    expect(request.headers.authorization).toMatch(/^Bearer \S+$/);
    sockets.push(socket);
    connectedAt.push(Date.now());
    authorizations.push(request.headers.authorization);
    onConnection?.(socket, sockets.length - 1, request.headers.authorization);
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'devices', count: 0 }));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('relay fixture did not bind');
  return { url: `ws://127.0.0.1:${address.port}`, sockets, connectedAt, authorizations };
}

// Independent /mac relay fixture. Only an explicit declaration enables expiry;
// transport pongs and other application traffic never renew this deadline.
async function startHeartbeatRelay(advertise = true, timeoutMs = 90_000) {
  const frames: Array<{ raw: string; at: number; connection: number }> = [];
  const offlineAt: number[] = [];
  const deadlines = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  const online = new Set<WebSocket>();
  const relay = await startRelay((socket, connection) => {
    online.add(socket);
    let declared = false;
    const expire = () => {
      const prior = deadlines.get(socket);
      if (prior) clearTimeout(prior);
      deadlines.set(socket, setTimeout(() => {
        online.delete(socket);
        offlineAt.push(Date.now());
        socket.close(1012, 'heartbeat_timeout');
      }, timeoutMs));
    };
    socket.on('message', (raw) => {
      const text = raw.toString();
      frames.push({ raw: text, at: Date.now(), connection });
      if (text === '{"t":"relay-capabilities","heartbeat":"app-v1"}') {
        if (!declared) { declared = true; expire(); }
      } else if (declared && text === '{"t":"relay-heartbeat","v":1}') {
        expire();
        socket.send('{"t":"relay-heartbeat-ack","v":1}');
      }
    });
    socket.on('close', () => {
      online.delete(socket);
      const deadline = deadlines.get(socket);
      if (deadline) clearTimeout(deadline);
      deadlines.delete(socket);
    });
    if (advertise) socket.send('{"t":"devices","count":0,"heartbeat":"app-v1"}');
  });
  return { ...relay, frames, offlineAt, online };
}

function startConnector(relayUrl: string, timing: {
  keepAliveIntervalMs?: number;
  pongTimeoutMs?: number;
  entitlementRetryIntervalMs?: number;
  entitlementRetryRandom?: () => number;
  blockedApprovalCount?: () => number;
} = {}): RelayConnector {
  vi.stubEnv('O8_RELAY_URL', relayUrl);
  const config = {
    blockedApprovalCount: () => 0,
    relayUrl,
    ...timing,
  };
  const connector = startRelayConnectorIfEnabled(config);
  if (!connector) throw new Error('relay fixture must start with eligible cached credentials');
  connectors.push(connector);
  return connector;
}

function cacheLicense(licenseKey: string | undefined = 'fixture-license', plan: Plan = 'pro'): void {
  expect(writeCachedEntitlement({ plan, licenseKey, status: 'active', expiresAt: null })).toBe(true);
}

beforeEach(() => {
  vi.stubEnv('O8_PLAN', '');
  vi.stubEnv('O8_RELAY_CONNECTOR', 'on');
  cacheLicense();
});

afterEach(async () => {
  for (const connector of connectors.splice(0)) connector.stop();
  await Promise.all(relayServers.splice(0).map(async (server) => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('desktop relay socket recovery through /mac', () => {
  it('keeps the desktop online while healthy, then expires a silent desktop within 90 seconds and redials', async () => {
    const relay = await startHeartbeatRelay();
    // Isolate relay-side detection from the separately tested desktop ping path.
    startConnector(relay.url, { keepAliveIntervalMs: 300_000 });
    await waitFor(() => relay.sockets.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 100_100));
    expect(relay.online.size).toBe(1);
    const socket = relay.sockets[0] as WebSocket & { _socket: Socket };
    const silentAt = Date.now();
    socket._socket.pause(); // no FIN, error, or close; relay retains the TCP peer
    await new Promise((resolve) => setTimeout(resolve, 90_300));
    const elapsed = relay.offlineAt.length ? (relay.offlineAt[0] - silentAt) / 1_000 : null;
    process.stdout.write(`[relay-heartbeat-test] silence-to-offline=${elapsed ?? '>90.300'}s\n`);
    expect(relay.online.size).toBe(0);
    expect(elapsed).toBeGreaterThan(0);
    expect(elapsed).toBeLessThanOrEqual(90.1);
    const first = relay.frames.filter((frame) => frame.connection === 0);
    expect(first[0].raw).toBe('{"t":"relay-capabilities","heartbeat":"app-v1"}');
    expect(first.slice(1).map((frame) => frame.raw)).toEqual(Array(5).fill('{"t":"relay-heartbeat","v":1}'));
    expect(first[1].at - first[0].at).toBeLessThan(100);
    for (let index = 2; index < first.length; index++) {
      expect(first[index].at - first[index - 1].at).toBeGreaterThanOrEqual(24_900);
      expect(first[index].at - first[index - 1].at).toBeLessThan(25_500);
    }
    let close: { code: number; reason: string } | undefined;
    socket.on('close', (code, reason) => { close = { code, reason: reason.toString() }; });
    socket._socket.resume();
    await waitFor(() => relay.sockets.length === 2);
    expect(close).toEqual({ code: 1012, reason: 'heartbeat_timeout' });
    await waitFor(() => relay.frames.some((frame) => frame.connection === 1));
    expect(relay.frames.filter((frame) => frame.connection === 1).map((frame) => frame.raw))
      .toEqual(['{"t":"relay-capabilities","heartbeat":"app-v1"}', '{"t":"relay-heartbeat","v":1}']);
  }, 200_000);

  it('sends no unknown frames to an older relay', async () => {
    const relay = await startHeartbeatRelay(false, 100);
    startConnector(relay.url, { keepAliveIntervalMs: 25, pongTimeoutMs: 80 });
    await waitFor(() => relay.sockets.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(relay.frames).toEqual([]);
    expect(relay.online.size).toBe(1);
  });

  it('exempts desktops that never declare heartbeat even when the relay supports it', async () => {
    const relay = await startHeartbeatRelay(true, 100);
    const desktop = new WebSocket(`${relay.url}/mac`, { headers: { authorization: 'Bearer fixture-license' } });
    try {
      await waitFor(() => desktop.readyState === WebSocket.OPEN);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(relay.online.size).toBe(1);
      expect(relay.offlineAt).toEqual([]);
    } finally { desktop.terminate(); }
  });

  it.each([1, 2])('accepts only a version 1 heartbeat acknowledgement as liveness (version %s)', async (version) => {
    let pings = 0;
    const relay = await startRelay((socket) => {
      (socket as WebSocket & { _autoPong: boolean })._autoPong = false;
      socket.send('{"t":"devices","count":0,"heartbeat":"app-v1"}');
      socket.on('ping', () => {
        pings++;
        socket.send(JSON.stringify({ t: 'relay-heartbeat-ack', v: version }));
      });
    });
    startConnector(relay.url, { keepAliveIntervalMs: 25, pongTimeoutMs: 50 });
    if (version === 1) {
      await waitFor(() => pings >= 5);
      expect(relay.sockets).toHaveLength(1);
    } else {
      await waitFor(() => relay.sockets.length === 2);
    }
  });

  it('redials a silently blackholed established socket within the production deadline', async () => {
    let pings = 0;
    let detectedAt = 0;
    const warn = console.warn.bind(console);
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      if (args[0] === '[relay] keepalive timeout') detectedAt = Date.now();
      warn(...args);
    });
    const relay = await startRelay((socket) => socket.on('ping', () => { pings++; }));
    startConnector(relay.url);
    await waitFor(() => relay.sockets.length === 1);
    // Pause the actual TCP receive path after upgrade. No close/error frame is
    // sent, and the established socket cannot receive ping or return pong.
    const socket = relay.sockets[0] as WebSocket & { _socket: Socket };
    expect(socket.readyState).toBe(WebSocket.OPEN);
    const blackholedAt = Date.now();
    socket._socket.pause();

    await waitFor(() => relay.sockets.length >= 2, 32_000);

    const redialMs = relay.connectedAt[1] - blackholedAt;
    const detectionMs = detectedAt - blackholedAt;
    console.log(`[relay-recovery-test] detection=${detectionMs}ms blackhole-to-redial=${redialMs}ms`);
    expect(detectionMs).toBeGreaterThan(0);
    expect(detectionMs).toBeLessThanOrEqual(30_500);
    expect(redialMs).toBeLessThanOrEqual(31_500);
    expect(pings).toBe(0);
  }, 35_000);

  it('keeps a healthy idle socket connected and cancels timers on stop', async () => {
    let pings = 0;
    const relay = await startRelay((socket) => socket.on('ping', () => { pings++; }));
    const connector = startConnector(relay.url, { keepAliveIntervalMs: 25, pongTimeoutMs: 80 });
    await waitFor(() => pings >= 5);
    expect(relay.sockets).toHaveLength(1);
    connector.stop();
    const stoppedAtPings = pings;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(pings).toBe(stoppedAtPings);
    expect(relay.sockets).toHaveLength(1);
  });

  it('recovers after 4409 by reading refreshed token B from the cache without restarting', async () => {
    let acceptedAttaches = 0;
    cacheLicense('expired-token-a');
    const relay = await startRelay((socket, _index, authorization) => {
      if (authorization !== 'Bearer renewed-token-b') socket.close(4409, 'entitlement_lapsed');
    });
    startConnector(relay.url, {
      entitlementRetryIntervalMs: 120,
      entitlementRetryRandom: () => 0.5,
      blockedApprovalCount: () => { acceptedAttaches++; return 0; },
    });
    await waitFor(() => relay.sockets[0]?.readyState === WebSocket.CLOSED);
    cacheLicense('renewed-token-b');
    expect(readCachedEntitlement()?.licenseKey).toBe('renewed-token-b');
    await waitFor(() => relay.sockets.length >= 2);
    expect(relay.authorizations).toEqual(['Bearer expired-token-a', 'Bearer renewed-token-b']);
    expect(relay.sockets[1].readyState).toBe(WebSocket.OPEN);
    // A relay devices frame acknowledges acceptance. A later transport failure
    // must use the normal 500-1,000 ms first retry, rather than the 120 ms test cadence.
    await waitFor(() => acceptedAttaches === 1);
    const droppedAt = Date.now();
    relay.sockets[1].terminate();
    await waitFor(() => relay.sockets.length >= 3);
    expect(relay.connectedAt[2] - droppedAt).toBeGreaterThanOrEqual(450);
    expect(relay.connectedAt[2] - droppedAt).toBeLessThanOrEqual(1_300);
    expect(relay.authorizations[2]).toBe('Bearer renewed-token-b');
    expect(relay.sockets[2].readyState).toBe(WebSocket.OPEN);
  });

  it('reads the refreshed cached token on an ordinary transport reconnect', async () => {
    const relay = await startRelay();
    startConnector(relay.url);
    await waitFor(() => relay.sockets.length === 1);
    cacheLicense('renewed-token-b');
    relay.sockets[0].terminate();
    await waitFor(() => relay.sockets.length === 2);
    expect(relay.authorizations).toEqual(['Bearer fixture-license', 'Bearer renewed-token-b']);
  });

  it('does not redial an unchanged rejected token faster than the slow entitlement cadence', async () => {
    cacheLicense('expired-token-a');
    const relay = await startRelay((socket) => socket.close(4409, 'entitlement_lapsed'));
    startConnector(relay.url, { entitlementRetryIntervalMs: 2_000, entitlementRetryRandom: () => 0.5 });
    await waitFor(() => relay.sockets[0]?.readyState === WebSocket.CLOSED);
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(relay.sockets).toHaveLength(1);
    await waitFor(() => relay.sockets.length >= 3, 3_500);
    expect(relay.authorizations).toEqual(Array(3).fill('Bearer expired-token-a'));
    expect(relay.connectedAt[1] - relay.connectedAt[0]).toBeGreaterThanOrEqual(2_000);
    expect(relay.connectedAt[2] - relay.connectedAt[1]).toBeGreaterThanOrEqual(2_000);
  });

  it.each(['plan', 'token', 'toggle'] as const)('pauses reconnects while current %s is ineligible and rechecks later', async (changed) => {
    const relay = await startRelay();
    startConnector(relay.url, { entitlementRetryIntervalMs: 150, entitlementRetryRandom: () => 0.5 });
    await waitFor(() => relay.sockets.length === 1);
    if (changed === 'plan') cacheLicense('fixture-license', 'free');
    if (changed === 'token') cacheLicense('');
    if (changed === 'toggle') vi.stubEnv('O8_RELAY_CONNECTOR', 'off');
    relay.sockets[0].terminate();
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(relay.sockets).toHaveLength(1);
    cacheLicense('renewed-token-b');
    vi.stubEnv('O8_RELAY_CONNECTOR', 'on');
    await waitFor(() => relay.sockets.length === 2);
    expect(relay.authorizations[1]).toBe('Bearer renewed-token-b');
  });

  it('cancels a pending 4409 retry when explicitly stopped', async () => {
    const relay = await startRelay((socket) => socket.close(4409, 'entitlement_lapsed'));
    const connector = startConnector(relay.url, { entitlementRetryIntervalMs: 100, entitlementRetryRandom: () => 0.5 });
    await waitFor(() => relay.sockets[0]?.readyState === WebSocket.CLOSED);
    connector.stop();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(relay.sockets).toHaveLength(1);
  });

  it('clears an outstanding pong deadline on stop and ignores stale socket callbacks on restart', async () => {
    let pings = 0;
    const relay = await startRelay((socket, index) => {
      socket.on('ping', () => {
        pings++;
      });
      if (index === 0) socket.once('ping', () => {
        (socket as WebSocket & { _socket: Socket })._socket.pause();
      });
    });
    const connector = startConnector(relay.url, { keepAliveIntervalMs: 25, pongTimeoutMs: 150 });
    connector.start(); // idempotent: must not orphan an already-dialing socket
    await waitFor(() => pings >= 1);
    // The first ping was answered before pause; the second is now blackholed.
    await new Promise((resolve) => setTimeout(resolve, 60));
    connector.stop();
    connector.start();
    await waitFor(() => relay.sockets.length >= 2);
    (relay.sockets[0] as WebSocket & { _socket: Socket })._socket.resume();
    await waitFor(() => relay.sockets[0].readyState === WebSocket.CLOSED);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(relay.sockets).toHaveLength(2);
    expect(relay.sockets[1].readyState).toBe(WebSocket.OPEN);
  });
});

describe('HTTP replay cancellation', () => {
  it('accepts only a well-formed http-cancel frame', () => {
    expect(httpCancelRequestId({ t: 'http-cancel', rid: 'request-1' })).toBe('request-1');
    expect(httpCancelRequestId({ t: 'http-cancel', rid: '' })).toBeNull();
    expect(httpCancelRequestId({ t: 'http-cancel', rid: '   ' })).toBeNull();
    expect(httpCancelRequestId({ t: 'http-cancel' })).toBeNull();
    expect(httpCancelRequestId({ t: 'http-req', rid: 'request-1' })).toBeNull();
    expect(httpCancelRequestId(null)).toBeNull();
  });

  it('isolates identical request ids across streams and ignores late cancels', () => {
    const registry = new RelayHttpRequestRegistry();
    const first = registry.begin('stream-a', 'request-1');
    const second = registry.begin('stream-b', 'request-1');

    expect(registry.cancel('stream-a', 'request-1')).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(first.signal.reason).toBe('client-cancel');
    expect(second.signal.aborted).toBe(false);
    expect(registry.cancel('stream-a', 'request-1')).toBe(false);

    registry.finish('stream-b', 'request-1', second);
    expect(registry.cancel('stream-b', 'request-1')).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('aborts every request owned by a torn-down stream only', () => {
    const registry = new RelayHttpRequestRegistry();
    const a1 = registry.begin('stream-a', 'request-1');
    const a2 = registry.begin('stream-a', 'request-2');
    const b1 = registry.begin('stream-b', 'request-1');

    expect(registry.abortStream('stream-a')).toBe(2);
    expect(a1.signal.reason).toBe('stream-teardown');
    expect(a2.signal.reason).toBe('stream-teardown');
    expect(b1.signal.aborted).toBe(false);
    expect(registry.size).toBe(1);
  });

  it('supersedes a reused id without letting stale cleanup remove its replacement', () => {
    const registry = new RelayHttpRequestRegistry();
    const stale = registry.begin('stream-a', 'request-1');
    const current = registry.begin('stream-a', 'request-1');

    expect(stale.signal.reason).toBe('superseded');
    registry.finish('stream-a', 'request-1', stale);
    expect(registry.cancel('stream-a', 'request-1')).toBe(true);
    expect(current.signal.reason).toBe('client-cancel');
  });

  it('allows only the owning request to fire its timeout', () => {
    const registry = new RelayHttpRequestRegistry();
    const stale = registry.begin('stream-a', 'request-1');
    const current = registry.begin('stream-a', 'request-1');

    expect(registry.timeout('stream-a', 'request-1', stale)).toBe(false);
    expect(registry.timeout('stream-a', 'request-1', current)).toBe(true);
    expect(current.signal.reason).toBe('timeout');
    expect(registry.size).toBe(0);
  });
});

describe('base58Encode (must equal bs58 so the routingId matches the mobile client)', () => {
  it('matches known bs58 vectors', () => {
    expect(base58Encode(new Uint8Array())).toBe('');
    expect(base58Encode(Uint8Array.from([0]))).toBe('1');
    expect(base58Encode(Uint8Array.from([0, 0]))).toBe('11');
    expect(base58Encode(new TextEncoder().encode('hello world'))).toBe('StV1DL6CwTryKyV');
  });

  it('preserves leading zero bytes as leading 1s', () => {
    expect(base58Encode(Uint8Array.from([0, 0, 0, 1]))).toBe('1112');
  });
});

describe('deriveRoutingId', () => {
  const pub = Buffer.from('server-identity-pubkey-bytes').toString('base64');

  it('is base58(SHA-256(pubkey)[:16]) and deterministic', () => {
    const expected = base58Encode(
      createHash('sha256').update(Buffer.from(pub, 'base64')).digest().subarray(0, 16),
    );
    expect(deriveRoutingId(pub)).toBe(expected);
    expect(deriveRoutingId(pub)).toBe(deriveRoutingId(pub));
  });

  it('differs for different identity keys', () => {
    const a = deriveRoutingId(Buffer.from('key-a').toString('base64'));
    const b = deriveRoutingId(Buffer.from('key-b').toString('base64'));
    expect(a).not.toBe(b);
  });
});

describe('relayConnectorEligible (entitlement × operator toggle)', () => {
  it('free is never eligible, whatever the toggle', () => {
    expect(relayConnectorEligible('free', true)).toBe(false);
    expect(relayConnectorEligible('free', false)).toBe(false);
  });

  it('every paid tier is eligible when the toggle is on', () => {
    for (const plan of ['pro', 'team', 'founder'] as const) {
      expect(relayConnectorEligible(plan, true)).toBe(true);
    }
  });

  it('the operator toggle can disable an entitled plan', () => {
    expect(relayConnectorEligible('founder', false)).toBe(false);
  });
});

describe('buildHttpReplay — non-loopback marker + Bearer (v1.1 change 1)', () => {
  const base = 'http://127.0.0.1:3001';

  it('stamps a NON-loopback socket-truth marker + the wrapper trigger + forwards the Bearer', () => {
    const r = buildHttpReplay({ rid: '1', method: 'GET', path: '/api/mobile/inbox', authorization: 'Bearer tok' }, base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.headers['x-o8-client-addr']).toBe(RELAY_FORWARD_MARKER);
    expect(r.headers['x-o8-client-addr']).not.toMatch(/^127\.|::1|localhost/);
    expect(r.headers['x-o8-relay-forward']).toBe('1');
    expect(r.headers['authorization']).toBe('Bearer tok');
    expect(r.url).toBe(`${base}/api/mobile/inbox`);
  });

  it('picks up an Authorization nested in the headers object', () => {
    const r = buildHttpReplay({ path: '/api/mobile/x', headers: { Authorization: 'Bearer h' } }, base);
    expect(r.ok && r.headers['authorization']).toBe('Bearer h');
  });

  it('rejects SSRF-shaped paths (open-proxy guard)', () => {
    for (const path of ['//evil.com', 'http://evil', '/a/../b', 'relative', '', '/x\\y']) {
      expect(buildHttpReplay({ path }, base).ok).toBe(false);
    }
  });

  it('only attaches a body for non-GET/HEAD', () => {
    const b64 = Buffer.from('hi').toString('base64');
    const get = buildHttpReplay({ path: '/api/x', method: 'GET', bodyB64: b64 }, base);
    expect(get.ok && get.body).toBeUndefined();
    const post = buildHttpReplay({ path: '/api/x', method: 'POST', bodyB64: b64 }, base);
    expect(post.ok && post.body?.toString('utf8')).toBe('hi');
  });

  it('forwards only the safe header subset (never Cookie)', () => {
    const r = buildHttpReplay({ path: '/api/x', headers: { cookie: 'secret', 'content-type': 'application/json' } }, base);
    expect(r.ok && r.headers['cookie']).toBeUndefined();
    expect(r.ok && r.headers['content-type']).toBe('application/json');
  });

  it('marks only explicit web-machine replays and leaves the phone path unchanged', () => {
    const phone = buildHttpReplay({ path: '/mobile' }, base);
    const web = buildHttpReplay(
      { path: '/mobile' },
      base,
      { relaySurface: O8_WEB_MACHINE_SURFACE },
    );

    expect(phone.ok && phone.headers[O8_RELAY_SURFACE_HEADER]).toBeUndefined();
    expect(web.ok && web.headers[O8_RELAY_SURFACE_HEADER]).toBe(O8_WEB_MACHINE_SURFACE);
  });
});

describe('chunkBase64 (R6 chunking)', () => {
  it('is a single chunk when under the cap', () => {
    expect(chunkBase64('abc', 10)).toEqual(['abc']);
  });

  it('splits large payloads into ≤cap chunks that reconstruct exactly', () => {
    const s = 'x'.repeat(1000);
    const chunks = chunkBase64(s, 256);
    expect(chunks.length).toBe(4);
    expect(chunks.every((c) => c.length <= 256)).toBe(true);
    expect(chunks.join('')).toBe(s);
  });
});

describe('passthroughCloseCode (close-code namespaces)', () => {
  it('passes Mac-origin 4401/4403 through; relay-origin codes do not', () => {
    expect(passthroughCloseCode(4401)).toBe(4401);
    expect(passthroughCloseCode(4403)).toBe(4403);
    expect(passthroughCloseCode(4408)).toBeNull();
    expect(passthroughCloseCode(4409)).toBeNull();
    expect(passthroughCloseCode(1000)).toBeNull();
  });
});
