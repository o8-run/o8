import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { spawn, type ChildProcess } from '@/lib/providers/child-process';
import { childEnvironment } from '@/lib/providers/spawn-environment';
import type { RealtimeEventEnvelope } from '@/lib/realtime/types';

const PIPE_LIMIT = 1024 * 1024;

/** TS owns authentication, checkpoints and commands; Rust owns the public socket. */
export class O8dBridge {
  private readonly key = randomUUID();
  private child: ChildProcess | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private upstream = '';
  private generation = 0;
  private readonly fallback: Server;
  private transport: 'typescript' | 'o8d' = 'typescript';

  constructor(private readonly server: Server, private readonly port: number, private readonly epoch: string) {
    this.fallback = createServer((req, res) => server.emit('request', req, res));
    this.fallback.on('upgrade', (req, socket, head) => server.emit('upgrade', req, socket, head));
    this.fallback.on('error', () => this.stop());
  }

  get status() {
    return { transport: this.transport, pid: this.child?.pid ?? null, generation: this.generation };
  }

  /** Headers from the public client are replaced by Rust, never trusted verbatim. */
  peer(req: IncomingMessage): string | null {
    const supplied = req.headers['x-o8d-bridge'];
    if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(this.key)) return null;
    if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(this.key))) return null;
    return typeof req.headers['x-o8d-peer'] === 'string' ? req.headers['x-o8d-peer'] : null;
  }

  allowsUpgrade(req: IncomingMessage): boolean {
    const address = this.server.address();
    return !address || typeof address === 'string' || req.socket.localPort !== address.port || this.peer(req) !== null;
  }

  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('o8d upstream unavailable');
    this.upstream = `127.0.0.1:${address.port}`;
    await this.launch();
  }

  publish(events: RealtimeEventEnvelope[]) {
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

  private async launch() {
    if (this.stopped) return;
    if (this.fallback.listening) this.fallback.close();
    const binary = process.env.O8D_BINARY ?? join(process.cwd(), 'crates/o8d/target/release',
      process.platform === 'win32' ? 'o8d.exe' : 'o8d');
    const child = spawn(binary, ['--experimental-ws', '--listen', `0.0.0.0:${this.port}`,
      '--app-upstream', this.upstream], {
      env: childEnvironment({ inherit: false, env: {
        O8D_BRIDGE_KEY: this.key, O8D_EPOCH: this.epoch,
      } }), stdio: ['pipe', 'pipe', 'pipe'],
    });
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
        this.transport = 'typescript';
        if (!this.stopped && !this.fallback.listening) this.fallback.listen(this.port, '0.0.0.0');
        if (!this.stopped) this.retry = setTimeout(() => { void this.launch(); }, 2_000);
        if (!ready) resolve();
      };
      child.once('error', failed);
      child.once('exit', failed);
      output.on('line', (line) => {
        try {
          const message = JSON.parse(line);
          if (ready && message.draining === true && this.child === child) {
            this.transport = 'typescript';
            if (!this.stopped && !this.fallback.listening) this.fallback.listen(this.port, '0.0.0.0');
            return;
          }
          if (ready || typeof message.listening !== 'string') throw new Error('invalid readiness');
          ready = true;
          clearTimeout(timeout);
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
    this.child?.stdin?.end();
    if (this.fallback.listening) this.fallback.close();
  }
}
