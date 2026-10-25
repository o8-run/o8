import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { compareMcpExchanges, replayMcp, sendRecordedMcp, type RecordedMcpRequest } from '../scripts/lib/mcp-parity';
import { seedMcpScaleFixture, startMcpCpuLoad } from './fixtures/mcp-parity/scale-benchmark';

// Replace external observations only. Middleware, MCP handlers, API routes and persisted state are real.
vi.mock('@clerk/nextjs/server', () => ({ clerkMiddleware: (handler: unknown) => handler }));
vi.mock('@/lib/mcp/o8-webview-client', () => ({ O8WebviewClient: class {
  async screenshot() { return { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' }; }
} }));
vi.mock('@/lib/runtime/inventory', () => ({ getRuntimeInventorySnapshot: async () => ({ agents: [] }) }));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  getRuntimeAuthSnapshot: async () => ({ statuses: {} }),
  getDispatchableRuntimeAvailability: async () => [],
}));

const directory = realpathSync(process.env.CORTEX_IDE_DATA_DIR!);
const nativeReadTest = it.runIf(['linux', 'darwin'].includes(process.platform));
process.env.CORTEX_IDE_DB_PATH = join(directory, 'cortex-ide.db');
const token = 'o8d-fixture-operator-credential';
writeFileSync(join(directory, 'ws-token'), token);
const refusedCredentials = { worker: 'fixture-worker-credential', device: 'fixture-device-credential', spectator: 'fixture-spectator-credential' };
writeFileSync(join(directory, 'worker-token'), refusedCredentials.worker);
for (const [filename, credential] of [['mobile-device-tokens', refusedCredentials.device], ['broadcast-spectator-tokens', refusedCredentials.spectator]]) {
  writeFileSync(join(directory, filename), `${createHash('sha256').update(credential).digest('hex')}\n`);
}
process.env.O8D_MCP_READS = '1';
const { panelGateMiddleware } = await import('@/middleware');
const { mintPluginToken } = await import('@/lib/auth/plugin-token');
const mcp = await import('@/app/api/mcp/route');
const tasks = await import('@/app/api/tasks/route');
const mission = await import('@/app/api/orchestrator/status/route');
const status = await import('@/app/api/operator/status/route');
const defaults = await import('@/app/api/panel/operator-defaults/route');
const repos = await import('@/app/api/panel/repos/route');
const projects = await import('@/app/api/panel/projects/route');
const leases = await import('@/app/api/leases/route');
const spec = await import('@/app/api/repo-spec/route');
const { closeDb, getSqlite } = await import('@/lib/db');
const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { normalizeOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { probeMetadataLockProcessIdentitySync } = await import('@/lib/worktree/metadata-lock-process-identity');
const children: ChildProcess[] = [];
const seen: Array<{ path: string; body: string; headers: Record<string, string | string[] | undefined> }> = [];
type Handler = (request: NextRequest) => Response | Promise<Response>;
const routes: Record<string, Partial<Record<string, Handler>>> = {
  '/api/mcp': { POST: mcp.POST, GET: mcp.GET, DELETE: mcp.DELETE },
  '/api/tasks': { GET: tasks.GET, POST: tasks.POST },
  '/api/orchestrator/status': { GET: mission.GET },
  '/api/operator/status': { GET: status.GET },
  '/api/panel/operator-defaults': { GET: defaults.GET, POST: defaults.POST },
  '/api/panel/repos': { GET: repos.GET, POST: repos.POST },
  '/api/panel/projects': { GET: projects.GET, POST: projects.POST },
  '/api/leases': { GET: leases.GET, POST: leases.POST },
  '/api/repo-spec': { GET: spec.GET, POST: spec.POST },
};
let base = '';
let rust = '';
let nativeRust = '';
let records: RecordedMcpRequest[];
let failedSource = '';
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const request = new NextRequest(`${base}${incoming.url}`, {
      method: incoming.method,
      headers: incoming.headers as Record<string, string>,
      ...(body.length ? { body } : {}),
    });
    seen.push({ path: request.nextUrl.pathname, body: body.toString(), headers: incoming.headers });
    const gate = panelGateMiddleware(request);
    const handler = routes[request.nextUrl.pathname]?.[request.method];
    const response = gate.status !== 200 ? gate : request.nextUrl.pathname === failedSource
      ? Response.json({ error: 'fixture unavailable' }, { status: 503 })
      : handler ? await handler(request) : new Response(null, { status: 404 });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"fixture route failed"}');
  }
});

async function call(baseUrl: string, name: string, args: Record<string, unknown> = {}) {
  return sendRecordedMcp(baseUrl, token, { name, body: {
    jsonrpc: '2.0', id: 'fixture', method: 'tools/call', params: { name, arguments: args },
  } });
}
function toolPayload(exchange: Awaited<ReturnType<typeof call>>) {
  return JSON.parse((exchange.body as { result: { content: Array<{ text: string }> } }).result.content[0].text);
}

async function startRust(upstream: string, native = false, database?: string, executable?: string): Promise<string> {
  const binary = executable ?? process.env.O8D_MCP_TEST_BINARY ?? 'crates/o8d/target/debug/o8d';
  const child = spawn(binary, ['--experimental-mcp', '--listen', '127.0.0.1:0', '--upstream', upstream,
    ...(native ? ['--native-reads', '--data-dir', directory] : [])], {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(database ? { env: { ...process.env, CORTEX_IDE_DB_PATH: database } } : {}),
  });
  children.push(child);
  const [line] = await Promise.race([once(child.stdout!, 'data'), once(child, 'exit').then(() => { throw new Error('Rust MCP startup failed'); })]);
  return `http://${JSON.parse(String(line)).listening}`;
}
async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture listener');
  return `http://127.0.0.1:${address.port}`;
}
async function stop(server: ReturnType<typeof createServer>) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

