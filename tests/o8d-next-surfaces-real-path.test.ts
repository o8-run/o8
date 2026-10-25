import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';
import { cutoverClient } from './fixtures/ws-cutover-client';

const binary = process.env.O8D_TEST_BINARY ?? join(process.cwd(), 'crates/o8d/target/debug', process.platform === 'win32' ? 'o8d.exe' : 'o8d');
let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
beforeAll(async () => {
  if (!process.env.O8D_TEST_BINARY) await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-ws']);
  server = await startParityReference({ o8d: true, binary, nativeHttp: true });
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  await server.stopNext();
}, 180_000);
afterAll(async () => { await server?.stop(); });

it.each([
  ['Settings', 'GET', '/api/panel/operator-defaults?include=native', 200],
  ['Projects', 'GET', '/api/panel/projects', 200],
  ['Issues', 'GET', '/api/panel/repos', 200],
  ['Inbox', 'GET', '/api/panel/approvals', 200],
  ['Customize', 'GET', '/api/prompt-library', 200],
  ['Brain', 'POST', '/api/cortex/ask', 400],
])('serves %s through the production o8d bridge with Next stopped', async (_surface, method, path, status) => {
  const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: '{}' } : {}) });
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/json');
});

it('reads saved fixture sessions with Next stopped', async () => {
  mkdirSync(join(server.directory, 'chat-history'), { recursive: true });
  writeFileSync(join(server.directory, 'chat-history', 'thoughts-native-surface.json'), JSON.stringify({
    title: 'Fixture session', backend: 'claude', orchestratorVisible: true, repoPath: server.directory,
    savedAt: new Date().toISOString(), messages: [{ role: 'assistant', content: 'Fixture saved history' }],
  }));
  const response = await fetch(`${origin}/api/mobile/history?sessionKey=llm-chat:thoughts-native-surface&limit=100`, {
    headers: { authorization: `Bearer ${server.token}` },
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('Fixture saved history');
});

it('walks every production surface registration and its HTTP routes', async () => {
  const { nativeSurfaceRoutes } = await import('@/lib/ws-server/native-http-routes');
  const shell = readFileSync('native/o8-next/src/shell.rs', 'utf8');
  const registered = [...shell.matchAll(/(\w+): \w+(?:\([^)]*\))? = "surfaces\/[^"]+";/g)]
    .map(match => match[1]).filter(name => name !== 'fake');
  expect(Object.keys(nativeSurfaceRoutes).sort()).toEqual(registered.sort());
  for (const [name, routes] of Object.entries(nativeSurfaceRoutes)) {
    if (!['grid', 'terminal'].includes(name)) expect(routes.length, name).toBeGreaterThan(0);
    for (const route of routes) {
      const path = route.path.replace(/\[\w+\]/g, 'fixture');
      const handlers = await route.load() as Record<string, unknown>;
      for (const method of route.methods) {
        expect(handlers[method], `${method} ${route.path}`).toBeTypeOf('function');
        const response = await fetch(origin + path, { method, headers: {
          'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1', 'x-o8d-bridge': 'forged',
        } });
        expect(response.status, `${name}: ${method} ${path}`).toBe(401);
        await response.arrayBuffer();
      }
    }
  }
  // Also reject a new literal endpoint added to an existing surface/view without
  // a transport registration. Computed project-member routes are checked above.
  const files = readdirSync('native/o8-next/src', { recursive: true }).map(String)
    .filter(file => file.endsWith('.rs') && !file.includes('test') && !file.endsWith('fake.rs'));
  const paths = new Set(Object.values(nativeSurfaceRoutes).flat().map(route => route.path));
  for (const file of files) {
    const source = readFileSync(join('native/o8-next/src', file), 'utf8');
    for (const match of source.matchAll(/"(\/api\/[^"\s]+)"/g)) {
      if (match[1].includes('{endpoint}')) {
        const endpoints = [...source.matchAll(/\("(\w+)", "\w+", "\w+", \d+\)/g)].map(row => row[1]);
        expect(endpoints.length).toBeGreaterThan(0);
        for (const endpoint of endpoints) expect(paths.has(match[1].replace('{endpoint}', endpoint)), `${file}: ${endpoint}`).toBe(true);
        continue;
      }
      const path = match[1].split('?')[0].replace(/\{[^}]*\}/g, '[id]');
      if (path.endsWith('/')) continue; // Prefix used for error policy or route construction.
      const normalized = (value: string) => value.replace(/\[\w+\]/g, '[]');
      expect([...paths].some(known => normalized(known) === normalized(path)), `${file}: ${path}`).toBe(true);
    }
  }
});

