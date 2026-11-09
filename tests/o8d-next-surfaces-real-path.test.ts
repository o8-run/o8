import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';
import { cutoverClient } from './fixtures/ws-cutover-client';

const binary = process.env.O8D_BINARY ?? process.env.O8D_TEST_BINARY ?? join(process.cwd(), 'crates/o8d/target/debug', process.platform === 'win32' ? 'o8d.exe' : 'o8d');
// A1 reads: exercise the gate and original handler through the public socket.
const NATIVE_READS = [
  ['settings', '/api/cortex/codebase-memory', 200],
  ['settings', '/api/cortex/diagnostics', 200],
  ['session', '/api/tasks?includeDone=true&includeBrief=true', 200],
  ['session', '/api/panel/branches', 400],
  ['diff', '/api/panel/commits/[hash]', 400],
  ['diff', '/api/review/last-turn', 200],
  ['session', '/api/panel/files', 200],
  ['session', '/api/panel/file-diff', 400],
  ['settings', '/api/panel/status', 200],
  ['session', '/api/panel/resource-usage', 200],
  ['session', '/api/panel/serve-image', 400],
  ['session', '/api/visualizations/[id]', 404],
  ['session', '/api/repo-spec', 400],
  ['activity', '/api/review/workspace', 200],
  ['settings', '/api/runtime/capabilities', 200],
  ['settings', '/api/runtime/acp-registry', 200],
  ['settings', '/api/runtime/capacity', 200],
  ['settings', '/api/worktrees/retention-usage', 200],
  ['session', '/api/runtime/service-tiers', 200],
  ['session', '/api/runtime/telemetry', 400],
  ['session', '/api/orchestrator/status', 404],
  ['sidebar', '/api/orchestrator/packet-transcript', 400],
  ['session', '/api/orchestrator/archive', 200],
  ['setup', '/api/setup/cli-updates?runtime=fixture-unknown', 400],
  // Setup-wizard tool detection: no handler-level auth, gated by panelGateMiddleware
  // (/api/setup/* is not public, hardening #1562), so operator-ws-token-only over native. It reads
  // provider credentials to derive boolean presence; the dedicated test below proves no secret value
  // reaches the body (#5243).
  ['setup', '/api/setup/detect', 200],
  ['settings', '/api/panel/o8-update-summary?version=invalid', 400],
  ['activity', '/api/cortex/proposals', 200],
  ['activity', '/api/cortex/cross-repo-proposals', 200],
  ['activity', '/api/panel/problem-dossiers', 200],
  ['session', '/api/panel/file-asset', 400],
  ['session', '/api/v2/files', 400],
  ['session', '/api/v2/files/quick-docs', 200],
  ['session', '/api/visualizations', 400],
  ['pull_requests', '/api/panel/prs/[number]/timeline', 400],
  // Paired-device list: operator-only, token-based (not loopback), no token/hash in the body (#5243).
  ['settings', '/api/mobile/devices', 200],
  // MCP config generator (Settings > MCP): no handler-level auth, gated by panelGateMiddleware
  // (/api/setup/* is not public, hardening #1562). Over native (x-o8-client-addr=unverified-proxy)
  // the loopback branch fails, leaving operator-ws-token-only. Its GET body embeds the operator
  // WS_TOKEN (build.ts getOrCreateWsToken), so the forged-local-header negative below is the proof
  // a non-operator cannot extract it over the native transport (#5243).
  ['settings', '/api/setup/mcp-config', 200],
  // Mobile pairing config (Settings > Paired devices QR). GET only. Operator/loopback gets the real
  // ws-token; a device principal gets host/port refresh with token:'' (the device→token:'' branch is
  // pinned in its own test below). In DEVICE_CAPABILITIES (GET), so the generic negative still 401s a
  // missing/wrong token even with forged local headers. (#5243)
  ['settings', '/api/panel/mobile-pairing', 200],
] as const;
let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
beforeAll(async () => {
  if (!process.env.O8D_BINARY && !process.env.O8D_TEST_BINARY) await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-ws']);
  server = await startParityReference({ o8d: true, binary, nativeHttp: true, startupTimeoutMs: 120_000,
    preload: './tests/fixtures/ws-parity-acp-registry.cjs' });
  // The fixture Next server has no project route; startup must own this write.
  expect(JSON.parse(readFileSync(join(server.directory, 'projects.json'), 'utf8')))
    .toMatchObject({ activeProjectId: 'default', projects: [{ id: 'default' }] });
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
  ['Setup', 'GET', '/api/setup/config', 200],
  ['Terminal', 'GET', '/api/mobile/terminal-sessions', 200],
  ['Workers list', 'GET', '/api/lanes?active=true', 200],
  ['Workers events', 'GET', '/api/orchestrator/lane-events?since=0&timeoutMs=0', 200],
  ['Sidebar list', 'GET', '/api/v2/chat-history/list?include=orchestrator', 200],
  ['Sidebar archive validation', 'POST', '/api/runtime/archive', 400],
  ['Terminal View validation', 'POST', '/api/v2/chat-history/terminal-turns', 400],
  // Providers settings (#5243): operator ws-token lists instances; a POST with no action
  // reaches the handler and fails validation (proves the write path is registered, gated).
  ['Providers list', 'GET', '/api/runtime/provider-instances', 200],
  ['Providers write validation', 'POST', '/api/runtime/provider-instances', 400],
  // MCP Claude Desktop preview (Settings > MCP): operator GET inspects the Claude config. It
  // returns other servers by NAME only (never their contents); the o8 entry carries WS_TOKEN,
  // which is the operator's own token. The POST config-file write is pinned operator-only below.
  ['MCP Claude Desktop preview', 'GET', '/api/setup/claude-desktop', 200],
  // MCP external client (Settings > MCP): operator GET probes whether the hermes/openclaw CLI is
  // installed + o8 registered (read-only `command -v` via login shell; fixed CLI names). A POST with
  // no/invalid target fails validation (400) before any resolveCli/spawn, so this asserts the write
  // path is registered + gated without triggering a real CLI install. The install/remove spawn is
  // pinned operator-only in the standalone test below. (#5243)
  ['MCP external client probe', 'GET', '/api/setup/external-client?target=hermes', 200],
  ['MCP external client write validation', 'POST', '/api/setup/external-client', 400],
  // Connect-attach setting (Settings > Paired devices): operator GET reads the setting; a POST with
  // no boolean `enabled` fails validation (400) before any write, so this asserts the write path is
  // registered + gated without flipping the setting. No handler-level auth — same panelGateMiddleware
  // operator gate as the rest of /api/panel/* (not allowlisted), so over native it is operator-only.
  // The spawn-free POST write is pinned operator-only in the standalone test below. (#5243)
  ['Connect attach setting', 'GET', '/api/panel/connect/attach', 200],
  ['Connect attach write validation', 'POST', '/api/panel/connect/attach', 400],
  // Machine connect (Settings > Paired devices): operator GET lists machines, POST registers / DELETE
  // deregisters this machine via the upstream license server. With no clerk/license credential in the
  // fixture the handler short-circuits to auth_required (200, ok:false) before any upstream call, so each
  // verb proves it is registered + operator-gated without a network round-trip. Fail-closed 401 below. (#5243)
  ['Connect status', 'GET', '/api/panel/connect', 200],
  ['Connect register', 'POST', '/api/panel/connect', 200],
  ['Connect disconnect', 'DELETE', '/api/panel/connect', 200],
  // Paired-device revoke (Settings > Paired devices): the operator ws-token passes both gates and
  // reaches the handler, which 400s on the empty body (deviceId required) before any revoke — proving
  // the POST write path is registered and operator-gated without mutating the token-hash file. (#5243)
  ['Device revoke validation', 'POST', '/api/mobile/devices/revoke', 400],
  ['Diff commit validation', 'POST', '/api/review/commit', 400],
])('serves %s through the production o8d bridge with Next stopped', async (_surface, method, path, status) => {
  const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: '{}' } : {}) });
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/json');
});

