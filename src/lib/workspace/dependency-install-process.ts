import type { ExecFileOptions } from 'node:child_process';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { execFile, spawn } from '@/lib/providers/child-process';
import { piWriteHelperPath } from '@/lib/pi/sdk/scripts';

/** A cache reservation may be released only after installer teardown is proved. */
export function dependencyInstallProcessesStopped(error: unknown): boolean {
  return error instanceof Error && 'installProcessesStopped' in error && error.installProcessesStopped === true;
}

/** Supervise detached descendants as well as the install's original process group. */
export function execDependencyInstallProcess(command: string, args: string[], options: ExecFileOptions): Promise<{ stdout: string; stderr: string }> {
  if (process.platform !== 'win32') return execSupervisedInstall(command, args, options);
  const signal = options.signal;
  if (!signal) return promisify(execFile)(command, args, options).then(({ stdout, stderr }) => ({ stdout: String(stdout), stderr: String(stderr) }));
  signal?.throwIfAborted();
  const { signal: _signal, ...execution } = options;
  return new Promise((resolve, reject) => {
    // execFile discards detached; spawn is required to own a POSIX process group.
    const child = spawn(command, args, { ...execution, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    let bytes = 0;
    let failure: unknown;
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 1000, windowsHide: true }, () => {});
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* Group already exited. */ }
      }
      child.kill('SIGKILL');
    };
    const abort = () => { failure = signal.reason; stop(); };
    const timer = execution.timeout ? setTimeout(() => {
      failure = Object.assign(new Error('Install process exceeded its execution deadline.'), { code: 'ETIMEDOUT' }); stop();
    }, execution.timeout) : undefined;
    for (const name of ['stdout', 'stderr'] as const) child[name].on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (execution.maxBuffer ?? 1024 * 1024)) {
        failure = Object.assign(new Error('Install process exceeded its output limit.'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }); stop();
      } else output[name].push(chunk);
    });
    child.once('error', (error) => { failure = error; });
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      const result = { stdout: Buffer.concat(output.stdout).toString(), stderr: Buffer.concat(output.stderr).toString() };
      if (failure || code !== 0) reject(failure ?? Object.assign(new Error('Dependency install process failed.'), { code, signal: exitSignal, ...result }));
      else resolve(result);
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}


function execSupervisedInstall(command: string, args: string[], options: ExecFileOptions): Promise<{ stdout: string; stderr: string }> {
  const { signal, timeout, maxBuffer = 1024 * 1024, ...execution } = options;
  let helper: string;
  try { signal?.throwIfAborted(); helper = piWriteHelperPath(); }
  catch (error) { return Promise.reject(Object.assign(error as Error, { installProcessesStopped: true })); }
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(helper, ['supervise', String(process.pid), command, ...args], {
        ...execution, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) { reject(Object.assign(error as Error, { installProcessesStopped: true })); return; }
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    let bytes = 0;
    let receipt = '';
    let failure: Error | undefined;
    let stopping = false;
    let settled = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null, exitSignal?: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      signal?.removeEventListener('abort', abort);
      const result = { stdout: Buffer.concat(output.stdout).toString(), stderr: Buffer.concat(output.stderr).toString() };
      let confirmed = !child.pid;
      try { confirmed ||= JSON.parse(receipt).confirmed === true; } catch { /* A missing receipt cannot prove teardown. */ }
      if (!confirmed) {
        reject(Object.assign(new Error('Dependency install cleanup could not confirm that its process group and owned detached children stopped; its cache reservation remains protected.'), {
          code: 'dependency_install_cleanup_unconfirmed', cause: failure,
        }));
      } else if (failure || code !== 0) {
        const error = failure ?? Object.assign(new Error('Dependency install process failed.'), { code, signal: exitSignal, ...result });
        if (stopping) error.message += ' The install process group and its owned detached children were stopped.';
        reject(Object.assign(error, { installProcessesStopped: true }));
      } else resolve(result);
    };
    const stop = (error: Error) => {
      if (settled || stopping) return;
      failure = error;
      stopping = true;
      // TERM requests native teardown, not just the original process group.
      child.kill('SIGTERM');
      cleanupTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(null);
        child.stdout?.destroy(); child.stderr?.destroy();
        (child.stdio[3] as Readable | null)?.destroy();
      }, 10_000);
    };
    const abort = () => stop(signal?.reason instanceof Error ? signal.reason : new Error('Dependency install was aborted.'));
    // The native supervisor owns teardown; do not let spawn's timeout kill it.
    const timer = timeout ? setTimeout(() => stop(Object.assign(new Error('Install process exceeded its execution deadline.'), { code: 'ETIMEDOUT' })), timeout) : undefined;
    for (const name of ['stdout', 'stderr'] as const) child[name]?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBuffer) stop(Object.assign(new Error('Install process exceeded its output limit.'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
      else output[name].push(chunk);
    });
    (child.stdio[3] as NodeJS.ReadableStream | null)?.on('data', (chunk: Buffer) => {
      if (receipt.length < 4096) receipt += chunk.toString();
    });
    child.once('error', error => { failure = error; });
    child.once('close', finish);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