it('delivers a native session checkpoint after Next stops', async () => {
  const client = await cutoverClient(server.url, server.token);
  try {
    client.socket.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions: [{ stream: 'session:llm-chat:thoughts-native-surface' }] }));
    const frame = await client.wait(frame => frame.channel === 'realtime' && JSON.stringify(frame).includes('Fixture saved history'), 12_000);
    expect(JSON.stringify(frame)).toContain('thoughts-native-surface');
  } finally { await client.close(); }
});

it('keeps default HTTP behavior when native mode is off', async () => {
  const defaultServer = await startParityReference({ o8d: true, binary });
  try {
    const response = await fetch(new URL('/api/panel/projects', defaultServer.url.replace('ws:', 'http:')), {
      headers: { authorization: `Bearer ${defaultServer.token}` },
    });
    expect(response.status).toBe(404);
  } finally { await defaultServer.stop(); }
});

it('preserves canonical workspace paths through the native project handler', async () => {
  const alias = join(server.directory, 'workspace-alias');
  symlinkSync(server.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const response = await fetch(`${origin}/api/panel/repos`, { method: 'POST',
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'validate', localPath: alias }),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(realpathSync(body.repo.localPath)).toBe(realpathSync(server.directory));
});

it('streams Brain immediately, then survives a pane disconnect and concurrent refreshes', async () => {
  const abort = new AbortController();
  const response = await fetch(`${origin}/api/cortex/ask`, { method: 'POST', signal: abort.signal,
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'Fixture lookup', repoPath: server.directory }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain('event: open');
  abort.abort();
  await reader.cancel().catch(() => {});
  const replies = await Promise.all(Array.from({ length: 8 }, () => fetch(`${origin}/api/panel/projects`, {
    headers: { authorization: `Bearer ${server.token}` },
  })));
  for (const reply of replies) { expect(reply.status).toBe(200); await reply.arrayBuffer(); }
});

it('keeps concurrent route parameters and request bodies isolated', async () => {
  const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' };
  const create = await fetch(`${origin}/api/prompt-library`, { method: 'POST', headers,
    body: JSON.stringify({ title: 'Concurrent fixture', body: 'Initial fixture prompt', scope: 'global' }),
  });
  expect(create.status).toBe(201);
  const created = await create.json();
  const prompt = created.prompt ?? created;
  const requests = Array.from({ length: 6 }, (_, index) => fetch(`${origin}/api/prompt-library/${encodeURIComponent(prompt.id)}`, {
    method: 'PATCH', headers, body: JSON.stringify({ title: `Fixture ${index}`, body: `Body ${index}`, expectedUpdatedAt: prompt.updatedAt }),
  }));
  const responses = await Promise.all(requests);
  expect(responses.filter(response => response.ok)).toHaveLength(1);
  expect(responses.filter(response => response.status === 409)).toHaveLength(5);
  for (const response of responses) await response.arrayBuffer();
});

it('returns a bounded upload refusal without resetting the connection', async () => {
  const response = await fetch(`${origin}/api/prompt-library`, { method: 'POST',
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Large fixture', body: 'x'.repeat(16 * 1024 * 1024) }),
  });
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: 'Request exceeds 16 MiB' });
});

it('refuses read-only workers and invalid credentials on native writes', async () => {
  for (const bearer of ['o8ro_fixture-read-only', 'fixture-invalid']) {
    const response = await fetch(`${origin}/api/prompt-library`, { method: 'POST', headers: {
      authorization: `Bearer ${bearer}`, 'content-type': 'application/json',
      'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1',
    }, body: JSON.stringify({ title: 'Denied fixture', body: 'Must not persist' }) });
    expect(response.status).toBe(bearer.startsWith('o8ro_') ? 403 : 401);
    await response.arrayBuffer();
  }
});

it('does not turn the Rust relay peer into unauthenticated loopback authority', async () => {
  const response = await fetch(`${origin}/api/setup/identity`, { headers: {
    host: '127.0.0.1', origin: 'http://127.0.0.1',
    'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1', 'x-o8d-bridge': 'forged',
  } });
  expect(response.status).toBe(401);
  const authenticated = await fetch(`${origin}/api/setup/identity`, { headers: { authorization: `Bearer ${server.token}` } });
  expect(authenticated.status).toBe(200);
});
