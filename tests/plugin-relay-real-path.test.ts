import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { MachineRelayConnector } from '@/lib/connect/machine-attach';

// A relay-supplied plugin grant is plain claims the Mac cannot verify, so the
// connector refuses the stream before any local request or credential.
describe('machine connector plugin stream', () => {
  it('refuses a plugin stream with an unverifiable grant and replays nothing for it', async () => {
    let httpRequests = 0;
    const http = createServer((_incoming, outgoing) => { httpRequests++; outgoing.end('{}'); });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture failed');
    const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => relay.once('listening', resolve));
    const relayAddress = relay.address();
    if (!relayAddress || typeof relayAddress === 'string') throw new Error('WebSocket fixture failed');
    const frames: Array<Record<string, unknown>> = [];
    let peer: WebSocket | undefined;
    relay.on('connection', (socket) => {
      peer = socket;
      socket.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
      socket.send(JSON.stringify({ t: 'mux-open', sid: 'plugin-stream', surface: 'plugin', grant: { clientId: 'client-relay', scopes: ['o8:read'], expiresAt: Date.now() + 60_000 } }));
    });
    const waitFor = async (test: () => boolean) => {
      const end = Date.now() + 5000;
      while (!test()) {
        if (Date.now() >= end) throw new Error('plugin relay fixture timed out');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const connector = new MachineRelayConnector({
      machineId: 'machine-relay', relayUrl: `ws://127.0.0.1:${relayAddress.port}`,
      apiBase: `http://127.0.0.1:${address.port}`,
      operatorToken: () => 'fixture-operator-secret',
      ticketProvider: async () => ({ ticket: 'fixture-machine-ticket', expiresAt: new Date(Date.now() + 600_000).toISOString() }),
    });
    try {
      connector.start();
      await waitFor(() => frames.some((frame) => frame.t === 'mux-close'));
      expect(frames.find((frame) => frame.t === 'mux-close')).toEqual({ t: 'mux-close', sid: 'plugin-stream', code: 4403, reason: 'plugin_grant_unverifiable' });
      expect(frames.some((frame) => frame.t === 'mux-ready')).toBe(false);

      // A request on the refused stream reaches nothing; an ordinary stream opened
      // after it proves the connector processed the request first.
      peer!.send(JSON.stringify({ t: 'mux', sid: 'plugin-stream', seq: 0, payload: Buffer.from(JSON.stringify({
        t: 'http-req', rid: 'plugin-call', method: 'POST', path: '/api/plugins/mcp', headers: { 'content-type': 'application/json' }, bodyB64: '',
      })).toString('base64') }));
      peer!.send(JSON.stringify({ t: 'mux-open', sid: 'barrier' }));
      await waitFor(() => frames.some((frame) => frame.t === 'mux-ready' && frame.sid === 'barrier'));
      expect(httpRequests).toBe(0);
      expect(frames.some((frame) => frame.t === 'mux' && frame.sid === 'plugin-stream')).toBe(false);
    } finally {
      connector.stop('test-complete');
      for (const socket of relay.clients) socket.terminate();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });
});
