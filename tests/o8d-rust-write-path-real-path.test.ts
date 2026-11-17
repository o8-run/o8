import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
    const post = await fetch(origin + path, { method: 'POST', headers, body: Buffer.alloc(1024, 'a') });
    expect(post.headers.get('x-o8d-native'), `Native route was not reached: ${path}`).toBe('1');
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual({ method: 'POST', bytes: 1024, allA: true });
    const big = await fetch(origin + path, { method: 'POST', headers, body: Buffer.alloc(16 * 1024 * 1024 + 1, 'a') });
    expect(big.status).toBe(413);
    expect(big.headers.get('x-o8d-native')).toBe('1');
    expect(await big.json()).toMatchObject({ error: expect.any(String) });
    const saved = { tabId: 'thoughts-native-write-fallback', backend: 'claude', model: 'claude-code', repoPath: join(directory, 'fixture-repo'),
      messages: [{ id: 'fixture-write-message', role: 'user', content: 'fallback body '.repeat(90), timestamp: 1790812800000 }] };
    const fallback = await fetch(origin + path + '?fixtureFallback=1', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(saved) });
    expect(fallback.headers.get('x-o8d-native')).toBeNull();
    expect(fallback.status).toBe(200);
    await fallback.arrayBuffer();
    expect(JSON.parse(readFileSync(join(directory, 'chat-history', saved.tabId + '.json'), 'utf8')).messages).toEqual(saved.messages);
    const read = await fetch(origin + path + '?tabId=thoughts-review', { headers });
    expect(read.status).toBe(200);
    expect(read.headers.get('x-o8d-native')).toBe('1');
    await read.arrayBuffer();
    const denied = await fetch(origin + path, { method: 'POST', headers: { authorization: 'Bearer wrong', 'x-o8d-session-read': 'authorize', 'x-o8d-bridge': 'spoofed' }, body: Buffer.alloc(1024, 'a') });
    expect(denied.status).toBe(401);
    expect(denied.headers.get('x-o8d-native')).toBeNull();
    await denied.arrayBuffer();
  } finally {
    await server?.stop();
    rmSync(directory, { recursive: true, force: true });
    expect(readFileSync(tableFile, 'utf8')).toBe(tableBefore);
  }
}, 180_000);
