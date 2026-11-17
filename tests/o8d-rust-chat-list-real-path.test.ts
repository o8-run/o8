import { execFile } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';
import { CHAT_LIST_PARAMETERS, DEFAULT_PARITY_SEED, generateRequests, mismatchReceipt, normalize, seedSessionFixture, send, startSessionServer } from '../scripts/o8d/parity';
import { seedChatListEdges } from '../scripts/o8d/chat-list-fixture';

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
  let server: Awaited<ReturnType<typeof startSessionServer>> | undefined;
  try {
    await seedSessionFixture(directory);
    seedChatListEdges(directory);
    const requests = generateRequests({ path: '/api/v2/chat-history/list', parameters: CHAT_LIST_PARAMETERS, count: 500, ...(process.env.O8D_UPDATE_CHAT_LIST_CORPUS === '1' ? { seed: DEFAULT_PARITY_SEED } : {}) });
    const recorded: Array<{ status: number; body: unknown }> = [];
    server = await startSessionServer(directory, false, binary);
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
    await server.stop(); server = undefined;
    if (process.env.O8D_CHAT_LIST_CAPTURE_ONLY === '1') return;
    server = await startSessionServer(directory, true, binary);
    for (const request of requests) {
      const response = await send(server, request.path);
      expect(response.native, `Native route was not reached: /api/v2/chat-history/list; seed=${request.seed} case=${request.caseIndex}`).toBe(true);
      const difference = mismatchReceipt(request, recorded[request.caseIndex], { status: response.status, body: normalize(response.body) });
      expect(difference, difference ? JSON.stringify(difference) : undefined).toBeNull();
    }
  } finally { await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 300_000);
