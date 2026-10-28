import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { MODEL_IDS } from '@/lib/models';
import type { RuntimeLaunchRequest } from '@/lib/runtime/actions';
import type { McpToolResult } from '@/lib/mcp/operator-handlers/shared';

vi.mock('@/lib/codex/service-tier-catalogue', async () => ({ getCodexSpeedCatalogue: async () =>
  (await import('./helpers/codex-model-list-fixture')).codexEffortCatalogFixture }));
vi.mock('@/lib/skeleton/autoscan', () => ({ triggerScan: vi.fn(), triggerScanIfStale: vi.fn(), startChangePolling: vi.fn(), stopChangePolling: vi.fn() }));
vi.mock('@/lib/runtimes/shared/auth-detect', async (original) => ({
  ...await original<typeof import('@/lib/runtimes/shared/auth-detect')>(),
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: vi.fn(async () => ({ ready: true })) }));
vi.mock('@/lib/worktree/storage-telemetry', async (original) => ({
  ...await original<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({ accountingStatus: 'observed', probePath: '/', availableBytes: 90_000_000_000, freeBytes: 90_000_000_000, totalBytes: 100_000_000_000, error: null })),
}));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn() }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn() }));
vi.mock('@/lib/orchestrator/capacity-snapshots', () => ({ capturePacketCapacitySnapshot: vi.fn(async () => undefined) }));
// Capture only the provider start boundary. Real dispatch, provisioning, prompt
// construction and lane persistence still execute; no provider is contacted.
const launches = vi.hoisted(() => vi.fn(async (input: RuntimeLaunchRequest) => ({
  ok: true, surfaceId: `fixture:${input.packetId}`, note: 'Captured provider start without inference.',
})));
vi.mock('@/lib/runtime/actions', async (original) => ({
  ...await original<typeof import('@/lib/runtime/actions')>(), launchRuntimeSurface: launches,
}));

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-sealed-contract-')));
const dataDir = join(root, 'data');
const repoPath = join(root, 'repo');
const origin = join(root, 'origin.git');
mkdirSync(dataDir); mkdirSync(repoPath);
const git = (...args: string[]) => execFileSync('git', ['-C', repoPath, ...args], { stdio: 'pipe' });
execFileSync('git', ['init', '-q', '--bare', origin]);
git('init', '-q', '-b', 'main');
writeFileSync(join(repoPath, 'README.md'), 'fixture\n');
git('add', 'README.md');
git('-c', 'user.name=o8 test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
git('remote', 'add', 'origin', origin); git('push', '-u', 'origin', 'main');
execFileSync('git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
for (const [key, value] of Object.entries({ O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir,
  CORTEX_IDE_DB_PATH: join(dataDir, 'cortex-ide.db'), O8_OPERATOR_MCP_PROFILE: 'full',
  O8_SKIP_PRELAUNCH_TYPECHECK: '1', O8_APFS_DEPENDENCY_IMAGES: '0' })) vi.stubEnv(key, value);
const token = 'sealed-contract-operator-fixture';
writeFileSync(join(dataDir, 'ws-token'), token);
const setupRoute = await import('@/app/api/setup/agent/route');
const missionRoute = await import('@/app/api/orchestrator/create-mission/route');
const mcpRoute = await import('@/app/api/mcp/route');
const { panelGateMiddleware } = await import('@/middleware');
const { closeDb, getSqlite } = await import('@/lib/db');
const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
let port = 0;
let lastBody: Record<string, unknown>;
let validBody: Record<string, unknown>;
const server = createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += chunk.toString();
    const request = new NextRequest(`http://127.0.0.1:${port}${req.url}`, {
      method: req.method, headers: req.headers as Record<string, string>, ...(body ? { body } : {}),
    });
    const gate = panelGateMiddleware(request);
    if (req.url === '/api/orchestrator/create-mission') lastBody = JSON.parse(body);
    const response = gate.status !== 200 ? gate
      : req.url === '/api/mcp' ? await mcpRoute.POST(request)
      : req.url === '/api/setup/agent' ? await setupRoute.POST(request)
      : req.url === '/api/orchestrator/create-mission' ? await missionRoute.POST(request)
      : new Response('Unknown fixture route', { status: 404 });
    res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text());
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
});
const contract = {
  version: 1 as const,
  requirements: [{ id: 'R1', source: 'Explicit task.', expectedBehavior: 'One packet receives the sealed contract.', productionPath: 'create_mission -> createMission -> worker', verification: 'Registered HTTP fixture.' }],
  smallestRoute: [{ path: 'src/task.ts', requirements: ['R1'], reason: 'Smallest complete implementation.' }],
  processConstraints: [{ id: 'P1', source: 'Stay within the task.', expectedBehavior: 'No unrelated changes.', verification: 'Review the diff.' }],
  exclusions: ['No candidate comparison.'],
};
async function rpc(method: string, params?: Record<string, unknown>, authenticated = true) {
  const response = await fetch(`http://127.0.0.1:${port}/api/mcp`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: response.status, body: await response.json() };
}
async function call(name: string, args: Record<string, unknown>) {
  return (await rpc('tools/call', { name, arguments: args })).body.result as McpToolResult;
}
function payload(result: McpToolResult) {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const content = result.content[0]; if (content.type !== 'text') throw new Error('Expected text receipt.');
  return JSON.parse(content.text);
}
const create = (extra: Record<string, unknown> = {}) => call('create_mission', {
  repoPath, runtime: 'codex', requestedModel: MODEL_IDS.raw.openAiGpt61Sol, requestedEffort: 'medium', dispatch: false,
  issues_inline: [{ title: 'Implement one sealed task', body: 'Owned fixture.' }], sealedTaskContract: contract, ...extra,
});
const count = () => (getSqlite().prepare('SELECT COUNT(*) AS count FROM missions').get() as { count: number }).count;
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  writeFileSync(join(dataDir, 'api-port'), String(port));
  payload(await call('o8_setup', { action: 'open', path: repoPath }));
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

