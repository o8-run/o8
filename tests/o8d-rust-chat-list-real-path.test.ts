import { execFile } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';
import { CHAT_LIST_PARAMETERS, DEFAULT_PARITY_SEED, generateRequests, mismatchReceipt, normalize, seedSessionFixture, send } from '../scripts/o8d/parity';
import { startParityReference } from './fixtures/ws-parity-server';
import { seedChatListEdges } from '../scripts/o8d/chat-list-fixture';

async function startProductSessionServer(directory: string, native: boolean, binary: string) {
  const server = await startParityReference({ directory, nativeHttp: true, productFrontDoor: true,
    o8d: native, nativeSessionReads: 'default', binary });
  try { await server.stopNext(); } catch (error) { await server.stop(); throw error; }
  return { ...server, origin: server.url.replace('ws:', 'http:').replace('/ws', '') };
}

const corpusPath = join(process.cwd(), 'crates/o8d/evidence/chat-list/corpus.json');
function portable(value: unknown, directory: string): unknown {
  if (typeof value === 'string') return value.split(directory).join('$FIXTURE_ROOT');
  if (Array.isArray(value)) return value.map(item => portable(item, directory));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portable(item, directory)]));
  return value;
}

const targetDir = join(process.cwd(), 'crates/o8d/target/session-reads');
const binary = process.env.O8D_TEST_BINARY ?? process.env.O8D_BINARY ?? join(targetDir, 'debug', process.platform === 'win32' ? 'o8d.exe' : 'o8d');
beforeAll(async () => {
  if (process.env.O8D_TEST_BINARY || process.env.O8D_BINARY) return;
  await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--target-dir', targetDir],
    { maxBuffer: 64 * 1024 * 1024 });
}, 900_000);

it('matches the TypeScript chat-list oracle on 500 seeded requests through the public socket with Next stopped', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-chat-list-parity-')));
  let server: Awaited<ReturnType<typeof startProductSessionServer>> | undefined;
  try {
    await seedSessionFixture(directory);
    seedChatListEdges(directory);
    const initialFiles = Object.fromEntries(readdirSync(join(directory, 'chat-history')).map(file => [file, readFileSync(join(directory, 'chat-history', file), 'utf8')]));
    const initialTimes = Object.fromEntries(readdirSync(join(directory, 'chat-history')).map(file => [file, statSync(join(directory, 'chat-history', file))]));
    const requests = generateRequests({ path: '/api/v2/chat-history/list', parameters: CHAT_LIST_PARAMETERS, count: 500, ...(process.env.O8D_UPDATE_CHAT_LIST_CORPUS === '1' ? { seed: DEFAULT_PARITY_SEED } : {}) });
    const recorded: Array<{ status: number; body: unknown }> = [];
    server = await startProductSessionServer(directory, false, binary);
    for (const request of requests) {
      const response = await send(server, request.path);
      expect(response.native).toBe(false);
      recorded.push({ status: response.status, body: normalize(response.body) });
    }
    const captured = { version: 1, route: '/api/v2/chat-history/list', seed: requests[0].seed,
      fixtureRoot: '$FIXTURE_ROOT', requests: requests.map(request => ({ ...request, response: portable(recorded[request.caseIndex], directory) })) };
    if (process.env.O8D_UPDATE_CHAT_LIST_CORPUS === '1') {
      mkdirSync(join(corpusPath, '..'), { recursive: true });
      const { requests: cases, ...metadata } = captured;
      writeFileSync(corpusPath, `${JSON.stringify(metadata).slice(0, -1)},\n"requests":[\n${cases.map(item => JSON.stringify(item)).join(',\n')}\n]}\n`);
    }
    const frozen = JSON.parse(readFileSync(corpusPath, 'utf8')) as typeof captured;
    // An override seed still gets the live 500-case differential; the fixed
    // default additionally checks the committed TypeScript oracle for drift.
    if (requests[0].seed === frozen.seed) expect(captured).toEqual(frozen);
    expect(Object.fromEntries(readdirSync(join(directory, 'chat-history')).map(file => [file, readFileSync(join(directory, 'chat-history', file), 'utf8')]))).toEqual(initialFiles);
    await server.stop(); server = undefined;
    // Replay from the saved initial files, never from a TS-cleaned store.
    rmSync(join(directory, 'chat-history'), { recursive: true });
    mkdirSync(join(directory, 'chat-history'));
    for (const [file, content] of Object.entries(initialFiles)) {
      const path = join(directory, 'chat-history', file);
      writeFileSync(path, content);
      utimesSync(path, initialTimes[file].atime, initialTimes[file].mtime);
    }
    if (process.env.O8D_CHAT_LIST_CAPTURE_ONLY === '1') return;
    server = await startProductSessionServer(directory, true, binary);
    for (const request of requests) {
      const response = await send(server, request.path);
      expect(response.native, `Native route was not reached: /api/v2/chat-history/list; seed=${request.seed} case=${request.caseIndex}`).toBe(true);
      const difference = mismatchReceipt(request, recorded[request.caseIndex], { status: response.status, body: normalize(response.body) });
      expect(difference, difference ? JSON.stringify(difference) : undefined).toBeNull();
    }
    expect(Object.fromEntries(readdirSync(join(directory, 'chat-history')).map(file => [file, readFileSync(join(directory, 'chat-history', file), 'utf8')]))).toEqual(initialFiles);
  } finally { await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 300_000);


it('defers expired empty-placeholder cleanup to the canonical TS writer through the public socket', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-chat-list-gc-')));
  let server: Awaited<ReturnType<typeof startProductSessionServer>> | undefined;
  try {
    await seedSessionFixture(directory);
    server = await startProductSessionServer(directory, true, binary);
    const path = join(directory, 'chat-history', 'mobile-chat-gc.json');
    const seed = (fields: Record<string, unknown>, old: boolean) => {
      writeFileSync(path, JSON.stringify({ title: 'Synthetic placeholder', messages: [], ...fields }));
      const time = new Date(Date.now() - (old ? 7_200_000 : 0));
      utimesSync(path, time, time);
    };
    seed({}, false);
    expect((await send(server, '/api/v2/chat-history/list')).native).toBe(true);
    expect(existsSync(path)).toBe(true);
    for (const fields of [{ pinned: true }, { starred: true }, { orchestratorVisible: true }]) {
      seed(fields, true);
      expect((await send(server, '/api/v2/chat-history/list?include=orchestrator')).native).toBe(true);
      expect(existsSync(path)).toBe(true);
    }
    // GC runs before search/archive filtering; neither may suppress the write.
    for (const query of ['', '?q=no-match&archived=only', '?include=orchestrator']) {
      seed({}, true);
      const response = await send(server, `/api/v2/chat-history/list${query}`);
      expect(response.status).toBe(200);
      expect(response.native, 'Expired empty record must reach the canonical cleanup writer').toBe(false);
      expect(existsSync(path), 'Canonical cleanup must delete the expired record').toBe(false);
    }
    seed({}, false);
    expect((await send(server, '/api/v2/chat-history/list')).native).toBe(true);
    expect(existsSync(path)).toBe(true);
  } finally { await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 120_000);
