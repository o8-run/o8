import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { seedSessionFixture } from '../scripts/o8d/parity';
import { startParityReference } from './fixtures/ws-parity-server';

it('uses the current canonical operator token after a same-size same-mtime rotation', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-prompt-auth-authority-')));
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    await seedSessionFixture(directory);
    const tokenPath = join(directory, 'ws-token');
    const oldToken = 'a'.repeat(64);
    const newToken = 'b'.repeat(64);
    const date = new Date('2026-01-01T00:00:00.000Z');
    writeFileSync(tokenPath, oldToken); utimesSync(tokenPath, date, date);
    server = await startParityReference({ directory, nativeHttp: true, productFrontDoor: true, o8d: false, nativeSessionReads: 'default' });
    await server.stopNext();
    writeFileSync(tokenPath, oldToken); utimesSync(tokenPath, date, date);
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const call = (token: string) => fetch(origin + '/api/prompt-library', { headers: { authorization: 'Bearer ' + token } });
    const unrelated = (token: string) => fetch(origin + '/api/runtime/service-tiers?backend=fixture', { headers: { authorization: 'Bearer ' + token, connection: 'close' } });
    expect((await unrelated(oldToken)).status).toBe(200);
    expect((await call(oldToken)).status).toBe(200);
    const before = statSync(tokenPath);
    writeFileSync(tokenPath, newToken); utimesSync(tokenPath, date, date);
    const after = statSync(tokenPath);
    expect(after.size).toBe(before.size); expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(tokenPath, 'utf8') === newToken).toBe(true);
    const oldStatus = (await call(oldToken)).status;
    const newStatus = (await call(newToken)).status;
    // No credential bytes in assertion output; the canonical file has rotated.
    expect({ oldStatus, newStatus }).toEqual({ oldStatus: 401, newStatus: 200 });
    for (const [method, path, status] of [
      ['GET', '/api/prompt-library/missing', 404], ['POST', '/api/prompt-library', 400],
      ['PATCH', '/api/prompt-library/missing', 404], ['DELETE', '/api/prompt-library/missing', 404],
    ] as const) {
      for (const [token, expected] of [[oldToken, 401], [newToken, status]] as const) {
        const response = await fetch(origin + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(method === 'POST' || method === 'PATCH' ? { body: '{}' } : {}) });
        expect(response.status).toBe(expected);
      }
    }
    for (const extra of [{ origin: 'https://foreign.invalid' }, { 'user-agent': 'Mozilla/fixture' }] as Record<string, string>[]) {
      expect((await fetch(origin + '/api/prompt-library', { method: 'POST', headers: { authorization: 'Bearer ' + newToken, 'content-type': 'application/json', ...extra }, body: '{}' })).status).toBe(403);
    }
    // Prompt verification must not update the cache retained by unrelated routes.
    expect((await unrelated(oldToken)).status).toBe(200);
    expect((await unrelated(newToken)).status).toBe(401);
    // Retain missing-file WS_TOKEN provisioning, but an unreadable authority
    // must not silently become an environment-token authorization.
    rmSync(tokenPath);
    expect((await call(server.token)).status).toBe(200);
    expect(statSync(directory).isDirectory()).toBe(true);
    mkdirSync(tokenPath);
    expect((await call(server.token)).status).toBe(401);


  } finally { await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 180_000);
