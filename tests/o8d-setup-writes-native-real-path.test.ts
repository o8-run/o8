import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

it('permits only the operator to persist MCP and OpenCode setup without returning credentials', async () => {
  const saved = { ...process.env };
  const server = await startParityReference({ o8d: true, nativeHttp: true });
  try {
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const device = 'setup-fixture-device';
    const worker = 'setup-fixture-worker';
    const secret = 'setup-fixture-env-secret';
    writeFileSync(join(server.directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
    writeFileSync(join(server.directory, 'worker-token'), worker);
    const call = (path: string, token: string, body: unknown, relay = false, method = 'POST') => fetch(`${origin}/api/setup/${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1',
        'x-o8-client-addr': '127.0.0.1', ...(relay ? { 'x-o8-relay-forward': '1' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    });
    const input = { name: 'Fixture', transport: 'stdio', command: 'fixture-command', env: { FIXTURE_SECRET: secret }, workerInjection: true };
    for (const path of ['mcp-servers', 'opencode']) {
      for (const [token, status] of [['', 401], ['wrong', 401], [device, 403], [worker, 403]] as const) {
        expect((await call(path, token, input)).status).toBe(status);
        expect((await call(path, token, input, true)).status).toBe(status);
      }
    }
    const configPath = join(server.directory, '.config', 'opencode', 'opencode.json');
    expect(existsSync(configPath)).toBe(false);
    const created = await call('mcp-servers', server.token, input);
    expect(created.status).toBe(200);
    const response = await created.text();
    expect(response).not.toContain(secret);
    expect(JSON.parse(response)).toMatchObject({ ok: true, server: { name: 'Fixture', env: null, oauthToken: null } });
    const listing = await call('mcp-servers', server.token, {}, false, 'GET');
    expect(await listing.text()).not.toContain(secret);
    const installed = await call('opencode', server.token, {});
    expect(installed.status).toBe(200);
    expect(await installed.text()).not.toContain(server.token);
    const config = readFileSync(configPath, 'utf8');
    expect(JSON.parse(config).mcp.o8.environment.O8_DATA_DIR).toBe(server.directory);
    expect(JSON.parse(config).mcp.o8.command.join(' ')).toContain('operator-mcp-proxy');
    const preview = await call('opencode', server.token, {}, false, 'GET');
    expect(preview.status).toBe(200);
    expect(await preview.text()).not.toContain(server.token);
    Object.assign(process.env, { O8_NEXT_O8D: '1', O8_WS_PORT: new URL(origin).port });
    const { registerSymonMcpCacheInvalidator } = await import('@/lib/mcp/symon-tools-cache');
    let localInvalidations = 0;
    const unregister = registerSymonMcpCacheInvalidator(() => { localInvalidations++; });
    try {
      const next = await import('@/app/api/setup/mcp-servers/route');
      const forwarded = await next.POST(new Request('http://127.0.0.1/api/setup/mcp-servers', {
        method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json', 'x-o8-client-addr': '127.0.0.1' },
        body: JSON.stringify({ ...input, name: 'Forwarded' }),
      }));
      expect(forwarded.status).toBe(200);
      expect(await forwarded.text()).not.toContain(secret);
      expect(localInvalidations).toBe(0);
    } finally { unregister(); }
    expect(server.diagnostics().stderr).not.toContain(secret);
    expect(server.diagnostics().stderr).not.toContain(server.token);
  } finally {
    await server.stop();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}, 180_000);
