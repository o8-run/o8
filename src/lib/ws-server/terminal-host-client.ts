import { internalBrokerEnvironment } from '@/lib/providers/spawn-environment';
/**
 * Parent-side terminal-host: the seam ws-server spawns PTYs through.
 *
 *   - InlineTerminalHost: node-pty in-process (the historical behavior).
 *   - ChildTerminalHost:  forks terminal-host-entry and proxies each PTY over
 *     IPC, so a PTY wedge in either process can't freeze the other (#1498).
 *
 * Both present the identical `TerminalHandle` surface, so ws-server's terminal
 * handlers (batch buffer, scrollback, client fan-out) are untouched and the
 * client-facing WS protocol stays byte-identical. Selected by O8_TERMINAL_HOST
 * (inline | child); default resolved by the caller.
 */

import { reserveWorkLaunch, WorkAdmissionExpiredError, type WorkLaunchLease } from '@/lib/app-update/work-launch-admission';
import { fork, withChildEnvironment, type ChildProcess } from '@/lib/providers/child-process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  PtySpawnSpec,
  TerminalHandle,
  TerminalHost,
  TerminalHostEvent,
} from './terminal-host-protocol';
import type { ChildPty } from './terminal-host-child';

export type { TerminalHandle, TerminalHost } from './terminal-host-protocol';

// ── Inline host (node-pty in this process) ──────────────────────────────────

/** The node-pty module surface the inline host needs. */
export interface InlinePtyModule {
  spawn(
    file: string,
    args: string[],
    opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
  ): ChildPty;
}

export function createInlineTerminalHost(ptyModule: InlinePtyModule): TerminalHost {
  return {
    mode: 'inline',
    spawn(spec: PtySpawnSpec): TerminalHandle {
      const lease = reserveWorkLaunch(`Terminal ${spec.file}`);
      let p: ChildPty | undefined;
      try {
        lease.started(process.pid);
        p = withChildEnvironment(spec.env, [spec.file, ...spec.args], env => ptyModule.spawn(spec.file, spec.args, {
          name: spec.name ?? 'xterm-256color',
          cols: spec.cols,
          rows: spec.rows,
          cwd: spec.cwd,
          env,
        }), false, spec.cwd);
        try { lease.started(p.pid); } catch (error) {
          if (error instanceof WorkAdmissionExpiredError) {
            p.kill('SIGKILL');
            lease.release();
            throw error;
          }
          // Preserve uncertain ownership through exit on a PID write I/O fault.
        }
        p.onExit(lease.release);
      } catch (error) { if (!p) lease.release(); throw error; }
      const terminal = p;
      return {
        get pid() { return terminal.pid; },
        onData: (cb) => terminal.onData(cb),
        onExit: (cb) => terminal.onExit((e) => cb({ exitCode: e.exitCode, signal: e.signal })),
        write: (d) => terminal.write(d),
        resize: (c, r) => terminal.resize(c, r),
        kill: (s) => terminal.kill(s),
      };
    },
    dispose() { /* PTYs are killed by ws-server per-attachment */ },
  };
}

// ── Child host (forked terminal-host) ───────────────────────────────────────

