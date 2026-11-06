import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { MODEL_IDS } from '@/lib/models';
import type { McpToolResult } from '@/lib/mcp/operator-handlers/shared';

// Only external/background work is stubbed. Registration, projection, capture,
// HTTP authentication, mission preparation and both persistence stores are real.
vi.mock('@/lib/skeleton/autoscan', () => ({ triggerScan: vi.fn(), triggerScanIfStale: vi.fn(), startChangePolling: vi.fn(), stopChangePolling: vi.fn() }));
vi.mock('@/lib/runtimes/shared/auth-detect', async (original) => ({
  ...await original<typeof import('@/lib/runtimes/shared/auth-detect')>(),
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn() }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn() }));
const forbiddenDispatch = vi.hoisted(() => vi.fn(() => { throw new Error('This fixture must never dispatch.'); }));
vi.mock('@/lib/orchestrator/dispatch', async (original) => ({
  ...await original<typeof import('@/lib/orchestrator/dispatch')>(), runDispatchTick: forbiddenDispatch,
}));

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-empty-project-projection-')));
const dataDir = join(root, 'data');
const repoPath = join(root, 'fixture-repo');
mkdirSync(dataDir); mkdirSync(repoPath);
execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
writeFileSync(join(repoPath, 'README.md'), 'fixture\n');
execFileSync('git', ['-C', repoPath, 'add', 'README.md']);
execFileSync('git', ['-C', repoPath, '-c', 'user.name=o8 test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
vi.stubEnv('O8_DATA_DIR', dataDir);
vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);
vi.stubEnv('CORTEX_IDE_DB_PATH', join(dataDir, 'cortex-ide.db'));
vi.stubEnv('O8_OPERATOR_MCP_PROFILE', 'full');
writeFileSync(join(dataDir, 'ws-token'), 'empty-project-operator-fixture');
const setupRoute = await import('@/app/api/setup/agent/route');
const projectRoute = await import('@/app/api/panel/projects/route');
const missionRoute = await import('@/app/api/orchestrator/create-mission/route');
const { panelGateMiddleware } = await import('@/middleware');
const { handleOperatorMcpMessage } = await import('@/lib/mcp/operator-mcp-host');
const { setApiBase } = await import('@/lib/mcp/operator-handlers/shared');
const { closeDb, getSqlite } = await import('@/lib/db');
const { initializeProjectsLedger } = await import('@/lib/repos/projects');
const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
let port = 0;
let repoId: string;
const server = createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += chunk.toString();
    const request = new NextRequest(`http://127.0.0.1:${port}${req.url}`, {
      method: req.method, headers: req.headers as Record<string, string>, ...(body ? { body } : {}),
    });
    const gate = panelGateMiddleware(request);
    const response = gate.status !== 200 ? gate
      : req.url === '/api/setup/agent' && req.method === 'POST' ? await setupRoute.POST(request)
      : req.url === '/api/panel/projects' && req.method === 'GET' ? await projectRoute.GET()
      : req.url === '/api/orchestrator/create-mission' && req.method === 'POST' ? await missionRoute.POST(request)
      : new Response('Unknown fixture route', { status: 404 });
    res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text());
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
  const response = await handleOperatorMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return response!.result as McpToolResult;
}
function payload(result: McpToolResult) {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const content = result.content[0];
  if (content.type !== 'text') throw new Error('Expected text receipt.');
  return JSON.parse(content.text);
}
function count(table: 'projects' | 'project_repos' | 'missions' | 'lanes' | 'worker_runs' | 'review_queue') {
  return (getSqlite().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}
const create = (extra: Record<string, unknown> = {}) => call('create_mission', {
  repoPath, runtime: 'codex', requestedModel: MODEL_IDS.raw.openAiGpt61Sol, requestedEffort: 'medium', dispatch: false,
  issues_inline: [{ title: 'Prepare the first packet', body: 'No dispatch or inference.' }], ...extra,
});

beforeAll(async () => {
  // Match ws-server startup; project reads no longer bootstrap the ledger.
  await initializeProjectsLedger();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  setApiBase(`http://127.0.0.1:${port}`);
  writeFileSync(join(dataDir, 'api-port'), String(port));
  // Onboarding reads the default ledger before registration on first run.
  const empty = payload(await call('o8_list_projects'));
  expect(empty.projects).toMatchObject([{ id: 'default', repoPaths: [] }]);
  const opened = payload(await call('o8_setup', { action: 'open', path: repoPath }));
  expect(opened.request.status).toBe('pending'); // No simulated app completion.
  repoId = opened.request.project.id;
  expect(opened.request.project.localPath).toBe(repoPath);
  expect(JSON.parse(readFileSync(join(dataDir, 'repos.json'), 'utf8')).repos).toMatchObject([{ id: repoId, localPath: repoPath }]);
  expect(count('projects')).toBe(0); expect(count('project_repos')).toBe(0);
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

it('discovers the exact virtual repository identity with zero Settings projects', async () => {
  const discovered = payload(await call('o8_list_projects'));
  expect(discovered.projects).toEqual([
    expect.objectContaining({ id: `repo:${repoId}`, repoPaths: [repoPath], repoCount: 1, active: true }),
  ]);
  expect(discovered.activeProjectId).toBe(`repo:${repoId}`);
  expect(count('projects')).toBe(0); expect(count('project_repos')).toBe(0);
});

it('prepares and reloads missions with omitted and exact virtual project identities without dispatch', async () => {
  for (const extra of [{}, { projectId: `repo:${repoId}` }]) {
    const created = payload(await create(extra));
    expect(created.missionId).toBeTruthy(); expect(created.packets).toHaveLength(1);
    closeDb();
    const saved = readMissionRegistryEntry(created.missionId)!.mission;
    expect(saved.packets[0]).toMatchObject({ projectId: `repo:${repoId}`, workspaceTargetPath: repoPath, queueState: 'held' });
    const row = getSqlite().prepare('SELECT mission_state_json FROM missions WHERE id = ?').get(created.missionId) as { mission_state_json: string };
    expect(JSON.parse(row.mission_state_json).packets[0].projectId).toBe(`repo:${repoId}`);
  }
  expect(count('projects')).toBe(0); expect(count('project_repos')).toBe(0);
  expect(count('missions')).toBe(2);
  for (const table of ['lanes', 'worker_runs', 'review_queue'] as const) expect(count(table)).toBe(0);
  expect(forbiddenDispatch).not.toHaveBeenCalled();
  const ledger = JSON.parse(readFileSync(join(dataDir, 'projects.json'), 'utf8'));
  expect(ledger.projects).toMatchObject([{ id: 'default', repoPaths: [] }]);
  expect(ledger.projects.some((project: { id: string }) => project.id.startsWith('repo:'))).toBe(false);
});

it('refuses default, unrelated and deleted identities without preparing another mission', async () => {
  const { addRepo } = await import('@/lib/repos/registry');
  const { removeRepoFromPool } = await import('@/lib/repos/remove');
  const otherPath = join(root, 'unrelated-repo'); mkdirSync(otherPath);
  execFileSync('git', ['init', '-q', '-b', 'main', otherPath]);
  const other = await addRepo(otherPath);
  const before = count('missions');
  for (const projectId of ['default', `repo:${other.id}`, 'repo:missing', 'missing-project']) {
    expect((await create({ projectId })).isError).toBe(true);
    expect(count('missions')).toBe(before);
  }
  await removeRepoFromPool(other.id);
  expect((await create({ repoPath: otherPath, projectId: `repo:${other.id}` })).isError).toBe(true);
  expect(count('missions')).toBe(before);
  expect(count('projects')).toBe(0); expect(count('project_repos')).toBe(0);
  expect(forbiddenDispatch).not.toHaveBeenCalled();
});

// Normal Settings operations create the conflicting memberships only in this
// temporary fixture; the first-run positive cases above never create any.
it('retains ambiguous membership and colliding default-name refusals', async () => {
  const { createProject, addRepoToProject } = await import('@/lib/projects/store');
  const { setActiveProject } = await import('@/lib/repos/projects');
  const first = createProject({ name: 'First project' });
  const second = createProject({ name: 'Second project' });
  const shadow = createProject({ name: 'Default' });
  addRepoToProject(first.id, repoId, null, 'manual');
  addRepoToProject(second.id, repoId, null, 'manual');
  addRepoToProject(shadow.id, repoId, null, 'manual');
  await setActiveProject(shadow.id);
  const { createProject: createPanelProject } = await import('@/lib/repos/projects');
  const unrelated = await createPanelProject('Unrelated active project');
  await setActiveProject(unrelated.activeProjectId);
  const before = count('missions');
  expect((await create()).isError).toBe(true);
  expect((await create({ projectId: 'default' })).isError).toBe(true);
  expect(count('missions')).toBe(before);
  for (const table of ['lanes', 'worker_runs', 'review_queue'] as const) expect(count(table)).toBe(0);
  expect(forbiddenDispatch).not.toHaveBeenCalled();
});
