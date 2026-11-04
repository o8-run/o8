import { execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface HistorySnapshotData {
  sessionKey: string;
  entries: Array<{ id: string; role: string; text: string }>;
  replace?: boolean;
}

interface RealtimeFrame {
  channel?: string;
  event?: string;
  data?: {
    delivery?: string;
    stream?: string;
    events?: Array<{
      seq?: number;
      capturedSeq?: number;
      channel?: string;
      event?: string;
      data?: HistorySnapshotData;
    }>;
  };
}

interface HistoryResponseGate {
  started: Promise<void>;
  markStarted: () => void;
  released: Promise<void>;
  release: () => void;
}

const dataDir = mkdtempSync(join(tmpdir(), 'o8-realtime-history-wire-'));
const token = 'realtime-history-wire-token';
const historyReads = new Map<string, number>();
const historyVersions = new Map([
  ['worker-a', 1],
  ['worker-b', 1],
]);
const historyEntryCounts = new Map<string, number>();
const failingHistorySessions = new Set<string>();
const historyResponseDelays = new Map<string, number>();
const historyResponseGates = new Map<string, HistoryResponseGate>();
const activeHistoryReads = new Map<string, number>();
const maxActiveHistoryReads = new Map<string, number>();
const sockets = new Set<WebSocket>();
let apiServer: Server;
let wsProcess: ChildProcess;
let apiPort = 0;
let wsPort = 0;
let serverOutput = '';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('missing test port'));
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}. Server output: ${serverOutput.slice(-2_000)}`);
}

async function waitForHealth(): Promise<void> {
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${wsPort}/health`)).ok;
    } catch {
      return false;
    }
  }, 'ws-server health', 20_000);
}