// provider-instances is a credential route (it writes provider API keys), so pin the
// fail-closed gate on the native transport: a missing or wrong token is refused even
// when the caller forges the loopback markers, for both the GET read and the POST write.
it('refuses provider-instances over native without the operator ws-token (#5243)', async () => {
  for (const method of ['GET', 'POST'] as const) {
    for (const authorization of [undefined, 'Bearer fixture-wrong-token']) {
      const response = await fetch(origin + '/api/runtime/provider-instances', {
        method,
        headers: {
          ...(authorization ? { authorization } : {}), 'content-type': 'application/json',
          'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1', 'x-o8d-bridge': 'forged',
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
  }
});

// claude-desktop POST writes the user's Claude MCP config file, so pin the fail-closed gate on the
// native transport: a missing or wrong token is refused even with forged loopback markers, for both
// the GET preview and the POST write. An authorized POST {remove:true} confirms the write path is
// reachable and gated — a safe no-op against the fixture's empty config (HOME is the fixture dir).
it('refuses setup/claude-desktop over native without the operator ws-token; write path operator-only (#5243)', async () => {
  for (const method of ['GET', 'POST'] as const) {
    for (const authorization of [undefined, 'Bearer fixture-wrong-token']) {
      const response = await fetch(origin + '/api/setup/claude-desktop', {
        method,
        headers: {
          ...(authorization ? { authorization } : {}), 'content-type': 'application/json',
          'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1', 'x-o8d-bridge': 'forged',
        },
        ...(method === 'POST' ? { body: '{"remove":true}' } : {}),
      });
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
  }
  const ok = await fetch(origin + '/api/setup/claude-desktop', {
    method: 'POST',
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: '{"remove":true}',
  });
  expect(ok.status).toBe(200);
  await ok.arrayBuffer();
});

// external-client POST shells out to the hermes/openclaw CLI to install/remove the o8 MCP server,
// so pin the fail-closed gate on the native transport: a missing or wrong token is refused even with
// forged loopback markers, for both the GET probe and the POST spawn. The POST uses an invalid target
// so it would fail validation before any resolveCli/spawn even if it reached the handler — but it must
// not: the gate refuses it first (401, not 400). (#5243)
it('refuses setup/external-client over native without the operator ws-token; CLI spawn operator-only (#5243)', async () => {
  for (const method of ['GET', 'POST'] as const) {
    for (const authorization of [undefined, 'Bearer fixture-wrong-token']) {
      const response = await fetch(origin + '/api/setup/external-client?target=hermes', {
        method,
        headers: {
          ...(authorization ? { authorization } : {}), 'content-type': 'application/json',
          'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1', 'x-o8d-bridge': 'forged',
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
  }
});

// connect/attach POST writes the connect-attach setting, so pin the fail-closed gate on the native
// transport: a missing or wrong token is refused even with forged loopback markers, for both the GET
// read and the POST write. The POST body is invalid so it would 400 before any write even if it
// reached the handler — but it must not: the gate refuses it first (401, not 400). (#5243)
it('refuses panel/connect/attach over native without the operator ws-token; write path operator-only (#5243)', async () => {
  for (const method of ['GET', 'POST'] as const) {
    for (const authorization of [undefined, 'Bearer fixture-wrong-token']) {
      const response = await fetch(origin + '/api/panel/connect/attach', {
        method,
        headers: {
          ...(authorization ? { authorization } : {}), 'content-type': 'application/json',
          'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1', 'x-o8d-bridge': 'forged',
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
  }
});

// panel/connect GET lists machines, POST registers this machine, DELETE deregisters it + writes attach-off,
// all through the upstream license server using x-clerk-session-token (or the cached license key). Pin the
// fail-closed gate on the native transport: a missing or wrong token is refused even with forged loopback
// markers, for all three verbs. With the operator ws-token but no upstream credential in the fixture, the
// handler runs and returns auth_required (200, ok:false) WITHOUT reaching the registry — proving it is
// reachable + operator-gated over native with no network round-trip to the license server. (#5243)
it('refuses panel/connect over native without the operator ws-token; connect/disconnect operator-only (#5243)', async () => {
  for (const method of ['GET', 'POST', 'DELETE'] as const) {
    for (const authorization of [undefined, 'Bearer fixture-wrong-token']) {
      const response = await fetch(origin + '/api/panel/connect', {
        method,
        headers: {
          ...(authorization ? { authorization } : {}), 'content-type': 'application/json',
          'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1', 'x-o8d-bridge': 'forged',
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
  }
  const ok = await fetch(origin + '/api/panel/connect', {
    headers: { authorization: `Bearer ${server.token}` },
  });
  expect(ok.status).toBe(200);
  expect(JSON.parse(await ok.text()).error?.code).toBe('auth_required');
});

// mobile-pairing hands the operator the real ws-token but a device only host/port with token:'' —
// the operator credential must NEVER cross to a device. Pin it over the native transport with a real
// enrolled-device bearer (seed its sha256 into the device-token file the middleware + principal both
// read): the device gets 200 with token:'' and the ws-token never appears in the body, even with
// forged loopback markers, while the operator still gets the real ws-token. (#5243)
it('never hands the ws-token to a device over native mobile-pairing (#5243)', async () => {
  const deviceToken = 'enrolled-device-token-pairing-5243-abcdef0123456789';
  writeFileSync(join(server.directory, 'mobile-device-tokens'),
    `${createHash('sha256').update(deviceToken).digest('hex')}\n`, { mode: 0o600 });

  const deviceRes = await fetch(origin + '/api/panel/mobile-pairing', {
    headers: {
      authorization: `Bearer ${deviceToken}`,
      'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1', 'x-o8d-bridge': 'forged',
    },
  });
  expect(deviceRes.status).toBe(200);
  const deviceText = await deviceRes.text();
  expect(JSON.parse(deviceText).token).toBe('');
  expect(deviceText).not.toContain(server.token);

  // The operator, by contrast, gets the real ws-token — proving the device branch is a real narrowing.
  const operatorRes = await fetch(origin + '/api/panel/mobile-pairing', {
    headers: { authorization: `Bearer ${server.token}` },
  });
  expect(operatorRes.status).toBe(200);
  expect(JSON.parse(await operatorRes.text()).token).toBe(server.token);
});

// Paired-device revoke is operator-only device administration: a device must not be able to revoke
// devices (including itself), and neither may a worker. Pin the fail-closed gate over the native
// transport with real enrolled device + worker bearers (seed the token files the middleware reads):
// every non-operator caller is refused before the handler can touch the token-hash file, even with
// forged loopback markers; only the operator ws-token reaches the handler, which 400s on the empty
// body (deviceId required) — a safe no-op that proves reachability without a revoke. (#5243)
it('refuses paired-device revoke over native to everyone but the operator (#5243)', async () => {
  const deviceToken = 'enrolled-device-token-revoke-5243-abcdef0123456789';
  const workerToken = 'packet-worker-token-revoke-5243-abcdef0123456789';
  writeFileSync(join(server.directory, 'mobile-device-tokens'),
    `${createHash('sha256').update(deviceToken).digest('hex')}\n`, { mode: 0o600 });
  writeFileSync(join(server.directory, 'worker-token'), workerToken, { mode: 0o600 });
  const post = (authorization?: string) => fetch(origin + '/api/mobile/devices/revoke', {
    method: 'POST',
    headers: {
      ...(authorization ? { authorization } : {}), 'content-type': 'application/json',
      'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1', 'x-o8d-bridge': 'forged',
    },
    body: JSON.stringify({ deviceId: 'victim-device' }),
  });
  expect((await post()).status, 'no bearer').toBe(401);
  expect((await post('Bearer fixture-wrong-token')).status, 'wrong bearer').toBe(401);
  expect((await post(`Bearer ${deviceToken}`)).status, 'a device cannot revoke devices').toBe(403);
  expect((await post(`Bearer ${workerToken}`)).status, 'a worker cannot revoke devices').toBe(403);
  // The operator reaches the handler; an empty body 400s (deviceId required) before any revoke.
  const operator = await fetch(origin + '/api/mobile/devices/revoke', {
    method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, body: '{}',
  });
  expect(operator.status).toBe(400);
});

// setup/detect reads provider credentials (process.env + .env.local under the data dir) to decide
// whether each tool's auth is present, then spawns CLI version probes. Over native it must stay
// operator-ws-token-only AND never echo a secret VALUE. Seed fake key values into the data dir's
// .env.local: the handler reads them (the api-keys tool reports openrouter configured), but the
// response body carries only names/booleans/paths — never the seeded values. (#5243)
it('reads provider credentials but never returns their values over native setup/detect (#5243)', async () => {
  const fakeOpenRouter = 'sk-or-v1-redactionproof0000000000000000000000000000000000000000000000';
  const fakeOpenAI = 'sk-redactionproof1111111111111111111111111111111111';
  const envPath = join(server.directory, '.env.local');
  writeFileSync(envPath, `OPENROUTER_API_KEY=${fakeOpenRouter}\nOPENAI_API_KEY=${fakeOpenAI}\n`, { mode: 0o600 });
  try {
    // Missing/wrong credentials are refused even with forged loopback markers.
    for (const authorization of [undefined, 'Bearer fixture-wrong-token']) {
      const refused = await fetch(origin + '/api/setup/detect', { headers: {
        ...(authorization ? { authorization } : {}),
        'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1', 'x-o8d-bridge': 'forged',
      } });
      expect(refused.status).toBe(401);
      await refused.arrayBuffer();
    }

    const response = await fetch(origin + '/api/setup/detect', { headers: { authorization: `Bearer ${server.token}` } });
    expect(response.status).toBe(200);
    const body = await response.text();
    // The handler READ the seeded credentials: the API-keys tool reports openrouter configured.
    const apiKeys = JSON.parse(body).tools.find((tool: { id: string }) => tool.id === 'api-keys');
    expect(apiKeys?.details?.providers).toContainEqual({ provider: 'openrouter', configured: true });
    // But it NEVER echoes a secret VALUE — not the OpenRouter key, not the OpenAI key other tools read.
    expect(body).not.toContain(fakeOpenRouter);
    expect(body).not.toContain(fakeOpenAI);
  } finally {
    rmSync(envPath, { force: true });
  }
});

it('keeps Sidebar and saved history reachable after verbose Workers events', async () => {
  const verbose = await startParityReference({ o8d: true, binary, nativeHttp: true,
    preload: './tests/fixtures/ws-parity-output.cjs', startupTimeoutMs: 120_000 });
  try {
    await verbose.stopNext();
    const base = verbose.url.replace('ws:', 'http:').replace('/ws', '');
    const delivery = (await (await fetch(base + '/health')).json()).delivery;
    expect(delivery.transport).toBe('o8d');
    mkdirSync(join(verbose.directory, 'chat-history'), { recursive: true });
    writeFileSync(join(verbose.directory, 'chat-history', 'thoughts-verbose.json'), JSON.stringify({
      title: 'Verbose fixture', backend: 'pi', orchestratorVisible: true, repoPath: verbose.directory,
      savedAt: new Date().toISOString(), messages: [{ role: 'assistant', content: 'Survived Workers events' }],
    }));
    for (const path of ['/api/lanes?active=true', '/api/orchestrator/lane-events?since=0&timeoutMs=0',
      '/api/v2/chat-history/list?include=orchestrator', '/api/mobile/history?sessionKey=llm-chat:thoughts-verbose&limit=100']) {
      const response = await fetch(base + path, { headers: { authorization: `Bearer ${verbose.token}` } });
      expect(response.status, path).toBe(200);
      const body = await response.text();
      if (path.startsWith('/api/orchestrator/lane-events')) {
        await expect.poll(() => verbose.diagnostics().stdoutBytes, { timeout: 10_000 }).toBeGreaterThan(1024 ** 2);
        await expect.poll(() => verbose.diagnostics().stderrBytes, { timeout: 10_000 }).toBeGreaterThan(1024 ** 2);
      }
      if (path.startsWith('/api/mobile/history')) expect(body).toContain('Survived Workers events');
    }
    expect(verbose.diagnostics()).toMatchObject({ code: null, signal: null, error: '' });
    expect(verbose.diagnostics().stderr.length).toBeLessThanOrEqual(16_384);
    const health = await (await fetch(base + '/health')).json();
    expect(health.delivery).toEqual(delivery);
  } finally { await verbose.stop(); }
  const shutdown = verbose.diagnostics();
  expect(shutdown).toMatchObject({ exitAfterStop: true, error: '' });
  expect(shutdown.signal === 'SIGTERM' || shutdown.code !== null).toBe(true);
}, 120_000);

it.each(NATIVE_READS)('serves A1 %s GET %s with its production auth and Next stopped', async (surface, pattern, status) => {
  const { nativeSurfaceRoutes } = await import('@/lib/ws-server/native-http-registry');
  const routePath = pattern.split('?')[0];
  const path = pattern.replace(/\[\w+\]/g, 'fixture');
  // Public health is deliberately readable without credentials. All other
  // reads must refuse missing/wrong credentials even with forged local headers.
  for (const authorization of [undefined, 'Bearer fixture-wrong-token']) {
    const response = await fetch(origin + path, { headers: {
      ...(authorization ? { authorization } : {}),
      'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1', 'x-o8d-bridge': 'forged',
    } });
    expect(response.status).toBe(routePath === '/api/panel/status' ? 200 : 401);
    await response.arrayBuffer();
  }
  const response = await fetch(origin + path, { headers: { authorization: `Bearer ${server.token}` } });
  expect(response.status).toBe(status);
  const body = await response.text();
  expect(body).not.toContain('Native route unavailable');
  if (routePath === '/api/runtime/acp-registry') {
    expect(JSON.parse(body)).toMatchObject({ stale: false, agents: [{ id: 'fixture-agent', version: '1.0.0' }] });
  }
  // A2 adds POST to /api/cortex/proposals; every other A1 read stays GET-only.
  const methods = nativeSurfaceRoutes[surface].find(route => route.path === routePath)?.methods ?? [];
  expect(methods).toEqual(routePath === '/api/cortex/proposals' ? ['GET', 'POST'] : ['GET']);
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE'].filter(method => !methods.includes(method))) {
    const refused = await fetch(origin + path, { method, headers: { authorization: `Bearer ${server.token}` } });
    expect(refused.status).toBe(405);
    expect(refused.headers.get('allow')).toBe(methods.join(', '));
    await refused.arrayBuffer();
  }
});

it.each([
  ['/api/panel/ports', 200, 'ports'],
  ['/api/v2/files', 400, 'path required'],
  ['/api/panel/file-io', 400, 'path param required'],
  ['/api/panel/file-asset', 400, 'path required'],
  ['/api/mobile/media', 400, 'path is required'],
])('reaches the production registration for GET %s with Next stopped', async (path, status, detail) => {
  const response = await fetch(origin + path, { headers: { authorization: `Bearer ${server.token}` } });
  expect(response.status).toBe(status);
  expect(await response.text()).toContain(detail);
});

it('reads R1 scoped files and visualization metadata without changing the registry', async () => {
  const registryPath = join(server.directory, 'repos.json');
  const repoPath = join(server.directory, 'r1-read-repo');
  await promisify(execFile)('git', ['init', '-q', '-b', 'main', repoPath]);
  await promisify(execFile)('git', ['-C', repoPath, 'remote', 'add', 'origin', 'https://github.com/organization/native-read.git']);
  writeFileSync(join(repoPath, 'o8.md'), 'Scoped native read fixture');
  writeFileSync(join(repoPath, 'AGENTS.md'), 'Scoped quick document fixture');
  writeFileSync(join(repoPath, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><text>Scoped asset</text></svg>');
  const saved = existsSync(registryPath) ? readFileSync(registryPath, 'utf8') : null;
  const store = saved ? JSON.parse(saved) : { version: 1, repos: [] };
  store.repos.push({ id: 'r1-read', name: 'r1-read-repo', localPath: repoPath,
    isGitRepo: true, remoteUrl: 'https://github.com/previous/native-read.git' });
  writeFileSync(registryPath, JSON.stringify(store));
  const before = readFileSync(registryPath);
  const mtime = statSync(registryPath, { bigint: true }).mtimeNs;
  try {
    // Earlier requests may have cached the empty registry.
    await new Promise(resolve => setTimeout(resolve, 5_100));
    const query = new URLSearchParams({ workspace: repoPath });
    for (const path of [`/api/v2/files?${query}&path=o8.md`, `/api/v2/files?${query}&path=o8.md&preview=1`,
      `/api/v2/files/quick-docs?${query}`, `/api/panel/file-asset?${query}&path=image.svg`,
      `/api/visualizations?${new URLSearchParams({ repoPath, threadId: 'thoughts-r1-read' })}`]) {
      const response = await fetch(origin + path, { headers: { authorization: `Bearer ${server.token}` } });
      expect(response.status, path).toBe(200);
      const body = await response.text();
      if (path.startsWith('/api/v2/files?')) expect(body).toContain('Scoped native read fixture');
      if (path.startsWith('/api/v2/files/quick-docs')) expect(body).toContain('AGENTS.md');
      if (path.startsWith('/api/visualizations?')) expect(JSON.parse(body).result.visualizations).toEqual([]);
    }
    expect(readFileSync(registryPath)).toEqual(before);
    expect(statSync(registryPath, { bigint: true }).mtimeNs).toBe(mtime);
  } finally {
    if (saved === null) rmSync(registryPath);
    else writeFileSync(registryPath, saved);
  }
});

it('refuses an unknown HTTP route with Next stopped', async () => {
  const response = await fetch(`${origin}/api/native-fixture-unknown-route`, {
    headers: { authorization: `Bearer ${server.token}` },
  });
  expect(response.status).toBe(404);
  await response.arrayBuffer();
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

it('reads parent subagents through the native bridge with Next stopped', async () => {
  const query = new URLSearchParams({ repoPath: server.directory, threadId: 'thoughts-native-surface' });
  const response = await fetch(`${origin}/api/orchestrator/shared-team/active?${query}`, {
    headers: { authorization: `Bearer ${server.token}` },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ threadId: 'thoughts-native-surface', workers: [] });
});

it('persists Setup conversation creation through its existing handler with Next stopped', async () => {
  const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' };
  const created = await fetch(`${origin}/api/v2/chat-history`, { method: 'POST', headers, body: JSON.stringify({
    tabId: 'thoughts-native-setup', messages: [], backend: 'pi', model: 'pi', repoPath: server.directory,
    title: 'Fixture setup conversation',
  }) });
  expect(created.status).toBe(200);
  const saved = await fetch(`${origin}/api/v2/chat-history?tabId=thoughts-native-setup`, { headers });
  expect(saved.status).toBe(200);
  const history = await saved.json();
  expect(history).toMatchObject({ backend: 'pi', model: 'pi', messages: [] });
  expect(realpathSync(history.repoPath)).toBe(realpathSync(server.directory));
});

it('walks every production surface registration and its HTTP routes', async () => {
  const { nativeSurfaceRoutes } = await import('@/lib/ws-server/native-http-registry');
  const { viewerHttpRoutes } = await import('@/lib/viewers/http-routes');
  const shell = readFileSync('native/o8-next/src/shell.rs', 'utf8');
  const registered = [...shell.matchAll(/(\w+): \w+(?:\([^)]*\))? = "surfaces\/[^"]+";/g)]
    .map(match => match[1]).filter(name => name !== 'fake');
  expect(Object.keys(nativeSurfaceRoutes).sort()).toEqual(registered.sort());
  for (const [name, routes] of Object.entries({ ...nativeSurfaceRoutes, viewers: viewerHttpRoutes })) {
    if (!['grid', 'palette', 'shortcuts'].includes(name)) expect(routes.length, name).toBeGreaterThan(0);
    for (const route of routes) {
      const path = route.path.replace(/\[\w+\]/g, 'fixture');
      const handlers = await route.load() as Record<string, unknown>;
      for (const method of route.methods) {
        expect(handlers[method], `${method} ${route.path}`).toBeTypeOf('function');
        const response = await fetch(origin + path, { method, headers: {
          'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1', 'x-o8d-bridge': 'forged',
        } });
        expect(response.status, `${name}: ${method} ${path}`).toBe(route.path === '/api/panel/status' && method === 'GET' ? 200 : 401);
        await response.arrayBuffer();
      }
    }
  }

}, 120_000);

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

it('reaches the mission card decision handlers with Next stopped', async () => {
  const url = `${origin}/api/task-artifacts/tart-00000000-0000-4000-8000-000000000000/decision`;
  for (const method of ['GET', 'POST']) {
    const refused = await fetch(url, { method, headers: { 'x-o8-client-addr': '127.0.0.1' } });
    expect(refused.status).toBe(401);
    await refused.arrayBuffer();
    // The handler's own principal check admits the operator bearer, then finds no card.
    const response = await fetch(url, { method, headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({ actionId: 'approve', nonce: 'native-fixture' }) } : {}) });
    expect(response.status, method).toBe(404);
    expect(await response.json(), method).toMatchObject({ error: { code: 'not_found' } });
  }
});

it('gates the native folder picker POST with Next stopped', async () => {
  // Refusals only: an authorized call would open the host's real chooser.
  for (const authorization of [undefined, 'Bearer fixture-wrong-token']) {
    const refused = await fetch(`${origin}/api/panel/browse-folder`, { method: 'POST', body: '{}',
      headers: { 'content-type': 'application/json', 'x-o8-client-addr': '127.0.0.1', ...(authorization ? { authorization } : {}) } });
    expect(refused.status).toBe(401);
    await refused.arrayBuffer();
  }
  const get = await fetch(`${origin}/api/panel/browse-folder`, { headers: { authorization: `Bearer ${server.token}` } });
  expect(get.status).toBe(405);
  expect(get.headers.get('allow')).toBe('POST');
  await get.arrayBuffer();
});

it('saves a notes image through the native asset POST with Next stopped', async () => {
  const repo = join(server.directory, 'asset-repo');
  mkdirSync(repo, { recursive: true });
  const url = `${origin}/api/repo-spec/asset?${new URLSearchParams({ repoPath: repo })}`;
  const image = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const upload = (authorization?: string) => fetch(url, { method: 'POST', body: image,
    headers: { 'content-type': 'image/png', 'x-filename': 'clipboard.png', ...(authorization ? { authorization } : {}),
      'x-o8-client-addr': '127.0.0.1' } });
  for (const authorization of [undefined, 'Bearer fixture-wrong-token']) {
    const refused = await upload(authorization);
    expect(refused.status).toBe(401);
    await refused.arrayBuffer();
  }
  expect(existsSync(join(repo, 'o8-assets'))).toBe(false);
  const response = await upload(`Bearer ${server.token}`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ ok: true, bytes: image.length });
  expect(body.relPath).toMatch(/^o8-assets\/clipboard-[0-9a-f]{10}\.png$/);
  expect(readFileSync(join(repo, body.relPath))).toEqual(image);
  const get = await fetch(url, { headers: { authorization: `Bearer ${server.token}` } });
  expect(get.status).toBe(405);
  expect(get.headers.get('allow')).toBe('POST');
  await get.arrayBuffer();
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

it('preserves packet-worker lane diff and visualization ownership through o8d', async () => {
  const env = { ...process.env, O8_DATA_DIR: server.directory, CORTEX_IDE_DATA_DIR: server.directory,
    CORTEX_IDE_DB_PATH: join(server.directory, 'cortex-ide.db'), WS_TOKEN: server.token };
  const seeded = await promisify(execFile)(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--eval', `
    (async () => {
      const { createLane } = require('./src/lib/lane/registry.ts');
      const { mintPacketWorkerToken } = require('./src/lib/auth/packet-worker-token.ts');
      const { insertVisualization } = require('./src/lib/visualizations/store.ts');
      const { registerPacketWorkerTokenHash } = require('./src/lib/auth/worker-token.ts');
      const { createHash } = require('node:crypto');
      const { NextRequest } = require('next/server');
      const { GET } = require('./src/app/api/lanes/[id]/diff/route.ts');
      const root = process.env.CORTEX_IDE_DATA_DIR;
      const lane = createLane({ repoPath: root, branch: 'fixture-unresolved-', runtime: 'codex', packetId: 'fixture-native-worker' });
      const foreign = createLane({ repoPath: root, branch: 'fixture-foreign-', runtime: 'codex', packetId: 'fixture-native-foreign' });
      const token = mintPacketWorkerToken(lane.packetId);
      const foreignToken = mintPacketWorkerToken(foreign.packetId);
      const visualizationId = 'vis-00000000-0000-4000-8000-000000000001';
      insertVisualization({ kind: 'o8-visualization', id: visualizationId, title: 'Native read fixture',
        html: '<p>Persisted native read</p>', height: 320, repoPath: root, threadId: null,
        packetId: lane.packetId, createdAt: new Date().toISOString() });
      const ghostToken = 'o8pw_fixture-recognized-without-row';
      registerPacketWorkerTokenHash(createHash('sha256').update(ghostToken).digest('hex'));
      const response = await GET(new NextRequest('http://127.0.0.1/api/lanes/' + lane.id + '/diff', {
        headers: { host: '127.0.0.1', authorization: 'Bearer ' + token, 'x-o8-client-addr': '127.0.0.1' },
      }), { params: Promise.resolve({ id: lane.id }) });
      console.log(JSON.stringify({ laneId: lane.id, foreignLaneId: foreign.id, visualizationId, token, foreignToken, ghostToken, status: response.status, body: await response.json() }));
      require('./src/lib/db/index.ts').closeDb();
    })().catch(() => { process.exitCode = 1; });
  `], { env });
  const fixture = JSON.parse(seeded.stdout.split('\n').find(line => line.startsWith('{"laneId":'))!);
  expect(fixture.status).toBe(409);
  const read = (laneId: string, bearer = fixture.token, method = 'GET') => fetch(`${origin}/api/lanes/${laneId}/diff`, {
    method, headers: { authorization: `Bearer ${bearer}` },
  });
  const own = await read(fixture.laneId);
  expect(own.status).toBe(fixture.status);
  expect(await own.json()).toEqual(fixture.body);
  const foreign = await read(fixture.foreignLaneId);
  expect(foreign.status).toBe(403);
  expect((await foreign.json()).error.code).toBe('worker_packet_mismatch');
  expect((await read(fixture.laneId, fixture.ghostToken)).status).toBe(401);
  expect((await read(fixture.laneId, fixture.token, 'POST')).status).toBe(403);
  const visualization = await fetch(`${origin}/api/visualizations/${fixture.visualizationId}`, {
    headers: { authorization: `Bearer ${fixture.token}` },
  });
  expect(visualization.status).toBe(200);
  expect((await visualization.json()).result.visualization.html).toBe('<p>Persisted native read</p>');
  const ownList = await fetch(`${origin}/api/visualizations?packetId=fixture-native-worker`, {
    headers: { authorization: `Bearer ${fixture.token}` },
  });
  expect(ownList.status).toBe(200);
  expect((await ownList.json()).result.visualizations).toEqual([expect.objectContaining({ id: fixture.visualizationId })]);
  const foreignList = await fetch(`${origin}/api/visualizations?packetId=fixture-native-foreign`, {
    headers: { authorization: `Bearer ${fixture.token}` },
  });
  expect(foreignList.status).toBe(403);
  expect(await foreignList.text()).not.toContain(fixture.visualizationId);
  const foreignVisualization = await fetch(`${origin}/api/visualizations/${fixture.visualizationId}`, {
    headers: { authorization: `Bearer ${fixture.foreignToken}` },
  });
  expect(foreignVisualization.status).toBe(404);
  await foreignVisualization.arrayBuffer();
  const unrelated = await fetch(`${origin}/api/prompt-library`, { headers: { authorization: `Bearer ${fixture.token}` } });
  expect(unrelated.status).toBe(403);
  await promisify(execFile)(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--eval', `
    const { getSqlite, closeDb } = require('./src/lib/db/index.ts');
    getSqlite().prepare("UPDATE worker_tokens SET revoked_at = ? WHERE packet_id = ?").run(new Date().toISOString(), 'fixture-native-worker');
    closeDb();
  `], { env });
  expect((await read(fixture.laneId)).status).toBe(401);
  expect((await read(fixture.foreignLaneId)).status).toBe(401);
  const revokedVisualization = await fetch(`${origin}/api/visualizations/${fixture.visualizationId}`, {
    headers: { authorization: `Bearer ${fixture.token}` },
  });
  // The production visualization handler hides documents from unbound workers.
  expect(revokedVisualization.status).toBe(404);
  expect(await revokedVisualization.text()).not.toContain('Persisted native read');
});

// Write routes from #5243, each with the auth basis its gate and handler enforce.
const WRITE_ROUTES: Array<[method: string, path: string, workerStatus: number]> = [
  ['POST', '/api/orchestrator/handoff', 403],
  ['POST', '/api/orchestrator/reset-session', 403],
  ['POST', '/api/orchestrator/compact', 403],
  ['POST', '/api/orchestrator/session-rules', 403],
  ['DELETE', '/api/orchestrator/session-rules?id=fixture', 403],
  ['POST', '/api/orchestrator/delegate', 403],
  ['POST', '/api/next/voice-host', 403],
  ['POST', '/api/orchestrator/discard-packet', 403],
  ['POST', '/api/orchestrator/comparison-pick', 403],
  ['POST', '/api/orchestrator/workspace', 403],
  ['POST', '/api/orchestrator/steer-packet', 403],
  ['POST', '/api/cortex/reingest', 403],
  ['POST', '/api/orchestrator/stop-packet', 403],
  ['POST', '/api/orchestrator/rerun-with-feedback', 403],
  ['POST', '/api/orchestrator/reset-packet', 403],
  ['POST', '/api/orchestrator/spawn-prompt', 403],
  ['POST', '/api/runtime/action', 403],
  // Packet-bound workers reach proposals through the gate; the handler binds the packet.
  ['POST', '/api/cortex/proposals', 403],
];

async function seedPacketWorker(packetId: string) {
  const env = { ...process.env, O8_DATA_DIR: server.directory, CORTEX_IDE_DATA_DIR: server.directory,
    CORTEX_IDE_DB_PATH: join(server.directory, 'cortex-ide.db'), WS_TOKEN: server.token };
  const seeded = await promisify(execFile)(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--eval', `
    const { createLane } = require('./src/lib/lane/registry.ts');
    const { mintPacketWorkerToken } = require('./src/lib/auth/packet-worker-token.ts');
    const root = process.env.CORTEX_IDE_DATA_DIR;
    const lane = createLane({ repoPath: root, branch: 'fixture-writes-', runtime: 'codex', packetId: ${JSON.stringify(packetId)} });
    console.log(JSON.stringify({ laneId: lane.id, token: mintPacketWorkerToken(lane.packetId) }));
    require('./src/lib/db/index.ts').closeDb();
  `], { env });
  return JSON.parse(seeded.stdout.split('\n').find(line => line.startsWith('{"laneId":'))!) as { laneId: string; token: string };
}

let refusalWorker: ReturnType<typeof seedPacketWorker> | undefined;
it.each(WRITE_ROUTES)('refuses native %s %s without the operator bearer', async (method, path, workerStatus) => {
  const worker = await (refusalWorker ??= seedPacketWorker('fixture-writes-refusal'));
  const forged = { 'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1', 'x-o8d-bridge': 'forged', 'content-type': 'application/json' };
  const send = (authorization?: string) => fetch(origin + path, { method,
    headers: { ...forged, ...(authorization ? { authorization } : {}) },
    body: JSON.stringify({ action: 'dismiss_observation', id: 'fixture', threadId: 'thoughts-fixture', text: 'Denied fixture' }) });
  for (const [authorization, status] of [[undefined, 401], ['Bearer fixture-invalid', 401],
    ['Bearer o8ro_fixture-read-only', 403], [`Bearer ${worker.token}`, workerStatus]] as const) {
    const response = await send(authorization);
    expect(response.status, `${method} ${path} ${authorization ?? 'no bearer'}`).toBe(status);
    await response.arrayBuffer();
  }
});

it('adds, lists and removes a session rule through the native transport', async () => {
  const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' };
  const added = await fetch(`${origin}/api/orchestrator/session-rules`, { method: 'POST', headers,
    body: JSON.stringify({ threadId: 'thoughts-native-rules', text: 'Fixture native rule' }) });
  expect(added.status).toBe(200);
  const rule = (await added.json()).result.rule;
  expect(rule.text).toBe('Fixture native rule');
  const listed = await fetch(`${origin}/api/orchestrator/session-rules?threadId=thoughts-native-rules`, { headers });
  expect(listed.status).toBe(200);
  expect((await listed.json()).result.rules.map((entry: { id: string }) => entry.id)).toEqual([rule.id]);
  const removed = await fetch(`${origin}/api/orchestrator/session-rules?id=${encodeURIComponent(rule.id)}`, { method: 'DELETE', headers });
  expect(removed.status).toBe(200);
  expect((await removed.json()).result.removed).toBe(true);
});

it('keeps proposal writes bound to the worker packet through the native transport', async () => {
  const own = await seedPacketWorker('fixture-writes-proposals');
  const foreign = await seedPacketWorker('fixture-writes-proposals-foreign');
  const propose = (token: string, body: Record<string, unknown>) => fetch(`${origin}/api/cortex/proposals`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'propose_observation', kind: 'pattern', text: 'Fixture observation', ...body }) });
  const foreignPacket = await propose(own.token, { packetId: 'fixture-writes-proposals-foreign', laneId: foreign.laneId });
  expect(foreignPacket.status).toBe(403);
  expect((await foreignPacket.json()).error.code).toBe('worker_packet_mismatch');
  const foreignLane = await propose(own.token, { packetId: 'fixture-writes-proposals', laneId: foreign.laneId });
  expect(foreignLane.status).toBe(403);
  expect((await foreignLane.json()).error.code).toBe('worker_lane_mismatch');
  const dismissal = await propose(own.token, { action: 'dismiss_observation', id: 'fixture' });
  expect(dismissal.status).toBe(403);
  expect((await dismissal.json()).error.code).toBe('operator_required');
  const created = await propose(own.token, { packetId: 'fixture-writes-proposals', laneId: own.laneId });
  expect(created.status).toBe(200);
  const proposal = (await created.json()).proposal;
  expect(proposal).toMatchObject({ packetId: 'fixture-writes-proposals', laneId: own.laneId });
  const operator = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' };
  const listed = await fetch(`${origin}/api/cortex/proposals`, { headers: operator });
  expect(listed.status).toBe(200);
  expect((await listed.json()).proposals.map((entry: { id: string }) => entry.id)).toContain(proposal.id);
  const dismissed = await fetch(`${origin}/api/cortex/proposals`, { method: 'POST', headers: operator,
    body: JSON.stringify({ action: 'dismiss_observation', id: proposal.id }) });
  expect(dismissed.status).toBe(200);
  expect(await dismissed.json()).toMatchObject({ ok: true, dismissed: true });
});

it.each([
  ['POST', '/api/orchestrator/handoff', {}, 400, 'invalid_handoff_request'],
  ['POST', '/api/orchestrator/compact', { repoPath: '' }, 400, 'repoPath is required'],
  ['POST', '/api/orchestrator/delegate', {}, 400, 'clientMutationId is required'],
  ['POST', '/api/orchestrator/discard-packet', { packetId: 'fixture-missing' }, 400, 'client_mutation_id_required'],
  ['POST', '/api/orchestrator/comparison-pick', {}, 400, 'packetId is required'],
  ['POST', '/api/orchestrator/workspace', { action: 'restore', packetId: 'fixture-missing', clientMutationId: 'fixture' }, 404, 'workspace_not_found'],
  ['POST', '/api/orchestrator/steer-packet', {}, 400, 'invalid_request'],
  ['POST', '/api/cortex/reingest', { repoPath: '/fixture-missing' }, 404, 'No connected repo'],
  ['POST', '/api/orchestrator/stop-packet', {}, 400, 'packetId is required'],
  ['POST', '/api/orchestrator/rerun-with-feedback', { packetId: 'fixture-missing' }, 400, 'feedback is required'],
  ['POST', '/api/orchestrator/reset-packet', {}, 400, 'packetId is required'],
  ['POST', '/api/orchestrator/spawn-prompt', { repoPath: '/fixture-missing' }, 400, 'task is required'],
  ['POST', '/api/runtime/action', {}, 400, 'action, surfaceId, and clientMutationId are required'],
])('runs the production %s %s handler for the operator with Next stopped', async (method, path, body, status, detail) => {
  const response = await fetch(origin + path, { method, body: JSON.stringify(body),
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' } });
  expect(response.status).toBe(status);
  expect(await response.text()).toContain(detail);
});

it('resets an orchestrator session through the native transport', async () => {
  const response = await fetch(`${origin}/api/orchestrator/reset-session`, { method: 'POST',
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ repoPath: server.directory, threadId: 'thoughts-native-reset' }) });
  expect(response.status).toBe(200);
  expect((await response.json()).ok).toBe(true);
});
