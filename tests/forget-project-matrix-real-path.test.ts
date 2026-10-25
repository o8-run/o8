import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { PacketContext } from '@/lib/orchestrator/types';

const inventoryState = vi.hoisted(() => ({ agents: [] as import('@/lib/fleet/types').AgentSummary[] }));
vi.mock('@/lib/realtime/publisher', async original => ({
  ...await original<typeof import('@/lib/realtime/publisher')>(),
  publishCortexChange: async () => {}, publishRealtimeMutation: async () => {},
}));
vi.mock('@/lib/runtime/inventory', async original => ({
  ...await original<typeof import('@/lib/runtime/inventory')>(), getRuntimeInventorySnapshot: async () => inventoryState,
}));
vi.mock('@/lib/orchestrator/capacity-snapshots', () => ({ capturePacketCapacitySnapshot: async () => {} }));
vi.mock('@/lib/lane/report-claim-check', () => ({ startReportClaimCheck: () => {} }));

const root = mkdtempSync(join(tmpdir(), 'o8-forget-project-matrix-'));
const token = 'fixture-project-memory-operator';
const sharedRepo = join(root, 'shared-repo'), otherRepo = join(root, 'other-repo');
const projects = [
  { projectId: 'matrix-a', repoPath: sharedRepo },
  { projectId: 'matrix-b', repoPath: sharedRepo },
  { projectId: 'matrix-other', repoPath: otherRepo },
];
const cases = projects.flatMap(project => [0, 1].map(sibling => ({ ...project, sibling })));
let db: typeof import('@/lib/db');
let corrections: typeof import('@/app/api/cortex/operator-corrections/route');
let outcomes: typeof import('@/app/api/cortex/recent-outcomes/route');
let relay: typeof import('@/lib/orchestrator/context-relay');
let projectsModule: typeof import('@/lib/repos/projects');
let buildPacketPrompt: typeof import('@/lib/orchestrator/packet-prompt').buildPacketPrompt;
type Pair = { packets: OrchestratorPacket[]; contexts: PacketContext[]; corrections: string[][]; capture(): Promise<void> };
const pairs: Pair[] = [];