it('registers a plain contract-only schema and keeps HTTP authentication', async () => {
  const list = (await rpc('tools/list')).body.result.tools;
  expect(list.find((tool: { name: string }) => tool.name === 'create_mission').inputSchema.properties.sealedTaskContract)
    .toMatchObject({ type: 'object', required: ['version', 'requirements', 'smallestRoute', 'exclusions'] });
  expect((await rpc('tools/call', { name: 'create_mission', arguments: {} }, false)).status).toBe(401);
});

it('persists the exact contract without comparison and launches exactly one real dispatch entry', async () => {
  const created = payload(await create());
  expect(created.packets).toHaveLength(1);
  validBody = structuredClone(lastBody);
  closeDb();
  const saved = readMissionRegistryEntry(created.missionId)!.mission;
  const packet = saved.packets[0];
  expect(packet).toMatchObject({ taskContract: contract, taskContractSource: 'explicit', taskContractRequired: true });
  expect(packet.qualitySearch).toBeUndefined(); expect(packet.comparisonModels).toBeUndefined();
  expect(packet.comparisonGroupId).toBeNull(); expect(saved.activeComparisonGroups).toEqual([]);
  const row = getSqlite().prepare('SELECT mission_state_json FROM missions WHERE id = ?').get(created.missionId) as { mission_state_json: string };
  expect(JSON.parse(row.mission_state_json).packets[0].taskContract).toEqual(contract);
  const { dispatchMission } = await import('@/lib/orchestrator/operator-mission-service');
  await dispatchMission({ missionId: created.missionId });
  expect(launches).toHaveBeenCalledTimes(1);
  const sent = launches.mock.calls[0][0];
  expect(sent.packetId).toBe(packet.id); expect(sent.effort).toBe('medium');
  expect(sent.prompt).toContain('Sealed pre-edit task contract:');
  expect(sent.prompt).toContain(JSON.stringify(contract));
  expect(sent.prompt).not.toContain('Quality-search candidate role:');
  expect(readMissionRegistryEntry(created.missionId)!.mission.packets).toHaveLength(1);
}, 40_000);

