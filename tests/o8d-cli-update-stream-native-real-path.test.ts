import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
beforeAll(async () => {
  server = await startParityReference({ o8d: true, nativeHttp: true, preload: './tests/fixtures/ws-parity-cli-update.cjs' });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  writeFileSync(join(server.directory, 'mobile-device-tokens'), createHash('sha256').update('cli-fixture-device').digest('hex'));
  writeFileSync(join(server.directory, 'worker-token'), 'cli-fixture-worker');
}, 120_000);
afterAll(async () => { await server?.stop(); });
const post = (signal?: AbortSignal) => fetch(`${origin}/api/setup/cli-updates`, { method: 'POST', signal,
  headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json', accept: 'text/event-stream' },
  body: JSON.stringify({ runtime: 'claude-code' }),
});
const receipt = () => JSON.parse(readFileSync(join(server.directory, 'claude-code-cli-update.json'), 'utf8'));
const assertClean = async () => {
  await expect.poll(() => receipt().status, { timeout: 15_000 }).toBe('succeeded');
  expect(existsSync(join(server.directory, 'claude-code-cli-update.lock'))).toBe(false);
  const pid = Number(readFileSync(join(server.directory, 'fixture-installer-pid'), 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow();
  expect(realpathSync(join(server.directory, '.local/bin/claude'))).toBe(join(server.directory, '.local/share/claude/versions/2.0.2'));
};
it('keeps installation operator-only through the native gate', async () => {
  for (const [token, status] of [['', 401], ['wrong', 401], ['o8ro_fixture', 403], ['cli-fixture-device', 403], ['cli-fixture-worker', 403]] as const) {
    const response = await fetch(`${origin}/api/setup/cli-updates`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-o8-client-addr': '127.0.0.1', ...(token ? { authorization: `Bearer ${token}` } : {}),
    }, body: JSON.stringify({ runtime: 'claude-code' }) });
    expect(response.status).toBe(status);
  }
  expect(existsSync(join(server.directory, 'fixture-installer-pid'))).toBe(false);
});
it('completes the installer progress stream through o8d with Next stopped', async () => {
  const response = await post();
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const text = await response.text();
  expect(text).toContain('event: progress');
  expect(text).toContain('event: result');
  expect(text).toContain('"status":"succeeded"');
  await assertClean();
});
it('finishes and cleans the owned installer after the socket disconnects', async () => {
  // Restore the fixture's selected version so a second installation is required.
  const { symlinkSync } = await import('node:fs');
  unlinkSync(join(server.directory, '.local/bin/claude'));
  symlinkSync(join(server.directory, '.local/share/claude/versions/2.0.1'), join(server.directory, '.local/bin/claude'));
  if (existsSync(join(server.directory, 'claude-code-cli-update.json'))) unlinkSync(join(server.directory, 'claude-code-cli-update.json'));
  const abort = new AbortController();
  const response = await post(abort.signal);
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: progress');
  abort.abort();
  await reader.cancel().catch(() => {});
  await assertClean();
  expect((await fetch(`${origin}/api/setup/status`, { headers: { authorization: `Bearer ${server.token}` } })).status).toBe(200);
});