function packet(id: string, repoPath: string): OrchestratorPacket {
  return { id, workspaceTargetPath: repoPath, referenceLabel: id, title: 'Inspect parser', summary: '',
    status: 'draft', queueState: 'queued', runtime: 'codex', dependencyPacketIds: [], dependencyLabels: [],
  } as unknown as OrchestratorPacket;
}
function request(endpoint: string, projectId: string, repoPath: string, method = 'GET', body?: object) {
  const params = new URLSearchParams({ projectId, repoPath, query: 'matrixcanary', limit: '100' });
  if (endpoint === 'recent-outcomes') params.set('inventory', 'true');
  return new NextRequest(`http://localhost/api/cortex/${endpoint}?${params}`, {
    method, headers: { host: 'localhost', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function inventory(projectId: string, repoPath: string) {
  return {
    corrections: (await (await corrections.GET(request('operator-corrections', projectId, repoPath))).json()).corrections,
    outcomes: (await (await outcomes.GET(request('recent-outcomes', projectId, repoPath))).json()).outcomes,
  } as { corrections: Array<{ id: string; projectId: string }>; outcomes: Array<{ id: string; projectId: string; summary: string }> };
}

beforeAll(async () => {
  vi.stubEnv('O8_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DATA_DIR', root);
  vi.stubEnv('CORTEX_IDE_DB_PATH', join(root, 'fixture.db'));
  mkdirSync(sharedRepo); mkdirSync(otherRepo); writeFileSync(join(root, 'ws-token'), token);
  writeFileSync(join(root, 'projects.json'), JSON.stringify({ activeProjectId: 'matrix-a',
    projects: projects.map(project => ({ id: project.projectId, name: project.projectId,
      repoPaths: [project.repoPath], createdAt: new Date().toISOString() })),
  }));
  db = await import('@/lib/db');
  projectsModule = await import('@/lib/repos/projects');
  corrections = await import('@/app/api/cortex/operator-corrections/route');
  outcomes = await import('@/app/api/cortex/recent-outcomes/route');
  relay = await import('@/lib/orchestrator/context-relay');
  ({ buildPacketPrompt } = await import('@/lib/orchestrator/packet-prompt'));
  const { createLane } = await import('@/lib/lane/registry');
  const { recordLaneEvent } = await import('@/lib/lane/events');
  const approvals = await import('@/lib/approvals/store');
  const approvalRoute = await import('@/app/api/panel/approvals/route');
  const { registerRuntime } = await import('@/lib/runtimes');
  for (const [index, project] of cases.entries()) {
    await projectsModule.setActiveProject(project.projectId);
    const packets = [0, 1].map(sibling => ({ ...packet(`pkt-20261025-1234-${index}-${sibling}`, project.repoPath), projectId: project.projectId }));
    const correctionIds: string[][] = [];
    for (const value of packets) {
      const lane = createLane({ repoPath: project.repoPath, projectId: project.projectId,
        branch: 'fixture', runtime: 'codex', packetId: value.id });
      const approval = approvals.createApproval({ source: 'runtime', runtime: 'codex', agent: 'codex',
        projectId: project.projectId, sessionKey: `fixture:${value.id}`, title: value.id, description: 'Review parser',
        summary: '', risk: 'medium', metadata: { Packet: value.id, Lane: lane.id } });
      const response = await approvalRoute.POST(new NextRequest('http://localhost/api/panel/approvals', {
        method: 'POST', headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: approval.id, action: 'reject', reason: `matrixcanary rejection ${value.id}` }),
      }));
      expect(response.status).toBe(200);
      const steer = recordLaneEvent(lane.id, 'steered_packet', 'orchestrator', {
        packetId: value.id, source: 'operator', message: `matrixcanary steer ${value.id}`,
      });
      correctionIds.push([`approval:${approval.id}`, `steer:${steer.id}`]);
    }
    const contexts: PacketContext[] = [];
    const capture = async () => {
      // Capture uses the lane's project even after the active project changes.
      registerRuntime({ id: 'codex', displayName: 'Matrix transcript',
        capabilities: { discover: false, readTranscript: true, launch: false, resume: false,
          interrupt: false, reviewDiffs: false, costTelemetry: false, streaming: false },
        discoverSessions: async () => [], getChangedFiles: async () => [],
        readTranscript: async () => [{ id: 'completion', role: 'assistant',
          text: `matrixcanary completion ${packets[contexts.length % 2].id}`, timestamp: new Date('2026-10-25T12:00:00Z') }],
        launch: async () => ({ ok: false, note: 'fixture' }), resume: async () => ({ ok: false, note: 'fixture' }),
        interrupt: async () => ({ ok: false, note: 'fixture' }),
      });
      for (const value of packets) {
        contexts.push(await relay.capturePacketCompletionContext(value.id, `codex:matrix-${index}`));
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    };
    inventoryState.agents = [{ sessionKey: `codex:matrix-${index}`,
      runtimeSurface: { lifecycle: { lastRunFinishedAt: '2026-10-25T12:00:05.000Z' } },
    } as import('@/lib/fleet/types').AgentSummary];
    await capture();
    inventoryState.agents = [];
    pairs.push({ packets, contexts, corrections: correctionIds, capture });
  }
  await projectsModule.setActiveProject('matrix-a');
}, 120_000);
afterAll(() => { db?.closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe.each(cases.map((value, index) => ({ ...value, index })))('$projectId, forgotten timestamp sibling $sibling', ({ projectId, repoPath, sibling, index }) => {
  it('inspect: project A cannot see other projects, including the shared repository', async () => {
    const listed = await inventory('matrix-a', sharedRepo);
    expect.soft(listed.corrections.every(row => row.projectId === 'matrix-a')).toBe(true);
    expect.soft(listed.outcomes.every(row => row.projectId === 'matrix-a')).toBe(true);
    const { correctionsRetriever } = await import('@/lib/cortex/qa/retrievers/corrections');
    const retrieved = await correctionsRetriever({ question: 'matrixcanary feedback', repoPath: sharedRepo, projectId: 'matrix-a', limit: 100 });
    const foreignIds = pairs.filter((_, pairIndex) => cases[pairIndex].projectId !== 'matrix-a').flatMap(pair => pair.corrections.flat());
    expect.soft(retrieved.rows.some(row => foreignIds.some(id => id.endsWith(`:${row.citation.rowId}`)))).toBe(false);
    const own = await inventory(projectId, repoPath);
    for (const id of pairs[index].corrections.flat()) expect.soft(own.corrections.map(row => row.id)).toContain(id);
    expect.soft(pairs[index].contexts[0].sourceOutcomeId).not.toBe(pairs[index].contexts[1].sourceOutcomeId);
  });

  it('forget: cross-project IDs are 404 and leave recall unchanged; own IDs are 200', async () => {
    const pair = pairs[index], selected = pair.contexts[sibling];
    if (projectId !== 'matrix-a') {
      const { readMemoryRevision } = await import('@/lib/cortex/memory-revision');
      const revision = readMemoryRevision();
      for (const id of pair.corrections[sibling]) {
        expect.soft((await corrections.DELETE(request('operator-corrections', 'matrix-a', sharedRepo, 'DELETE', { id, projectId: 'matrix-a' }))).status).toBe(404);
      }
      expect.soft((await outcomes.DELETE(request('recent-outcomes', 'matrix-a', sharedRepo, 'DELETE', {
        id: selected.sourceOutcomeId, projectId: 'matrix-a', repoPath: sharedRepo,
      }))).status).toBe(404);
      expect.soft(readMemoryRevision()).toBe(revision);
      expect.soft((await corrections.DELETE(request('operator-corrections', 'matrix-a', sharedRepo, 'DELETE', {
        id: pair.corrections[sibling][0], projectId,
      }))).status).toBe(404);
    }
    for (const id of pair.corrections[sibling]) {
      expect.soft((await corrections.DELETE(request('operator-corrections', projectId, repoPath, 'DELETE', { id, projectId }))).status).toBe(200);
    }
    expect.soft((await outcomes.DELETE(request('recent-outcomes', projectId, repoPath, 'DELETE', {
      id: selected.sourceOutcomeId, repoPath, projectId,
    }))).status).toBe(200);
  });

  async function checkRecall() {
    const pair = pairs[index];
    const listed = await inventory(projectId, repoPath);
    for (const id of pair.corrections[sibling]) expect.soft(listed.corrections.map(row => row.id)).not.toContain(id);
    for (const id of pair.corrections[1 - sibling]) expect.soft(listed.corrections.map(row => row.id)).toContain(id);
    expect.soft(listed.outcomes.map(row => row.id)).not.toContain(pair.contexts[sibling].sourceOutcomeId);
    expect.soft(listed.outcomes.some(row => row.summary === `matrixcanary completion ${pair.packets[sibling].id}`)).toBe(false);
    expect.soft(listed.outcomes.map(row => row.id)).toContain(pair.contexts[1 - sibling].sourceOutcomeId);
    const { hasForgottenPacketOutcome } = await import('@/lib/cortex/outcome-exclusion');
    expect.soft(hasForgottenPacketOutcome(pair.packets[sibling].id)).toBe(true);
    expect.soft(hasForgottenPacketOutcome(pair.packets[1 - sibling].id)).toBe(false);
    expect.soft(await relay.readPacketCompletionContext(pair.packets[sibling].id)).toBeNull();
    expect.soft(await relay.readPacketCompletionContext(pair.packets[1 - sibling].id)).not.toBeNull();
    const { correctionsRetriever } = await import('@/lib/cortex/qa/retrievers/corrections');
    const recalled = await correctionsRetriever({ question: 'matrixcanary feedback', repoPath, projectId, limit: 100 });
    for (const id of pair.corrections[sibling]) {
      expect.soft(recalled.rows.some(row => id.endsWith(`:${row.citation.rowId}`))).toBe(false);
    }
    for (const id of pair.corrections[1 - sibling]) {
      expect.soft(recalled.rows.some(row => id.endsWith(`:${row.citation.rowId}`))).toBe(true);
    }
  }
  it('re-capture: identical completion stays forgotten while its sibling remains retained', async () => {
    await pairs[index].capture();
    await checkRecall();
  });
  it('restart: persisted inventory and exact packet exclusions survive database reopen', async () => {
    db.closeDb(); db.getSqlite();
    await checkRecall();
  });
  it('dependent dispatch: a cold worker prompt omits the forgotten completion and keeps its sibling', async () => {
    const pair = pairs[index];
    await projectsModule.setActiveProject(projectId);
    const next = { ...packet(`dependent-${index}`, repoPath), projectId, dependencyPacketIds: pair.packets.map(value => value.id) };
    const cold = execFileSync(process.execPath, ['--import', join(process.cwd(), 'scripts/register-server-only-stub.mjs'),
      '--import', createRequire(import.meta.url).resolve('tsx'), '--input-type=module', '-e',
      "const m = await import('./src/lib/orchestrator/packet-prompt.ts'); const f = m.default ?? m; process.stdout.write('MATRIX_PROMPT:' + await f.buildPacketPrompt(JSON.parse(process.argv[1]), JSON.parse(process.argv[2]))); process.exit(0);",
      JSON.stringify(next), JSON.stringify([...pair.packets, next]),
    ], { cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 30_000 });
    const text = cold.split('MATRIX_PROMPT:').at(-1)!;
    expect.soft(text).not.toContain(`matrixcanary completion ${pair.packets[sibling].id}`);
    expect.soft(text).toContain(`matrixcanary completion ${pair.packets[1 - sibling].id}`);
    const warm = await buildPacketPrompt(next, [...pair.packets, next]);
    expect.soft(warm).not.toContain(`matrixcanary completion ${pair.packets[sibling].id}`);
    expect.soft(warm).toContain(`Previous work from dependency 'Inspect parser': matrixcanary completion ${pair.packets[1 - sibling].id}`);
    await projectsModule.setActiveProject('matrix-a');
  }, 45_000);
});

it('requires explicit correction project identity and refuses conflicting project selectors', async () => {
  const pair = pairs[0];
  const missingProject = new NextRequest('http://localhost/api/cortex/operator-corrections', {
    method: 'DELETE', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ id: pair.corrections[1][0] }),
  });
  expect((await corrections.DELETE(missingProject)).status).toBe(400);
  expect((await corrections.DELETE(request('operator-corrections', 'matrix-a', sharedRepo, 'DELETE', {
    id: pair.corrections[1][0], projectId: 'matrix-b',
  }))).status).toBe(404);
});
