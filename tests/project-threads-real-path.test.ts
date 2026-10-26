import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { execFileSync, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { ProjectThreads, ProjectThread } from '@/lib/threads/types';

const fixture = vi.hoisted(() => ({ agents: [] as import('@/lib/fleet/types').AgentSummary[], moveHead: null as (() => void) | null }));
vi.mock('@/lib/providers/child-process', async original => {
  const actual = await original<typeof import('@/lib/providers/child-process')>();
  return { ...actual, execFileSync: (...args: unknown[]) => {
    const result = Reflect.apply(actual.execFileSync, actual, args);
    if (args[0] === 'git' && Array.isArray(args[1]) && args[1].includes('ls-tree') && fixture.moveHead) {
      const move = fixture.moveHead; fixture.moveHead = null; move();
    }
    return result;
  } };
});
vi.mock('@/lib/runtime/inventory', () => ({ getRuntimeInventorySnapshot: async () => ({ agents: fixture.agents }) }));
vi.mock('@/lib/realtime/publisher', async original => ({ ...await original<typeof import('@/lib/realtime/publisher')>(), publishRealtimeMutation: async () => {} }));
const root = mkdtempSync(join(tmpdir(), 'o8-project-threads-'));
process.env.O8_DATA_DIR = root; process.env.CORTEX_IDE_DATA_DIR = root;
process.env.CORTEX_IDE_DB_PATH = join(root, 'fixture.db');
const repoPath = join(root, 'repo');
let route: { GET(request: NextRequest): Promise<Response> };
let db: typeof import('@/lib/db');
let packetId: string;
let laneId: string;
let token: string;
let initialHead: string;
const request = (query = '', auth = true) => new NextRequest(`http://localhost/api/panel/threads?repoPath=${encodeURIComponent(repoPath)}${query}`, { headers: auth ? { authorization: `Bearer ${token}` } : { 'x-o8-client-addr': '198.51.100.2' } });
beforeAll(async () => {
  mkdirSync(repoPath); execFileSync('git', ['init', '-q', repoPath]);
  execFileSync('git', ['-C', repoPath, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  initialHead = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  db = await import('@/lib/db'); token = (await import('@/lib/ws-auth')).getOrCreateWsToken();
  const { addRepo } = await import('@/lib/repos/registry');
  await addRepo(repoPath);
  const { createLane, attachSession, setLaneStatus } = await import('@/lib/lane/registry');
  const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
  const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
  const state = createEmptyOrchestratorMissionState(); state.missionId = 'mission-thread-fixture'; state.repoPath = repoPath; state.summary = 'Two parser attempts';
  packetId = 'pkt-thread-fixture';
  state.packets = [{ id: packetId, title: 'Parser decision', summary: 'Inspect the parser output', workspaceTargetPath: repoPath,
    status: 'running', runtime: 'codex', dependencyPacketIds: [], dependencyLabels: [],
    taskContract: { version: 1, requirements: [{ id: 'R1', source: 'Parser', expectedBehavior: 'Reject invalid input', productionPath: 'parser.ts', verification: 'parser test' }], smallestRoute: [{ path: 'parser.ts', requirements: ['R1'], reason: 'Parser behavior' }], exclusions: [] },
  } as unknown as OrchestratorPacket];
  writeOrchestratorControlPlaneState(state);
  (await import('@/lib/db/missions-store')).recordMission({ id: state.missionId!, repoPath, runtime: 'codex', prompt: state.prompt, summary: state.summary, constraints: '', packetMeta: [], totalWaves: 1, missionState: state });
  const lane = createLane({ packetId, repoPath, runtime: 'codex', branch: 'main', baseBranch: initialHead, label: 'Parser worker' });
  laneId = lane.id; attachSession(lane.id, 'codex:parser'); setLaneStatus(lane.id, 'awaiting_human');
  fixture.agents = [{ name: 'Parser worker', sessionKey: 'codex:parser', workspace: repoPath, runtime: 'codex', model: 'fixture-model', status: 'blocked' },
    { name: 'Direct worker', sessionKey: 'claude:direct', workspace: repoPath, runtime: 'claude-code', model: 'fixture-model', status: 'working' },
    { name: 'Foreign worker', sessionKey: 'codex:foreign', workspace: join(root, 'foreign'), runtime: 'codex', status: 'working' }] as import('@/lib/fleet/types').AgentSummary[];
  db.getSqlite().prepare(`INSERT INTO usage_logs (id, model, provider, input_tokens, output_tokens, session_key, lane_id, packet_id, repo_path, billing_period) VALUES ('usage-thread', 'fixture-model', 'fixture', 120, 30, 'codex:parser', ?, ?, ?, 'fixture')`).run(laneId, packetId, repoPath);
  const { recordArtifact } = await import('@/lib/artifacts/store');
  recordArtifact({ source: 'manual', kind: 'report', packetId, laneId, repoPath, relPath: 'artifacts/report.json', label: 'Parser evidence', mimeType: 'application/json' });
  db.getSqlite().prepare(`INSERT INTO session_outcomes (id, project_id, repo_path, runtime, session_key, lane_id, packet_id, outcome, summary, changed_files_json, started_at, completed_at)
    VALUES ('thread-completion', 'default', ?, 'codex', 'codex:parser', ?, ?, 'partial', 'Parser completion', ?, datetime('now'), datetime('now'))`).run(repoPath, laneId, packetId, JSON.stringify(['parser.ts', '../outside', '/secret']));
  writeFileSync(join(repoPath, 'parser.ts'), 'export const parser = true;');
  route = await import('@/app/api/panel/threads/route');
}, 120_000);
afterAll(() => { db?.closeDb(); rmSync(root, { recursive: true, force: true }); });

it('reads all canonical project work with four groups and exact task evidence after reopen', async () => {
  const routePath = '@/app/api/panel/threads/route'; route = await import(routePath);
  db.closeDb();
  const response = await route.GET(request()); expect(response.status).toBe(200);
  const body = await response.json() as ProjectThreads;
  expect(Object.keys(body.counts).sort()).toEqual(['resolved', 'review', 'waiting', 'working']);
  expect(body.tasks.find(row => row.id === packetId)).toMatchObject({ group: 'blocked', thread: { kind: 'packet', state: 'waiting' } });
  expect(body.tasks.filter(row => row.thread.kind === 'session').map(row => row.thread.sessionKey)).toContain('claude:direct');
  expect(JSON.stringify(body)).not.toContain('codex:foreign');
  expect(body.tasks.filter(row => row.thread.kind === 'mission')).toHaveLength(1);
  expect(body.tasks.filter(row => row.thread.sessionKey === 'codex:parser')).toHaveLength(1);
  const detail = await (await route.GET(request('&taskId=' + packetId))).json() as { task: ProjectThread };
  expect(detail.task.thread.requirements).toEqual([expect.objectContaining({ id: 'R1', text: 'Reject invalid input', covered: false })]);
  expect(detail.task.thread.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Parser evidence' }), expect.objectContaining({ kind: 'file', title: 'parser.ts' })]));
  expect(JSON.stringify(detail.task.thread.artifacts)).not.toContain('../outside');
  expect(JSON.stringify(detail.task.thread.artifacts)).not.toContain('/secret');
  expect(detail.task.thread.workers).toEqual([expect.objectContaining({ sessionKey: 'codex:parser', tokens: 150, runtime: 'codex', model: 'fixture-model' })]);
});

it('shares state filters with the registered MCP catalog and refuses foreign or unauthenticated detail reads', async () => {
  const routePath = '@/app/api/panel/threads/route'; route = await import(routePath);
  const body = await (await route.GET(request('&state=waiting'))).json() as ProjectThreads;
  expect(body.tasks.every(row => row.thread.state === 'waiting')).toBe(true);
  expect((await route.GET(request('&taskId=session:codex:foreign'))).status).toBe(404);
  expect((await route.GET(request('', false))).status).toBe(401);
  const { handleOperatorMcpMessage, operatorToolsForProfile } = await import('@/lib/mcp/operator-mcp-host');
  expect(operatorToolsForProfile('full').some(tool => tool.name === 'o8_threads_list')).toBe(true);
  const response = await handleOperatorMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'o8_threads_list', arguments: { repoPath, state: 'waiting' } } }, 'full');
  const result = response!.result as { content: Array<{ text: string }> };
  expect((JSON.parse(result.content[0].text) as ProjectThreads).tasks.map(row => row.id)).toEqual(body.tasks.map(row => row.id));
});

async function cliThreads(args: string[]) {
  const { build } = await import('esbuild');
  const entry = join(root, 'o8.mjs');
  if (!existsSync(join(root, 'node_modules'))) symlinkSync(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  if (!existsSync(entry)) await build({ entryPoints: [join(process.cwd(), 'cli/src/index.ts')], outfile: entry, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    banner: { js: 'import {createRequire as __fixtureCreateRequire} from "node:module";const require=__fixtureCreateRequire(import.meta.url);globalThis.require=require;' } });
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' || !req.url?.startsWith('/api/panel/threads?')) { res.writeHead(404); res.end(); return; }
    const response = await route.GET(new NextRequest(`http://localhost${req.url}`, { headers: { authorization: `Bearer ${token}` } }));
    res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(await response.text());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as import('node:net').AddressInfo;
    return await promisify(execFile)(process.execPath, [entry, ...args], { env: { ...process.env, O8_API_PORT: String(address.port), O8_API_TOKEN: token }, timeout: 20_000 });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

it('reads the same waiting threads through the built CLI without dispatch or inference', async () => {
  const output = await cliThreads(['threads', 'list', '--repo', repoPath, '--state', 'waiting']);
  const expected = await (await route.GET(request('&state=waiting'))).json() as ProjectThreads;
  expect((JSON.parse(output.stdout) as ProjectThreads).tasks.map(task => task.id)).toEqual(expected.tasks.map(task => task.id));
});

it('maps every persisted inbox status and paginates the full scoped inventory without losing identities', async () => {
  const routePath = '@/app/api/panel/threads/route'; route = await import(routePath);
  const { enqueueInboxItem } = await import('@/lib/supervisor/inbox');
  const expected = { pending: 'waiting', healing: 'working', escalated: 'waiting', human_required: 'waiting', self_healed: 'resolved', resolved: 'resolved', dismissed: 'resolved' } as const;
  const ids = Object.entries(expected).map(([status, state]) => ({
    id: enqueueInboxItem({ repoPath, packetId: `orphan-${status}`, kind: 'verification_failed', payload: { errorExcerpt: `Keep CODE_${status} verbatim` }, status: status as keyof typeof expected }).id,
    state,
  }));
  const full = await (await route.GET(request('&limit=250'))).json() as ProjectThreads;
  for (const item of ids) expect(full.tasks.find(task => task.id === `inbox:${item.id}`)?.thread.state).toBe(item.state);
  const paged: string[] = []; let offset: number | null = 0;
  while (offset !== null) {
    const page = await (await route.GET(request(`&limit=1&offset=${offset}`))).json() as ProjectThreads;
    paged.push(...page.tasks.map(task => task.id)); offset = page.nextOffset;
  }
  expect(paged).toEqual(full.tasks.map(task => task.id)); expect(new Set(paged).size).toBe(paged.length);
  expect((await route.GET(request('&limit=251'))).status).toBe(400);
  expect((await route.GET(request('&state=invented'))).status).toBe(400);
  const unknown = await (await route.GET(request('&projectId=unknown-project'))).json() as ProjectThreads;
  expect(unknown.tasks).toEqual([]);
});

it('ticks requirements only for current review evidence and retains exact immutable PR identities and check state', async () => {
  const routePath = '@/app/api/panel/threads/route'; route = await import(routePath);
  const git = (...args: string[]) => execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' }).trim();
  git('add', 'parser.ts'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'parser');
  const head = git('rev-parse', 'HEAD');
  const { recordOrchestratorReview } = await import('@/lib/approvals/store');
  recordOrchestratorReview(packetId, { approved: true, findings: [], reviewedHeadSha: head, contractCoverageEvidence: {
    contractVersion: 1, headSha: head, entries: [{ requirementId: 'R1', productionPath: 'parser.ts', verification: 'Parser fixture command passed' }],
  } });
  const { upsertGitHubPullRequest } = await import('@/lib/github-broker/store');
  upsertGitHubPullRequest({ pullRequestId: 501, repositoryId: 900, repoFullName: 'fixture/repo', number: 1, title: 'Exact parser PR', state: 'open', url: 'https://github.com/fixture/repo/pull/1', headSha: head,
    author: null, body: '', headRefName: 'parser', baseRefName: 'main', additions: 1, deletions: 0, changedFiles: 1,
    reviewDecision: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), closedAt: null, mergedAt: null,
    statusCheckRollup: [{ name: 'Parser tests', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
  db.getSqlite().prepare(`INSERT INTO conversation_pr_context (thread_id,host,repository_id,pull_request_id,number,repository_name,kind,source,source_key,packet_id,lane_id,created_at)
    VALUES ('thoughts-fixture','github.com',900,501,1,'fixture/repo','delivery','packet',?,?,?,datetime('now'))`).run(laneId, packetId, laneId);
  const read = async () => (await (await route.GET(request('&taskId=' + packetId))).json() as { task: ProjectThread }).task.thread;
  expect((await read()).requirements[0].covered).toBe(true);
  expect((await read()).merges).toEqual([expect.objectContaining({ title: 'Exact parser PR', checks: 'pass', head })]);
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'new head');
  expect((await read()).requirements[0].covered).toBe(false);
  db.getSqlite().prepare('UPDATE github_pull_requests SET repository_id = 901 WHERE pull_request_id = 501').run();
  expect((await read()).merges).toEqual([]);
});

it('refuses a requirement check when HEAD moves during evidence collection', async () => {
  const routePath = '@/app/api/panel/threads/route'; route = await import(routePath);
  const git = (...args: string[]) => execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' }).trim();
  git('add', 'parser.ts'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'parser review');
  const head = git('rev-parse', 'HEAD');
  (await import('@/lib/approvals/store')).recordOrchestratorReview(packetId, { approved: true, findings: [], reviewedHeadSha: head, contractCoverageEvidence: {
    contractVersion: 1, headSha: head, entries: [{ requirementId: 'R1', productionPath: 'parser.ts', verification: 'Parser fixture passed' }],
  } });
  const read = async () => (await (await route.GET(request('&taskId=' + packetId))).json() as { task: ProjectThread }).task.thread;
  expect((await read()).requirements[0].covered).toBe(true);
  fixture.moveHead = () => git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'head moved during read');
  expect((await read()).requirements[0].covered).toBe(false);
});

it('refuses to continue a page after the recorded thread ordering changes', async () => {
  const routePath = '@/app/api/panel/threads/route'; route = await import(routePath);
  const first = await (await route.GET(request('&limit=1'))).json() as ProjectThreads & { revision?: string };
  const query = `&limit=1&offset=1&revision=${first.revision ?? 'initial-snapshot'}`;
  expect((await route.GET(request(query))).status).toBe(200);
  (await import('@/lib/lane/registry')).createLane({ repoPath, branch: 'new-thread', runtime: 'codex', label: 'New work between pages' });
  expect((await route.GET(request(query))).status).toBe(409);
});

it('keeps a pending approval visible when its session has no packet or discovered worker', async () => {
  const routePath = '@/app/api/panel/threads/route'; route = await import(routePath);
  const { createApproval } = await import('@/lib/approvals/store');
  const approval = createApproval({ source: 'test', runtime: 'codex', agent: 'Approval fixture', sessionKey: 'codex:undiscovered', title: 'Choose parser outcome', description: 'Needs API_KEY before continuing', summary: 'Needs API_KEY before continuing', risk: 'medium', metadata: { RepoPath: repoPath }, projectId: null });
  const full = await (await route.GET(request())).json() as ProjectThreads;
  expect(full.tasks.find(task => task.id === `approval:${approval.id}`)).toMatchObject({ blockedReason: 'Needs API_KEY before continuing', thread: { state: 'waiting' } });
});

it('reads local tool counts for the exact child and mission without reading foreign workers', async () => {
  const { registerRuntime, getRuntime } = await import('@/lib/runtimes/registry');
  const previous = getRuntime('codex');
  const read = vi.fn(async () => [{ toolCalls: [{ name: 'Read' }, { name: 'Edit' }] }]);
  registerRuntime({ ...previous, id: 'codex', readTranscript: read } as unknown as import('@/lib/runtimes/types').AgentRuntime);
  try {
    const detail = await (await route.GET(request('&taskId=' + packetId))).json() as { task: ProjectThread };
    expect(detail.task.thread.workers[0].tools).toBe(2);
    const mission = await (await route.GET(request('&taskId=mission-thread-fixture'))).json() as { task: ProjectThread };
    expect(mission.task.thread.workers.find(worker => worker.sessionKey === 'codex:parser')?.tools).toBe(2);
    expect(read.mock.calls.every(call => (call as unknown[])[0] !== 'codex:foreign')).toBe(true);
  } finally { if (previous) registerRuntime(previous); }
});

it('does not resolve old approvals as a side effect of background thread reads', async () => {
  const approval = (await import('@/lib/approvals/store')).createApproval({ source: 'test', runtime: 'codex', agent: 'Old decision', sessionKey: 'codex:old-decision', title: 'Old decision', description: 'Retain this pending decision', summary: 'Retain this pending decision', risk: 'medium', metadata: { RepoPath: repoPath }, projectId: null });
  db.getSqlite().prepare('UPDATE approvals SET created_at = ? WHERE id = ?').run(Date.now() - 3_600_000, approval.id);
  expect((await import('@/lib/approvals/store')).getApproval(approval.id)?.status).toBe('pending');
  expect((await route.GET(request())).status).toBe(200);
  expect((await import('@/lib/approvals/store')).getApproval(approval.id)?.status).toBe('pending');
});

it('retains a failed handoff on its exact packet instead of dropping its attention', async () => {
  const { persistAgentMessage, updateAgentMessageDelivery } = await import('@/lib/agents/store');
  const { message } = persistAgentMessage({ from: 'fixture-a', to: 'fixture-b', repo: repoPath, text: 'Inspect the exact parser output', refs: { packetId, laneId } });
  updateAgentMessageDelivery(message.id, 'failed', 'Synthetic delivery refusal');
  const full = await (await route.GET(request())).json() as ProjectThreads;
  const packet = full.tasks.find(task => task.id === packetId)!;
  expect(packet.thread.state).toBe('waiting');
  expect(packet.thread.history).toContainEqual(expect.objectContaining({ id: message.id, label: 'Inspect the exact parser output' }));
});

const displaySecret = 'synthetic-project-thread-credential-8341';
const displayHome = '/' + ['Users', 'synthetic-thread-owner', 'private'].join('/');
const displayCanary = `Authorization: Bearer ${displaySecret} at ${displayHome}/decision.json`;
function expectPrivateTextHidden(value: string) {
  expect.soft(value).not.toContain(displaySecret);
  expect.soft(value).not.toContain(displayHome);
  expect.soft(value).toContain('[redacted]');
  expect.soft(value).toContain('~/private');
}
it('redacts recorded handoffs and artifact titles through the route and built CLI', async () => {
  const { persistAgentMessage } = await import('@/lib/agents/store');
  persistAgentMessage({ from: 'private-bound', to: 'reviewer', repo: repoPath, text: displayCanary, refs: { packetId, laneId } });
  persistAgentMessage({ from: 'private-orphan', to: 'reader', repo: repoPath, text: displayCanary, refs: { laneId: null, packetId: null } });
  const { recordArtifact } = await import('@/lib/artifacts/store');
  recordArtifact({ source: 'manual', kind: 'report', packetId, laneId, repoPath, relPath: 'artifacts/private-report.json', label: displayCanary, mimeType: 'application/json' });
  const response = await route.GET(request('&taskId=' + packetId)); expect(response.status).toBe(200);
  expectPrivateTextHidden(await response.text());
  for (const action of [['list'], ['show', packetId]]) for (const mode of [[], ['--human']]) {
    const output = await cliThreads([...mode, 'threads', ...action, '--repo', repoPath]);
    expectPrivateTextHidden(output.stdout);
  }
}, 60_000);
it('scopes orphan approvals and incidents by project identity when repositories are shared', async () => {
  const { createProject, setProjectRepos, setActiveProject } = await import('@/lib/repos/projects');
  const { createApproval } = await import('@/lib/approvals/store');
  const { enqueueInboxItem } = await import('@/lib/supervisor/inbox');
  const a = (await createProject('Thread scope A')).activeProjectId;
  const b = (await createProject('Thread scope B')).activeProjectId;
  await setProjectRepos(a, [repoPath]); await setProjectRepos(b, [repoPath]);
  const records = [];
  for (const [projectId, marker] of [[a, 'private-only-A'], [b, 'private-only-B']]) {
    await setActiveProject(projectId);
    const approval = createApproval({ source: 'test', runtime: 'codex', agent: marker, sessionKey: `codex:${marker}`, title: marker, description: marker, summary: marker, risk: 'medium', metadata: { RepoPath: repoPath }, projectId });
    const incident = enqueueInboxItem({ repoPath, packetId: `orphan-${marker}`, kind: 'verification_failed', payload: { errorExcerpt: marker } });
    records.push({ projectId, marker, approval: `approval:${approval.id}`, incident: `inbox:${incident.id}` });
  }
  for (const own of records) {
    const foreign = records.find(record => record !== own)!;
    const response = await route.GET(request('&projectId=' + own.projectId)); expect(response.status).toBe(200);
    const body = await response.json() as ProjectThreads;
    const text = JSON.stringify(body);
    expect.soft(text).toContain(own.marker); expect.soft(text).not.toContain(foreign.marker);
    expect.soft(body.tasks.map(task => task.id)).toEqual(expect.arrayContaining([own.approval, own.incident]));
    for (const id of [foreign.approval, foreign.incident]) expect.soft((await route.GET(request(`&projectId=${own.projectId}&taskId=${id}`))).status).toBe(404);
    const cli = await cliThreads(['threads', 'list', '--repo', repoPath, '--project', own.projectId]);
    expect.soft(cli.stdout).toContain(own.marker); expect.soft(cli.stdout).not.toContain(foreign.marker);
  }
}, 60_000);
it('serves each recorded evidence kind through its emitted URL and redacts report bodies', async () => {
  const { recordArtifact } = await import('@/lib/artifacts/store');
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  const kinds = [
    { kind: 'report', ext: 'json', mimeType: 'application/json', bytes: Buffer.from(JSON.stringify({ note: displayCanary, token: displaySecret, password: displaySecret, nested: { authorization: displaySecret }, result: 'Parser verified' })) },
    { kind: 'receipt', ext: 'txt', mimeType: 'text/plain', bytes: Buffer.from(displayCanary) },
    { kind: 'screenshot', ext: 'png', mimeType: 'image/png', bytes: Buffer.from([137, 80, 78, 71]) },
    { kind: 'video', ext: 'webm', mimeType: 'video/webm', bytes: Buffer.from([26, 69, 223, 163]) },
  ] as const;
  const expected = new Map();
  for (const item of kinds) {
    const relPath = `artifacts/served-${item.kind}.${item.ext}`; writeFileSync(join(root, relPath), item.bytes);
    const record = recordArtifact({ source: 'manual', kind: item.kind, packetId, laneId, repoPath, relPath, label: `Served ${item.kind}`, mimeType: item.mimeType })!;
    expected.set(record.id, item);
  }
  const detail = await (await route.GET(request('&taskId=' + packetId))).json() as { task: ProjectThread };
  for (const artifact of detail.task.thread.artifacts.filter(item => expected.has(item.id))) {
    const url = new URL(artifact.href, 'http://localhost');
    const modulePath = url.pathname === '/api/panel/serve-image' ? '@/app/api/panel/serve-image/route' : '@/app/api/panel/threads/artifact/route';
    const serving = await import(modulePath);
    const response = await serving.GET(new NextRequest(url, { headers: { authorization: `Bearer ${token}` } }));
    expect.soft(response.status, artifact.kind).toBe(200);
    const item = expected.get(artifact.id)!;
    if (item.kind === 'report' || item.kind === 'receipt') expectPrivateTextHidden(await response.text());
    else expect.soft(Buffer.from(await response.arrayBuffer())).toEqual(item.bytes);
  }
});

it('redacts interactive evidence at its emitted read URL without modifying the saved artifact', async () => {
  const { insertTaskArtifact, getTaskArtifactById } = await import('@/lib/task-artifacts/store');
  const id = 'tart-00000000-0000-4000-8000-000000004703';
  const html = `<pre>${displayCanary} ${JSON.stringify({ password: displaySecret })}</pre>`;
  const at = new Date().toISOString();
  insertTaskArtifact({ id, schemaVersion: 1, title: `Bearer ${displaySecret}`, html,
    target: { kind: 'packet', repoPath, packetId, laneId, sessionKey: 'codex:parser', threadId: null },
    originHead: initialHead, headPolicy: 'any', actions: [], state: 'live', stateReason: null, createdBy: 'operator', createdAt: at, updatedAt: at });
  const detail = await (await route.GET(request('&taskId=' + packetId))).json() as { task: ProjectThread };
  const artifact = detail.task.thread.artifacts.find(item => item.id === id)!;
  const url = new URL(artifact.href, 'http://localhost');
  const modulePath = url.pathname.startsWith('/api/task-artifacts/') ? '@/app/api/task-artifacts/[id]/route' : '@/app/api/panel/threads/artifact/route';
  const reader = await import(modulePath);
  const response = await reader.GET(new NextRequest(url, { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(200); expectPrivateTextHidden(await response.text());
  expect(getTaskArtifactById(id)?.html).toBe(html);
});

it('authenticates artifact reads and refuses recorded paths outside the artifact root', async () => {
  const reader = await import('@/app/api/panel/threads/artifact/route');
  const { recordArtifact } = await import('@/lib/artifacts/store');
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  writeFileSync(join(root, 'private-outside.txt'), displayCanary);
  symlinkSync(join(root, 'private-outside.txt'), join(root, 'artifacts', 'private-link.txt'));
  const read = (id: string, authorized = true) => reader.GET(new NextRequest(`http://localhost/api/panel/threads/artifact?id=${id}`, {
    headers: authorized ? { authorization: `Bearer ${token}` } : { 'x-o8-client-addr': '198.51.100.2' },
  }));
  for (const relPath of ['private-outside.txt', '../private-outside.txt', join(root, 'private-outside.txt'), 'artifacts/private-link.txt']) {
    const record = recordArtifact({ source: 'manual', kind: 'report', packetId, laneId, repoPath, relPath, mimeType: 'text/plain' });
    expect(record).not.toBeNull();
    expect((await read(record!.id, false)).status).toBe(401);
    const response = await read(record!.id);
    expect(response.status).toBe(404); expect(await response.text()).not.toContain(displaySecret);
  }
});

async function sharedThreadProjects(suffix: string) {
  const { createProject, setProjectRepos, getProjectsLedger } = await import('@/lib/repos/projects');
  const { createLane, attachSession } = await import('@/lib/lane/registry');
  const { persistAgentMessage } = await import('@/lib/agents/store');
  const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
  const { recordMission } = await import('@/lib/db/missions-store');
  const projects = [];
  for (const label of ['A', 'B']) {
    const projectId = (await createProject(`Shared ${suffix} ${label}`)).activeProjectId;
    await setProjectRepos(projectId, [repoPath]);
    const id = `pkt-shared-${suffix}-${label}`;
    const lane = createLane({ repoPath, packetId: id, projectId, branch: id, runtime: 'codex', label: `Thread ${suffix} ${label}` });
    const sessionKey = `codex:shared-${suffix}-${label}`;
    attachSession(lane.id, sessionKey);
    const state = createEmptyOrchestratorMissionState();
    state.missionId = `mission-shared-${suffix}-${label}`; state.repoPath = repoPath;
    state.summary = `Mission ${suffix} ${label}`;
    state.packets = [{ id, projectId, title: lane.label, summary: '', status: 'running', runtime: 'codex',
      workspaceTargetPath: repoPath, dependencyPacketIds: [], dependencyLabels: [] } as unknown as OrchestratorPacket];
    recordMission({ id: state.missionId, repoPath, runtime: 'codex', prompt: '', summary: state.summary, constraints: '', packetMeta: [], totalWaves: 1, missionState: state });
    const marker = `handoff-private-${suffix}-${label}`;
    const { message } = persistAgentMessage({ from: `sender-${label}`, to: `reader-${label}`, repo: repoPath, text: marker, refs: { laneId: lane.id, packetId: id } });
    projects.push({ projectId, packetId: id, laneId: lane.id, sessionKey, marker, handoffId: `handoff:${message.conversation!.id}` });
  }
  // Include persisted legacy ledger rows as well as SQLite-projected projects.
  const ledger = await getProjectsLedger();
  for (const project of ledger.projects) if (projects.some(own => own.projectId === project.id)) project.repoPaths = [repoPath];
  writeFileSync(join(root, 'projects.json'), JSON.stringify(ledger));
  return projects;
}

it('scopes every handoff read by project identity in routes and built CLI list and show', async () => {
  const projects = await sharedThreadProjects('handoffs');
  for (const own of projects) {
    const foreign = projects.find(project => project !== own)!;
    for (const taskId of [undefined, own.packetId]) {
      const response = await route.GET(request(`&projectId=${own.projectId}${taskId ? `&taskId=${taskId}` : ''}`));
      expect.soft(response.status).toBe(200);
      const text = await response.text();
      expect.soft(text).toContain(own.marker); expect.soft(text).not.toContain(foreign.marker);
      const args = taskId ? ['show', taskId] : ['list'];
      const cli = await cliThreads(['threads', ...args, '--repo', repoPath, '--project', own.projectId]);
      expect.soft(cli.stdout).toContain(own.marker); expect.soft(cli.stdout).not.toContain(foreign.marker);
    }
    for (const id of [foreign.packetId, foreign.handoffId]) {
      const response = await route.GET(request(`&projectId=${own.projectId}&taskId=${id}`));
      expect.soft(response.status).toBe(404); expect.soft(await response.text()).not.toContain(foreign.marker);
      await expect.soft(cliThreads(['threads', 'show', id, '--repo', repoPath, '--project', own.projectId])).rejects.toMatchObject({ code: 4 });
    }
  }
}, 60_000);

it('keeps projectless sessions out of shared-project reads and uses saved chat identity', async () => {
  const [a, b] = await sharedThreadProjects('sessions');
  const { writePersistedLlmChat } = await import('@/lib/llm/chat-history-store');
  for (const project of [a, b]) {
    const history = { messages: [], repoPath, projectId: project.projectId, title: `saved-${project.marker}` };
    writePersistedLlmChat(`thoughts-${project.packetId}`, history);
  }
  const unknown = { name: 'Unattributed shared session', sessionKey: 'codex:unattributed-shared', workspace: repoPath, runtime: 'codex', status: 'working' } as unknown as import('@/lib/fleet/types').AgentSummary;
  fixture.agents.push(unknown);
  try {
    for (const own of [a, b]) {
      const foreign = own === a ? b : a;
      const response = await route.GET(request(`&projectId=${own.projectId}`));
      const text = await response.text();
      expect.soft(text).toContain(`saved-${own.marker}`);
      expect.soft(text).not.toContain(`saved-${foreign.marker}`);
      expect.soft(text).not.toContain(unknown.sessionKey);
      const cli = await cliThreads(['threads', 'list', '--repo', repoPath, '--project', own.projectId]);
      expect.soft(cli.stdout).toContain(`saved-${own.marker}`);
      expect.soft(cli.stdout).not.toContain(`saved-${foreign.marker}`);
      expect.soft(cli.stdout).not.toContain(unknown.sessionKey);
    }
  } finally { fixture.agents = fixture.agents.filter(agent => agent !== unknown); }
}, 60_000);

it.each(['file', 'interactive'] as const)('refuses another shared project\'s %s artifact without exposing its existence', async kind => {
  const projects = await sharedThreadProjects(kind);
  const reader = await import('@/app/api/panel/threads/artifact/route');
  const { recordArtifact } = await import('@/lib/artifacts/store');
  const { insertTaskArtifact } = await import('@/lib/task-artifacts/store');
  const ids: string[] = [];
  for (const [index, project] of projects.entries()) {
    if (kind === 'file') {
      const relPath = `artifacts/shared-${kind}-${index}.json`;
      mkdirSync(join(root, 'artifacts'), { recursive: true }); writeFileSync(join(root, relPath), JSON.stringify({ note: project.marker }));
      ids.push(recordArtifact({ source: 'manual', kind: 'report', packetId: project.packetId, laneId: project.laneId, repoPath, relPath, mimeType: 'application/json' })!.id);
    } else {
      const id = `tart-00000000-0000-4000-8000-00000000470${index}`;
      const at = new Date().toISOString();
      insertTaskArtifact({ id, schemaVersion: 1, title: project.marker, html: `<p>${project.marker}</p>`,
        target: { kind: 'packet', repoPath, packetId: project.packetId, laneId: project.laneId, sessionKey: project.sessionKey, threadId: null },
        originHead: initialHead, headPolicy: 'any', actions: [], state: 'live', stateReason: null, createdBy: 'operator', createdAt: at, updatedAt: at });
      ids.push(id);
    }
  }
  const read = (id: string, projectId: string) => reader.GET(new NextRequest(`http://localhost/api/panel/threads/artifact?${new URLSearchParams({ id, projectId, ...(kind === 'interactive' ? { source: 'interactive' } : {}) })}`, { headers: { authorization: `Bearer ${token}` } }));
  for (const [index, own] of projects.entries()) {
    const foreign = projects[1 - index];
    const ownResponse = await read(ids[index], own.projectId);
    expect.soft(ownResponse.status).toBe(200); expect.soft(await ownResponse.text()).toContain(own.marker);
    const denied = await read(ids[1 - index], own.projectId);
    const missing = await read('missing-artifact', own.projectId);
    expect.soft(denied.status).toBe(404); expect.soft(await denied.text()).toBe(await missing.text());
    for (const projectId of ['unknown-project', '']) expect.soft((await read(ids[index], projectId)).status).toBe(404);
    const detail = await (await route.GET(request(`&projectId=${own.projectId}&taskId=${own.packetId}`))).json() as { task: ProjectThread };
    const link = detail.task.thread.artifacts.find(artifact => artifact.id === ids[index]);
    expect.soft(link).toBeDefined();
    expect.soft(new URL(link!.href, 'http://localhost').searchParams.get('projectId')).toBe(own.projectId);
    expect.soft(JSON.stringify(detail)).not.toContain(foreign.marker);
  }
}, 60_000);

it('refuses contradictory or unowned evidence identities before exposing metadata or bytes', async () => {
  const [a, b] = await sharedThreadProjects('conflicts');
  const { writePersistedLlmChat } = await import('@/lib/llm/chat-history-store');
  const { recordArtifact } = await import('@/lib/artifacts/store');
  const { insertTaskArtifact } = await import('@/lib/task-artifacts/store');
  const reader = await import('@/app/api/panel/threads/artifact/route');
  const foreignChat = 'thoughts-foreign-evidence';
  const unownedChat = 'thoughts-unowned-evidence';
  writePersistedLlmChat(foreignChat, { messages: [], repoPath, ...{ projectId: b.projectId } });
  writePersistedLlmChat(unownedChat, { messages: [], repoPath });
  const marker = 'foreign-artifact-conflicting-owner';
  const reads: Array<Record<string, string>> = [];
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  for (const [index, threadId] of [foreignChat, unownedChat].entries()) {
    const relPath = `artifacts/conflicting-${index}.json`;
    writeFileSync(join(root, relPath), JSON.stringify({ note: marker }));
    const file = recordArtifact({ source: 'manual', kind: 'report', label: marker, repoPath, packetId: a.packetId, laneId: a.laneId, threadId, relPath, mimeType: 'application/json' })!;
    const id = `tart-00000000-0000-4000-8000-00000000471${index}`;
    const at = new Date().toISOString();
    insertTaskArtifact({ id, schemaVersion: 1, title: marker, html: `<p>${marker}</p>`,
      target: { kind: 'packet', repoPath, packetId: a.packetId, laneId: a.laneId, sessionKey: a.sessionKey, threadId },
      originHead: initialHead, headPolicy: 'any', actions: [], state: 'live', stateReason: null, createdBy: 'operator', createdAt: at, updatedAt: at });
    reads.push({ id: file.id }, { id, source: 'interactive' });
  }
  for (const target of reads) {
    const response = await reader.GET(new NextRequest(`http://localhost/api/panel/threads/artifact?${new URLSearchParams({ ...target, projectId: a.projectId })}`, { headers: { authorization: `Bearer ${token}` } }));
    expect.soft(response.status).toBe(404); expect.soft(await response.text()).not.toContain(marker);
  }
  for (const taskId of [undefined, a.packetId]) {
    const response = await route.GET(request(`&projectId=${a.projectId}${taskId ? `&taskId=${taskId}` : ''}`));
    expect.soft(response.status).toBe(200); expect.soft(await response.text()).not.toContain(marker);
    const cli = await cliThreads(['threads', ...(taskId ? ['show', taskId] : ['list']), '--repo', repoPath, '--project', a.projectId]);
    expect.soft(cli.stdout).not.toContain(marker);
  }
}, 60_000);

it('does not infer ownership for projectless pool rows or mixed-project mission prompts', async () => {
  const [a, b] = await sharedThreadProjects('unowned');
  const { createLane } = await import('@/lib/lane/registry');
  const lane = createLane({ repoPath, branch: 'unowned', runtime: 'codex', label: 'unowned-pool-private-title' });
  db.getSqlite().prepare('UPDATE lanes SET project_id = NULL WHERE id = ?').run(lane.id);
  const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
  const state = createEmptyOrchestratorMissionState();
  state.missionId = 'unowned-aggregate'; state.repoPath = repoPath; state.summary = 'unowned-aggregate-private-summary';
  state.packets = [a, b].map(project => ({ id: project.packetId, projectId: project.projectId, title: 'Own child', status: 'running', runtime: 'codex', workspaceTargetPath: repoPath, dependencyPacketIds: [], dependencyLabels: [] } as unknown as OrchestratorPacket));
  (await import('@/lib/db/missions-store')).recordMission({ id: state.missionId, repoPath, runtime: 'codex', prompt: '', summary: state.summary, constraints: '', packetMeta: [], totalWaves: 1, missionState: state });
  for (const id of [lane.id, state.missionId]) {
    expect.soft((await route.GET(request(`&projectId=${a.projectId}&taskId=${id}`))).status).toBe(404);
    await expect.soft(cliThreads(['threads', 'show', id, '--repo', repoPath, '--project', a.projectId])).rejects.toMatchObject({ code: 4 });
  }
  const text = await (await route.GET(request(`&projectId=${a.projectId}`))).text();
  expect(text).toContain(a.packetId); expect(text).not.toContain(lane.label); expect(text).not.toContain(state.summary);
}, 60_000);

it('refuses mission summaries when a child packet and lane disagree about project ownership', async () => {
  const [a, b] = await sharedThreadProjects('mission-conflict');
  const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
  const state = createEmptyOrchestratorMissionState();
  state.missionId = 'mission-conflicting-child'; state.repoPath = repoPath;
  state.summary = 'conflicting-child-private-mission-summary';
  state.packets = [a, b].map(project => ({ id: project.packetId, projectId: a.projectId, title: 'Child',
    status: 'running', runtime: 'codex', workspaceTargetPath: repoPath, dependencyPacketIds: [], dependencyLabels: [] } as unknown as OrchestratorPacket));
  (await import('@/lib/db/missions-store')).recordMission({ id: state.missionId, repoPath, runtime: 'codex', prompt: '', summary: state.summary, constraints: '', packetMeta: [], totalWaves: 1, missionState: state });
  const response = await route.GET(request(`&projectId=${a.projectId}`));
  expect.soft(response.status).toBe(200); expect.soft(await response.text()).not.toContain(state.summary);
  expect.soft((await route.GET(request(`&projectId=${a.projectId}&taskId=${state.missionId}`))).status).toBe(404);
  const cli = await cliThreads(['threads', 'list', '--repo', repoPath, '--project', a.projectId]);
  expect.soft(cli.stdout).not.toContain(state.summary);
  await expect.soft(cliThreads(['threads', 'show', state.missionId, '--repo', repoPath, '--project', a.projectId])).rejects.toMatchObject({ code: 4 });
}, 60_000);
