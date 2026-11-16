import { spawn } from 'node:child_process';

/** Rust inherits the environment; retain that behavior, but bound process lifetime and memory. */
export function run(cmd: 'git' | 'gh', args: string[], cwd: string, signal: AbortSignal, raw = false): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), failure: Error | undefined;
    const kill = () => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
      if (child.pid && process.platform === 'win32') {
        const reaper = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        reaper.on('error', () => child.kill('SIGKILL'));
      } else child.kill('SIGKILL');
    };
    const stop = (error: Error) => { failure ??= error; kill(); };
    const abort = () => stop(new Error('Phone tool process aborted'));
    const timer = setTimeout(() => stop(new Error(`${cmd} timed out after 30s`)), 30_000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdin.on('error', () => { /* A command may close stdin immediately. */ });
    child.stdin.end();
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > 8 * 1024 * 1024) stop(new Error(`${cmd} output exceeded 8 MiB`));
      else stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(0, 64 * 1024); });
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(stderr.toString('utf8').trim() || `${cmd} failed`));
      else resolve(raw ? stdout.toString('utf8') : stdout.toString('utf8').trim());
    });
  });
}
export function prefix(value: string, bytes: number): string {
  let result = '';
  let size = 0;
  for (const char of value) { size += Buffer.byteLength(char); if (size > bytes) break; result += char; }
  return result;
}
export function bounded(value: string, bytes: number): [string, boolean] {
  value = value.trim();
  const marker = '\n… [truncated]';
  return Buffer.byteLength(value) <= bytes ? [value, false] : [prefix(value, bytes - Buffer.byteLength(marker)) + marker, true];
}
