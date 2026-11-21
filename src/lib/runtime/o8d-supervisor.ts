import { createConnection } from 'node:net';
import { lstatSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import type { MetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';

export interface SupervisorReference {
  id: string;
  owner: string;
  epoch: string;
  cursor: number;
}
export interface SupervisorSpawn {
  id: string;
  owner: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdoutPath: string;
  stderrPath: string;
  stdinPath?: string;
  admissionPath?: string;
}
export interface SupervisorReceipt {
  id: string;
  pid: number;
  epoch: string;
  identity: MetadataLockProcessIdentity;
}
export type SupervisorEvent = { seq: number } & (
  { stream: 'stdout' | 'stderr'; data: string }
  | { stream: 'exit'; code: number | null; signal: number | null }
);
export interface SupervisorAttachment extends SupervisorReceipt {
  events: SupervisorEvent[];
  cursor: number;
  gap: boolean;
  state: 'running' | 'draining' | 'settling' | 'exited' | 'lost';
  groupEmpty: boolean;
}

/** Errors deliberately exclude credentials, arguments, environment and paths. */
export class SupervisorError extends Error {
  constructor(code: string) { super(`Worker supervisor refused: ${code}`); }
}

export class O8dSupervisorClient {
  constructor(private readonly socket: string, private readonly token: string) {}

  private request<T>(body: Record<string, unknown> | (() => Record<string, unknown>)): Promise<T> {
    return new Promise((resolve, reject) => {
      let socket: ReturnType<typeof createConnection>;
      try {
        if (!isAbsolute(this.socket) || !this.token) throw new SupervisorError('configuration');
        const directory = lstatSync(dirname(this.socket));
        const endpoint = lstatSync(this.socket);
        const uid = process.getuid?.();
        if (!directory.isDirectory() || directory.isSymbolicLink() || process.platform !== 'win32' && directory.uid !== uid || (process.platform !== 'win32' && (directory.mode & 0o077) !== 0)
          || !endpoint.isSocket() || process.platform !== 'win32' && endpoint.uid !== uid || (process.platform !== 'win32' && (endpoint.mode & 0o077) !== 0)) throw new SupervisorError('socket-ownership');
        socket = createConnection(this.socket);
      } catch { reject(new SupervisorError('unavailable')); return; }
      let settled = false;
      let size = 0;
      const chunks: Buffer[] = [];
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error); else resolve(value!);
      };
      socket.setTimeout(10_000, () => finish(new SupervisorError('timeout')));
      socket.once('connect', () => {
        try {
          // Policy checks supplied by the caller run immediately before write.
          const frame = JSON.stringify({ ...(typeof body === 'function' ? body() : body), version: 1, token: this.token }) + '\n';
          if (Buffer.byteLength(frame) > 2 * 1024 * 1024) throw new SupervisorError('request-limit');
          socket.end(frame);
        } catch { finish(new SupervisorError('submission-refused')); }
      });
      socket.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { finish(new SupervisorError('response-limit')); return; }
        chunks.push(chunk);
        if (!chunk.includes(10)) return;
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (result.ok !== true) {
            const code = typeof result.error === 'string' && /^[a-z-]+$/.test(result.error) ? result.error : 'invalid-response';
            finish(new SupervisorError(code));
          } else finish(undefined, result as T);
        } catch { finish(new SupervisorError('invalid-response')); }
      });
      socket.once('error', () => finish(new SupervisorError('transport')));
      socket.once('close', () => { if (!settled) finish(new SupervisorError('disconnected')); });
    });
  }

  spawn(input: SupervisorSpawn | (() => SupervisorSpawn)): Promise<SupervisorReceipt> {
    return this.request(() => ({ ...(typeof input === 'function' ? input() : input), op: 'spawn' }));
  }
  async attach(reference: SupervisorReference): Promise<SupervisorAttachment> {
    const result = await this.inspect(reference.id, reference.owner, reference.cursor);
    if (result.epoch !== reference.epoch || result.id !== reference.id || result.state === 'lost') throw new SupervisorError('ownership-unverifiable');
    return result;
  }
  /** Recover only an exact, durably prepared id after an uncertain submission. */
  inspect(id: string, owner: string, since = 0): Promise<SupervisorAttachment> {
    return this.request({ op: 'attach', id, owner, since });
  }
  signal(reference: SupervisorReference, signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): Promise<{ ok: true }> {
    return this.request({ op: 'signal', id: reference.id, owner: reference.owner, epoch: reference.epoch, signal });
  }
}

export function processSupervisorEnabled(runtimeId: string): boolean {
  return process.platform === 'linux' && runtimeId === 'codex' && process.env.O8_PROCESS_SUPERVISOR === '1';
}
export function ownedSupervisorClient(): O8dSupervisorClient {
  return new O8dSupervisorClient(process.env.O8D_SUPERVISOR_SOCKET ?? '', getOrCreateWsToken());
}