async function connectClient() {
  const frames: RealtimeFrame[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
  sockets.add(socket);
  socket.on('message', (raw) => {
    frames.push(JSON.parse(String(raw)) as RealtimeFrame);
  });
  socket.on('close', () => sockets.delete(socket));
  await once(socket, 'open');
  return { socket, frames };
}

function subscribe(socket: WebSocket, sessionKeys: string[]) {
  socket.send(JSON.stringify({
    type: 'realtime-subscribe',
    subscriptions: sessionKeys.map((sessionKey) => ({ stream: `session:${sessionKey}` })),
  }));
}

function historySnapshots(frames: RealtimeFrame[]) {
  return frames.flatMap((frame) => (
    frame.channel === 'realtime' && frame.event === 'batch'
      ? (frame.data?.events ?? []).flatMap((event) => (
        event.channel === 'history' && event.event === 'history.snapshot' && event.data
          ? [{
            delivery: frame.data?.delivery,
            seq: event.seq,
            capturedSeq: event.capturedSeq,
            ...event.data,
          }]
          : []
      ))
      : []
  ));
}

function historyResponseGateKey(sessionKey: string, sinceId?: string) {
  return `${sessionKey}\x00${sinceId ?? ''}`;
}

function blockHistoryResponse(sessionKey: string, sinceId?: string): HistoryResponseGate {
  let markStarted = () => {};
  let release = () => {};
  const gate: HistoryResponseGate = {
    started: new Promise<void>((resolve) => { markStarted = resolve; }),
    markStarted: () => markStarted(),
    released: new Promise<void>((resolve) => { release = resolve; }),
    release: () => release(),
  };
  historyResponseGates.set(historyResponseGateKey(sessionKey, sinceId), gate);
  return gate;
}

function readCount(sessionKey: string) {
  return historyReads.get(sessionKey) ?? 0;
}

beforeAll(async () => {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'ws-token'), `${token}\n`, { mode: 0o600 });
  apiPort = await freePort();
  wsPort = await freePort();

  apiServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${apiPort}`);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));

    // Stateful WS messages await the API readiness probe before subscribing.
    if (url.pathname === '/api/panel/status') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ready: true }));
      return;
    }

    if (url.pathname === '/api/mobile/sync' && request.method === 'POST') {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
        history?: { sessionKey?: string; sinceId?: string; limit?: number };
      };
      const sessionKey = body.history?.sessionKey;
      if (sessionKey) {
        const active = (activeHistoryReads.get(sessionKey) ?? 0) + 1;
        activeHistoryReads.set(sessionKey, active);
        maxActiveHistoryReads.set(sessionKey, Math.max(maxActiveHistoryReads.get(sessionKey) ?? 0, active));
        const version = historyVersions.get(sessionKey) ?? 1;
        historyReads.set(sessionKey, readCount(sessionKey) + 1);
        const gateKey = historyResponseGateKey(sessionKey, body.history?.sinceId);
        const responseGate = historyResponseGates.get(gateKey);
        if (responseGate) {
          responseGate.markStarted();
          await responseGate.released;
          if (historyResponseGates.get(gateKey) === responseGate) {
            historyResponseGates.delete(gateKey);
          }
        }
        const delayMs = historyResponseDelays.get(sessionKey) ?? 0;
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (failingHistorySessions.has(sessionKey)) {
          response.writeHead(503);
          response.end();
        } else {
          const entryCount = historyEntryCounts.get(sessionKey) ?? 1;
          const allEntries = Array.from({ length: entryCount }, (_, index) => ({
            id: entryCount === 1 ? `${sessionKey}-${version}` : `${sessionKey}-entry-${index}`,
            role: 'assistant',
            text: entryCount === 1
              ? `${sessionKey} history version ${version}`
              : `${sessionKey} history entry ${index}`,
          }));
          const sinceIndex = body.history?.sinceId
            ? allEntries.findIndex((entry) => entry.id === body.history?.sinceId)
            : -1;
          const bounded = allEntries.slice(-(body.history?.limit ?? 18));
          const entries = body.history?.sinceId && sinceIndex >= 0
            ? allEntries.slice(sinceIndex + 1)
            : bounded;
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({
            history: {
              sessionKey,
              entries,
              ...(body.history?.sinceId && sinceIndex < 0 ? { replace: true } : {}),
            },
            serverTime: new Date().toISOString(),
          }));
        }
        activeHistoryReads.set(sessionKey, active - 1);
        return;
      }
    }

    if (url.pathname === '/api/setup/identity') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ configured: false }));
      return;
    }

    response.writeHead(404);
    response.end();
  });
  apiServer.listen(apiPort, '127.0.0.1');
  await once(apiServer, 'listening');

  wsProcess = execFile(process.execPath, [
    '--import=./scripts/register-server-only-stub.mjs',
    '--import=tsx',
    'src/ws-server.ts',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CORTEX_IDE_DATA_DIR: dataDir,
      O8_API_PORT: String(apiPort),
      O8_WS_PORT: String(wsPort),
      NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`,
    },
  });
  wsProcess.stdout?.on('data', (chunk) => { serverOutput += String(chunk); });
  wsProcess.stderr?.on('data', (chunk) => { serverOutput += String(chunk); });
  await waitForHealth();
}, 30_000);