it('rejects malformed and conflicting MCP and direct HTTP contracts before mutation', async () => {
  const before = count();
  const beforeLaunches = launches.mock.calls.length;
  const branches = () => execFileSync('git', ['-C', repoPath, 'for-each-ref', '--format=%(refname)', 'refs/heads'], { encoding: 'utf8' });
  const beforeBranches = branches();
  const invalid = [
    { sealedTaskContract: null }, { sealedTaskContract: { ...contract, version: 2 } },
    { sealedTaskContract: { ...contract, requirements: [...contract.requirements, { id: 'BAD' }] } },
    { sealedTaskContract: { ...contract, smallestRoute: [{ ...contract.smallestRoute[0], requirements: ['R1', 'UNKNOWN'] }] } },
    { sealedTaskContract: { ...contract, exclusions: [''] } },
    { sealedTaskContract: { ...contract, unexpected: true } },
    { taskContract: 'off' }, { qualitySearch: { taskContract: contract } }, { comparisonModels: [] }, { huddle: true },
    { sealedTaskContract: { ...contract, requirements: Array(25).fill(contract.requirements[0]) } },
    { sealedTaskContract: { ...contract, requirements: [contract.requirements[0], contract.requirements[0]] } },
    { sealedTaskContract: { ...contract, requirements: [{ ...contract.requirements[0], source: 'x'.repeat(481) }] } },
    { sealedTaskContract: { ...contract, processConstraints: [{ ...contract.processConstraints[0], id: 'R1' }] } },
    { issues_inline: [{ title: 'One' }, { title: 'Two' }] },
    { issues_inline: undefined, issues: ['#1'] },
  ];
  for (const extra of invalid) {
    expect((await create(extra)).isError, JSON.stringify(extra)).toBe(true);
    expect(count()).toBe(before);
  }
  for (const extra of [...invalid.filter(extra => !('issues_inline' in extra) && !('issues' in extra)), { issues: [validBody.issues instanceof Array ? validBody.issues[0] : {}, { number: 90002, title: 'Other', body: '', url: '' }] }, { issues: [{ number: 1, title: 'GitHub task', body: '', url: 'https://github.com/example/repo/issues/1' }] }]) {
    const response = await fetch(`http://127.0.0.1:${port}/api/orchestrator/create-mission`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validBody, clientMutationId: crypto.randomUUID(), sealedTaskContract: contract, ...extra }),
    });
    expect(response.status, JSON.stringify(extra)).toBe(400); expect(count()).toBe(before);
  }
  expect(branches()).toBe(beforeBranches); expect(launches).toHaveBeenCalledTimes(beforeLaunches);
});

it('preserves quality-search two-candidate dispatch and the off opt-out', async () => {
  const off = payload(await create({ sealedTaskContract: undefined, taskContract: 'off' }));
  expect(readMissionRegistryEntry(off.missionId)!.mission.packets[0]).toMatchObject({ taskContractRequired: false });
  const quality = payload(await create({ sealedTaskContract: undefined, qualitySearch: { taskContract: contract } }));
  const before = launches.mock.calls.length;
  const { dispatchMission } = await import('@/lib/orchestrator/operator-mission-service');
  await dispatchMission({ missionId: quality.missionId });
  const { currentMissionState } = await import('@/lib/orchestrator/operator-mission-service/shared');
  const saved = currentMissionState();
  expect(saved.packets).toHaveLength(2);
  expect(launches.mock.calls.length - before).toBe(2);
  expect(saved.packets.map(packet => packet.qualitySearch?.role).sort()).toEqual(['minimal_complete', 'robustness_complete']);
  expect(saved.packets.every(packet => packet.taskContractRequired && packet.taskContractSource === 'explicit')).toBe(true);
}, 40_000);
