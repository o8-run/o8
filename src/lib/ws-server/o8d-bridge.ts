import { apiFrontDoorEnabled, nativeHttpTransportEnabled } from '@/lib/ws-server/api-front-door-config';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { isIP } from 'node:net';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { access, constants } from 'node:fs/promises';
import { statSync } from 'node:fs';
import packageJson from '../../../package.json';
import { resolvePortInfo } from '@/lib/panel/api-port';
import { getDataDir } from '@/lib/data-dir-migration';
import { spawn, type ChildProcess } from '@/lib/providers/child-process';
import { childEnvironment } from '@/lib/providers/spawn-environment';
import type { RealtimeEventEnvelope } from '@/lib/realtime/types';
import { localMachineName } from '@/lib/mobile/machine-name';
import { nativeSessionReadsEnabled } from './native-session-reads';
import { o8dBinaryPath } from './o8d-binary';
import { O8dProducer } from './o8d-producer';

const PIPE_LIMIT = 1024 * 1024;

/** Read-only authority snapshot; changed resolver cache keys defer to TS. */
function startupPortInfo(): string | undefined {
  try {
    const stamp = (name: string): string | null => {
      try { return statSync(join(getDataDir(), name), { bigint: true }).mtimeNs.toString(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    };
    const apiMtimeNs = stamp('api-port');
    const wsMtimeNs = stamp('ws-port');
    // Reuse the actual TS cache, including its intentional ws-port asymmetry.
    const info = resolvePortInfo();
    if (stamp('api-port') !== apiMtimeNs || stamp('ws-port') !== wsMtimeNs) return undefined;
    return JSON.stringify({ ...info, serverVersion: packageJson.version, apiMtimeNs, wsMtimeNs, apiFrontDoor: apiFrontDoorEnabled() });
  } catch { return undefined; }
}

/** TS owns authentication, checkpoints and commands; Rust owns the public socket. */
export class O8dBridge {
  private readonly key: string;
  private readonly producerSocket: string | undefined;
  private producer: O8dProducer | null = null;
  private child: ChildProcess | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private retryDelayMs = 2_000;
  private binary = '';

  private upstream = '';
  private generation = 0;
  private readonly fallback: Server;
  private transport: 'typescript' | 'o8d' = 'typescript';

  constructor(
    private readonly server: Server,
    private readonly port: number,
    private readonly epoch: string,
    /** Public bind host — loopback unless the operator opted in via O8_LAN_ACCESS. */
    private readonly host: string = '127.0.0.1',
    /** A takeover must never recover by evicting an existing API listener. */
    private readonly rejectPortConflicts = false,
  ) {
    this.producerSocket = apiFrontDoorEnabled() ? process.env.O8D_PRODUCER_SOCKET : undefined;
    if (this.producerSocket && !process.env.O8D_BRIDGE_KEY) throw new Error('Launcher producer credential unavailable');
    this.key = this.producerSocket ? process.env.O8D_BRIDGE_KEY! : randomUUID();
    this.fallback = createServer((req, res) => server.emit('request', req, res));
    this.fallback.on('upgrade', (req, socket, head) => server.emit('upgrade', req, socket, head));
    // A transient bind conflict must leave recovery enabled.
    this.fallback.on('error', (error: NodeJS.ErrnoException) => {
      if (this.rejectPortConflicts && error.code === 'EADDRINUSE') {
        this.stop(); this.server.emit('error', error); return;
      }
      this.scheduleRetry();
    });
  }

  get status() {
    if (this.producer) return this.producer.status;
    return { transport: this.transport, pid: this.child?.pid ?? null, generation: this.generation };
  }

  /** True when o8d sent this request: only Rust holds the per-process key. */
  bridged(req: IncomingMessage): boolean {
    const supplied = req.headers['x-o8d-bridge'];
    const expected = this.producerSocket ? `${this.key}:${this.epoch}` : this.key;
    if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected)) return false;
    return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  }

  /** Headers from the public client are replaced by Rust, never trusted verbatim. */
  peer(req: IncomingMessage): string | null {
    if (!this.bridged(req)) return null;
    const peer = req.headers['x-o8d-peer'];
    return typeof peer === 'string' && isIP(peer) ? peer : null;
  }

  /**
   * The caller's address: o8d's attested peer on the private upstream, the
   * socket itself on the fallback listener, and nothing on any other socket.
   */
  clientAddress(req: IncomingMessage): string | null {
    const upstream = this.server.address();
    const fallback = this.fallback.address();
    if (upstream && typeof upstream !== 'string' && req.socket.localPort === upstream.port) return this.peer(req);
    if (fallback && typeof fallback !== 'string' && req.socket.localPort === fallback.port) return req.socket.remoteAddress ?? null;
    return null;
  }

  allowsUpgrade(req: IncomingMessage): boolean {
    // An HTTP stamp never authorizes a WS session that o8d did not mediate.
    if (req.headers['x-o8d-relay'] !== undefined) return false;
    const address = this.server.address();
    return !address || typeof address === 'string' || req.socket.localPort !== address.port || this.peer(req) !== null;
  }

  async start() {
    if (!this.producerSocket) this.binary = o8dBinaryPath();
    const producerPort = this.producerSocket ? Number(process.env.O8D_PRODUCER_UPSTREAM_PORT) : 0;
    if (this.producerSocket && (!Number.isInteger(producerPort) || producerPort <= 0 || producerPort > 65535 || producerPort === this.port)) throw new Error('Private producer port unavailable');
    await new Promise<void>((resolve) => this.server.listen(producerPort, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('o8d upstream unavailable');
    this.upstream = `127.0.0.1:${address.port}`;
    if (this.producerSocket) {
      this.producer = new O8dProducer(this.producerSocket, this.key, this.upstream, this.epoch, startupPortInfo);
      await this.producer.start();
    } else await this.launch();
  }

  publish(events: RealtimeEventEnvelope[]) {
    if (this.producer) { this.producer.publish(events); return; }
    const child = this.child;
    if (this.transport !== 'o8d' || !child?.stdin?.writable) return;
    const line = `${JSON.stringify(events)}\n`;
    // Never build an unbounded Node pipe queue. Reconnecting clients resume from
    // the TS replay log, whose epoch and sequence survive a Rust process exit.
    if (Buffer.byteLength(line) + child.stdin.writableLength > PIPE_LIMIT) {
      child.stdin.end();
      return;
    }
    child.stdin.write(line);
  }

  private scheduleRetry() {
    if (this.stopped) return;
    if (this.retry) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(delay * 2, 60_000);
    this.retry = setTimeout(() => { this.retry = null; void this.launch(); }, delay);
  }

  private resumeFallback() {
    this.transport = 'typescript';
    if (!this.stopped && !this.fallback.listening) this.fallback.listen(this.port, this.host);
    this.scheduleRetry();
  }

  private async launch() {
    if (this.stopped) return;
    const binary = this.binary;
    // A missing daemon must not interrupt requests on the fallback listener.
    try { await access(binary, constants.X_OK); } catch {
      this.resumeFallback();
      return;
    }
    if (this.stopped) return;
    if (this.fallback.listening) this.fallback.close();
    let child: ChildProcess;
    try {
      child = spawn(binary, ['--experimental-ws', '--listen', `${this.host}:${this.port}`,
        '--app-upstream', this.upstream], {
        env: childEnvironment({ inherit: false, env: {
          O8D_BRIDGE_KEY: this.key, O8D_EPOCH: this.epoch,
          O8_API_FRONT_DOOR: apiFrontDoorEnabled() ? '1' : undefined,
          O8D_SERVER_VERSION: packageJson.version, O8D_STARTUP_PORT_INFO: startupPortInfo(),
          O8_INSTANCE_ID: process.env.O8_INSTANCE_ID, O8_BOOT_ID: process.env.O8_BOOT_ID,
          O8D_NATIVE_OWNED: nativeHttpTransportEnabled() ? '1' : undefined,
          O8D_NATIVE_SESSION_READS: nativeHttpTransportEnabled() && nativeSessionReadsEnabled() ? '1' : undefined,
          O8D_REQUEST_COUNTS_PATH: join(getDataDir(), 'o8d-request-counts.jsonl'),
          O8D_MACHINE_DISPLAY_NAME: nativeSessionReadsEnabled() ? localMachineName() : undefined,
          O8D_SESSION_DATA_DIR: getDataDir(), O8D_SESSION_DB_PATH: process.env.CORTEX_IDE_DB_PATH, TZ: process.env.TZ,
        } }), stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      // Policy preparation can throw before spawn emits an error (e.g. a busy store).
      this.resumeFallback();
      return;
    }
    this.child = child;
    child.stderr?.resume();
    child.stdin?.on('error', () => child.kill());
    const output = createInterface({ input: child.stdout! });
    await new Promise<void>((resolve) => {
      let ready = false;
      const timeout = setTimeout(() => child.kill(), 5_000);
      const failed = () => {
        clearTimeout(timeout);
        output.close();
        if (this.child !== child) return;
        this.child = null;
        this.resumeFallback();
        if (!ready) resolve();
      };
      child.once('error', failed);
      child.once('exit', failed);
      output.on('line', (line) => {
        try {
          const message = JSON.parse(line);
          if (ready && message.draining === true && this.child === child) {
            this.transport = 'typescript';
            if (!this.stopped && !this.fallback.listening) this.fallback.listen(this.port, this.host);
            return;
          }
          if (ready || typeof message.listening !== 'string') throw new Error('invalid readiness');
          ready = true;
          clearTimeout(timeout);
          if (this.retry) clearTimeout(this.retry);
          this.retry = null;
          this.retryDelayMs = 2_000;
          this.transport = 'o8d';
          this.generation += 1;
          resolve();
        } catch { child.kill(); }
      });
    });
  }

  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.producer?.stop();
    this.child?.stdin?.end();
    if (this.fallback.listening) this.fallback.close();
  }
}
