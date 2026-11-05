/** Repository-read oracle through production WS middleware and registry wiring. */
import { execFile } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startParityReference } from '../../tests/fixtures/ws-parity-server';
import { backendRss, firstDifference, IDLE_SETTLE_MS, normalize } from './parity';

export const REPOSITORY_READ_PATH = '/api/panel/branches';
export function repositoryCorpus(directory: string) {
  const read = (path: string) => `${REPOSITORY_READ_PATH}?${new URLSearchParams({ path })}`;
  return [
    REPOSITORY_READ_PATH,
    `${REPOSITORY_READ_PATH}?path=&path=${encodeURIComponent(join(directory, 'fixture-repo'))}`,
    read(join(directory, 'missing-repository')),
    read(join(directory, 'non-repository')),
    read(join(directory, 'unborn-repository')),
    read(join(directory, 'fixture-repo')),
    read(join(directory, 'repository-worktree')),
    read(join(directory, 'repository-worktree', 'nested')),
    read(join(directory, 'bare-repository')),
    read(join(directory, 'fixture-repo', '.git')),
    read(join(directory, 'repository-link')),
    read(join(directory, 'non-repository-link')),
  ];
}

export async function seedRepositoryFixture(directory: string) {
  writeFileSync(join(directory, 'fixture-owner'), 'o8d-native-read/v1');
  await promisify(execFile)(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx',
    'scripts/next/seed-o8d.ts', directory, '--repository-reads'],
  { env: { ...process.env, O8_NEXT_API_TOKEN: 'ws-parity-fixture-credential' } });
}

export async function startRepositoryServer(directory: string, nativeRepositoryReads: boolean, binary: string) {
  const server = await startParityReference({ directory, nativeHttp: true, o8d: true, nativeRepositoryReads, binary, startupTimeoutMs: 60_000 });
  try { await server.stopNext(); } catch (error) { await server.stop(); throw error; }
  return { ...server, origin: server.url.replace('ws:', 'http:').replace('/ws', '') };
}
type Server = Awaited<ReturnType<typeof startRepositoryServer>>;

export async function sendRepository(server: Server, path: string, headers: Record<string, string> = {}) {
  const response = await fetch(server.origin + path, { headers: { authorization: `Bearer ${server.token}`, ...headers } });
  return { status: response.status, body: await response.json() as unknown,
    native: response.headers.get('x-o8d-native-repository-read') === '1' };
}

async function measure(server: Server, path: string, native: boolean) {
  for (let index = 0; index < 10; index++) await sendRepository(server, path);
  const samples: number[] = [];
  for (let index = 0; index < 100; index++) {
    const start = performance.now();
    const response = await sendRepository(server, path);
    if (response.status !== 200 || response.native !== native) throw new Error(`Repository benchmark refusal: ${path}`);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  await new Promise(resolve => setTimeout(resolve, IDLE_SETTLE_MS));
  return { timings: [{ path: REPOSITORY_READ_PATH, p50Ms: samples[49] }], rss: await backendRss(server.pid) };
}

export async function runRepositoryParity(binary: string, benchmark = true, corpusFile?: string) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-repository-parity-')));
  let server: Server | undefined;
  try {
    await seedRepositoryFixture(directory);
    const paths = repositoryCorpus(directory);
    const recorded: Array<{ path: string; response: unknown }> = [];
    server = await startRepositoryServer(directory, false, binary);
    for (const path of paths) {
      const { status, body, native } = await sendRepository(server, path);
      if (native) throw new Error('Flag-off repository request unexpectedly served natively');
      recorded.push({ path, response: normalize({ status, body }) });
    }
    if (corpusFile) writeFileSync(corpusFile, `${JSON.stringify(recorded, null, 2)}\n`);
    const off = benchmark ? await measure(server, paths[5], false) : null;
    await server.stop(); server = undefined;
    server = await startRepositoryServer(directory, true, binary);
    for (const record of recorded) {
      const { status, body, native } = await sendRepository(server, record.path);
      if (!native) throw new Error(`Native repository read was not reached: ${record.path}`);
      const difference = firstDifference(record.response, normalize({ status, body }));
      if (difference) throw new Error(`Repository parity ${record.path}: ${difference}`);
    }
    const on = benchmark ? await measure(server, paths[5], true) : null;
    return { requests: recorded.length, differences: 0, warmups: 10, samples: 100, idleSettleMs: IDLE_SETTLE_MS, off, on };
  } finally { await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
}
