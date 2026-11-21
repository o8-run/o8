/** Front-door producer attachment; the launcher owns the daemon and public port. */
import { randomUUID } from 'node:crypto';
import { ComposerOwnerRequests, ComposerOwnerUnavailable, COMPOSER_RPC_FRAME_LIMIT, type ComposerOwnerMethod, type ComposerOwnerParams, type ComposerOwnerResults } from './composer-owner-rpc';
import { lstat } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { nativeCommitNotice } from './native-commit-notice';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { signalComposerQueueChange } from './composer-queue-signal';

const LIMIT = 1024 * 1024;
// Stable across producer-object replacement and reconnect, fresh on a WS boot.
const COMPOSER_QUEUE_BOOT_ID = randomUUID();
export class O8dProducer {
  private socket: Socket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private delay = 250;
  private pid: number | null = null;
  private generation = 0;
  private readonly composer = new ComposerOwnerRequests(frame => {
    const socket = this.socket;
    if (!this.pid || !socket?.writable) throw new ComposerOwnerUnavailable();
    if (socket.writableLength + Buffer.byteLength(frame) > COMPOSER_RPC_FRAME_LIMIT) throw new ComposerOwnerUnavailable('The composer owner write buffer is full.');
    socket.write(frame);
  });
  composerRequest<M extends ComposerOwnerMethod>(method: M, params: ComposerOwnerParams[M]): Promise<ComposerOwnerResults[M]> {
    return this.composer.request(method, params);
  }
  constructor(private readonly path: string, private readonly key: string,
    private readonly upstream: string, private readonly epoch: string,
    private readonly startupPortInfo: () => string | undefined) {}

  get status() { return { transport: this.pid ? 'o8d' as const : 'typescript' as const, pid: this.pid, generation: this.generation }; }
  async start(): Promise<void> {
    if (this.stopped || this.socket) return;
    try {
      const stat = await lstat(this.path);
      if (!stat.isSocket() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) || (process.platform !== 'win32' && stat.uid !== process.geteuid?.())) throw Error('Private producer socket unavailable');
    } catch { this.schedule(); return; }
    if (this.stopped) return;
    await new Promise<void>(resolve => {
      const socket = connect(this.path); this.socket = socket;
      let reply: Buffer[] = [], replyBytes = 0, ready = false;
      const failed = () => {
        socket.destroy();
        if (this.socket === socket) { this.socket = null; this.pid = null; this.composer.disconnect(); this.schedule(); }
        resolve();
      };
      socket.setTimeout(5_000, failed);
      socket.once('error', failed); socket.once('close', failed);
      socket.once('connect', () => {
        try {
          const raw = this.startupPortInfo();
          const grant = JSON.stringify({ version: 1, key: this.key, upstream: this.upstream, epoch: this.epoch,
            composerQueueBootId: COMPOSER_QUEUE_BOOT_ID, ...(raw ? { startupPortInfo: JSON.parse(raw) } : {}) }) + '\n';
          if (Buffer.byteLength(grant) > 16 * 1024) { failed(); return; }
          socket.write(grant);
        } catch { failed(); }
      });
      let publishing = 0;
      socket.on('data', chunk => {
        if (this.stopped || this.socket !== socket) { failed(); return; }
        // Process frames before retaining a partial line. Both the incomplete
        // frame and outstanding publication work are independently bounded.
        for (let offset = 0; offset < chunk.length;) {
          const end = chunk.indexOf(10, offset);
          const part = chunk.subarray(offset, end < 0 ? chunk.length : end + 1);
          if (replyBytes + part.length > (ready ? COMPOSER_RPC_FRAME_LIMIT : 4096)) { failed(); return; }
          reply.push(part); replyBytes += part.length; offset += part.length;
          if (end < 0) return;
          try {
            const frameBytes = replyBytes;
            const value = JSON.parse(Buffer.concat(reply, replyBytes).toString()); reply = []; replyBytes = 0;
            if (!ready) {
              if (value.version !== 1 || value.epoch !== this.epoch || !Number.isSafeInteger(value.pid) || value.pid <= 0
                || !Number.isSafeInteger(value.generation) || value.generation <= 0) throw Error('Invalid producer receipt');
              if (value.composerQueueEpoch !== undefined && (typeof value.composerQueueEpoch !== 'string' || !value.composerQueueEpoch || value.composerQueueEpoch.length > 256)) throw Error('Invalid composer owner epoch');
              this.composer.attach(value.composerQueueEpoch ?? null);
              ready = true; socket.setTimeout(0); this.pid = value.pid; this.generation = value.generation; this.delay = 250; resolve();
            } else if (!this.composer.receive(value)) {
              if (frameBytes > 16 * 1024) throw Error('Oversized commit notice');
              const notice = nativeCommitNotice(value, this.epoch);
              if (!notice || publishing >= 32) throw Error('Invalid commit notice');
              // o8d added, promoted, cancelled or held a queued message: check now.
              if (notice.mutation.action === 'composer-queue') signalComposerQueueChange();
              publishing++;
              // Node assigns the canonical producer sequence through its existing
              // publisher. Failure cannot change the already committed write.
              void publishRealtimeMutation(notice).catch(() => false).finally(() => { publishing--; });
            }
          } catch { failed(); return; }
        }
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
    this.retry = null; this.socket?.destroy(); this.socket = null; this.pid = null; this.composer.disconnect();
  }
}
