import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import { getSqlite } from '@/lib/db';
import { resolveReadOnlyWorkerToken } from '@/lib/auth/read-only-worker-token';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { insertExternalMcpServer, removeExternalMcpServer } from '@/lib/mcp/external-servers';
import { createOwnedSessionStore } from '@/lib/runtimes/shared/owned-session';
import type { OwnedRuntimeAdapter, OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session';
import { panelGateMiddleware } from '@/middleware';
import { POST as workerEvent } from '@/app/api/worker/event/route';

vi.mock('@/lib/runtime/pty-bridge', () => ({ spawnBridgeTerminalSession: vi.fn(async () => { throw new Error('No fixture bridge'); }) }));
const ready = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: ready }));
// #4899 admits a Codex effort only with the launching account's model/list evidence; the fixture
// advertises its model's effort instead of running the real codex app-server.
vi.mock('@/lib/codex/service-tier-catalogue', async (original) => ({
  ...await original<typeof import('@/lib/codex/service-tier-catalogue')>(),
  getCodexSpeedCatalogue: async () => ({ models: { 'gpt-6.1-sol': [] }, reasoningEfforts: { 'gpt-6.1-sol': ['high'] } }),
}));
// The real owned spawn, HTTP middleware/worker-event route, SQLite and stop path
// are exercised. A Node child substitutes for provider inference and Seatbelt.
vi.mock('@/lib/runtimes/shared/owned-session/sandbox', async (original) => ({
  ...await original<typeof import('@/lib/runtimes/shared/owned-session/sandbox')>(),
  prepareWorkerSandbox: async (input: { binary: string; args: string[] }) => input,
}));

let root: string;
let repo: string;
let output: string;
let server: Server;
let url: string;
let attachment: string;
let prior: Record<string, string | undefined>;
const envKeys = ['CORTEX_IDE_OWNED_CODEX_ROOT', 'O8_RESTRICTED_FIXTURE_BIN', 'O8_CRASH_SURVIVABLE_WORKERS',
  'O8_FIXTURE_SERVICE_SECRET', 'GH_TOKEN', 'NODE_OPTIONS', 'ANTHROPIC_API_KEY'];
const paths = ['/api/panel/status', '/api/leases', '/api/worker/event', '/api/mobile/enroll', '/api/plugins/mcp'];

