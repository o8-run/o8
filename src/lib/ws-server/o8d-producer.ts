/** Front-door producer attachment; the launcher owns the daemon and public port. */
import { lstat } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';

const LIMIT = 1024 * 1024;
export class O8dProducer {
  private socket: Socket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private delay = 250;
  private pid: number | null = null;
  private generation = 0;
  constructor(private readonly path: string, private readonly key: string,
    private readonly upstream: string, private readonly epoch: string,
    private readonly startupPortInfo: () => string | undefined) {}

  get status() { return { transport: this.pid ? 'o8d' as const : 'typescript' as const, pid: this.pid, generation: this.generation }; }
  async start(): Promise<void> {
    if (this.stopped || this.socket) return;
    try {
      const stat = await lstat(this.path);
      if (!stat.isSocket() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== process.geteuid?.()) throw Error('Private producer socket unavailable');
    } catch { this.schedule(); return; }
    if (this.stopped) return;
    await new Promise<void>(resolve => {
      const socket = connect(this.path); this.socket = socket;
      let reply = Buffer.alloc(0), ready = false;
      const failed = () => {
        socket.destroy();
        if (this.socket === socket) { this.socket = null; this.pid = null; this.schedule(); }
        resolve();
      };
      socket.setTimeout(5_000, failed);
      socket.once('error', failed); socket.once('close', failed);
      socket.once('connect', () => {
        try {
          const raw = this.startupPortInfo();
          const grant = JSON.stringify({ version: 1, key: this.key, upstream: this.upstream, epoch: this.epoch,
            ...(raw ? { startupPortInfo: JSON.parse(raw) } : {}) }) + '\n';
          if (Buffer.byteLength(grant) > 16 * 1024) { failed(); return; }
          socket.write(grant);
        } catch { failed(); }
      });
      socket.on('data', chunk => {
        if (this.stopped || this.socket !== socket || ready || reply.length + chunk.length > 4096) { failed(); return; }
        reply = Buffer.concat([reply, chunk]);
        if (!reply.includes(10)) return;
        try {
          if (reply.at(-1) !== 10 || reply.indexOf(10) !== reply.length - 1) throw Error('Malformed producer receipt');
          const value = JSON.parse(reply.toString());
          if (value.version !== 1 || value.epoch !== this.epoch || !Number.isSafeInteger(value.pid) || value.pid <= 0
            || !Number.isSafeInteger(value.generation) || value.generation <= 0) throw Error('Invalid producer receipt');
          ready = true; socket.setTimeout(0); this.pid = value.pid; this.generation = value.generation; this.delay = 250; resolve();
        } catch { failed(); }
      });
    });
  }
  private schedule() {
    if (this.stopped || this.retry) return;
    const delay = this.delay; this.delay = Math.min(delay * 2, 5_000);
    this.retry = setTimeout(() => { this.retry = null; void this.start(); }, delay);
  }
  publish(events: unknown[]) {
    const socket = this.socket;
    if (!this.pid || !socket?.writable) return;
    const line = JSON.stringify(events) + '\n';
    if (Buffer.byteLength(line) + socket.writableLength > LIMIT) { socket.destroy(); return; }
    socket.write(line);
  }
  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null; this.socket?.destroy(); this.socket = null; this.pid = null;
  }
}