beforeAll(async () => {
  if (!process.env.O8D_MCP_TEST_BINARY) {
    await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-mcp']);
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture listener');
  base = `http://127.0.0.1:${address.port}`;
  process.env.PORT = String(address.port);
  process.env.O8_API_PORT = String(address.port);
  process.env.O8_API_BASE = base;
  writeFileSync(join(directory, 'api-port'), String(address.port));
  mkdirSync(join(directory, 'repo'), { recursive: true });
  const repo = realpathSync(join(directory, 'repo'));
  await promisify(execFile)('git', ['init', '--quiet', repo]);
  writeFileSync(join(directory, 'repos.json'), JSON.stringify({ version: 1, repos: [{
    id: 'fixture-repo', name: 'Fixture', localPath: repo, remoteUrl: null,
    defaultBranch: 'main', isGitRepo: true, createdAt: '2026-01-01T00:00:00.000Z',
  }] }));
  writeFileSync(join(directory, 'projects.json'), JSON.stringify({ activeProjectId: 'fixture-project', projects: [
    { id: 'default', name: 'Workspace', repoPaths: [], createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'fixture-project', name: 'Fixture project', repoPaths: [repo], createdAt: '2026-01-01T00:00:00.000Z' },
  ] }));
  writeOrchestratorControlPlaneState(normalizeOrchestratorMissionState({
    missionId: 'fixture-mission', prompt: 'Fixture mission', summary: 'Recorded mission', runtime: 'codex',
    packets: [{ id: 'fixture-packet', title: 'Queued packet', summary: 'Fixture packet', runtime: 'codex',
      status: 'draft', queueState: 'queued', releaseState: 'pending', dependencyPacketIds: [] }],
  }));
  for (const laneStatus of ['running', 'reviewing', 'failed', 'completed'] as const) {
    const lane = createLane({ repoPath: repo, runtime: 'codex', branch: `fixture/${laneStatus}`,
      label: `Fixture ${laneStatus}`, baseCommit: 'a'.repeat(40) });
    setLaneStatus(lane.id, laneStatus, 'system');
  }
  const leaseResponse = await fetch(`${base}/api/leases`, { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ action: 'acquire', resource: 'fixture:mcp-parity',
    owner: { id: 'fixture-owner', label: 'Fixture owner', pid: process.pid }, claimToken: 'fixture-lease-claim-value-0123456789', ttlMs: 86_400_000 }) });
  expect(leaseResponse.status).toBe(200);
  rust = await startRust(base);
  nativeRust = await startRust(base, true);
  // Establish the paired publisher generation using the caller's credential.
  await call(base, 'o8_list_repos');
  await call(nativeRust, 'o8_list_repos');
  records = JSON.parse(readFileSync('tests/fixtures/mcp-parity/requests.json', 'utf8').replaceAll('$FIXTURE_REPO', repo));
}, 120_000);
afterAll(async () => {
  for (const child of children) child.kill();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

describe('o8d MCP through the real HTTP JSON-RPC entry point', () => {
  it('serves MCP from the o8d executable only with explicit opt-in', async () => {
    const binary = process.env.O8D_TEST_BINARY ?? 'crates/o8d/target/debug/o8d';
    await expect(promisify(execFile)(binary, ['--listen', '127.0.0.1:0', '--upstream', base])).rejects.toThrow('o8d failed');
    const endpoint = await startRust(base, true, undefined, binary);
    const recording = { name: 'initialize', body: { jsonrpc: '2.0', id: 'initialize', method: 'initialize' } };
    compareMcpExchanges(await sendRecordedMcp(base, token, recording), await sendRecordedMcp(endpoint, token, recording));
    expect(await replayMcp(base, endpoint, token, records)).toBe(records.length);
  }, 120_000);

  it('owns legacy initialization after authorization and preserves session responses', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 'session', method: 'initialize' });
    seen.length = 0;
    const response = await fetch(`${nativeRust}/api/mcp`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body });
    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toMatch(/^[a-f0-9-]{36}$/);
    expect((await response.json()).result.protocolVersion).toBe('2024-11-05');
    expect(seen.filter((entry) => entry.path === '/api/mcp').map((entry) => JSON.parse(entry.body).method)).toEqual(['o8d/read-context']);
    for (const credential of ['absent', 'invalid', 'read-only'] as const) {
      const recording = { name: 'initialize refusal', credential, body };
      compareMcpExchanges(await sendRecordedMcp(base, token, recording), await sendRecordedMcp(nativeRust, token, recording));
    }
    const notification = await fetch(`${nativeRust}/api/mcp`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize' }) });
    expect(notification.status).toBe(202);
    expect(notification.headers.get('mcp-session-id')).toMatch(/^[a-f0-9-]{36}$/);
    expect(await notification.text()).toBe('');
  });

  it('preserves catalog batches byte for byte and in request order', async () => {
    const body = '[{"jsonrpc":"2.0","id":1.0,"method":"tools/list"},{"jsonrpc":"2.0","id":"catalog-two","method":"tools/list"}]';
    const options = { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body };
    const expected = await fetch(`${base}/api/mcp`, options);
    seen.length = 0;
    const actual = await fetch(`${nativeRust}/api/mcp`, options);
    expect(actual.status).toBe(expected.status);
    expect(Buffer.from(await actual.arrayBuffer()).equals(Buffer.from(await expected.arrayBuffer()))).toBe(true);
    const forwarded = seen.filter((entry) => entry.path === '/api/mcp');
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].body).toBe(body);
  });

  it.each(['o8_send', 'dispatch_mission', 'o8_approve', 'approve_and_merge'])(
    'forwards %s unchanged for the TypeScript profile refusal', async (name) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: name, method: 'tools/call', params: {
        name, arguments: { fixture: 'must stay unchanged' },
      } });
      const recording = { name, body, headers: { 'x-o8-mcp-profile': 'unknown', 'x-fixture-correlation': name } };
      const reference = await sendRecordedMcp(base, token, recording);
      seen.length = 0;
      compareMcpExchanges(reference, await sendRecordedMcp(nativeRust, token, recording));
      const forwarded = seen.filter((entry) => entry.path === '/api/mcp');
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0].body).toBe(body);
      expect(forwarded[0].headers['x-fixture-correlation']).toBe(name);
      expect(reference.body).toMatchObject({ result: { isError: true } });
    },
  );

  it.each(['full', 'dogfood', 'visualizations', 'unknown'])('returns byte-identical catalog JSON for the %s profile', async (profile) => {
    const body = readFileSync('tests/fixtures/mcp-parity/list.json', 'utf8');
    const options = { method: 'POST', headers: { authorization: `Bearer ${token}`,
      'content-type': 'application/json', 'x-o8-mcp-profile': profile }, body };
    const responses = await Promise.all([base, rust, nativeRust].map((url) => fetch(`${url}/api/mcp`, options)));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    const bytes = await Promise.all(responses.map(async (response) => Buffer.from(await response.arrayBuffer())));
    for (const candidate of bytes.slice(1)) expect(candidate.equals(bytes[0])).toBe(true);
  });

  it.each([false, true])('rejects catalog byte drift through the URL replay harness (batch=%s)', async (batch) => {
    const catalog = readFileSync('tests/fixtures/mcp-parity/list.json', 'utf8');
    const body = batch ? `[${catalog}]` : catalog;
    const reference = await fetch(`${base}/api/mcp`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body });
    const reordered = JSON.stringify(await reference.json(), null, 2);
    const candidate = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(reordered);
    });
    const endpoint = await listen(candidate);
    try {
      await expect(replayMcp(base, endpoint, token, [{ name: 'catalog byte drift', body }])).rejects.toThrow('mismatch');
    } finally { await stop(candidate); }
  });

  it('replays the recorded tools/list request against both servers', async () => {
    const body = readFileSync('tests/fixtures/mcp-parity/list.json', 'utf8');
    const results = await Promise.all([base, rust].map((url) => sendRecordedMcp(url, token, { name: 'catalog', body })));
    expect(results[0].status).toBe(200);
    expect(results[1].status).toBe(200);
    compareMcpExchanges(results[0], results[1]);
  });

  it('replays every recorded request field by field against the same persisted state', async () => {
    expect(await replayMcp(base, rust, token, records)).toBe(records.length);
  }, 120_000);

  it('replays the recorded parity set with native reads enabled', async () => {
    expect(await replayMcp(base, nativeRust, token, records)).toBe(records.length);
  }, 120_000);

  nativeReadTest('publishes the platform process identity and refuses a different boot or start identity', async () => {
    await call(base, 'o8_list_repos');
    const sqlite = getSqlite();
    const row = sqlite.prepare("SELECT value FROM app_state WHERE key = 'o8d/mcp/v1/policy'").get() as { value: string };
    const policy = JSON.parse(row.value);
    const probe = probeMetadataLockProcessIdentitySync(process.pid);
    expect(probe.state).toBe('live');
    if (probe.state !== 'live') throw new Error('fixture process identity unavailable');
    expect(policy.identity).toEqual(probe.identity);
    for (const field of ['bootId', 'startId'] as const) {
      sqlite.prepare("UPDATE app_state SET value = ? WHERE key = 'o8d/mcp/v1/policy'").run(JSON.stringify({
        ...policy, identity: { ...policy.identity, [field]: 'different-fixture-identity' },
      }));
      try {
        seen.length = 0;
        expect((await call(nativeRust, 'o8_list_repos')).status).toBe(200);
        expect(seen.filter((entry) => entry.path === '/api/mcp').map((entry) => JSON.parse(entry.body).method)).toEqual(['tools/call']);
      } finally { sqlite.prepare("UPDATE app_state SET value = ? WHERE key = 'o8d/mcp/v1/policy'").run(row.value); }
    }
  });

  nativeReadTest.each(['fixture:mcp-parity', 'fixture:unheld', ' fixture:mcp-parity '])(
    'reads lease status for %s natively through recorded replay', async (resource) => {
      const recording = [{ name: 'lease status', body: { jsonrpc: '2.0', id: 'lease-status',
        method: 'tools/call', params: { name: 'o8_lease_status', arguments: { resource } } } }];
      const reference = await sendRecordedMcp(base, token, recording[0]);
      seen.length = 0;
      compareMcpExchanges(reference, await sendRecordedMcp(nativeRust, token, recording[0]));
      expect(seen).toHaveLength(0);
      expect(await replayMcp(base, nativeRust, token, recording)).toBe(1);
    },
  );

  nativeReadTest('reads the spec from disk, including missing files and committed edits, without TypeScript', async () => {
    const repoPath = realpathSync(join(directory, 'repo'));
    const path = join(repoPath, 'o8.md');
    for (const content of [null, '# Fixture spec\n\nRead π and 🦀.\n', '# Edited fixture\r\n']) {
      if (content === null) { if (existsSync(path)) unlinkSync(path); }
      else writeFileSync(path, content);
      const recording = { name: 'spec read', body: { jsonrpc: '2.0', id: 'spec', method: 'tools/call',
        params: { name: 'o8_spec_read', arguments: { repoPath } } } };
      const reference = await sendRecordedMcp(base, token, recording);
      seen.length = 0;
      compareMcpExchanges(reference, await sendRecordedMcp(nativeRust, token, recording));
      expect(seen).toHaveLength(0);
      expect(existsSync(path)).toBe(content !== null);
      expect(await replayMcp(base, nativeRust, token, [recording])).toBe(1);
    }
  });

  it.each([{ resource: '' }, { resource: 'fixture:🦀' }, { resource: '\ninside\ncontrol' }, {}])(
    'preserves lease-status input refusals for %j', async (args) => {
      compareMcpExchanges(await call(base, 'o8_lease_status', args), await call(nativeRust, 'o8_lease_status', args));
    },
  );

  nativeReadTest('retains TypeScript path normalization for noncanonical spec paths', async () => {
    const repo = realpathSync(join(directory, 'repo'));
    for (const repoPath of [`${repo}/.`, `${repo}//`, `${repo}/../repo`]) {
      const reference = await call(base, 'o8_spec_read', { repoPath });
      seen.length = 0;
      compareMcpExchanges(reference, await call(nativeRust, 'o8_spec_read', { repoPath }));
      expect(seen.some((entry) => entry.path === '/api/mcp' && JSON.parse(entry.body).method === 'tools/call')).toBe(true);
    }
  });

  nativeReadTest.each([
    '0009', '000A', '000B', '000C', '000D', '0020', '00A0', '1680',
    '2000', '2001', '2002', '2003', '2004', '2005', '2006', '2007',
    '2008', '2009', '200A', '2028', '2029', '202F', '205F', '3000', 'FEFF',
    // Unicode White_Space and historical whitespace that ECMAScript retains.
    '0085', '180E', '200B', '001C', '001D', '001E', '001F',
  ])('matches JavaScript spec-path trim for U+%s through recorded replay', async (code) => {
    const character = String.fromCodePoint(Number.parseInt(code, 16));
    const repo = join(directory, `unicode-spec-${code}`);
    for (const [path, content] of [[repo, '# Base spec\n'], [`${repo}${character}`, '# Distinct Unicode spec\n']]) {
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'o8.md'), content);
    }
    const repoPath = `${realpathSync(repo)}${character}`;
    const recording = { name: `spec trim U+${code}`, body: { jsonrpc: '2.0', id: 'unicode-spec',
      method: 'tools/call', params: { name: 'o8_spec_read', arguments: { repoPath } } } };
    const reference = await sendRecordedMcp(base, token, recording);
    expect(toolPayload(reference)).toMatchObject({
      content: character.trim() ? '# Distinct Unicode spec\n' : '# Base spec\n',
      path: join(repoPath.trim(), 'o8.md'),
    });
    seen.length = 0;
    compareMcpExchanges(reference, await sendRecordedMcp(nativeRust, token, recording));
    expect(seen).toHaveLength(0);
    expect(await replayMcp(base, nativeRust, token, [recording])).toBe(1);
  });

  nativeReadTest.each(['o8_status', 'get_mission_status', 'o8_task_list', 'o8_list_repos', 'o8_list_projects', 'o8_lease_list'])(
    'reads %s natively with zero TypeScript requests', async (name) => {
      const expected = await call(base, name);
      seen.length = 0;
      const actual = await call(nativeRust, name);
      compareMcpExchanges(expected, actual, name === 'o8_status'
        ? ['/body/result/content/0/text/json/data/snapshot/ageMs'] : []);
      expect(seen.map((entry) => entry.path)).toEqual([]);
    },
  );

  it('replays additional native credential and profile refusals', async () => {
    const additional: RecordedMcpRequest[] = JSON.parse(readFileSync('tests/fixtures/mcp-parity/native-reads.json', 'utf8')
      .replaceAll('$FIXTURE_REPO', realpathSync(join(directory, 'repo'))));
    const policy = getSqlite().prepare("SELECT value FROM app_state WHERE key = 'o8d/mcp/v1/policy'").get() as { value: string };
    const recordedNames = additional.map((record) => (record.body as { params: { name: string } }).params.name);
    expect([...new Set(recordedNames)].sort()).toEqual(JSON.parse(policy.value).names.sort());
    expect(await replayMcp(base, nativeRust, token, additional)).toBe(additional.length);
  });

  nativeReadTest('keeps all six warmed SQLite reads available during an upstream outage without writes', async () => {
    const names = ['o8_status', 'get_mission_status', 'o8_task_list', 'o8_list_repos', 'o8_list_projects', 'o8_lease_list'];
    const expected = new Map();
    for (const name of names) expected.set(name, await call(base, name));
    const sqlite = getSqlite();
    const changes = sqlite.prepare('SELECT total_changes() AS count').get();
    const version = sqlite.pragma('data_version', { simple: true });
    const files = ['repos.json', 'projects.json', 'orchestrator-state.json'];
    const contents = files.map((name) => readFileSync(join(directory, name), 'utf8'));
    seen.length = 0;
    failedSource = '/api/mcp';
    try {
      for (const name of names) {
        compareMcpExchanges(expected.get(name), await call(nativeRust, name), name === 'o8_status'
          ? ['/body/result/content/0/text/json/data/snapshot/ageMs'] : []);
      }
      expect(seen).toHaveLength(0);
      expect(sqlite.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
      expect(sqlite.pragma('data_version', { simple: true })).toBe(version);
      expect(files.map((name) => readFileSync(join(directory, name), 'utf8'))).toEqual(contents);
    } finally { failedSource = ''; }
  });

  nativeReadTest('sees committed WAL updates without modifying SQLite or the registries', async () => {
    const sqlite = getSqlite();
    expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    const lane = createLane({ repoPath: join(directory, 'repo'), runtime: 'codex', branch: 'fixture/native-wal', label: 'Native WAL fixture' });
    const expected = await call(base, 'o8_task_list');
    const changes = sqlite.prepare('SELECT total_changes() AS count').get();
    const dataVersion = sqlite.pragma('data_version', { simple: true });
    const jsonFiles = ['repos.json', 'projects.json', 'orchestrator-state.json'].map((file) => readFileSync(join(directory, file), 'utf8'));
    seen.length = 0;
    const result = await call(nativeRust, 'o8_task_list');
    compareMcpExchanges(expected, result);
    expect(toolPayload(result).tasks.some((task: { id: string }) => task.id === lane.id)).toBe(true);
    expect(seen).toHaveLength(0);
    expect(sqlite.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
    expect(sqlite.pragma('data_version', { simple: true })).toBe(dataVersion);
    expect(['repos.json', 'projects.json', 'orchestrator-state.json'].map((file) => readFileSync(join(directory, file), 'utf8'))).toEqual(jsonFiles);
  });

  it('does not create a missing native database and falls back through tools/call', async () => {
    const database = join(directory, 'absent-native.db');
    const candidate = await startRust(base, true, database);
    const expected = await call(base, 'o8_list_projects');
    seen.length = 0;
    compareMcpExchanges(expected, await call(candidate, 'o8_list_projects'));
    expect(seen.filter((entry) => entry.path === '/api/mcp').map((entry) => JSON.parse(entry.body).method)).toEqual(['tools/call']);
    expect(existsSync(database)).toBe(false);
    expect(existsSync(`${database}-wal`)).toBe(false);
  });

  it.each([-1, 5_000, 15_000])('falls back for a persisted status age of %s ms', async (ageMs) => {
    await call(base, 'o8_status', { fresh: true });
    const sqlite = getSqlite();
    const row = sqlite.prepare("SELECT key, value FROM app_state WHERE key LIKE 'o8d/mcp/v1/status/%' ORDER BY updated_at DESC LIMIT 1").get() as { key: string; value: string };
    const value = JSON.parse(row.value);
    value.snapshot.capturedAt = ageMs < 0 ? Date.now() + 60_000 : Date.now() - ageMs;
    sqlite.prepare('UPDATE app_state SET value = ? WHERE key = ?').run(JSON.stringify(value), row.key);
    try {
      seen.length = 0;
      expect((await call(nativeRust, 'o8_status')).status).toBe(200);
      expect(seen.filter((entry) => entry.path === '/api/mcp').map((entry) => JSON.parse(entry.body).method)).toEqual(['tools/call']);
    } finally { sqlite.prepare('UPDATE app_state SET value = ? WHERE key = ?').run(row.value, row.key); }
  });

  it('preserves exact session snapshot keys and explicit fresh requests', async () => {
    for (const args of [{ sessionKey: 'fixture:unobserved' }, { fresh: true }]) {
      seen.length = 0;
      const result = await call(nativeRust, 'o8_status', args);
      expect(result.status).toBe(200);
      expect(seen.filter((entry) => entry.path === '/api/mcp').map((entry) => JSON.parse(entry.body).method)).toEqual(['tools/call']);
    }
  });

  nativeReadTest('falls back on malformed policy, stale publisher identity and disabled reads', async () => {
    await call(base, 'o8_list_repos');
    const sqlite = getSqlite();
    const row = sqlite.prepare("SELECT value FROM app_state WHERE key = 'o8d/mcp/v1/policy'").get() as { value: string };
    const original = JSON.parse(row.value);
    for (const value of ['{', JSON.stringify({ ...original, identity: { ...original.identity, startId: 'invalid' } }), JSON.stringify({ ...original, enabled: false })]) {
      sqlite.prepare("UPDATE app_state SET value = ? WHERE key = 'o8d/mcp/v1/policy'").run(value);
      seen.length = 0;
      expect((await call(nativeRust, 'o8_list_repos')).status).toBe(200);
      expect(seen.filter((entry) => entry.path === '/api/mcp').map((entry) => JSON.parse(entry.body).method)).toEqual(['tools/call']);
    }
    sqlite.prepare("UPDATE app_state SET value = ? WHERE key = 'o8d/mcp/v1/policy'").run(row.value);
  });

  it.each(['archived', 'dependency', 'preflight'] as const)('preserves %s mission reconciliation through fallback', async (kind) => {
    const saved = readFileSync(join(directory, 'orchestrator-state.json'), 'utf8');
    const state = JSON.parse(saved).mission;
    const packet = state.packets[0];
    if (kind === 'archived') packet.archivedAt = '2026-01-01T00:00:00.000Z';
    if (kind === 'dependency') {
      state.packets.push({ ...packet, id: 'dependent-fixture', dependencyPacketIds: [packet.id] });
    }
    if (kind === 'preflight') { packet.preflightRefusals = 3; packet.maxAttempts = 3; }
    writeOrchestratorControlPlaneState(normalizeOrchestratorMissionState(state));
    try {
      for (const name of ['get_mission_status', 'o8_task_list']) {
        const expected = await call(base, name);
        seen.length = 0;
        compareMcpExchanges(expected, await call(nativeRust, name));
        expect(seen.filter((entry) => entry.path === '/api/mcp').map((entry) => JSON.parse(entry.body).method)).toEqual(['tools/call']);
      }
    } finally { writeFileSync(join(directory, 'orchestrator-state.json'), saved); }
  });

  nativeReadTest('refuses an unbound publisher generation even when its process identity is live', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"Fixture upstream refuses"}');
    });
    const upstreamUrl = await listen(upstream);
    await call(base, 'o8_list_repos');
    const sqlite = getSqlite();
    const row = sqlite.prepare("SELECT value FROM app_state WHERE key = 'o8d/mcp/v1/policy'").get() as { value: string };
    const fake = { ...JSON.parse(row.value), base: upstreamUrl, generation: 'another-publisher-generation' };
    sqlite.prepare("UPDATE app_state SET value = ? WHERE key = 'o8d/mcp/v1/policy'").run(JSON.stringify(fake));
    try {
      const candidate = await startRust(upstreamUrl, true);
      const actual = await call(candidate, 'o8_list_repos');
      expect(actual.status).toBe(403);
      expect(actual.body).toEqual({ error: 'Fixture upstream refuses' });
    } finally {
      sqlite.prepare("UPDATE app_state SET value = ? WHERE key = 'o8d/mcp/v1/policy'").run(row.value);
      await stop(upstream);
    }
  });

  it.each(['data', 'approvals', 'runtimeConnections'] as const)('falls back instead of projecting malformed published %s', async (field) => {
    await call(base, 'o8_status', { fresh: true });
    const sqlite = getSqlite();
    const row = sqlite.prepare("SELECT key, value FROM app_state WHERE key LIKE 'o8d/mcp/v1/status/%' ORDER BY updated_at DESC LIMIT 1").get() as { key: string; value: string };
    const broken = JSON.parse(row.value);
    if (field === 'data') delete broken.snapshot.data;
    if (field === 'approvals') broken.snapshot.data.approvals = {};
    if (field === 'runtimeConnections') broken.snapshot.runtimeConnections = {};
    sqlite.prepare('UPDATE app_state SET value = ? WHERE key = ?').run(JSON.stringify(broken), row.key);
    try {
      seen.length = 0;
      const actual = await call(nativeRust, 'o8_status');
      expect(actual.status).toBe(200);
      expect(toolPayload(actual).data.runtimeConnections).toBeTruthy();
      expect(seen.filter((entry) => entry.path === '/api/mcp').map((entry) => JSON.parse(entry.body).method)).toEqual(['tools/call']);
    } finally { sqlite.prepare('UPDATE app_state SET value = ? WHERE key = ?').run(row.value, row.key); }
  });

  it.each(['o8_status', 'get_mission_status', 'o8_task_list', 'o8_list_repos', 'o8_list_projects', 'o8_lease_list'])(
    'serves %s without forwarding a tools/call to TypeScript', async (name) => {
      seen.length = 0;
      const result = await call(rust, name);
      expect(result.status).toBe(200);
      expect((result.body as { result: { isError: boolean } }).result.isError).toBe(false);
      const forwarded = seen.filter((entry) => entry.path === '/api/mcp').map((entry) => JSON.parse(entry.body).method);
      expect(forwarded).toEqual(['o8d/read-context']);
    },
  );

  it('preserves sequential fresh-then-cached status semantics within a batch', async () => {
    await call(rust, 'o8_status', { fresh: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = await sendRecordedMcp(rust, token, { name: 'sequential snapshots', body: [
      { jsonrpc: '2.0', id: 'fresh', method: 'tools/call', params: { name: 'o8_status', arguments: { fresh: true } } },
      { jsonrpc: '2.0', id: 'cached', method: 'tools/call', params: { name: 'o8_status', arguments: {} } },
    ] });
    const snapshots = (result.body as Array<{ result: { content: Array<{ text: string }> } }>).map((entry) =>
      JSON.parse(entry.result.content[0].text).data.snapshot.capturedAt);
    expect(snapshots[1]).toBe(snapshots[0]);
  });

  it.each([undefined, null])('does not refresh status for a notification id %s', async (id) => {
    seen.length = 0;
    const result = await sendRecordedMcp(rust, token, { name: 'status notification', body: {
      jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'o8_status', arguments: { fresh: true } },
    } });
    expect(result.status).toBe(202);
    expect(seen.map((entry) => entry.path)).toEqual(['/api/mcp']);
  });

  it('observes persisted updates after startup and returns compact/detailed tasks', async () => {
    const compact = toolPayload(await call(rust, 'o8_task_list', { includeDone: true }));
    expect(compact.tasks.length).toBeGreaterThanOrEqual(4);
    expect(compact.tasks.some((task: { group: string }) => task.group === 'done')).toBe(true);
    const lane = createLane({ repoPath: join(directory, 'repo'), runtime: 'codex', branch: 'fixture/after-start', label: 'After start' });
    const details = toolPayload(await call(rust, 'o8_task_list', { includeDone: true, includeDetails: true }));
    expect(details.tasks.find((task: { id: string }) => task.id === lane.id)).toMatchObject({ title: 'After start', summary: '', lane: { id: lane.id } });
    const persisted = getSqlite().prepare('SELECT id FROM lanes WHERE id = ?').get(lane.id);
    expect(persisted).toBeTruthy();
    compareMcpExchanges(await call(base, 'o8_task_list', { includeDone: true, includeDetails: true }),
      await call(rust, 'o8_task_list', { includeDone: true, includeDetails: true }));
  });

  it('forwards a mutation body and mixed batch exactly once with the original headers', async () => {
    const bodies = [
      ' { "jsonrpc": "2.0", "id": "mutation", "method": "tools/call", "params": { "name": "o8_create_project", "arguments": { "name": "Proxy fixture" } } } ',
      JSON.stringify([{ jsonrpc: '2.0', id: 0, method: 'tools/list' }, { jsonrpc: '2.0', id: 'mutate', method: 'tools/call', params: { name: 'o8_create_project', arguments: { name: 'Batch fixture' } } }]),
    ];
    for (const body of bodies) {
      seen.length = 0;
      const result = await sendRecordedMcp(rust, token, { name: 'mutation', body, headers: { 'x-fixture-correlation': 'original' } });
      expect(result.status).toBe(200);
      const forwarded = seen.filter((entry) => entry.path === '/api/mcp');
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0].body).toBe(body);
      expect(forwarded[0].headers['x-fixture-correlation']).toBe('original');
    }
    expect(getSqlite().prepare("SELECT name FROM projects WHERE name IN ('Proxy fixture', 'Batch fixture')").all()).toHaveLength(2);
  });

  it.each(['absent', 'invalid', 'read-only'] as const)('refuses %s callers before any read or mutation', async (credential) => {
    for (const body of [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'o8_create_project', arguments: { name: 'Refused' } } }]) {
      const recording = { name: credential, credential, body };
      const expected = await sendRecordedMcp(base, token, recording);
      seen.length = 0;
      const actual = await sendRecordedMcp(rust, token, recording);
      expect(actual.status).toBe(credential === 'read-only' ? 403 : 401);
      compareMcpExchanges(expected, actual);
      expect(seen.every((entry) => entry.path === '/api/mcp')).toBe(true);
    }
    expect(getSqlite().prepare("SELECT id FROM projects WHERE name = 'Refused'").all()).toHaveLength(0);
  });

  it.each(['worker', 'device', 'spectator', 'plugin'] as const)('refuses an active %s capability before source reads', async (kind) => {
    const credential = kind === 'plugin' ? mintPluginToken({ machineId: 'fixture', clientId: 'fixture', scopes: ['o8:read'] }) : refusedCredentials[kind];
    for (const body of [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'o8_status' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'o8_create_project', arguments: { name: 'Refused capability' } } },
    ]) {
      const recording = { name: kind, body };
      const expected = await sendRecordedMcp(base, credential, recording);
      seen.length = 0;
      const actual = await sendRecordedMcp(nativeRust, credential, recording);
      expect(actual.status).toBe(403);
      compareMcpExchanges(expected, actual);
      expect(seen.map((entry) => entry.path)).toEqual(['/api/mcp']);
    }
    expect(getSqlite().prepare("SELECT id FROM projects WHERE name = 'Refused capability'").all()).toHaveLength(0);
  });

  it('cannot widen a server profile and defaults to TypeScript when the source opt-in is off', async () => {
    process.env.O8_OPERATOR_MCP_PROFILE = 'dogfood';
    try {
      const recording = { name: 'narrow', headers: { 'x-o8-mcp-profile': 'full' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'o8_status' } } };
      const expected = await sendRecordedMcp(base, token, recording);
      seen.length = 0;
      compareMcpExchanges(expected, await sendRecordedMcp(nativeRust, token, recording));
      expect(seen).toHaveLength(['linux', 'darwin'].includes(process.platform) ? 0 : 1);
      expect((await call(nativeRust, 'o8_status')).body).toMatchObject({ result: { isError: true } });
    } finally { delete process.env.O8_OPERATOR_MCP_PROFILE; }
    delete process.env.O8D_MCP_READS;
    try { compareMcpExchanges(await call(base, 'o8_list_repos'), await call(nativeRust, 'o8_list_repos')); }
    finally { process.env.O8D_MCP_READS = '1'; }
  });

  it('rechecks a rotated operator credential before native reads and the catalog', async () => {
    const recording = { name: 'rotation', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } };
    const nativeRead = { name: 'rotation read', body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'o8_list_repos' } } };
    const replacement = 'fixture-replacement-operator-credential';
    writeFileSync(join(directory, 'ws-token'), replacement);
    try {
      expect((await sendRecordedMcp(nativeRust, token, recording)).status).toBe(401);
      expect((await sendRecordedMcp(nativeRust, token, nativeRead)).status).toBe(401);
      compareMcpExchanges(await sendRecordedMcp(base, replacement, recording), await sendRecordedMcp(nativeRust, replacement, recording));
      const expected = await sendRecordedMcp(base, replacement, nativeRead);
      seen.length = 0;
      compareMcpExchanges(expected, await sendRecordedMcp(nativeRust, replacement, nativeRead));
      expect(seen.filter((entry) => entry.path === '/api/mcp').map((entry) => JSON.parse(entry.body).method)).toEqual(['tools/call']);
    } finally { writeFileSync(join(directory, 'ws-token'), token); }
  });

  it('falls back only for the failing read source', async () => {
    const expected = await call(base, 'o8_task_list');
    seen.length = 0;
    failedSource = '/api/tasks';
    try {
      compareMcpExchanges(expected, await call(rust, 'o8_task_list'));
      expect(seen.filter((entry) => entry.path === '/api/mcp').map((entry) => JSON.parse(entry.body).method)).toEqual(['o8d/read-context', 'tools/call']);
    } finally { failedSource = ''; }
  });

  it('does not follow upstream redirects or expose malformed upstream bodies', async () => {
    let destinationHits = 0;
    const destination = createServer((_request, response) => { destinationHits += 1; response.writeHead(200).end(); });
    const destinationUrl = await listen(destination);
    let redirect = true;
    const upstream = createServer((_request, response) => {
      if (redirect) response.writeHead(307, { location: destinationUrl }).end();
      else response.writeHead(200, { 'content-type': 'application/json' }).end('fixture malformed');
    });
    const upstreamUrl = await listen(upstream);
    const candidate = await startRust(upstreamUrl);
    try {
      const request = { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), redirect: 'manual' as const };
      const response = await fetch(`${candidate}/api/mcp`, request);
      expect(response.status).toBe(307);
      await response.text();
      expect(destinationHits).toBe(0);
      redirect = false;
      const invalid = await fetch(`${candidate}/api/mcp`, request);
      expect(invalid.status).toBe(503);
      expect(await invalid.json()).toEqual({ error: 'o8d MCP upstream unavailable' });
      await stop(upstream);
      const missing = await fetch(`${candidate}/api/mcp`, request);
      expect(missing.status).toBe(503);
      expect(await missing.json()).toEqual({ error: 'o8d MCP upstream unavailable' });
    } finally {
      if (upstream.listening) await stop(upstream);
      await stop(destination);
    }
  });

  it('requires runtime opt-in and rejects non-loopback upstreams', async () => {
    const binary = process.env.O8D_MCP_TEST_BINARY ?? 'crates/o8d/target/debug/o8d';
    for (const args of [[], ['--experimental-mcp', '--listen', '0.0.0.0:0', '--upstream', base], ['--experimental-mcp', '--listen', '127.0.0.1:0', '--upstream', 'http://remote.invalid:1234']]) {
      await expect(promisify(execFile)(binary, args)).rejects.toThrow('o8d failed');
    }
  });

  it('runs the URL-based parity CLI against both real listeners', async () => {
    const result = await promisify(execFile)(process.execPath, ['--import=tsx', 'scripts/mcp-parity.ts', `--reference=${base}`, `--candidate=${rust}`, '--recording=tests/fixtures/mcp-parity/portable.json'], {
      env: { ...process.env, O8_MCP_PARITY_TOKEN: token },
    });
    expect(result.stdout).toContain('MCP parity passed');
  });
  it.runIf(Boolean(process.env.O8_MCP_BENCH_REPORT))('measures both servers with the existing speed MCP client', async () => {
    seen.length = 0;
    await promisify(execFile)(process.execPath, ['scripts/mcp-benchmark.mjs', `--reference=${base}`,
      `--candidate=${nativeRust}`, `--output=${process.env.O8_MCP_BENCH_REPORT}`], {
      env: { ...process.env, O8_MCP_PARITY_TOKEN: token },
    });
    const report = JSON.parse(readFileSync(process.env.O8_MCP_BENCH_REPORT!, 'utf8'));
    expect(report.results).toHaveLength(14);
    expect(report.samples).toBe(100);
    expect(report.acceptance).toMatchObject({ statusP50Under10Ms: expect.any(Boolean),
      everyNativeToolAtLeast5xLower: expect.any(Boolean) });
    expect(report.comparisons).toHaveLength(6);
    for (const comparison of report.comparisons) {
      expect(comparison).toMatchObject({ name: expect.any(String), p50Speedup: expect.any(Number),
        p95Speedup: expect.any(Number), p50AtLeast5xLower: expect.any(Boolean), p95AtLeast5xLower: expect.any(Boolean) });
      const calls = seen.filter((entry) => entry.path === '/api/mcp'
        && JSON.parse(entry.body).method === 'tools/call' && JSON.parse(entry.body).params?.name === comparison.name).length;
      comparison.candidateForwardedCalls = calls - (report.samples + report.warmups);
      expect(comparison.candidateForwardedCalls).toBeGreaterThanOrEqual(0);
    }
    expect(report.baseline).toMatchObject({ source: '#4374', comparable: false,
      results: expect.arrayContaining([expect.objectContaining({ name: 'o8_status', median: 35.5, p95: 1667.03 })]) });
    writeFileSync(process.env.O8_MCP_BENCH_REPORT!, `${JSON.stringify(report, null, 2)}\n`);
  }, 180_000);

  it.runIf(Boolean(process.env.O8_MCP_SCALE_BENCH_REPORT_DIR))('measures realistic state with idle and CPU-loaded TypeScript', async () => {
    const fixture = await seedMcpScaleFixture({ directory, sqlite: getSqlite(),
      initializeRepo: async (path) => { await promisify(execFile)('git', ['init', '--quiet', path]); },
      acquireLease: async (index) => {
        const response = await fetch(`${base}/api/leases`, { method: 'POST', headers: {
          authorization: `Bearer ${token}`, 'content-type': 'application/json',
        }, body: JSON.stringify({ action: 'acquire', resource: `fixture:scale-lease-${index}`,
          owner: { id: `fixture-owner-${index}`, label: `Fixture owner ${index}`, pid: process.pid },
          claimToken: `scale-fixture-claim-value-${String(index).padStart(12, '0')}`, ttlMs: 86_400_000 }) });
        expect(response.status).toBe(200);
      },
    });
    const registered = toolPayload(await call(base, 'o8_list_repos'));
    expect(registered.count).toBe(50);
    expect(getSqlite().prepare('SELECT COUNT(*) AS count FROM missions').get()).toEqual({ count: 300 });
    expect(fixture).toMatchObject({ missions: 300, packets: 2_000, lanes: 2_000, repos: 50, leases: 200, projects: 10 });
    expect(toolPayload(await call(base, 'o8_lease_list')).count).toBe(200);
    for (const name of ['o8_status', 'get_mission_status', 'o8_task_list', 'o8_list_repos', 'o8_list_projects', 'o8_lease_list']) {
      if (name === 'o8_status') await call(base, name, { fresh: true });
      compareMcpExchanges(await call(base, name), await call(nativeRust, name), name === 'o8_status'
        ? ['/body/result/content/0/text/json/data/snapshot/ageMs'] : []);
    }
    const outputDirectory = process.env.O8_MCP_SCALE_BENCH_REPORT_DIR!;
    mkdirSync(outputDirectory, { recursive: true });
    for (const busy of [false, true]) {
      await call(base, 'o8_status', { fresh: true });
      await call(nativeRust, 'o8_status');
      seen.length = 0;
      const stopLoad = startMcpCpuLoad(busy);
      const output = join(outputDirectory, busy ? 'large-cpu-busy.json' : 'large-idle.json');
      let cpuLoad;
      try {
        await promisify(execFile)(process.execPath, ['scripts/mcp-benchmark.mjs', `--reference=${base}`,
          `--candidate=${nativeRust}`, `--output=${output}`], { env: { ...process.env, O8_MCP_PARITY_TOKEN: token } });
      } finally { cpuLoad = stopLoad(); }
      const report = JSON.parse(readFileSync(output, 'utf8'));
      expect(report.results).toHaveLength(14);
      expect(report.samples).toBe(100);
      expect(cpuLoad.cycles > 0).toBe(busy);
      const referenceRequests = report.samples + report.warmups;
      const fallbackRequestsIncludingWarmups = Object.fromEntries(report.results.filter((row: { server: string; name: string }) =>
        row.server === 'Rust' && row.name !== 'tools/list').map((row: { name: string }) => {
        const calls = seen.filter((entry) => {
          if (entry.path !== '/api/mcp') return false;
          const request = JSON.parse(entry.body);
          return request.method === 'tools/call' && request.params?.name === row.name;
        }).length;
        expect(calls).toBeGreaterThanOrEqual(referenceRequests);
        expect(calls).toBeLessThanOrEqual(referenceRequests * 2);
        return [row.name, calls - referenceRequests];
      }));
      writeFileSync(output, `${JSON.stringify({ schema: 'o8/mcp/scale-benchmark/v1',
        scenario: busy ? 'large-cpu-busy' : 'large-idle', fixture, cpuLoad,
        node: process.versions.node, transport: 'fixture HTTP adapter using production middleware, MCP handlers and read routes',
        clientAndRustInSeparateProcesses: true, fallbackRequestsIncludingWarmups, ...report }, null, 2)}\n`);
    }
  }, 1_200_000);

  it('refuses scale seeding outside the owned fixture database', async () => {
    const ownedDirectory = join(directory, 'scale-seeder-owned');
    mkdirSync(ownedDirectory, { recursive: true });
    const sqlite = getSqlite();
    const before = sqlite.prepare('SELECT COUNT(*) AS count FROM lanes').get();
    await expect(seedMcpScaleFixture({ directory: ownedDirectory, sqlite,
      initializeRepo: async () => { throw new Error('Unreachable repo mutation'); },
      acquireLease: async () => { throw new Error('Unreachable lease mutation'); },
    })).rejects.toThrow('Refusing scale seeding outside the owned fixture database');
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM lanes').get()).toEqual(before);
  });

});