class ChildHandle implements TerminalHandle {
  pid: number | undefined = undefined;
  private dataCb: ((data: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  private exited = false;

  constructor(
    private readonly id: string,
    private readonly child: ChildProcess,
    readonly lease: WorkLaunchLease,
  ) {}

  onData(cb: (data: string) => void): void { this.dataCb = cb; }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void { this.exitCb = cb; }

  write(data: string): void {
    this.child.send?.({ type: 'write', id: this.id, data });
  }
  resize(cols: number, rows: number): void {
    this.child.send?.({ type: 'resize', id: this.id, cols, rows });
  }
  kill(signal?: string): void {
    this.child.send?.({ type: 'kill', id: this.id, signal });
  }

  /** @internal — fed by the host from IPC frames. */
  _emitData(data: string): void { this.dataCb?.(data); }
  /** @internal */
  _emitExit(e: { exitCode: number; signal?: number }, confirmed = true): void {
    if (this.exited) return;
    this.exited = true;
    // If the host dies before acknowledging a spawn, a PTY may still exist.
    // Retain its uncertain reader instead of guessing that it exited.
    if (confirmed && this.pid) this.lease.release();
    this.exitCb?.(e);
  }
}

export interface ChildTerminalHostOptions {
  /** Absolute path to the fork entry. Defaults resolved from import.meta.url. */
  forkEntry?: string;
  /** execArgv for the fork (e.g. ['--import','tsx'] in dev). */
  execArgv?: string[];
  log?: (msg: string) => void;
}

/** Resolve the fork entry + execArgv for dev (tsx .ts) vs packaged (.mjs). */
export function resolveTerminalHostForkTarget(): { forkEntry: string; execArgv: string[] } {
  // A sidecar may point us straight at the bundled artifact.
  const bundled = process.env.O8_BUNDLED_TERMINAL_HOST;
  if (bundled) return { forkEntry: bundled, execArgv: [] };

  const here = dirname(fileURLToPath(import.meta.url));
  const isDev = import.meta.url.endsWith('.ts');
  return isDev
    ? { forkEntry: join(here, 'terminal-host-entry.ts'), execArgv: ['--import', 'tsx'] }
    : { forkEntry: join(here, 'terminal-host.mjs'), execArgv: [] };
}

export function createChildTerminalHost(options: ChildTerminalHostOptions = {}): TerminalHost {
  const resolved = resolveTerminalHostForkTarget();
  const forkEntry = options.forkEntry ?? resolved.forkEntry;
  const execArgv = options.execArgv ?? resolved.execArgv;
  const log = options.log ?? (() => {});

  const child = fork(forkEntry, [], {
    env: internalBrokerEnvironment(),
    execArgv,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });

  const handles = new Map<string, ChildHandle>();
  let seq = 0;
  let disposed = false;

  child.on('message', (msg: TerminalHostEvent) => {
    const h = handles.get(msg.id);
    if (!h) return;
    switch (msg.type) {
      case 'spawned':
        h.pid = msg.pid;
        try { h.lease.started(msg.pid); } catch (error) {
          if (error instanceof WorkAdmissionExpiredError) h.kill('SIGKILL');
          // Other PID write faults retain the reader until confirmed exit.
        }
        break;
      case 'spawn-error':
        h.lease.release();
        log(`spawn-error for ${msg.id}: ${msg.message}`);
        handles.delete(msg.id);
        h._emitExit({ exitCode: 1 });
        break;
      case 'data':
        h._emitData(msg.data);
        break;
      case 'exit':
        handles.delete(msg.id);
        h._emitExit({ exitCode: msg.exitCode, signal: msg.signal });
        break;
      default:
        break;
    }
  });

  child.on('exit', (code, signal) => {
    log(`terminal-host child exited (code=${code ?? '?'} signal=${signal ?? '?'})`);
    // Surface an exit to every live handle so ws-server tears the attachment
    // down (broadcasts 'exited', cleans clients). No auto-respawn — child mode
    // is opt-in; a crash falls back visibly rather than silently reconnecting.
    for (const h of handles.values()) {
      h._emitExit({ exitCode: code ?? 1, signal: signal ? 1 : undefined }, false);
    }
    handles.clear();
  });

  child.on('error', (err) => {
    log(`terminal-host child error: ${err instanceof Error ? err.message : String(err)}`);
  });

  return {
    mode: 'child',
    spawn(spec: PtySpawnSpec): TerminalHandle {
      const id = `t${(seq += 1)}`;
      const lease = reserveWorkLaunch(`Terminal ${spec.file}`);
      const handle = new ChildHandle(id, child, lease);
      handles.set(id, handle);
      // IPC preserves order: the child processes this spawn (creating the pty)
      // before any subsequent write/resize/kill on the same id.
      child.send?.({ type: 'spawn', id, spec, admissionId: lease.id });
      return handle;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try { child.kill(); } catch { /* already gone */ }
    },
  };
}
