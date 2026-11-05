/** Reuse the existing authenticated standalone reader for flagged repository GETs. */
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { getDataDir } from '@/lib/data-dir-migration';
import { spawn, type ChildProcess } from '@/lib/providers/child-process';
import { childEnvironment } from '@/lib/providers/spawn-environment';

const MARKER = 'x-o8d-native-repository-read';
const PATHS = new Set(['/api/panel/branches']);
const STARTUP_TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 2_000;
const RESPONSE_LIMIT = 16 * 1024 * 1024;

interface Reader {
  key: string;
  child: ChildProcess;
  ready: Promise<string>;
  started: boolean;
}
let reader: Reader | null = null;
let retryAfter = 0;

function closeReader(current: Reader): void {
  current.child.stdin?.end();
  if (!current.started) { current.child.kill(); return; }
  // EOF lets the reader cancel and reap an active Git child. Immediate SIGTERM
  // would bypass that cleanup. The fallback exceeds its 20-second work budget.
  const timer = setTimeout(() => current.child.kill('SIGKILL'), 25_000);
  timer.unref();
  current.child.once('exit', () => clearTimeout(timer));
}

/** Closing stdin also works when the parent is killed before its exit hook runs. */
export function stopRepositoryReader(): void {
  const current = reader;
  reader = null;
  if (current) closeReader(current);
}
process.once('exit', stopRepositoryReader);

function privateOrigin(): Promise<string> {
  const directory = getDataDir();
  const binary = resolve(process.env.O8D_BINARY ?? join(process.cwd(), 'crates/o8d/target/release',
    process.platform === 'win32' ? 'o8d.exe' : 'o8d'));
  const key = JSON.stringify([directory, binary]);
  if (reader?.key === key && reader.child.exitCode === null && reader.child.signalCode === null) return reader.ready;
  if (Date.now() < retryAfter) return Promise.reject(new Error('Repository reader unavailable'));
  stopRepositoryReader();
  const child = spawn(binary, ['--experimental-http', '--listen', '127.0.0.1:0', '--data-dir', directory,
    '--exit-on-stdin-eof'], {
    env: childEnvironment({ inject: false, env: { O8D_NATIVE_REPOSITORY_READS: '1' } }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr?.resume();
  const current: Reader = { key, child, ready: Promise.resolve(''), started: false };
  current.ready = new Promise<string>((resolveReady, rejectReady) => {
    let ready = false;
    let settled = false;
    let failed = false;
    let outputBytes = 0;
    const output = createInterface({ input: child.stdout! });
    const fail = () => {
      if (failed) return;
      failed = true;
      if (reader === current) reader = null;
      retryAfter = Date.now() + RETRY_DELAY_MS;
      clearTimeout(timer);
      output.close();
      closeReader(current);
      if (!settled) { settled = true; rejectReady(new Error('Repository reader unavailable')); }
    };
    const timer = setTimeout(fail, STARTUP_TIMEOUT_MS);
    child.once('error', fail);
    child.once('exit', fail);
    child.stdin?.on('error', fail);
    child.stdout!.on('data', (chunk: Buffer) => {
      if (!ready && (outputBytes += chunk.length) > 16_384) fail();
    });
    output.on('line', (line) => {
      if (settled) return;
      try {
        const value = JSON.parse(line) as { listening?: unknown };
        if (typeof value.listening !== 'string' || !/^127\.0\.0\.1:[1-9]\d{0,4}$/.test(value.listening)) throw new Error('Invalid readiness');
        const port = Number(value.listening.split(':')[1]);
        if (port > 65535) throw new Error('Invalid readiness');
        ready = true;
        current.started = true;
        settled = true;
        clearTimeout(timer);
        resolveReady(`http://${value.listening}`);
      } catch { fail(); }
    });
  });
  reader = current;
  return current.ready;
}

/** Called only by registry handlers after the unchanged public middleware gate. */
export async function readRepositoryRequest(request: Request): Promise<Response | null> {
  if (process.env.O8D_NATIVE_REPOSITORY_READS !== '1' || request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (!PATHS.has(url.pathname)) return null;
  try {
    const origin = await privateOrigin();
    const response = await fetch(`${origin}${url.pathname}${url.search}`, {
      headers: { authorization: request.headers.get('authorization') ?? '' },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
      redirect: 'error',
    });
    if (response.headers.get(MARKER) !== '1' || response.status === 503) {
      await response.body?.cancel();
      return null;
    }
    const stream = response.body?.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let length = 0;
    if (stream) {
      while (true) {
        const { done, value } = await stream.read();
        if (done) break;
        length += value.length;
        if (length > RESPONSE_LIMIT) { await stream.cancel(); return null; }
        chunks.push(value);
      }
    }
    return new Response(new Blob(chunks), { status: response.status, headers: response.headers });
  } catch {
    // A failed optional reader never replaces the existing production fallback.
    return null;
  }
}
