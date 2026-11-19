import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { beforeAll, afterAll } from 'vitest';
import type { O8dProducer } from '@/lib/ws-server/o8d-producer';

export const COMPOSER_BINARY_SKIP = 'SKIP composer owner proofs: set O8D_TEST_BINARY to an already-built compatible o8d. No build is started.';
let suspend: (() => void) | undefined;
let resume: (() => Promise<void>) | undefined;
let restart: (() => Promise<void>) | undefined;
let childEnvironment: Record<string, string> | undefined;
export async function restartComposerOwnerFixture(): Promise<void> {
  if (!restart) throw Error('A native composer owner fixture is required.');
  await restart();
}
/** Child fixtures model the executor; the parent becomes a classic read/relay client. */
export async function withFixtureComposerExecutor<T>(run: () => Promise<T>): Promise<T> {
  if (!suspend || !resume) throw Error('A native composer owner fixture is required.');
  suspend();
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(childEnvironment ?? {})) { previous.set(name, process.env[name]); process.env[name] = value; }
  try { return await run(); } finally {
    for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await resume();
  }
}
export async function recoverComposerOwner(): Promise<void> {
  await withFixtureComposerExecutor(() => promisify(execFile)(process.execPath,
    ['--import=tsx', '--import=./scripts/register-server-only-stub.mjs', resolve('tests/fixtures/composer-queue-recover.mts')],
    { cwd: process.cwd(), env: process.env, timeout: 15000 }).then(() => undefined));
}
/** Legacy test assertions now call the real daemon, never a substitute TS row writer. */
export function installComposerOwnerFixture(): void {
  let daemon: ChildProcess | undefined, producer: O8dProducer | undefined, upstream: Server | undefined;
  let directory: string | undefined, unbind: (() => void) | undefined;
  beforeAll(async () => {
    const binary = process.env.O8D_TEST_BINARY;
    if (!binary) { console.info('Native queue test transport requires O8D_TEST_BINARY; no implicit build or TS fallback.'); return; }
    const { getDataDir } = await import('@/lib/data-dir-migration');
    const { getSqlite } = await import('@/lib/db');
    const { getOrCreateWsToken } = await import('@/lib/ws-auth');
    const { handleNativeHttp } = await import('@/lib/ws-server/native-http-routes');
    const { bindComposerOwnerProducer } = await import('@/lib/orchestrator/composer-owner-client');
    const { O8dProducer: Producer } = await import('@/lib/ws-server/o8d-producer');
    const data = getDataDir(); getSqlite();
    const token = getOrCreateWsToken(), key = randomUUID(), epoch = randomUUID();
    directory = mkdtempSync('/tmp/o8-cq-suite-'); const socket = join(directory, 'p.sock');
    const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const publicPort = (reservation.address() as { port: number }).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    upstream = createServer((request, response) => {
      void (async () => {
        if (request.url === '/internal/realtime') { request.resume(); response.writeHead(request.headers.authorization === `Bearer ${token}` ? 202 : 401).end(); return; }
        if (typeof request.headers['x-o8d-bridge'] !== 'string' || !request.headers['x-o8d-bridge'].startsWith(`${key}:`)) { response.writeHead(401).end(); return; }
        if (!await handleNativeHttp(request, response, publicPort, true, '127.0.0.1')) response.writeHead(404).end();
      })().catch(error => response.writeHead(500).end(String(error)));
    });
    await new Promise<void>(resolve => upstream!.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;
    childEnvironment = { O8_WS_PORT: String(publicPort), O8_API_PORT: String(publicPort),
      O8D_PRODUCER_SOCKET: socket, O8D_BRIDGE_KEY: key, O8D_PRODUCER_UPSTREAM_PORT: String(upstreamPort), O8_COMPOSER_FIXTURE_EPOCH: epoch };
    const stopDaemon = async () => {
      if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
        const closed = once(daemon, 'exit'); daemon.kill(); const timer = setTimeout(() => daemon!.kill('SIGKILL'), 5000);
        await closed; clearTimeout(timer);
      }
    };
    const launch = async () => {
      rmSync(socket, { force: true });
      daemon = spawn(binary, ['--experimental-ws', '--listen', `127.0.0.1:${publicPort}`, '--producer-socket', socket], {
      env: { ...process.env, O8_API_FRONT_DOOR: '1', O8D_NATIVE_OWNED: '1', O8D_BRIDGE_KEY: key,
        O8D_SESSION_DATA_DIR: data, O8D_SESSION_DB_PATH: process.env.CORTEX_IDE_DB_PATH ?? join(data, 'cortex-ide.db'),
        O8D_SERVER_VERSION: 'composer-queue-suite', O8_BOOT_ID: randomUUID(), O8_INSTANCE_ID: randomUUID(), WS_TOKEN: token },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let diagnostic = ''; daemon.stdout!.resume(); daemon.stderr!.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-8192); });
    const end = Date.now() + 10000;
    while (!existsSync(socket)) {
      if (daemon!.exitCode !== null || Date.now() > end) throw Error(`Composer owner preflight failed: ${diagnostic}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    };
    await launch();
    suspend = () => { unbind?.(); unbind = undefined; producer?.stop(); producer = undefined; };
    resume = async () => {
      producer = new Producer(socket, key, `127.0.0.1:${upstreamPort}`, epoch, () => undefined);
      await producer.start();
      unbind = bindComposerOwnerProducer((method, params) => producer!.composerRequest(method, params));
    };
    await resume();
    restart = async () => { suspend!(); await stopDaemon(); await launch(); await resume!(); };
  }, 30000);
  afterAll(async () => {
    suspend?.(); suspend = undefined; resume = undefined; restart = undefined; childEnvironment = undefined;
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      const closed = once(daemon, 'exit'); daemon.kill(); const timer = setTimeout(() => daemon!.kill('SIGKILL'), 5000);
      await closed; clearTimeout(timer);
    }
    if (upstream?.listening) { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream!.close(() => resolve())); }
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
}
