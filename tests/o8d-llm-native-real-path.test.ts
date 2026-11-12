import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
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
  server = await startParityReference({ o8d: true, nativeHttp: true, preload: resolve('tests/fixtures/llm-native-preload.cjs'), entry: resolve('tests/fixtures/llm-plan-owner-entry.mjs'), startupTimeoutMs: 120_000 });
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

it('keeps account controls and inference in one owner', async () => {
  const { NextRequest } = await import('next/server');
  const { POST } = await import('@/app/api/v2/proxy/llm/route');
  const account = await import('@/app/api/panel/models/chatgpt/route');
  const saved = { ...process.env };
  Object.assign(process.env, { O8_NEXT_O8D: '1', O8_WS_PORT: new URL(origin).port });
  const headers = { authorization: `Bearer ${server.token}`, 'x-clerk-session-token': readFileSync(join(server.directory, 'fixture-session'), 'utf8'),
    host: '127.0.0.1', 'x-o8-client-addr': '127.0.0.1', 'content-type': 'application/json' };
  try {
    const status = await account.GET(new NextRequest('http://127.0.0.1/api/panel/models/chatgpt', { headers }));
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ connected: true, activeId: 'fixture-account' });
    const welcome = await account.POST(new NextRequest('http://127.0.0.1/api/panel/models/chatgpt', { method: 'POST', headers, body: JSON.stringify({ action: 'welcome' }) }));
    expect(await welcome.json()).toEqual({ ok: true });
    const response = await POST(new NextRequest('http://127.0.0.1/api/v2/proxy/llm', { method: 'POST', headers,
      body: JSON.stringify({ provider: 'chatgpt', model: 'fixture', disableTools: true, messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'prior' }] }) }));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('first');
    const disconnected = await account.DELETE(new NextRequest('http://127.0.0.1/api/panel/models/chatgpt', { method: 'DELETE', headers }));
    expect(await disconnected.json()).toEqual({ revocationConfirmed: true });
    const ending = (async () => { let text = ''; while (true) { const part = await reader.read(); if (part.done) return text; text += new TextDecoder().decode(part.value); } })();
    expect(await Promise.race([ending, new Promise((_, reject) => setTimeout(() => reject(new Error('Stream did not end after disconnect')), 5000))])).not.toContain('plan-fixture-secret');
    expect(server.diagnostics().stderr).not.toMatch(/plan-fixture-secret|plan-refresh-secret/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}, 20_000);
it('preserves admission and shapes for every sibling method', async () => {
  for (const [path, method, allowedDevice, allowedWorker] of [
    ['/api/panel/models/chatgpt', 'GET', false, false], ['/api/panel/models/chatgpt', 'POST', false, false],
    ['/api/panel/models/chatgpt', 'DELETE', false, false], ['/api/panel/approvals', 'GET', true, true],
    ['/api/panel/approvals', 'POST', true, false], ['/api/mobile/action', 'POST', true, false],
  ] as const) {
    for (const extra of [{}, { 'x-o8-relay-forward': '1' }] as Record<string, string>[] ) {
      for (const token of ['', 'wrong', device, worker, server.token]) {
        const response = await fetch(`${origin}${path}`, { method, headers: { ...forged, ...extra, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          ...(method === 'GET' ? {} : { body: '{}' }) });
        if (!token || token === 'wrong') expect(response.status).toBe(401);
        else if ((token === device && !allowedDevice) || (token === worker && !allowedWorker)) expect(response.status).toBe(403);
        else if (path === '/api/panel/models/chatgpt') expect(response.status).toBe(401);
        else if (path === '/api/panel/approvals' && method === 'GET') expect(response.status).toBe(token === worker ? 403 : 200);
        else expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).not.toMatch(/plan-fixture-secret|plan-refresh-secret/);
        const payload = JSON.parse(text);
        if (response.status === 200) expect(payload.approvals).toEqual(expect.any(Array));
        else expect(payload).toHaveProperty('error');
      }
    }
  }
});

it('keeps granted approval reads bound to the worker packet', async () => {
  const token = readFileSync(join(server.directory, 'fixture-packet-worker'), 'utf8');
  for (const [packet, status] of [['fixture-packet', 200], ['other-packet', 403]] as const) {
    const response = await fetch(`${origin}/api/panel/approvals?packetId=${packet}`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(status);
    if (status === 200) expect(await response.json()).toMatchObject({ approvals: [] });
  }
});
