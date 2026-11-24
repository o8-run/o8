import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import { readConnectAttachSetting } from './attach-settings';
import {
  MachineRelayConnector,
  type MachineRelayTicket,
} from './machine-attach';
import { MachineAttachSupervisor } from './machine-attach-supervisor';

type ConnectionRecord = {
  path: string;
  authorization: string | undefined;
  machineId: string | undefined;
};

type RelayHarness = {
  url: string;
  server: WebSocketServer;
  connections: ConnectionRecord[];
  connectionTimes: number[];
};

const harnesses: RelayHarness[] = [];
const temporaryDirectories: string[] = [];

async function startRelay(
  onConnection?: (socket: WebSocket, index: number) => void,
  options: { autoPong?: boolean } = {},
): Promise<RelayHarness> {
  const connections: ConnectionRecord[] = [];
  const connectionTimes: number[] = [];
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    ...(options.autoPong === undefined
      ? {}
      : { autoPong: options.autoPong }),
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  server.on('connection', (socket, request) => {
    connectionTimes.push(Date.now());
    connections.push({
      path: request.url ?? '',
      authorization: request.headers.authorization,
      machineId: request.headers['x-o8-machine-id'] as string | undefined,
    });
    onConnection?.(socket, connections.length - 1);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('relay fixture did not bind');
  const harness = {
    url: `ws://127.0.0.1:${address.port}`,
    server,
    connections,
    connectionTimes,
  };
  harnesses.push(harness);
  return harness;
}

function ticket(machineId: string, sequence = 1): MachineRelayTicket {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  return {
    ticket: compactJwt(
      { alg: 'EdDSA', typ: 'JWT' },
      {
        accountId: 'account_1',
        machineId,
        installId: 'install_1',
        aud: 'o8-relay',
        iat: nowSeconds,
        exp: nowSeconds + 600,
        sequence,
      },
    ),
    expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
  };
}

function compactJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
): string {
  return [
    Buffer.from(JSON.stringify(header)).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    Buffer.from('fixture-signature').toString('base64url'),
  ].join('.');
}

function decodeJwtPart(tokenValue: string, index: number): Record<string, unknown> {
  const part = tokenValue.split('.')[index];
  if (!part) throw new Error('invalid fixture jwt');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function parseFrame(raw: RawData): Record<string, unknown> {
  return JSON.parse(raw.toString()) as Record<string, unknown>;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for relay fixture');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async ({ server }) => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('machine relay attach real path', () => {
  it('presents the machine ticket and replays only notice-page reads, with no local credential', async () => {
    const responses = new Map<string, Record<string, unknown>>();
    const relay = await startRelay((socket) => {
      socket.send(JSON.stringify({ t: 'mux-open', sid: 'web-1' }));
      socket.on('message', (raw) => {
        const outer = parseFrame(raw);
        if (outer.t === 'mux-ready') {
          const requests = [
            { rid: 'page', method: 'GET', path: '/mobile', authorization: 'Bearer untrusted-web-value' },
            { rid: 'asset', method: 'GET', path: '/_next/static/chunks/app.js', headers: { Authorization: 'Bearer untrusted-web-value' } },
            { rid: 'api', method: 'GET', path: '/api/panel/repos' },
            { rid: 'write', method: 'POST', path: '/mobile' },
            { rid: 'escape', method: 'GET', path: '/_next/static/%2e%2e/api/panel/repos' },
          ];
          for (const request of requests) {
            socket.send(JSON.stringify({
              t: 'mux',
              sid: 'web-1',
              seq: 1,
              payload: Buffer.from(JSON.stringify({ t: 'http-req', ...request }), 'utf8').toString('base64'),
            }));
          }
          return;
        }
        if (outer.t === 'mux' && typeof outer.payload === 'string') {
          const response = JSON.parse(
            Buffer.from(outer.payload, 'base64').toString('utf8'),
          ) as Record<string, unknown>;
          responses.set(String(response.rid), response);
        }
      });
    });
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init });
      return new Response('<html>notice</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    }) as typeof fetch;
    const machineId = 'machine_01HREALPATH';
    const issued = ticket(machineId);
    const connector = new MachineRelayConnector({
      machineId,
      relayUrl: relay.url,
      apiBase: 'http://127.0.0.1:47120',
      operatorToken: () => 'local-operator-token',
      ticketProvider: async () => issued,
      fetchImpl,
      reconnectBaseMs: 20,
      reconnectCapMs: 40,
    });

    connector.start();
    await waitFor(() => responses.size === 5);

    expect(relay.connections).toHaveLength(1);
    expect(relay.connections[0]).toMatchObject({
      path: '/machine',
      machineId,
      authorization: `Bearer ${issued.ticket}`,
    });
    expect(decodeJwtPart(issued.ticket, 0)).toEqual({ alg: 'EdDSA', typ: 'JWT' });
    expect(decodeJwtPart(issued.ticket, 1)).toMatchObject({
      accountId: 'account_1',
      machineId,
      installId: 'install_1',
      aud: 'o8-relay',
    });

    expect(fetchCalls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:47120/mobile',
      'http://127.0.0.1:47120/_next/static/chunks/app.js',
    ]);
    for (const call of fetchCalls) {
      const headers = new Headers(call.init?.headers);
      expect(headers.get('authorization')).toBeNull();
      expect(headers.get('x-o8-client-addr')).toBe('o8-relay-forward');
      expect(headers.get('x-o8-relay-forward')).toBe('1');
      expect(headers.get('x-o8-relay-surface')).toBe('web-machine');
    }
    expect(responses.get('page')).toMatchObject({ t: 'http-res', status: 200 });
    expect(responses.get('asset')).toMatchObject({ t: 'http-res', status: 200 });
    for (const rid of ['api', 'write', 'escape']) {
      expect(responses.get(rid)).toMatchObject({ t: 'http-res', status: 403, error: 'web_machine_route_forbidden' });
    }

    connector.stop('test-complete');
  });

  it('fetches a fresh ticket and reconnects after the relay drops the socket', async () => {
    const relay = await startRelay((socket, index) => {
      if (index === 0) {
        setTimeout(() => socket.close(1012, 'fixture-drop'), 10);
      }
    });
    let issued = 0;
    const connector = new MachineRelayConnector({
      machineId: 'machine_reconnect',
      relayUrl: relay.url,
      ticketProvider: async () => ticket('machine_reconnect', ++issued),
      reconnectBaseMs: 20,
      reconnectCapMs: 40,
    });

    connector.start();
    await waitFor(() => relay.connections.length >= 2);

    expect(issued).toBeGreaterThanOrEqual(2);
    expect(relay.connections.every((entry) => entry.path === '/machine')).toBe(true);
    expect(relay.connections.every((entry) => entry.machineId === 'machine_reconnect')).toBe(true);
    expect(relay.connections[0]?.authorization).not.toBe(relay.connections[1]?.authorization);

    connector.stop('test-complete');
  });

  it('supervisor re-establishes after two quick relay drops within the capped ladder interval', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let secondDropAt = 0;
    const relay = await startRelay((socket, index) => {
      if (index === 0) {
        socket.send(JSON.stringify({ t: 'devices', count: 0 }));
        setTimeout(() => socket.close(1012, 'first-restart'), 10);
        return;
      }
      if (index === 1) {
        setTimeout(() => {
          secondDropAt = Date.now();
          socket.close(1012, 'second-restart');
        }, 10);
        return;
      }
      socket.send(JSON.stringify({ t: 'devices', count: 0 }));
    });
    let issued = 0;
    const supervisor = new MachineAttachSupervisor({
      reconcileIntervalMs: 20,
      readEnabled: () => true,
      readCredential: () => 'account-token',
      readInstallId: () => 'install_double_drop',
      listRegisteredMachines: async () => [{
        machineId: 'machine_double_drop',
        installId: 'install_double_drop',
        name: 'Double Drop Mac',
        platform: 'darwin',
        appVersion: '0.1.0',
      }],
      createConnector: (machine) => new MachineRelayConnector({
        machineId: machine.machineId,
        relayUrl: relay.url,
        ticketProvider: async () => ticket(machine.machineId, ++issued),
        reconnectBaseMs: 300,
        reconnectCapMs: 600,
      }),
    });

    supervisor.start();
    await waitFor(() => relay.connections.length >= 3);

    const thirdAttachAt = relay.connectionTimes[2] ?? Number.POSITIVE_INFINITY;
    expect(secondDropAt).toBeGreaterThan(0);
    expect(thirdAttachAt - secondDropAt).toBeLessThanOrEqual(450);
    expect(issued).toBeGreaterThanOrEqual(3);

    supervisor.stop();
  });

  it('keeps an otherwise idle machine socket alive beyond 15 simulated minutes', async () => {
    let pings = 0;
    const relay = await startRelay((socket) => {
      socket.send(JSON.stringify({ t: 'devices', count: 0 }));
      socket.on('ping', () => {
        pings++;
      });
    });
    const connector = new MachineRelayConnector({
      machineId: 'machine_keepalive',
      relayUrl: relay.url,
      ticketProvider: async () => ticket('machine_keepalive'),
      // Each 5 ms test tick represents the production 30-second cadence.
      keepAliveIntervalMs: 5,
      pongTimeoutMs: 20,
      reconnectBaseMs: 20,
      reconnectCapMs: 40,
    });

    connector.start();
    await waitFor(() => pings >= 31, 1_000);

    expect(pings).toBeGreaterThanOrEqual(31);
    expect(relay.connections).toHaveLength(1);
    expect(relay.server.clients.size).toBe(1);

    connector.stop('test-complete');
  });

  it('treats a missing keepalive pong as a drop and reconnects', async () => {
    let pings = 0;
    const relay = await startRelay((socket) => {
      socket.send(JSON.stringify({ t: 'devices', count: 0 }));
      socket.on('ping', () => {
        pings++;
      });
    }, { autoPong: false });
    let issued = 0;
    const connector = new MachineRelayConnector({
      machineId: 'machine_no_pong',
      relayUrl: relay.url,
      ticketProvider: async () => ticket('machine_no_pong', ++issued),
      keepAliveIntervalMs: 10,
      pongTimeoutMs: 5,
      reconnectBaseMs: 10,
      reconnectCapMs: 20,
    });

    connector.start();
    await waitFor(() => relay.connections.length >= 2);

    expect(pings).toBeGreaterThanOrEqual(1);
    expect(issued).toBeGreaterThanOrEqual(2);

    connector.stop('test-complete');
  });

  it('opens no local realtime socket for a web-machine stream and drops its realtime frames', async () => {
    const localWebSocket = await startRelay();
    let ready = false;
    let relayed = 0;
    const relay = await startRelay((socket) => {
      socket.send(JSON.stringify({ t: 'mux-open', sid: 'web-realtime' }));
      socket.on('message', (raw) => {
        const outer = parseFrame(raw);
        if (outer.t === 'mux-ready') {
          ready = true;
          socket.send(JSON.stringify({
            t: 'mux',
            sid: 'web-realtime',
            seq: 1,
            payload: Buffer.from(JSON.stringify({ type: 'ping' }), 'utf8').toString('base64'),
          }));
          // An ordered stream open after the frame proves it was processed.
          socket.send(JSON.stringify({ t: 'mux-open', sid: 'barrier' }));
          return;
        }
        if (outer.t === 'mux') relayed++;
      });
    });
    let barrier = false;
    relay.server.on('connection', (socket) => socket.on('message', (raw) => {
      const outer = parseFrame(raw);
      if (outer.t === 'mux-ready' && outer.sid === 'barrier') barrier = true;
    }));
    const connector = new MachineRelayConnector({
      machineId: 'machine_realtime',
      relayUrl: relay.url,
      operatorToken: () => 'local-operator-token',
      ticketProvider: async () => ticket('machine_realtime'),
      reconnectBaseMs: 20,
      reconnectCapMs: 40,
    });

    connector.start();
    await waitFor(() => ready && barrier);

    expect(localWebSocket.connections).toEqual([]);
    expect(relayed).toBe(0);

    connector.stop('test-complete');
  });

  it('rotates the relay ticket before expiry without waiting for a socket drop', async () => {
    const relay = await startRelay((socket) => {
      socket.send(JSON.stringify({ t: 'devices', count: 0 }));
      socket.send(JSON.stringify({ t: 'mux-open', sid: 'refresh-stream' }));
    });
    let issued = 0;
    const connector = new MachineRelayConnector({
      machineId: 'machine_refresh',
      relayUrl: relay.url,
      operatorToken: () => 'local-operator-token',
      ticketProvider: async () => ticket('machine_refresh', ++issued),
      refreshIntervalMs: 40,
      expiryLeadMs: 0,
      reconnectBaseMs: 20,
      reconnectCapMs: 40,
    });

    connector.start();
    await waitFor(() => relay.connections.length >= 2);

    expect(issued).toBeGreaterThanOrEqual(2);
    expect(relay.connections[0]?.authorization).not.toBe(relay.connections[1]?.authorization);

    connector.stop('test-complete');
  });

  it('keeps the authenticated socket serving when a ticket rotation candidate fails', async () => {
    const authenticatedSockets: WebSocket[] = [];
    let rotationRejected = false;
    let muxReady = false;
    const relay = await startRelay((socket, index) => {
      if (index === 0) {
        authenticatedSockets.push(socket);
        socket.send(JSON.stringify({ t: 'devices', count: 0 }));
        socket.on('message', (raw) => {
          if (parseFrame(raw).t === 'mux-ready') muxReady = true;
        });
        return;
      }
      rotationRejected = true;
      socket.close(4409, 'rotation-ticket-rejected');
    });
    let issued = 0;
    const connector = new MachineRelayConnector({
      machineId: 'machine_rotation_failure',
      relayUrl: relay.url,
      operatorToken: () => 'local-operator-token',
      ticketProvider: async () => ticket('machine_rotation_failure', ++issued),
      refreshIntervalMs: 40,
      expiryLeadMs: 0,
      reconnectBaseMs: 1_000,
      reconnectCapMs: 1_000,
      keepAliveIntervalMs: 60_000,
    });

    connector.start();
    await waitFor(() => rotationRejected);
    const activeSocket = authenticatedSockets[0];
    activeSocket?.send(JSON.stringify({ t: 'mux-open', sid: 'still-active' }));
    await waitFor(() => muxReady);

    expect(relay.connections).toHaveLength(2);
    expect(activeSocket?.readyState).toBe(WebSocket.OPEN);

    connector.stop('test-complete');
  });

  it('defaults OFF and the supervisor opens no relay socket without operator opt-in', async () => {
    const relay = await startRelay();
    const dataDir = mkdtempSync(path.join(tmpdir(), 'o8-connect-off-'));
    temporaryDirectories.push(dataDir);
    const setting = readConnectAttachSetting({ env: {}, dataDir });
    const createConnector = vi.fn(() => new MachineRelayConnector({
      machineId: 'machine_off',
      relayUrl: relay.url,
      ticketProvider: async () => ticket('machine_off'),
    }));
    const listRegisteredMachines = vi.fn(async () => [{
      machineId: 'machine_off',
      installId: 'install_off',
      name: 'Off Mac',
      platform: 'darwin',
      appVersion: '0.1.0',
    }]);
    const supervisor = new MachineAttachSupervisor({
      reconcileIntervalMs: 20,
      readEnabled: () => setting.enabled,
      readCredential: () => 'account-token',
      readInstallId: () => 'install_off',
      listRegisteredMachines,
      createConnector,
    });

    supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(setting).toEqual({ enabled: false, source: 'default', locked: false });
    expect(listRegisteredMachines).not.toHaveBeenCalled();
    expect(createConnector).not.toHaveBeenCalled();
    expect(relay.connections).toHaveLength(0);

    supervisor.stop();
  });

  it('keeps an authenticated attach through a transient credential-read miss and recovery', async () => {
    let credential: string | null = 'account-token';
    const audit = vi.spyOn(console, 'log').mockImplementation(() => {});
    const relay = await startRelay((socket) => {
      socket.send(JSON.stringify({ t: 'devices', count: 0 }));
    });
    const supervisor = new MachineAttachSupervisor({
      reconcileIntervalMs: 60_000,
      readEnabled: () => true,
      readCredential: () => credential,
      readSignedOutAt: () => null,
      readInstallId: () => 'install_signed_in',
      listRegisteredMachines: async () => [{
        machineId: 'machine_signed_in',
        installId: 'install_signed_in',
        name: 'Signed-in Mac',
        platform: 'darwin',
        appVersion: '0.1.0',
      }],
      createConnector: (machine) => new MachineRelayConnector({
        machineId: machine.machineId,
        relayUrl: relay.url,
        ticketProvider: async () => ticket(machine.machineId),
      }),
    });

    supervisor.start();
    await waitFor(() => relay.connections.length === 1);
    credential = null;
    await supervisor.reconcile();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(relay.connections).toHaveLength(1);
    expect(relay.server.clients.size).toBe(1);
    expect(audit).toHaveBeenCalledWith(
      '[connect] credential-read miss (transient), keeping attach',
    );

    credential = 'account-token';
    await supervisor.reconcile();
    expect(relay.connections).toHaveLength(1);

    supervisor.stop();
  });

  it('detaches an authenticated attach when the explicit sign-out marker is durable', async () => {
    let signedOutAt: number | null = null;
    const audit = vi.spyOn(console, 'log').mockImplementation(() => {});
    const relay = await startRelay((socket) => {
      socket.send(JSON.stringify({ t: 'devices', count: 0 }));
    });
    const supervisor = new MachineAttachSupervisor({
      reconcileIntervalMs: 60_000,
      readEnabled: () => true,
      readCredential: () => 'account-token',
      readSignedOutAt: () => signedOutAt,
      readInstallId: () => 'install_durable_signout',
      listRegisteredMachines: async () => [{
        machineId: 'machine_durable_signout',
        installId: 'install_durable_signout',
        name: 'Durable Sign-out Mac',
        platform: 'darwin',
        appVersion: '0.1.0',
      }],
      createConnector: (machine) => new MachineRelayConnector({
        machineId: machine.machineId,
        relayUrl: relay.url,
        ticketProvider: async () => ticket(machine.machineId),
      }),
    });

    supervisor.start();
    await waitFor(() => relay.connections.length === 1);
    signedOutAt = Date.now();
    await supervisor.reconcile();
    await waitFor(() => relay.server.clients.size === 0);

    expect(audit).toHaveBeenCalledWith(
      '[connect] signed-out (durable), detaching',
    );
    supervisor.stop();
  });

  it('asks an enabled existing connector to resume on each supervisor tick', async () => {
    const start = vi.fn();
    const stop = vi.fn();
    const resume = vi.fn();
    const supervisor = new MachineAttachSupervisor({
      reconcileIntervalMs: 60_000,
      readEnabled: () => true,
      readCredential: () => 'account-token',
      readInstallId: () => 'install_resume',
      listRegisteredMachines: async () => [{
        machineId: 'machine_resume',
        installId: 'install_resume',
        name: 'Resume Mac',
        platform: 'darwin',
        appVersion: '0.1.0',
      }],
      createConnector: () => ({ start, stop, resume }),
    });

    supervisor.start();
    await waitFor(() => start.mock.calls.length === 1);
    await supervisor.reconcile();

    expect(resume).toHaveBeenCalledOnce();
    supervisor.stop();
  });
});
