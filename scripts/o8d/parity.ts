/** Domain-read oracle: real WS entry, persisted fixture, Next listener closed. */
import { execFile } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { startParityReference } from '../../tests/fixtures/ws-parity-server';
import { runRepositoryParity } from './repository-parity';

// No patterns, suffix matching or semantic fields. The current fixture needs no exclusions.
export const VOLATILE_FIELDS: readonly string[] = ['requestId', 'epoch', 'generatedAt'];
export function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !VOLATILE_FIELDS.includes(key)).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, normalize(item)]));
  return value;
}
/** JSON pointer to the first difference; array order and missing/null remain significant. */
export function firstDifference(expected: unknown, actual: unknown, path = '$'): string | null {
  if (Object.is(expected, actual)) return null;
  if (!expected || !actual || typeof expected !== 'object' || typeof actual !== 'object'
    || Array.isArray(expected) !== Array.isArray(actual)) return `${path}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`;
  const left = expected as Record<string, unknown>;
  const right = actual as Record<string, unknown>;
  for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
    const at = `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) return `${at}: ${Object.hasOwn(left, key) ? 'missing from candidate' : 'unexpected in candidate'}`;
    const difference = firstDifference(left[key], right[key], at);
    if (difference) return difference;
  }
  return null;
}
export const SESSION_READ_PATHS = [
  '/api/mobile/orchestrator/threads', '/api/mobile/history', '/api/v2/chat-history', '/api/orchestrator/composer-queue',
] as const;
export function sessionCorpus(directory: string) {
  const queue = `${SESSION_READ_PATHS[3]}?${new URLSearchParams({ repoPath: join(directory, 'fixture-repo'), threadId: 'thoughts-review', backend: 'claude' })}`;
  return [
    `${SESSION_READ_PATHS[0]}?limit=500`, `${SESSION_READ_PATHS[0]}?limit=1&offset=1`,
    `${SESSION_READ_PATHS[0]}?archived=1`, `${SESSION_READ_PATHS[0]}?backend=invalid`,
    `${SESSION_READ_PATHS[1]}?sessionKey=llm-chat:thoughts-review&limit=100`,
    `${SESSION_READ_PATHS[1]}?sessionKey=llm-chat:thoughts-long&page=1&limit=100`,
    `${SESSION_READ_PATHS[1]}?sessionKey=llm-chat:thoughts-long&page=1&before=invalid`,
    `${SESSION_READ_PATHS[1]}`, `${SESSION_READ_PATHS[1]}?sessionKey=llm-chat:thoughts-missing`,
    `${SESSION_READ_PATHS[2]}?tabId=thoughts-review&limit=100`,
    `${SESSION_READ_PATHS[2]}?tabId=thoughts-long&limit=100`,
    `${SESSION_READ_PATHS[2]}?tabId=thoughts-long&before=invalid`,
    `${SESSION_READ_PATHS[2]}?tabId=thoughts-missing`, SESSION_READ_PATHS[2], queue, SESSION_READ_PATHS[3],
    `${SESSION_READ_PATHS[2]}?tabId=thoughts-worktree-root`,
    `${SESSION_READ_PATHS[1]}?sessionKey=llm-chat:thoughts-worktree-nested`,
  ];
}
export async function seedSessionFixture(directory: string, linkedCheckout = false) {
  writeFileSync(join(directory, 'fixture-owner'), 'o8d-native-read/v1');
  await promisify(execFile)(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx',
    'scripts/next/seed-o8d.ts', directory, ...(linkedCheckout ? ['--linked-checkout'] : [])],
  { env: { ...process.env, O8_NEXT_API_TOKEN: 'ws-parity-fixture-credential' } });
}
export async function startSessionServer(directory: string, nativeSessionReads: boolean, binary: string) {
  const server = await startParityReference({ directory, nativeHttp: true, o8d: true, nativeSessionReads, binary, startupTimeoutMs: 60_000 });
  try { await server.stopNext(); } catch (error) { await server.stop(); throw error; }
  return { ...server, origin: server.url.replace('ws:', 'http:').replace('/ws', '') };
}
type Server = Awaited<ReturnType<typeof startSessionServer>>;
export const IDLE_SETTLE_MS = 20_000;
export async function send(server: Server, path: string, headers: Record<string, string> = {}) {
  const response = await fetch(server.origin + path, { headers: { authorization: `Bearer ${server.token}`, ...headers } });
  return { status: response.status, body: await response.json() as unknown,
    native: response.headers.get('x-o8d-native-session-read') === '1' };
}
export async function backendRss(pid: number) {
  const { stdout } = await promisify(execFile)('ps', ['-eo', 'pid=,ppid=,rss=']);
  const processes = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const pids = new Set([pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [child, parent] of processes) if (pids.has(parent) && !pids.has(child)) { pids.add(child); changed = true; }
  }
  return { kib: processes.filter(([id]) => pids.has(id)).reduce((sum, row) => sum + row[2], 0), processes: pids.size };
}
async function measure(server: Server, paths: string[], native: boolean) {
  const timings: Array<{ path: string; p50Ms: number }> = [];
  for (const path of paths) {
    for (let i = 0; i < 10; i++) await send(server, path);
    const samples: number[] = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      const response = await send(server, path);
      if (response.status !== 200 || response.native !== native) throw new Error(`Benchmark refusal: ${path}`);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    timings.push({ path: path.split('?')[0], p50Ms: samples[49] });
  }
  await new Promise(resolve => setTimeout(resolve, IDLE_SETTLE_MS));
  return { timings, rss: await backendRss(server.pid) };
}
export async function runSessionParity(binary: string, benchmark = true, corpusFile?: string) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-session-parity-')));
  let server: Server | undefined;
  try {
    await seedSessionFixture(directory, true);
    const paths = sessionCorpus(directory);
    const recorded: Array<{ path: string; response: unknown }> = [];
    server = await startSessionServer(directory, false, binary);
    for (const path of paths) {
      const { status, body, native } = await send(server, path);
      if (native) throw new Error('Flag-off request unexpectedly served natively');
      recorded.push({ path, response: normalize({ status, body }) });
    }
    // Replay opaque cursors generated by the TS oracle, rather than rebuilding them.
    for (const index of [5, 10]) {
      const body = (recorded[index].response as { body: { page: { beforeCursor: string } } }).body;
      const path = `${paths[index]}&before=${encodeURIComponent(body.page.beforeCursor)}`;
      const { status, body: page } = await send(server, path);
      recorded.push({ path, response: normalize({ status, body: page }) });
    }
    if (corpusFile) writeFileSync(corpusFile, `${JSON.stringify(recorded, null, 2)}\n`);
    const measuredPaths = [paths[0], paths[5], paths[10], paths[14]];
    const off = benchmark ? await measure(server, measuredPaths, false) : null;
    await server.stop();
    server = undefined;
    server = await startSessionServer(directory, true, binary);
    for (const record of recorded) {
      const { status, body, native } = await send(server, record.path);
      if (!native) throw new Error(`Native session read was not reached: ${record.path.split('?')[0]}`);
      const difference = firstDifference(record.response, normalize({ status, body }));
      if (difference) throw new Error(`Session parity ${record.path.split('?')[0]}: ${difference}`);
    }
    const on = benchmark ? await measure(server, measuredPaths, true) : null;
    return { requests: recorded.length, differences: 0, warmups: 10, samples: 100, idleSettleMs: IDLE_SETTLE_MS, off, on };
  } finally { await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const binary = process.env.O8D_BINARY;
  if (!binary) throw new Error('Set O8D_BINARY to the o8d built with experimental-session-reads');
  const domain = process.argv.find(arg => arg.startsWith('--domain='))?.slice(9) ?? 'session';
  if (!['session', 'repository'].includes(domain)) throw new Error(`Unknown parity domain: ${domain}`);
  const corpus = process.argv.find(arg => arg.startsWith('--corpus='))?.slice(9);
  const result = domain === 'repository'
    ? runRepositoryParity(binary, true, corpus)
    : runSessionParity(binary, true, corpus);
  void result.then(report => {
    const output = process.argv.find(arg => arg.startsWith('--report='))?.slice(9);
    if (output) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  }).catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
