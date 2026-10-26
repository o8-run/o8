import type { ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile, spawn } from '@/lib/providers/child-process';

/** Packet deadline cancellation owns the install process group, including scripts. */
export function execDependencyInstallProcess(command: string, args: string[], options: ExecFileOptions): Promise<{ stdout: string; stderr: string }> {
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
