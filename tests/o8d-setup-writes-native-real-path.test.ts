import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

it('permits only the operator to persist MCP and OpenCode setup without returning credentials', async () => {
  const saved = { ...process.env };
  // The server writes OpenCode config under XDG_CONFIG_HOME when it is set (as on
  // Linux runners). Clear it so the write lands in the fixture's HOME, never the host's.
  delete process.env.XDG_CONFIG_HOME;
  const server = await startParityReference({ o8d: true, nativeHttp: true, preload: './tests/fixtures/ws-setup-cache-observer.cjs' });
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
    Object.assign(process.env, { CORTEX_IDE_DATA_DIR: server.directory, CORTEX_IDE_DB_PATH: join(server.directory, 'cortex-ide.db'), WS_TOKEN: server.token });
    delete process.env.O8_DATA_DIR;
    const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
    const boundWorker = mintPacketWorkerToken('setup-packet');
    const { getSpectatorTokenStore } = await import('@/lib/broadcast/spectator-token-store');
    const spectator = getSpectatorTokenStore().mint({ repoGrants: [server.directory] });
    const { getSqlite } = await import('@/lib/db');
    const sqlite = getSqlite();
    const input = { name: 'Fixture', transport: 'stdio', command: process.execPath, args: [join(process.cwd(), 'tests/fixtures/ws-setup-mcp-server.cjs')], symonInjection: true, env: { FIXTURE_SECRET: secret }, workerInjection: true };
    for (const path of ['mcp-servers', 'opencode']) {
      for (const [token, status] of [['', 401], ['wrong', 401], [device, 403], [worker, 403], [boundWorker, 403], [spectator.bearer, 403]] as const) {
        expect((await call(path, token, input)).status).toBe(status);
        expect((await call(path, token, input, true)).status).toBe(status);
        if (path === 'mcp-servers') for (const method of ['PATCH', 'DELETE']) {
          expect((await call(path, token, input, false, method)).status).toBe(status);
          expect((await call(path, token, input, true, method)).status).toBe(status);
        }
      }
    }
    const configPath = join(server.directory, '.config', 'opencode', 'opencode.json');
    expect(existsSync(configPath)).toBe(false);
    const created = await call('mcp-servers', server.token, input);
    expect(created.status).toBe(200);
    const response = await created.text();
    expect(response).not.toContain(secret);
    expect(JSON.parse(response)).toMatchObject({ ok: true, server: { name: 'Fixture', env: null, oauthToken: null } });
    const id = JSON.parse(response).server.id;
    const oauth = 'setup-fixture-oauth-secret';
    sqlite.prepare('UPDATE external_mcp_servers SET oauth_token = ? WHERE id = ?').run(oauth, id);
    Object.assign(process.env, { O8_NEXT_O8D: '1', O8_WS_PORT: new URL(origin).port });
    // Load the real WS tool catalog, which registers its session/cache invalidator.
    const catalog = await fetch(`${origin}/api/symon/mcp/tools`, { headers: { authorization: `Bearer ${server.token}` } });
    expect(catalog.status).toBe(200);
    expect((await catalog.json()).tools).toHaveLength(1);
    const invalidations = () => existsSync(join(server.directory, 'cache-invalidations'))
      ? readFileSync(join(server.directory, 'cache-invalidations'), 'utf8').split('cleared\n').length - 1 : 0;
    const beforePatch = invalidations();
    const setupRoute = await import('@/app/api/setup/mcp-servers/route');
    const patched = await setupRoute.PATCH(new Request('http://127.0.0.1/api/setup/mcp-servers', {
      method: 'PATCH', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id, enabled: false }),
    }));
    expect(patched.status).toBe(200);
    expect(invalidations()).toBe(beforePatch + 1);
    const patchText = await patched.text();
    expect(patchText).not.toContain(secret);
    expect(patchText).not.toContain(oauth);
    expect(JSON.parse(patchText).server).toMatchObject({ env: null, envJson: null, oauthToken: null });
    const listing = await call('mcp-servers', server.token, {}, false, 'GET');
    const listText = await listing.text();
    expect(listText).not.toContain(secret);
    expect(listText).not.toContain(oauth);
    expect(JSON.parse(listText).servers.find((entry: { id: string }) => entry.id === id))
      .toMatchObject({ env: null, envJson: null, oauthToken: null });
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
      const stored = sqlite.prepare('SELECT env_json, worker_injection FROM external_mcp_servers WHERE name = ?').get('Forwarded') as { env_json: string; worker_injection: number };
      expect(JSON.parse(stored.env_json)).toEqual(input.env);
      expect(stored.worker_injection).toBe(1);
      expect((await (await fetch(`${origin}/api/symon/mcp/tools`, { headers: { authorization: `Bearer ${server.token}` } })).json()).tools).toHaveLength(1);
      const forwardedId = (sqlite.prepare('SELECT id FROM external_mcp_servers WHERE name = ?').get('Forwarded') as { id: string }).id;
      const beforeDelete = invalidations();
      const removed = await next.DELETE(new Request('http://127.0.0.1/api/setup/mcp-servers', {
        method: 'DELETE', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: forwardedId }),
      }));
      expect(removed.status).toBe(200);
      expect(invalidations()).toBe(beforeDelete + 1);
      const opencode = await import('@/app/api/setup/opencode/route');
      // Give Next a different config directory: only the WS owner's file changes.
      process.env.XDG_CONFIG_HOME = join(server.directory, 'next-config');
      const forwardedConfig = await opencode.POST(new Request('http://127.0.0.1/api/setup/opencode', {
        method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ remove: true }),
      }));
      expect(forwardedConfig.status).toBe(200);
      expect(JSON.parse(readFileSync(configPath, 'utf8')).mcp.o8).toBeUndefined();
      expect(existsSync(join(process.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'))).toBe(false);
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
