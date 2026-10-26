/** Replay peer for the existing global and session wire schemas. */
import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';

export function attachSidebarSocket(server: Server, token: string, requests: string[]) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/ws' || url.searchParams.get('token') !== token) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.send(JSON.stringify({ channel: 'system', event: 'connected', data: { bootId: 'sidebar-fixture' } }));
      ws.on('message', bytes => {
        const message = JSON.parse(String(bytes)) as { type: string; subscriptions?: Array<{ stream: string }> };
        requests.push(`WS ${message.type}`);
        if (message.type === 'ping') return;
        const stream = message.subscriptions?.[0]?.stream;
        if (message.type !== 'realtime-subscribe' || message.subscriptions?.length !== 1 || !stream) {
          ws.close(1008); return;
        }
        // Production initial global snapshots contain only the recent tail.
        // They must never replace the native list's full HTTP bootstrap.
        if (stream === 'global') void import('../../src/lib/mobile/orchestrator-thread-history').then(({ listMobileOrchestratorThreads }) => {
          ws.send(JSON.stringify({ channel: 'orchestrator-threads', event: 'snapshot', data: { threads: listMobileOrchestratorThreads() } }));
        });
      });
      ws.on('error', () => {});
    });
  });
  return {
    changed: async (id: string) => {
      const { listMobileOrchestratorThreads } = await import('../../src/lib/mobile/orchestrator-thread-history');
      const thread = listMobileOrchestratorThreads({ limit: 3000 }).find(row => row.id === id);
      for (const ws of wss.clients) ws.send(JSON.stringify(thread
        ? { channel: 'orchestrator-threads', event: 'upsert', data: { thread } }
        : { channel: 'orchestrator-threads', event: 'snapshot', data: { threads: [] } }));
    },
    close: () => { for (const ws of wss.clients) ws.terminate(); wss.close(); },
  };
}
