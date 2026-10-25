import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';
import { beforeAll, expect, it } from 'vitest';

const binary = process.env.O8D_TEST_BINARY ?? join(process.cwd(), 'crates/o8d/target/debug/o8d');
const credential = 'input-drain-fixture-credential';
const run = it.runIf(process.platform !== 'win32');

beforeAll(async () => {
  if (!process.env.O8D_TEST_BINARY) await promisify(execFile)('cargo', ['build', '--locked',
    '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-ws']);
}, 120_000);

run.each([
  { upstreamExits: false, plaintext: true, withheld: false, policy: 0 },
  { upstreamExits: true, plaintext: true, withheld: false, policy: 0 },
  { upstreamExits: true, plaintext: false, withheld: false, policy: 0 },
  { upstreamExits: false, plaintext: true, withheld: true, policy: 0 },
  { upstreamExits: false, plaintext: false, withheld: false, policy: 4403 },
  { upstreamExits: false, plaintext: false, withheld: false, policy: 1008 },
])('accounts for queued inputs (exits=$upstreamExits plaintext=$plaintext withheld=$withheld policy=$policy)', async ({ upstreamExits, plaintext, withheld, policy }) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-input-drain-')));
  const receipt = join(directory, 'received.json');
  const delivered: string[] = [];
  writeFileSync(receipt, '[]');
  const upstream = createServer(async (incoming) => {
    // An accepted incomplete HTTP request must retain the existing 5 s bound.
    try { for await (const _chunk of incoming) { /* Wait for the unfinished body. */ } }
    catch { /* The drain deadline intentionally aborts this request. */ }
  });
  const peers = new WebSocketServer({ server: upstream, autoPong: !withheld && !policy,
    verifyClient: ({ req }: { req: IncomingMessage }) => req.headers['x-o8d-bridge'] === credential });
  let backend: WebSocket | undefined;
  let firstInput!: () => void;
  const receivedInput = new Promise<void>((resolve) => { firstInput = resolve; });
  peers.on('connection', (socket) => {
    backend = socket;
    if (plaintext) socket.send(JSON.stringify({ __o8d: { capabilities: [], subscriptions: [] } }));
    socket.send(JSON.stringify({ channel: 'control', event: 'fixture-ready' }));
    socket.on('message', (raw) => {
      const message = withheld ? null : JSON.parse(String(raw));
      if (!withheld && message.type !== 'terminal-input') return;
      delivered.push(withheld ? String(delivered.length) : message.requestId);
      writeFileSync(receipt, JSON.stringify(delivered));
      firstInput();
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture address');
  const child = spawn(binary, ['--experimental-ws', '--listen', '127.0.0.1:0',
    '--app-upstream', `127.0.0.1:${address.port}`], {
    env: { ...process.env, O8D_BRIDGE_KEY: credential, O8D_EPOCH: 'input-drain-fixture' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const exit = once(child, 'exit');
  const [line] = await once(lines, 'line');
  const endpoint = `http://${JSON.parse(line).listening}`;
  const sender = new WebSocket(endpoint.replace('http:', 'ws:'));
  const failed: string[] = [];
  const applicationFrames: unknown[] = [];
  let upstreamReady!: () => void;
  const greeted = new Promise<void>((resolve) => { upstreamReady = resolve; });
  sender.on('message', (raw) => {
    const frame = JSON.parse(String(raw));
    applicationFrames.push(frame);
    if (frame.event === 'fixture-ready') upstreamReady();
    if (frame.data?.code === 'input_not_delivered') {
      failed.push(frame.data.requestId);
    }
  });
  sender.on('error', () => {});
  let policyDuringDrain = false;
  sender.on('ping', (data) => {
    if (policy && data.toString().startsWith('o8-drain:')) {
      policyDuringDrain = true;
      backend!.close(policy, 'fixture policy refusal');
    }
  });
  const ingress = request(endpoint, { method: 'POST', headers: { Expect: '100-continue', 'Content-Length': '100' } });
  // Expect can flush headers during construction; register before any await.
  const continued = once(ingress, 'continue');
  ingress.on('error', () => {});
  let paused = false;
  try {
    await once(sender, 'open');
    await greeted;
    const ready = once(sender, 'pong');
    sender.ping('ready');
    await ready;
    ingress.flushHeaders();
    await continued;
    process.kill(child.pid!, 'SIGSTOP');
    paused = true;
    const pauseDeadline = performance.now() + 2_000;
    for (;;) {
      const state = await promisify(execFile)('ps', ['-o', 'state=', '-p', String(child.pid)]);
      if (state.stdout.trim().startsWith('T')) break;
      if (performance.now() > pauseDeadline) throw new Error('fixture process did not pause');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (upstreamExits) backend!.terminate();
    await Promise.all(Array.from({ length: 500 }, (_, index) => new Promise<void>((resolve, reject) => {
      const message = withheld ? '' : JSON.stringify(plaintext
        ? { type: 'terminal-input', sessionName: 'fixture-terminal', requestId: String(index), data: `input-${index}` }
        : { e2ee: 1, n: `fixture-nonce-${index}`, c: 'opaque-fixture-ciphertext' });
      sender.send(message, (error) => error ? reject(error) : resolve());
    })));
    const closed = once(sender, 'close');
    let started: number;
    if (withheld) {
      process.kill(child.pid!, 'SIGCONT');
      paused = false;
      await receivedInput;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(delivered.length).toBeGreaterThan(0);
      expect(delivered.length).toBeLessThanOrEqual(256);
      started = performance.now();
      child.stdin.end();
    } else {
      // EOF must already be queued when the paused child resumes.
      child.stdin.end();
      started = performance.now();
      process.kill(child.pid!, 'SIGCONT');
      paused = false;
    }
    await exit;
    const elapsed = performance.now() - started;
    const [code, reason] = await closed;
    const received = JSON.parse(readFileSync(receipt, 'utf8')) as string[];
    const accounted = [...received, ...failed];
    process.stdout.write(`INPUT_DRAIN plaintext=${plaintext} withheld=${withheld} policy=${policy} delivered=${received.length} failed=${failed.length} exitMs=${elapsed.toFixed(1)}\n`);
    if (!plaintext) {
      expect(failed).toHaveLength(0);
      expect(applicationFrames).toEqual([{ channel: 'control', event: 'fixture-ready' }]);
      expect(code).toBe(policy || 1011);
      if (policy) {
        expect(policyDuringDrain).toBe(true);
        expect(String(reason)).toBe('fixture policy refusal');
      } else { expect(String(reason)).toContain('unconfirmed'); }
    } else if (withheld) {
      expect(failed).toHaveLength(500);
    } else {
      expect(accounted).toHaveLength(500);
      expect(new Set(accounted).size).toBe(500);
      expect(accounted.sort((left, right) => Number(left) - Number(right))).toEqual(Array.from({ length: 500 }, (_, index) => String(index)));
      expect(received).toHaveLength(upstreamExits ? 0 : 500);
      expect(failed).toHaveLength(upstreamExits ? 500 : 0);
    }
    expect(elapsed).toBeGreaterThanOrEqual(4_800);
    expect(elapsed).toBeLessThan(6_000);
    expect(child.exitCode).toBe(0);
  } finally {
    if (paused) process.kill(child.pid!, 'SIGCONT');
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
    sender.terminate();
    ingress.destroy();
    for (const peer of peers.clients) peer.terminate();
    await new Promise<void>((resolve) => peers.close(() => resolve()));
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    lines.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
