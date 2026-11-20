/** Starts the real o8d composer queue owner for a disposable data directory and
 * binds this process to it through the producer socket, as the desktop bridge does.
 * Used by the queue test fixture and the native shell's dev server. */
import * as childProcess from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { O8dProducer } from '../../src/lib/ws-server/o8d-producer';

// Fixture surfaces stub spawn to forbid runtime launches; keep the real one,
// captured when this module loads, for the owner daemon only.
const spawnOwner = childProcess.spawn;

export interface ComposerOwner {
  /** Environment for a child process that acts as the executor. */
  childEnvironment: Record<string, string>;
  suspend(): void;
  resume(): Promise<void>;
  restart(): Promise<void>;
  close(): Promise<void>;
}

/** The o8d that owns the queue: an explicit test binary, else the workspace build. */
export function composerOwnerBinary(): string {
  const binary = process.env.O8D_TEST_BINARY ?? resolve('crates/o8d/target/debug/o8d');
  if (!existsSync(binary)) {
    throw Error(`Composer queue owner missing at ${binary}. Build it with: cargo build --manifest-path crates/o8d/Cargo.toml --features experimental-session-reads --bin o8d`);
  }
  return binary;
}

export async function startComposerOwner(binary: string): Promise<ComposerOwner> {
  const { getDataDir } = await import('../../src/lib/data-dir-migration');
  const { getSqlite } = await import('../../src/lib/db');
  const { getOrCreateWsToken } = await import('../../src/lib/ws-auth');
  const { handleNativeHttp } = await import('../../src/lib/ws-server/native-http-routes');
  const { bindComposerOwnerProducer } = await import('../../src/lib/orchestrator/composer-owner-client');
  const { O8dProducer: Producer } = await import('../../src/lib/ws-server/o8d-producer');
  const data = getDataDir(); getSqlite();
  const token = getOrCreateWsToken(), key = randomUUID(), epoch = randomUUID();
  const directory = mkdtempSync('/tmp/o8-cq-suite-'); const socket = join(directory, 'p.sock');
  const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const publicPort = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const upstream: Server = createServer((request, response) => {
    void (async () => {
      if (request.url === '/internal/realtime') { request.resume(); response.writeHead(request.headers.authorization === `Bearer ${token}` ? 202 : 401).end(); return; }
      if (typeof request.headers['x-o8d-bridge'] !== 'string' || !request.headers['x-o8d-bridge'].startsWith(`${key}:`)) { response.writeHead(401).end(); return; }
      if (!await handleNativeHttp(request, response, publicPort, true, '127.0.0.1')) response.writeHead(404).end();
    })().catch(error => response.writeHead(500).end(String(error)));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;
  let daemon: ChildProcess | undefined, producer: O8dProducer | undefined, unbind: (() => void) | undefined;
  const stopDaemon = async () => {
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      const closed = once(daemon, 'exit'); daemon.kill(); const timer = setTimeout(() => daemon!.kill('SIGKILL'), 5000);
      await closed; clearTimeout(timer);
    }
  };
  const launch = async () => {
    rmSync(socket, { force: true });
    daemon = spawnOwner(binary, ['--experimental-ws', '--listen', `127.0.0.1:${publicPort}`, '--producer-socket', socket], {
      env: { ...process.env, O8_API_FRONT_DOOR: '1', O8D_NATIVE_OWNED: '1', O8D_BRIDGE_KEY: key,
        O8D_SESSION_DATA_DIR: data, O8D_SESSION_DB_PATH: process.env.CORTEX_IDE_DB_PATH ?? join(data, 'cortex-ide.db'),
        O8D_SERVER_VERSION: 'composer-queue-suite', O8_BOOT_ID: randomUUID(), O8_INSTANCE_ID: randomUUID(), WS_TOKEN: token },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let diagnostic = ''; daemon.stdout!.resume(); daemon.stderr!.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-8192); });
    const end = Date.now() + 10000;
    while (!existsSync(socket)) {
      if (daemon.exitCode !== null || Date.now() > end) throw Error(`Composer owner preflight failed: ${diagnostic}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const suspend = () => { unbind?.(); unbind = undefined; producer?.stop(); producer = undefined; };
  const resume = async () => {
    producer = new Producer(socket, key, `127.0.0.1:${upstreamPort}`, epoch, () => undefined);
    await producer.start();
    unbind = bindComposerOwnerProducer((method, params) => producer!.composerRequest(method, params));
  };
  await launch(); await resume();
  return {
    childEnvironment: { O8_WS_PORT: String(publicPort), O8_API_PORT: String(publicPort),
      O8D_PRODUCER_SOCKET: socket, O8D_BRIDGE_KEY: key, O8D_PRODUCER_UPSTREAM_PORT: String(upstreamPort), O8_COMPOSER_FIXTURE_EPOCH: epoch },
    suspend, resume,
    restart: async () => { suspend(); await stopDaemon(); await launch(); await resume(); },
    close: async () => {
      suspend(); await stopDaemon();
      if (upstream.listening) { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
