import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';

export type Frame = { channel?: string; event?: string; data?: Record<string, unknown> };
export type MutationEvent = { seq: number; data?: { mutation?: { mutationId?: string; note?: string } } };

/** Real app client, with no production-only or helper-only dispatch shortcuts. */
export async function cutoverClient(url: string, token: string, resume?: { since: number; epoch: string }) {
  const endpoint = new URL(url);
  endpoint.searchParams.set('token', token);
  const socket = new WebSocket(endpoint);
  const frames: Frame[] = [];
  socket.on('message', (raw) => frames.push(JSON.parse(String(raw))));
  const wait = async (predicate: (frame: Frame) => boolean, timeoutMs = 5_000) => {
    const deadline = performance.now() + timeoutMs;
    while (!frames.some(predicate)) {
      if (performance.now() > deadline) throw new Error('cutover client timed out');
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return frames.find(predicate)!;
  };
  await once(socket, 'open');
  const connected = await wait((frame) => frame.event === 'connected');
  socket.send(JSON.stringify({ type: 'realtime-negotiate', protocol: { min: 1, max: 1 },
    appVersion: '1.0.0', clientKind: 'test', capabilities: [] }));
  const welcome = await wait((frame) => frame.event === 'welcome');
  const epoch = String(welcome.data?.epoch);
  const since = Number(connected.data?.realtimeSeq);
  socket.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions: [
    { stream: 'global', since: resume?.since ?? since, epoch: resume?.epoch ?? epoch },
  ] }));
  socket.send(JSON.stringify({ type: 'ping' }));
  // The existing TS policy deliberately drops pongs behind durable replay.
  const ping = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
  }, 50);
  try { await wait((frame) => frame.channel === 'pong'); }
  finally { clearInterval(ping); }
  const events = () => frames.flatMap((frame) => (frame.data?.events ?? []) as MutationEvent[]);
  return {
    socket, frames, wait, epoch, since, events,
    delivered: (id: string) => new Promise<void>((resolve, reject) => {
      const matches = (frame: Frame) => (frame.data?.events as MutationEvent[] | undefined)
        ?.some((event) => event.data?.mutation?.mutationId === id) ?? false;
      if (frames.some(matches)) { resolve(); return; }
      const timer = setTimeout(() => {
        socket.off('message', receive);
        reject(new Error('cutover client timed out'));
      }, 5_000);
      function receive(raw: WebSocket.RawData) {
        if (!matches(JSON.parse(String(raw)) as Frame)) return;
        clearTimeout(timer);
        socket.off('message', receive);
        resolve();
      }
      socket.on('message', receive);
    }),
    close: async () => {
      if (socket.readyState === WebSocket.CLOSED) return;
      const closed = once(socket, 'close');
      socket.close(1000, 'fixture complete');
      await closed;
    },
  };
}

export async function publishCutoverMutation(server: { url: string; token: string }, id: string, size = 1024) {
  const response = await fetch(new URL('/internal/realtime', server.url.replace(/^ws/, 'http')), {
    method: 'POST', headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'mutation', mutation: { mutationId: id, source: 'server',
      action: 'cutover-fixture', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z', note: 'x'.repeat(size) } }),
  });
  await response.arrayBuffer();
  if (response.status !== 202) throw new Error('cutover producer rejected');
}

export async function cutoverHealth(server: { url: string }) {
  return fetch(new URL('/health', server.url.replace(/^ws/, 'http'))).then((response) => response.json()) as Promise<{
    delivery?: { transport: string; pid: number | null; generation: number };
  }>;
}

export async function waitForTransport(server: { url: string }, transport: string, generation = 0) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const health = await cutoverHealth(server);
      if (health.delivery?.transport === transport && health.delivery.generation >= generation) return health.delivery;
    } catch { /* Listener handoff has a short reconnect window. */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('cutover transport timed out');
}
