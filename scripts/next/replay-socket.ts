/** Owned loopback replay peer. Uses the production wire schema, without loading
 * ws-server's runtime discovery, provider readers, or app startup hooks. */
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';

type Frame = { channel: string; event: string; data: Record<string, unknown> };
export function attachReplaySocket(server: Server, token: string, requests: string[]): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const replay = JSON.parse(readFileSync('native/o8-next/fixtures/stream.replay.json', 'utf8')) as {
    cadenceMs: number; disconnectBefore: number; frames: Frame[]; initial: { sessionKey: string };
  };
  let reconnectFrom: number | null = null;
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // Never log the query string or credential.
    requests.push(`WS ${url.pathname}`);
    if (url.pathname !== '/ws' || url.searchParams.get('token') !== token) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', ws => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let subscribed = false;
    let cursor = reconnectFrom ?? 0;
    const reconnecting = reconnectFrom !== null; reconnectFrom = null;
    ws.send(JSON.stringify(replay.frames[cursor++]));
    ws.on('message', bytes => {
      const message = JSON.parse(bytes.toString()) as { type: string; subscriptions?: Array<{ stream: string; since?: number }> };
      requests.push(`WS ${message.type}`);
      if (message.type === 'ping') { ws.send(JSON.stringify({ channel: 'pong', event: 'pong', data: {} })); return; }
      // The stop pill's one-shot socket waits for this ack, as ws-server sends it.
      if (message.type === 'orchestrator-interrupt') {
        const { threadId, repoPath } = message as { threadId?: string; repoPath?: string };
        ws.send(JSON.stringify({ channel: 'orchestrator', event: 'interrupt-ack',
          data: { threadId, repoPath, state: 'accepted', interrupted: true, duplicate: false } }));
        return;
      }
      if (subscribed || message.type !== 'realtime-subscribe') { ws.close(1008); return; }
      const subscriptions = message.subscriptions;
      if (subscriptions?.length !== 1 || subscriptions[0].stream !== `session:${replay.initial.sessionKey}` || subscriptions[0].since !== undefined) {
        ws.close(1008); return;
      }
      subscribed = true;
      timer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN || cursor >= replay.frames.length) { clearInterval(timer); return; }
        ws.send(JSON.stringify(replay.frames[cursor++]));
        // One actual transport interruption per replay, after a valid update.
        if (!reconnecting && cursor === replay.disconnectBefore) { reconnectFrom = cursor; clearInterval(timer); ws.close(1012, 'fixture reconnect'); }
      }, replay.cadenceMs);
    });
    ws.on('close', () => clearInterval(timer));
    ws.on('error', () => clearInterval(timer));
  });
  return () => { for (const ws of wss.clients) ws.terminate(); wss.close(); };
}
