import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
const device = 'llm-fixture-device';
const worker = 'llm-fixture-worker';
const spectator = 'llm-fixture-spectator';
const forged = { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1' };
function post(token: string, model = 'fixture', extra: Record<string, string> = {}) {
  return fetch(`${origin}/api/v2/proxy/llm`, { method: 'POST', headers: {
    ...forged, ...extra, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
  }, body: JSON.stringify({ provider: 'openai', model, disableTools: true,
    messages: [{ role: 'user', content: 'fixture' }, { role: 'assistant', content: 'prior' }] }) });
}
beforeAll(async () => {
  server = await startParityReference({ o8d: true, nativeHttp: true, preload: resolve('tests/fixtures/llm-native-preload.cjs') });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  writeFileSync(join(server.directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(server.directory, 'worker-token'), worker);
  writeFileSync(join(server.directory, 'broadcast-spectator-tokens'), createHash('sha256').update(spectator).digest('hex'));
}, 120_000);
afterAll(async () => { await server?.stop(); });
it('preserves middleware admission despite forged addresses and relay markers', async () => {
  for (const extra of [{}, { 'x-o8-relay-forward': '1' }] as Record<string, string>[]) {
    for (const [token, status] of [['', 401], ['wrong', 401], [worker, 403], [spectator, 403]] as const) {
      expect((await post(token, 'fixture', extra)).status).toBe(status);
    }
    for (const token of [server.token, device]) {
      const response = await post(token, 'fixture', extra);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('first');
      expect(text).toContain('second');
      expect(text).not.toContain('llm-fixture-provider-secret');
    }
  }
});
it('delivers the first stream event before upstream completion', async () => {
  const response = await post(device);
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain('first');
  expect(first).not.toContain('second');
  let rest = '';
  while (true) { const chunk = await reader.read(); if (chunk.done) break; rest += new TextDecoder().decode(chunk.value); }
  expect(rest).toContain('second');
});
it('does not echo provider credentials from upstream errors or diagnostics', async () => {
  const response = await post(server.token, 'fixture-error');
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain('llm-fixture-provider-secret');
  expect(server.diagnostics().stderr).not.toContain('llm-fixture-provider-secret');
});