afterAll(async () => {
  for (const socket of sockets) socket.close();
  if (wsProcess && wsProcess.exitCode === null) {
    wsProcess.kill('SIGTERM');
    await Promise.race([once(wsProcess, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  if (apiServer?.listening) await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

describe('realtime session history server path', () => {
  it('bootstraps, deduplicates shared polling, stops unsubscribed work, and reconnects', async () => {
    expect([...historyReads.values()].reduce((sum, count) => sum + count, 0)).toBe(0);

    historyResponseDelays.set('worker-a', 100);
    const primary = await connectClient();
    const duplicate = await connectClient();
    subscribe(primary.socket, ['worker-a', 'worker-b']);
    subscribe(duplicate.socket, ['worker-a']);

    await waitFor(() => {
      const primaryBootstraps = historySnapshots(primary.frames)
        .filter((snapshot) => snapshot.delivery === 'bootstrap');
      const duplicateBootstraps = historySnapshots(duplicate.frames)
        .filter((snapshot) => snapshot.delivery === 'bootstrap');
      return primaryBootstraps.some((snapshot) => snapshot.sessionKey === 'worker-a')
        && primaryBootstraps.some((snapshot) => snapshot.sessionKey === 'worker-b')
        && duplicateBootstraps.some((snapshot) => snapshot.sessionKey === 'worker-a');
    }, 'two nonempty bootstrap streams');
    historyResponseDelays.delete('worker-a');
    expect(readCount('worker-a')).toBe(1);
    expect(readCount('worker-b')).toBe(1);

    for (const snapshot of [
      ...historySnapshots(primary.frames),
      ...historySnapshots(duplicate.frames),
    ].filter((candidate) => candidate.delivery === 'bootstrap')) {
      expect(snapshot.entries).toHaveLength(1);
      expect(snapshot.replace).toBe(true);
    }

    const baselineA = readCount('worker-a');
    const baselineB = readCount('worker-b');
    await waitFor(
      () => readCount('worker-a') > baselineA && readCount('worker-b') > baselineB,
      'one shared safety refresh',
    );
    expect(readCount('worker-a') - baselineA).toBe(1);
    expect(readCount('worker-b') - baselineB).toBe(1);
    expect(historySnapshots(primary.frames).filter((snapshot) => snapshot.delivery === 'live')).toEqual([]);

    historyVersions.set('worker-a', 2);
    await waitFor(() => historySnapshots(primary.frames).some((snapshot) => (
      snapshot.delivery === 'live'
        && snapshot.sessionKey === 'worker-a'
        && snapshot.entries[0]?.id === 'worker-a-2'
    )), 'changed fingerprint broadcast');

    maxActiveHistoryReads.set('worker-a', 0);
    historyResponseDelays.set('worker-a', 1_250);
    failingHistorySessions.add('worker-a');
    const failureBaseline = readCount('worker-a');
    await waitFor(() => readCount('worker-a') >= failureBaseline + 2, 'two failed guarded refreshes');
    await waitFor(() => (activeHistoryReads.get('worker-a') ?? 0) === 0, 'failed refresh completion');
    expect(maxActiveHistoryReads.get('worker-a')).toBe(1);
    expect(serverOutput.match(/realtime session history unavailable: worker-a/g)).toHaveLength(1);

    failingHistorySessions.delete('worker-a');
    historyResponseDelays.delete('worker-a');
    historyVersions.set('worker-a', 3);
    await waitFor(() => historySnapshots(primary.frames).some((snapshot) => (
      snapshot.delivery === 'live'
        && snapshot.sessionKey === 'worker-a'
        && snapshot.entries[0]?.id === 'worker-a-3'
    )), 'history bridge recovery', 12_000);
    expect(serverOutput).toContain('realtime session history recovered: worker-a');

    subscribe(primary.socket, ['worker-a']);
    primary.socket.send(JSON.stringify({ type: 'ping' }));
    await waitFor(
      () => primary.frames.some((frame) => frame.channel === 'pong'),
      'unsubscribe acknowledgement barrier',
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const unsubscribedBaselineA = readCount('worker-a');
    const unsubscribedBaselineB = readCount('worker-b');
    await waitFor(() => readCount('worker-a') > unsubscribedBaselineA, 'remaining subscribed refresh');
    expect(readCount('worker-b')).toBe(unsubscribedBaselineB);

    const primaryClosed = once(primary.socket, 'close');
    const duplicateClosed = once(duplicate.socket, 'close');
    primary.socket.close();
    duplicate.socket.close();
    await Promise.all([primaryClosed, duplicateClosed]);

    const reconnected = await connectClient();
    subscribe(reconnected.socket, ['worker-a', 'worker-b']);
    await waitFor(() => {
      const bootstraps = historySnapshots(reconnected.frames)
        .filter((snapshot) => snapshot.delivery === 'bootstrap');
      return bootstraps.some((snapshot) => snapshot.sessionKey === 'worker-a')
        && bootstraps.some((snapshot) => snapshot.sessionKey === 'worker-b');
    }, 'reconnect bootstrap');
    const reconnectBootstraps = historySnapshots(reconnected.frames)
      .filter((snapshot) => snapshot.delivery === 'bootstrap');
    expect(reconnectBootstraps).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionKey: 'worker-a', replace: true }),
      expect.objectContaining({ sessionKey: 'worker-b', replace: true }),
    ]));

    historyEntryCounts.set('worker-long', 75);
    subscribe(reconnected.socket, ['worker-a', 'worker-b', 'worker-long']);
    await waitFor(() => historySnapshots(reconnected.frames).some((snapshot) => (
      snapshot.delivery === 'bootstrap'
        && snapshot.sessionKey === 'worker-long'
        && snapshot.entries.length === 75
    )), 'full retained long-history bootstrap');
    const longBaseline = historySnapshots(reconnected.frames)
      .filter((snapshot) => snapshot.sessionKey === 'worker-long').length;
    await waitFor(() => readCount('worker-long') >= 2, 'long-history delta poll');
    expect(historySnapshots(reconnected.frames)
      .filter((snapshot) => snapshot.sessionKey === 'worker-long')).toHaveLength(longBaseline);
  }, 20_000);

  it('checkpoints a delayed bootstrap after a live delta delivered during its join', async () => {
    const sessionKey = 'worker-bootstrap-race';
    historyVersions.set(sessionKey, 1);
    const incumbent = await connectClient();
    const newcomer = await connectClient();
    let deltaGate: HistoryResponseGate | null = null;
    let bootstrapGate: HistoryResponseGate | null = null;

    try {
      subscribe(incumbent.socket, [sessionKey]);
      await waitFor(() => historySnapshots(incumbent.frames).some((snapshot) => (
        snapshot.delivery === 'bootstrap'
          && snapshot.sessionKey === sessionKey
          && snapshot.entries[0]?.id === `${sessionKey}-1`
      )), 'incumbent race-session bootstrap');

      deltaGate = blockHistoryResponse(sessionKey, `${sessionKey}-1`);
      bootstrapGate = blockHistoryResponse(sessionKey);
      historyVersions.set(sessionKey, 2);
      await deltaGate.started;

      subscribe(newcomer.socket, [sessionKey]);
      newcomer.socket.send(JSON.stringify({ type: 'ping' }));
      await waitFor(
        () => newcomer.frames.some((frame) => frame.channel === 'pong'),
        'newcomer subscription acknowledgement barrier',
      );

      deltaGate.release();
      await bootstrapGate.started;
      await waitFor(() => historySnapshots(newcomer.frames).some((snapshot) => (
        snapshot.delivery === 'live'
          && snapshot.sessionKey === sessionKey
          && snapshot.entries[0]?.id === `${sessionKey}-2`
      )), 'newcomer live delta before bootstrap');
      expect(historySnapshots(newcomer.frames).some((snapshot) => (
        snapshot.delivery === 'bootstrap' && snapshot.sessionKey === sessionKey
      ))).toBe(false);

      bootstrapGate.release();
      await waitFor(() => historySnapshots(newcomer.frames).some((snapshot) => (
        snapshot.delivery === 'bootstrap' && snapshot.sessionKey === sessionKey
      )), 'newcomer delayed bootstrap');

      const newcomerSnapshots = historySnapshots(newcomer.frames)
        .filter((snapshot) => snapshot.sessionKey === sessionKey);
      const liveIndex = newcomerSnapshots.findIndex((snapshot) => snapshot.delivery === 'live');
      const bootstrapIndex = newcomerSnapshots.findIndex((snapshot) => snapshot.delivery === 'bootstrap');
      const live = newcomerSnapshots[liveIndex];
      const bootstrap = newcomerSnapshots[bootstrapIndex];

      expect(liveIndex).toBeGreaterThanOrEqual(0);
      expect(bootstrapIndex).toBeGreaterThan(liveIndex);
      expect(live?.seq).toEqual(expect.any(Number));
      expect(bootstrap).toMatchObject({
        replace: true,
        entries: [expect.objectContaining({ id: `${sessionKey}-2` })],
        capturedSeq: expect.any(Number),
      });
      expect(bootstrap!.capturedSeq!).toBeGreaterThanOrEqual(live!.seq!);
    } finally {
      deltaGate?.release();
      bootstrapGate?.release();
      incumbent.socket.close();
      newcomer.socket.close();
    }
  }, 15_000);
});