beforeEach(async () => {
  ready.mockReset().mockResolvedValue(undefined);
  root = mkdtempSync(join(getDataDir(), 'controlled-credential-'));
  repo = join(root, 'repo'); output = join(root, 'child.json');
  execFileSync('git', ['init', '-q', repo]);
  prior = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.CORTEX_IDE_OWNED_CODEX_ROOT = join(root, 'sessions');
  process.env.O8_RESTRICTED_FIXTURE_BIN = process.execPath;
  process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';
  process.env.O8_FIXTURE_SERVICE_SECRET = 'fixture-secret';
  process.env.GH_TOKEN = 'fixture-gh-secret';
  process.env.ANTHROPIC_API_KEY = 'fixture-api-key';
  process.env.NODE_OPTIONS = '--no-warnings';
  attachment = insertExternalMcpServer({ name: 'fixture_attachment', transport: 'stdio', command: process.execPath,
    args: ['-e', 'process.exit(0)'], env: { SERVICE_TOKEN: 'fixture-tool-secret' }, workerInjection: true, enabled: true }).id;
  server = createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, String(value));
      headers.set('x-o8-client-addr', '127.0.0.1');
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const request = new NextRequest(new URL(incoming.url!, url), { method: incoming.method, headers,
        ...(incoming.method === 'POST' ? { body: Buffer.concat(chunks).toString() } : {}) });
      let response: Response = panelGateMiddleware(request);
      if (response.status === 200 && request.nextUrl.pathname === '/api/worker/event') response = await workerEvent(request);
      outgoing.writeHead(response.status, { 'content-type': 'application/json' });
      outgoing.end(await response.text());
    } catch { outgoing.writeHead(500); outgoing.end('{}'); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  url = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  removeExternalMcpServer(attachment);
  for (const key of envKeys) {
    if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
  }
  rmSync(root, { recursive: true, force: true });
});
function saved(): OwnedSessionRecord {
  const sessions = join(root, 'sessions');
  return JSON.parse(readFileSync(join(sessions, readdirSync(sessions)[0]!, 'session.json'), 'utf8'));
}
function child(): { token: string; statuses: number[]; injected: number; secrets: string[]; pid: number; mcp: unknown } {
  return JSON.parse(readFileSync(output, 'utf8'));
}
function coldResolution(): { identity: { tokenId: string; runId: string } | null } {
  const cold = join(root, 'cold-resolver.cjs');
  buildSync({ entryPoints: ['tests/fixtures/read-only-worker-resolver.fixture.ts'], outfile: cold,
    platform: 'node', format: 'cjs', bundle: true, logLevel: 'silent', external: ['better-sqlite3'],
    alias: { 'server-only': join(process.cwd(), 'tests/stubs/server-only.ts') } });
  return JSON.parse(execFileSync(process.execPath, [cold, child().token], { encoding: 'utf8',
    env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules') } }));
}
function adapter(persistent = true): OwnedRuntimeAdapter {
  return { runtimeId: 'codex', surfaceIdPrefix: 'codex-owned:', rootEnvVar: 'CORTEX_IDE_OWNED_CODEX_ROOT',
    rootDefault: join(root, 'sessions'), binaryName: 'node', binaryEnvOverride: 'O8_RESTRICTED_FIXTURE_BIN',
    humanLabel: 'Fixture', squadShortName: 'Fixture', workerMcpInjection: 'config-override',
    launchArgs: ({ workerMcpServers, workerMcpConfigPath }) => ['-e', `
      (async () => {
        const token = process.env.O8_WORKER_TOKEN;
        const statuses = await Promise.all(${JSON.stringify(paths)}.map(async (path, i) =>
          (await fetch(${JSON.stringify(url)} + path, { method: i ? 'POST' : 'GET',
            headers: { authorization: 'Bearer ' + token }, ...(i ? { body: '{}' } : {}) })).status));
        require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({ token, statuses,
          injected: ${workerMcpServers?.length ?? 0}, pid: process.pid,
          mcp: ${workerMcpConfigPath ? `JSON.parse(require('node:fs').readFileSync(${JSON.stringify(workerMcpConfigPath)}, 'utf8'))` : 'null'},
          secrets: ${JSON.stringify(envKeys.slice(3))}.filter(key => !!process.env[key]) }));
        ${persistent ? 'setInterval(() => {}, 1000);' : 'process.exit(0);'}
      })().catch(() => process.exit(1));`],
    resumeArgs: () => [], parseRunLog: () => ({ entries: [], outcome: 'running', completedTurn: false }) };
}
function request(controlled = true) {
  return { cwd: repo, prompt: 'Inspect the selected fixture.', packetId: 'fixture-credential-packet',
    model: 'gpt-6.1-sol', effort: 'high' as const, runtimeConfig: { workMode: 'read-only' },
    ...(controlled ? { executionPolicy: 'single-attempt' as const } : {}) };
}

describe('controlled owned worker credentials through actual child HTTP', () => {
  it('denies every API path including public and self-authenticated routes, strips service secrets and attachments, and revokes on stop', async () => {
    const store = createOwnedSessionStore(adapter(), { workspaceSpawnGuard: async () => ({ status: 'available', source: 'no-snapshot' }) });
    const result = await store.launch(request());
    expect(result.ok, result.note).toBe(true);
    try {
      await vi.waitFor(() => expect(() => child()).not.toThrow(), { timeout: 5000 });
      expect(child().statuses).toEqual([403, 403, 403, 403, 403]);
      expect(child().injected).toBe(0);
      expect(child().secrets).toEqual([]);
      expect(coldResolution().identity).toMatchObject({ runId: saved().activeRun!.id });
      expect((await workerEvent(new Request(`${url}/api/worker/event`, { method: 'POST',
        headers: { authorization: `Bearer ${child().token}` }, body: '{}' }))).status).toBe(403);
      expect(resolveRequestPrincipalContext(new Request(url, { headers: { authorization: `Bearer ${child().token}` } })))
        .toMatchObject({ role: 'worker', packetId: null, readOnly: true });
    } finally { await store.interrupt(result.surfaceId); }
    await vi.waitFor(() => expect(() => process.kill(child().pid, 0)).toThrow(), { timeout: 5000 });
    const row = getSqlite().prepare('SELECT scope, revoked_at FROM worker_tokens WHERE lease_process_marker = ?').get(saved().recentRuns[0]!.id) as { scope: string; revoked_at: string | null };
    expect(row.scope).toBe('local-read-only');
    expect(row.revoked_at).toBeTruthy();
    expect(coldResolution()).toEqual({ identity: null });
    expect(resolveRequestPrincipalContext(new Request(url, { headers: { authorization: `Bearer ${child().token}` } }))).toMatchObject({ role: 'anonymous' });
  });

  it('revokes a terminal child and keeps the consumed attempt held', async () => {
    const store = createOwnedSessionStore(adapter(false), { workspaceSpawnGuard: async () => ({ status: 'available', source: 'no-snapshot' }) });
    const result = await store.launch(request());
    await vi.waitFor(() => expect(() => child()).not.toThrow(), { timeout: 5000 });
    await vi.waitFor(() => expect(saved().activeRun).toBeUndefined(), { timeout: 5000 });
    expect(resolveReadOnlyWorkerToken(child().token)).toBeNull();
    await expect(store.resume(result.surfaceId, 'Repeat it')).rejects.toThrow(/single.attempt/i);
    expect(saved().runIdentityLedger?.totalRuns).toBe(1);
  });

  it('uses an explicit empty MCP config for a controlled config-file adapter', async () => {
    const runtime = adapter(); runtime.workerMcpInjection = 'config-file';
    const store = createOwnedSessionStore(runtime, { workspaceSpawnGuard: async () => ({ status: 'available', source: 'no-snapshot' }) });
    const result = await store.launch(request());
    try {
      await vi.waitFor(() => expect(() => child()).not.toThrow(), { timeout: 5000 });
      expect(child().mcp).toEqual({ mcpServers: {} });
      expect(child().injected).toBe(0);
    } finally { await store.interrupt(result.surfaceId); }
  });

  it('revokes a credential if readiness refuses before journaling or spawning', async () => {
    ready.mockRejectedValueOnce(new Error('Fixture readiness refused'));
    const store = createOwnedSessionStore(adapter());
    await expect(store.launch(request())).rejects.toThrow('Fixture readiness refused');
    const rows = getSqlite().prepare("SELECT revoked_at FROM worker_tokens WHERE scope = 'local-read-only'").all() as Array<{ revoked_at: string | null }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.revoked_at)).toBe(true);
    expect(() => child()).toThrow();
  });

  it('preserves the ordinary packet worker credential and configured attachments as a control', async () => {
    const store = createOwnedSessionStore(adapter(), { workspaceSpawnGuard: async () => ({ status: 'available', source: 'no-snapshot' }) });
    // The worker's source environment holds GH_TOKEN; since #4585 only RUNTIME_KEYS['copilot-cli'] passes it on.
    expect(process.env.GH_TOKEN).toBe('fixture-gh-secret');
    const result = await store.launch(request(false));
    expect(result.ok, result.note).toBe(true);
    try {
      await vi.waitFor(() => expect(() => child()).not.toThrow(), { timeout: 5000 });
      expect(child().statuses[0]).toBe(200);
      expect(child().statuses[2]).toBe(400);
      expect(child().injected).toBe(1);
      expect(child().secrets).not.toContain('GH_TOKEN');
      expect(resolveRequestPrincipalContext(new Request(url, { headers: { authorization: `Bearer ${child().token}` } })))
        .toMatchObject({ role: 'worker', packetId: 'fixture-credential-packet' });
    } finally { await store.interrupt(result.surfaceId); }
  });

  it('passes GH_TOKEN to an ordinary Copilot CLI worker, whose runtime declares it', async () => {
    const runtime = { ...adapter(), runtimeId: 'copilot-cli', surfaceIdPrefix: 'copilot-cli-owned:' };
    const store = createOwnedSessionStore(runtime, { workspaceSpawnGuard: async () => ({ status: 'available', source: 'no-snapshot' }) });
    // Copilot CLI has no reasoning-effort surface, so its launch carries no effort pin.
    const { effort: _effort, ...ordinary } = request(false);
    const result = await store.launch(ordinary);
    expect(result.ok, result.note).toBe(true);
    try {
      await vi.waitFor(() => expect(() => child()).not.toThrow(), { timeout: 5000 });
      expect(child().secrets).toContain('GH_TOKEN');
    } finally { await store.interrupt(result.surfaceId); }
  });
});
