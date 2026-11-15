import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, expect, it, vi } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';
import type { Lane } from '@/lib/lane/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

vi.mock('@/lib/cortex/qa/ask', () => ({ askCortex: async (_q: string, _r: string, options: { projectId: string }) => ({
  answer: options.projectId, citations: [], class: 'A', retrievalMs: 0, classifyMs: 0, sourcesConsidered: 0,
}) }));
const directory = mkdtempSync(join(tmpdir(), 'o8-worker-reads-'));
Object.assign(process.env, { O8_DATA_DIR: directory, CORTEX_IDE_DATA_DIR: directory,
  CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'), WS_TOKEN: 'ws-parity-fixture-credential' });
const legacy = 'fixture-legacy-worker-0123456789';
writeFileSync(join(directory, 'worker-token'), legacy);
writeFileSync(join(directory, 'ws-token'), process.env.WS_TOKEN!);
const { createLane } = await import('@/lib/lane/registry');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { withLockedState } = await import('@/lib/orchestrator/control-plane');
const { getSqlite, closeDb } = await import('@/lib/db');
const { createApproval } = await import('@/lib/approvals/store');
const { listProblemDossiers } = await import('@/lib/problems/dossiers');
const { panelGateMiddleware } = await import('@/middleware');
const approvals = await import('@/app/api/panel/approvals/route');
const tasks = await import('@/app/api/tasks/route');
const task = await import('@/app/api/tasks/[taskId]/route');
const availability = await import('@/app/api/tasks/worker-availability/route');
const touches = await import('@/app/api/lanes/touches/route');
const dossiers = await import('@/app/api/panel/problem-dossiers/route');
const brain = await import('@/app/api/cortex/ask/answer/route');
const lanes: Lane[] = [];
for (const id of ['A', 'B']) {
  const repoPath = join(directory, id);
  mkdirSync(repoPath);
  lanes.push(createLane({ repoPath, projectId: `project-${id}`, packetId: `packet-${id}`,
    branch: `fixture-${id}`, runtime: 'codex', sessionKey: `codex-owned:${id}` }));
  createApproval({ projectId: `project-${id}`, source: 'test', runtime: 'codex', agent: 'fixture',
    sessionKey: `codex-owned:${id}`, title: id, description: id, summary: id, risk: 'low',
    metadata: { Packet: `packet-${id}`, Lane: lanes.at(-1)!.id } });
}
await withLockedState(state => {
  state.packets.push(...['A', 'B'].map(id => ({ id: `packet-${id}`, title: id, summary: id,
    status: 'ready', projectId: `project-${id}`, workspaceTargetPath: join(directory, id) } as unknown as OrchestratorPacket)));
  return state;
});
listProblemDossiers();
for (const id of ['A', 'B']) getSqlite().prepare(`INSERT INTO problem_dossiers
  (id,fingerprint,project_id,repo_path,pain_statement,first_observed_at,last_observed_at,impact_band,evidence_confidence,closure_contract_json,created_at,updated_at)
  VALUES (?,?,?,?,?,'2026-01-01','2026-01-01','low','high','{}','2026-01-01','2026-01-01')`)
  .run(id, id, `project-${id}`, join(directory, id), id);
getSqlite().exec('ALTER TABLE lanes ADD COLUMN files_touched TEXT');
getSqlite().prepare('UPDATE lanes SET files_touched = ?').run(JSON.stringify(['src/shared.ts']));
const worker = mintPacketWorkerToken('packet-A');
const operator = process.env.WS_TOKEN!;
let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
afterAll(async () => { await server?.stop(); closeDb(); rmSync(directory, { recursive: true, force: true }); });

async function direct(path: string, token: string, body?: object) {
  const req = new NextRequest(`http://localhost:3001/api/${path}`, { method: body ? 'POST' : 'GET',
    headers: { host: 'localhost:3001', 'x-o8-client-addr': '127.0.0.1', authorization: `Bearer ${token}`,
      'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const gate = panelGateMiddleware(req);
  if (gate.headers.get('x-middleware-next') !== '1') return gate;
  if (path.startsWith('panel/approvals')) return approvals.GET(req);
  if (path.startsWith('tasks')) return tasks.GET(req);
  if (path.startsWith('lanes/touches')) return touches.GET(req);
  if (path.startsWith('panel/problem-dossiers')) return dossiers.GET(req);
  return brain.POST(req);
}
for (const transport of ['Next', 'native'] as const) {
  const call = async (path: string, token: string, body?: object) => {
    if (transport === 'Next') return direct(path, token, body);
    if (!server) {
      server = await startParityReference({ o8d: true, nativeHttp: true, directory,
        preload: './tests/fixtures/worker-packet-brain.cjs', startupTimeoutMs: 120_000 });
      await server.stopNext();
    }
    return fetch(`${server.url.replace('ws:', 'http:').replace('/ws', '')}/api/${path}`, {
      method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  };
  it(`${transport}: approval contexts are packet scoped`, async () => {
    for (const query of [`packetId=packet-B`, `packetId=packet-A&laneId=${lanes[1].id}`,
      'packetId=packet-A&sessionKey=codex-owned:B', 'packetId=packet-A&sessionKey=codex-owned:A&terminalSession=other',
      'packetId=packet-A&terminalSession=other']) {
      expect((await call(`panel/approvals?${query}`, worker)).status, query).toBe(403);
    }
    expect((await call('panel/approvals?packetId=packet-A', legacy)).status).toBe(403);
    const own = await call('panel/approvals?packetId=packet-A', worker);
    expect(own.status).toBe(200);
    expect((await own.json()).approvals.map((a: { title: string }) => a.title)).toEqual(['A']);
    expect((await (await call('panel/approvals?scope=all', operator)).json()).approvals).toHaveLength(2);
  }, 180_000);
  it(`${transport}: task pool and briefs are packet scoped`, async () => {
    expect((await call('tasks?includeBrief=true&includeDone=true', legacy)).status).toBe(403);
    const own = await call('tasks?includeBrief=true&includeDone=true', worker);
    expect(own.status).toBe(200);
    const pool = await own.json();
    expect(pool.tasks.map((t: { packetId: string }) => t.packetId)).toEqual(['packet-A']);
    expect(JSON.stringify(pool)).not.toContain('packet-B');
    expect((await (await call('tasks?projectId=project-B&includeBrief=true', worker)).json()).tasks).toEqual([]);
    expect((await (await call('tasks?includeDone=true', operator)).json()).tasks).toHaveLength(2);
  });
  it(`${transport}: dossiers are packet project scoped`, async () => {
    expect((await call('panel/problem-dossiers', legacy)).status).toBe(403);
    expect((await call('panel/problem-dossiers?projectId=project-B', worker)).status).toBe(403);
    expect((await (await call('panel/problem-dossiers', worker)).json()).dossiers.map((d: { id: string }) => d.id)).toEqual(['A']);
    expect((await (await call('panel/problem-dossiers', operator)).json()).dossiers).toHaveLength(2);
  });
  it(`${transport}: Brain context uses the packet project`, async () => {
    const body = { question: 'fixture question', packetId: 'packet-A' };
    expect((await call('cortex/ask/answer', legacy, body)).status).toBe(403);
    expect((await call('cortex/ask/answer', worker, { ...body, projectId: 'project-B' })).status).toBe(403);
    const own = await call('cortex/ask/answer', worker, body);
    expect(own.status).toBe(200);
    expect((await own.json()).answer).toBe('project-A');
    const other = await call('cortex/ask/answer', operator, { ...body, projectId: 'project-B' });
    expect(other.status).toBe(200);
    expect((await other.json()).answer).toBe('project-B');
  });
}
it('Next: a single task read is packet scoped', async () => {
  const read = (id: string, token: string) => {
    const req = new NextRequest(`http://localhost:3001/api/tasks/${id}`, { headers: { host: 'localhost:3001',
      'x-o8-client-addr': '127.0.0.1', authorization: `Bearer ${token}` } });
    const gate = panelGateMiddleware(req);
    return gate.headers.get('x-middleware-next') !== '1' ? gate : task.GET(req, { params: Promise.resolve({ taskId: id }) });
  };
  expect((await read('packet-A', legacy)).status).toBe(403);
  expect((await read('packet-B', worker)).status).toBe(403);
  expect((await read(lanes[1].id, worker)).status).toBe(403);
  // Another packet's task and an unknown id are refused alike, without naming the other packet.
  const foreign = await read(lanes[1].id, worker);
  const unknown = await read('no-such-task', worker);
  expect(unknown.status).toBe(403);
  expect(JSON.stringify(await foreign.json())).not.toContain('packet-B');
  expect(Object.keys(await unknown.json()).sort()).toEqual(['error', 'ok']);
  const own = await read('packet-A', worker);
  expect(own.status).toBe(200);
  expect((await own.json()).task.packetId).toBe('packet-A');
  expect((await read('packet-B', operator)).status).toBe(200);
});
it('Next: remote worker availability is not a worker read', async () => {
  const read = (token: string) => {
    const req = new NextRequest('http://localhost:3001/api/tasks/worker-availability', { headers: { host: 'localhost:3001',
      'x-o8-client-addr': '127.0.0.1', authorization: `Bearer ${token}` } });
    const gate = panelGateMiddleware(req);
    return gate.headers.get('x-middleware-next') !== '1' ? gate : availability.GET(req);
  };
  expect((await read(worker)).status).toBe(403);
  expect((await read(operator)).status).not.toBe(403);
});
it('Next: lane touches are packet scoped', async () => {
  expect((await direct('lanes/touches?packet=packet-A', legacy)).status).toBe(403);
  expect((await direct('lanes/touches?packet=packet-B', worker)).status).toBe(403);
  expect((await direct('lanes/touches?path=src/foo.ts', worker)).status).toBe(403);
  const own = await direct('lanes/touches?packet=packet-A', worker);
  expect(own.status).toBe(200);
  expect(await own.json()).toMatchObject({ packetId: 'packet-A', paths: ['src/shared.ts'], lanes: [] });
  const all = await direct('lanes/touches?packet=packet-A', operator);
  expect((await all.json()).lanes.map((lane: { packetId: string }) => lane.packetId)).toEqual(['packet-B']);
  expect((await direct('lanes/touches?packet=packet-B', operator)).status).toBe(200);
});
