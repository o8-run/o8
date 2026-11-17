import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from 'node:http';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { seedSessionFixture } from '../scripts/o8d/parity';
import { startParityReference } from './fixtures/ws-parity-server';

// The verification-only fixture patch adds POST to an existing table route and
// a byte-echo Rust handler. Neither belongs in the production route inventory.
const buildDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-write-fixture-')));
const binary = join(buildDirectory, 'o8d-write-fixture');
beforeAll(async () => {
  await promisify(execFile)(process.execPath, [
    'scripts/o8d/build-write-fixture.mjs', process.cwd(),
    process.env.CARGO_TARGET_DIR ?? resolve('crates/o8d/target'), binary,
  ], { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
}, 310_000);
afterAll(() => rmSync(buildDirectory, { recursive: true, force: true }));

// Withhold the body: an unauthorized request must be refused from its head,
// even when its declared length exceeds the native limit. Pumping 17 MiB via
// fetch races the canonical listener's early close and can surface ECONNRESET
// instead of its response. Do not retry that race or send Expect (which would
// deliberately bypass native admission).
function refusedOversizedHead(origin: string, path: string) {
  return new Promise<{ status: number | undefined; native: string | string[] | undefined; body: string }>((resolve, reject) => {
    const pending = request(new URL(path, origin), { method: 'POST', headers: {
      authorization: 'Bearer wrong', 'x-o8d-session-read': 'authorize',
      'x-o8d-bridge': 'spoofed', 'content-length': String(16 * 1024 * 1024 + 1),
    } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('error', reject);
      response.once('end', () => {
        resolve({ status: response.statusCode, native: response.headers['x-o8d-native'],
          body: Buffer.concat(chunks).toString('utf8') });
        pending.destroy();
      });
    });
    pending.once('error', reject);
    pending.setTimeout(10_000, () => pending.destroy(new Error('Admission waited for an unauthorized body')));
    pending.flushHeaders();
  });
}

it('threads POST bytes into native dispatch, bounds bodies, and replays a buffered fallback exactly', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-native-write-')));
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  const tableFile = resolve('crates/o8d/native-routes.json');
  const tableBefore = readFileSync(tableFile, 'utf8');
  try {
    await seedSessionFixture(directory);
    server = await startParityReference({ directory, nativeHttp: true, o8d: true,
      nativeSessionReads: true, binary, preload: resolve('tests/fixtures/write-fixture-preload.cjs') });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const path = '/api/v2/chat-history';
    const headers = { authorization: `Bearer ${server.token}` };
    const corpus = JSON.parse(readFileSync(resolve('crates/o8d/evidence/write-path/corpus.json'), 'utf8')) as {
      cases: Array<{ case: string; method: string; path: string; body: { bytes: number; fill: string };
        response: { status: number; native: boolean; body: unknown } }>;
      typescriptFallback: { response: { body: unknown } };
    };
    for (const record of corpus.cases) {
      const response = await fetch(origin + record.path, { method: record.method, headers,
        body: Buffer.alloc(record.body.bytes, record.body.fill) });
      expect(response.headers.get('x-o8d-native') === '1', `Native route was not reached: ${record.case}`).toBe(record.response.native);
      expect(response.status).toBe(record.response.status);
      expect(await response.json()).toEqual(record.response.body);
    }
    const saved = { tabId: 'thoughts-native-write-fallback', backend: 'claude', model: 'claude-code', repoPath: join(directory, 'fixture-repo'),
      messages: [{ id: 'fixture-write-message', role: 'user', content: 'fallback body '.repeat(90), timestamp: 1790812800000 }] };
    const fallback = await fetch(origin + path + '?fixtureFallback=1', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(saved) });
    expect(fallback.headers.get('x-o8d-native')).toBeNull();
    expect(fallback.status).toBe(200);
    expect(await fallback.json()).toEqual(corpus.typescriptFallback.response.body);
    expect(JSON.parse(readFileSync(join(directory, 'chat-history', saved.tabId + '.json'), 'utf8')).messages).toEqual(saved.messages);
    const read = await fetch(origin + path + '?tabId=thoughts-review', { headers });
    expect(read.status).toBe(200);
    expect(read.headers.get('x-o8d-native')).toBe('1');
    await read.arrayBuffer();
    const denied = await refusedOversizedHead(origin, path);
    expect(denied.status).toBe(401);
    expect(denied.native).toBeUndefined();
    await server.stop(); server = undefined;
    server = await startParityReference({ directory, nativeHttp: true, o8d: true,
      nativeSessionReads: false, binary, preload: resolve('tests/fixtures/write-fixture-preload.cjs') });
    await server.stopNext();
    const referenceOrigin = server.url.replace('ws:', 'http:').replace('/ws', '');
    expect(await refusedOversizedHead(referenceOrigin, path)).toEqual(denied);
  } finally {
    await server?.stop();
    rmSync(directory, { recursive: true, force: true });
    expect(readFileSync(tableFile, 'utf8')).toBe(tableBefore);
  }
}, 180_000);
