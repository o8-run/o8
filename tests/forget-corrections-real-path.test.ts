import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

vi.mock('@/lib/realtime/publisher', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/realtime/publisher')>(),
  publishCortexChange: vi.fn(async () => {}), publishRealtimeMutation: vi.fn(async () => {}),
}));
vi.mock('@/lib/runtime/inventory', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/runtime/inventory')>(),
  getRuntimeInventorySnapshot: async () => ({ agents: [] }),
}));
vi.mock('@/lib/orchestrator/capacity-snapshots', () => ({ capturePacketCapacitySnapshot: async () => {} }));
vi.mock('@/lib/lane/report-claim-check', () => ({ startReportClaimCheck: () => {} }));
const operator = 'fixture-forget-corrections-operator';
const device = 'fixture-forget-corrections-device';
const root = mkdtempSync(join(tmpdir(), 'o8-forget-corrections-'));
const repo = join(root, 'repo');
let db: typeof import('@/lib/db');
let lanes: typeof import('@/lib/lane/registry');
let approvals: typeof import('@/lib/approvals/store');
let approvalRoute: typeof import('@/app/api/panel/approvals/route');
let prompt: typeof import('@/lib/orchestrator/packet-prompt');
let retrieve: typeof import('@/lib/cortex/qa/retrieve');
let recall: typeof import('@/lib/cortex/qa/recall');
let route: { GET(request: NextRequest): Promise<Response>; DELETE(request: NextRequest): Promise<Response> };

beforeAll(async () => {
  vi.stubEnv('O8_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DATA_DIR', root);
  vi.stubEnv('CORTEX_IDE_DB_PATH', join(root, 'fixture.db'));
  mkdirSync(repo);
  writeFileSync(join(root, 'ws-token'), operator);
  writeFileSync(join(root, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex') + '\n');
  db = await import('@/lib/db'); lanes = await import('@/lib/lane/registry');
  approvals = await import('@/lib/approvals/store'); approvalRoute = await import('@/app/api/panel/approvals/route');
  prompt = await import('@/lib/orchestrator/packet-prompt'); retrieve = await import('@/lib/cortex/qa/retrieve');
  recall = await import('@/lib/cortex/qa/recall');
}, 120_000); // Allow cold transformation of the production route/prompt graph; test deadlines stay unchanged.
afterAll(() => { db?.closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

async function loadRoute() {
  const name = '@/app/api/cortex/operator-corrections/route';
  route = await import(name);
}
function request(method = 'GET', body?: object, token = operator, query = '') {
  return new NextRequest(`http://localhost/api/cortex/operator-corrections${query}`, {
    method, headers: { host: 'localhost', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify({ projectId: 'default', ...body }) } : {}),
  });
}
function packet(id: string) {
  return { id, workspaceTargetPath: repo, referenceLabel: id, title: 'Parser correction', summary: '',
    status: 'draft', queueState: 'queued', runtime: 'codex', dependencyPacketIds: [], dependencyLabels: [],
  } as unknown as OrchestratorPacket;
}
async function rejection(id: string, repoPath = repo) {
  const lane = lanes.createLane({ repoPath, branch: 'fixture', runtime: 'codex', packetId: id });
  const approval = approvals.createApproval({ source: 'runtime', runtime: 'codex', agent: 'codex', sessionKey: `fixture:${id}`,
    title: id, description: 'Review parser', summary: '', risk: 'medium', metadata: { Packet: id, Lane: lane.id } });
  const response = await approvalRoute.POST(new NextRequest('http://localhost/api/panel/approvals', {
    method: 'POST', headers: { host: 'localhost', authorization: `Bearer ${operator}` },
    body: JSON.stringify({ id: approval.id, action: 'reject', reason: `${id} correction canary` }),
  }));
  expect(response.status).toBe(200);
  return { id: `approval:${approval.id}`, rowId: approval.id, reason: `${id} correction canary` };
}
async function brainReasons() {
  return (await retrieve.retrieveAll({ question: 'operator correction feedback', repoPath: repo }))
    .find(result => result.retriever === 'corrections')!.rows.map(row => row.fields.body);
}

describe('selective correction recall through operator routes and persisted consumers', () => {
  it('keeps an identical completion forgotten through recapture, reindex and restart, including fresh worker prompts', async () => {
    const { registerRuntime } = await import('@/lib/runtimes/registry');
    const { capturePacketCompletionContext } = await import('@/lib/orchestrator/context-relay');
    const outcomes = await import('@/app/api/cortex/recent-outcomes/route');
    const summary = 'recapturecanary durable parser outcome';
    const completedAt = new Date();
    const runtime: import('@/lib/runtimes/types').AgentRuntime = {
      id: 'codex', displayName: 'Fixture completion',
      capabilities: { discover: false, readTranscript: true, launch: false, resume: false,
        interrupt: false, reviewDiffs: true, costTelemetry: false, streaming: false },
      discoverSessions: async () => [], readTranscript: async () => [{ id: 'completion', role: 'assistant', text: summary, timestamp: completedAt }],
      getChangedFiles: async () => [], launch: async () => ({ ok: false, note: 'fixture' }),
      resume: async () => ({ ok: false, note: 'fixture' }), interrupt: async () => ({ ok: false, note: 'fixture' }),
    };
    const packetId = 'forget-recapture'; const sessionKey = 'codex:forget-recapture';
    lanes.createLane({ repoPath: repo, branch: 'fixture', runtime: 'codex', packetId });
    const capture = async () => {
      registerRuntime(runtime);
      await capturePacketCompletionContext(packetId, sessionKey);
      await new Promise<void>(resolve => setImmediate(resolve));
    };
    await capture();
    const selected = db.getSqlite().prepare('SELECT id, repo_path AS repoPath, project_id AS projectId FROM session_outcomes WHERE packet_id = ?').get(packetId) as { id: string; repoPath: string; projectId: string };
    expect(selected).toBeDefined();
    const learnings = await import('@/lib/orchestrator/attempt-log');
    await learnings.persistAttemptLearnings(repo, packetId, 1, { summary, filesChanged: [], sourceOutcomeId: selected.id });
    const dependent = { ...packet('dependent-after-forget'), dependencyPacketIds: [packetId] };
    expect(await prompt.buildPacketPrompt(dependent, [packet(packetId), dependent])).toContain(summary);
    expect(await prompt.buildPacketPrompt(packet('fresh-before-forget'), [])).toContain(summary);
    const inventory = () => outcomes.GET(new NextRequest('http://localhost/api/cortex/recent-outcomes?inventory=true&query=recapturecanary', { headers: { authorization: `Bearer ${operator}` } }));
    expect((await (await inventory()).json()).outcomes.map((row: { id: string }) => row.id)).toContain(selected.id);
    expect((await outcomes.DELETE(new NextRequest('http://localhost/api/cortex/recent-outcomes', { method: 'DELETE', body: JSON.stringify(selected) }))).status).toBe(200);
    // Auto-review re-pulls this exact transcript and therefore computes the same outcome ID.
    await capture();
    db.closeDb(); db.getSqlite();
    await capture();
    // Rebuild the outcome FTS mirror from the durable ledger after the reopen.
    db.getSqlite().exec("DELETE FROM outcomes_fts; INSERT INTO outcomes_fts(outcome_id, summary, plan_text) SELECT id, summary, COALESCE(plan_text, '') FROM session_outcomes");
    expect.soft((await (await inventory()).json()).outcomes).toEqual([]);
    expect.soft(db.getSqlite().prepare('SELECT id FROM session_outcomes WHERE id = ?').get(selected.id)).toBeUndefined();
    const retrieved = await retrieve.retrieveAll({ question: 'recapturecanary', repoPath: repo });
    expect.soft(JSON.stringify(retrieved.flatMap(result => result.rows))).not.toContain(summary);
    expect.soft(await prompt.buildPacketPrompt(packet('fresh-after-forget'), [])).not.toContain(summary);
    // A late learning writer also cannot launder the forgotten completion into a retry.
    await learnings.persistAttemptLearnings(repo, packetId, 2, { summary, filesChanged: [], sourceOutcomeId: selected.id });
    expect(await learnings.readPacketAttemptLearnings(packetId, repo)).toEqual([]);
    expect(await prompt.buildPacketPrompt(dependent, [packet(packetId), dependent])).not.toContain(summary);
    expect(await prompt.buildPacketPrompt(packet(packetId), [])).not.toContain(summary);
  });

  it('inspects and forgets a route-recorded rejection, invalidating recall while retaining its audit and neighbors after reopen', async () => {
    const removed = await rejection('remove-feedback'); const kept = await rejection('keep-feedback');
    expect(await brainReasons()).toContain(removed.reason);
    const relay = await import('@/lib/orchestrator/context-relay');
    await relay.recordPacketReviewContext('remove-feedback', { approved: false, findings: [{ file: 'parser.ts',
      severity: 'bug', description: removed.reason, resolution: 'deferred' }] });
    const dependent = { ...packet('correction-dependent'), dependencyPacketIds: ['remove-feedback'] };
    expect(await prompt.buildPacketPrompt(dependent, [packet('remove-feedback'), dependent])).toContain(removed.reason);
    expect(await prompt.buildPacketPrompt(packet('remove-feedback'), [])).toContain(removed.reason);
    await loadRoute();
    const listed = await (await route.GET(request())).json();
    expect(listed.corrections.map((c: { id: string }) => c.id)).toContain(removed.id);
    const rows = [{ citation: { kind: 'correction', rowId: removed.rowId, table: 'approvals' }, fields: { body: removed.reason } }] as import('@/lib/cortex/qa/types').TypedRow[];
    recall.seedRecallCacheForTests({ question: 'cached feedback', repoPath: repo, rows, vector: [1, 0] });
    recall.setRecallDependenciesForTests({ hasEmbedding: () => true, assertSpend: async () => {}, classify: async () => ({ class: 'A', bm25Variants: ['feedback'] }), retrieve: async () => [], embed: async () => [1, 0] });
    expect((await recall.recallRows('cached feedback', repo)).rows).toHaveLength(1);
    expect((await route.DELETE(request('DELETE', { id: removed.id }))).status).toBe(200);
    expect((await recall.recallRows('cached feedback', repo)).rows).toEqual([]);
    expect(approvals.getApproval(removed.rowId)?.resolution?.note).toBe(removed.reason);
    db.closeDb(); db.getSqlite();
    expect(await brainReasons()).not.toContain(removed.reason);
    expect(await prompt.buildPacketPrompt(dependent, [packet('remove-feedback'), dependent])).not.toContain(removed.reason);
    expect(await brainReasons()).toContain(kept.reason);
    expect(await prompt.buildPacketPrompt(packet('remove-feedback'), [])).not.toContain(removed.reason);
    expect((await (await route.GET(request())).json()).corrections.map((c: { id: string }) => c.id)).toEqual([kept.id]);
    expect((await route.DELETE(request('DELETE', { id: removed.id }))).status).toBe(404);
  });

  it('forgets one persisted steer without erasing its terminal audit or a neighboring steer', async () => {
    await loadRoute();
    const lane = lanes.createLane({ repoPath: repo, branch: 'fixture', runtime: 'codex', packetId: 'steer-packet' });
    const events = await import('@/lib/lane/events');
    const removed = events.recordLaneEvent(lane.id, 'steered_packet', 'orchestrator', { packetId: 'steer-packet', source: 'operator', message: 'remove steer canary' });
    const kept = events.recordLaneEvent(lane.id, 'steered_packet', 'orchestrator', { packetId: 'steer-packet', source: 'operator', message: 'keep steer canary' });
    expect(await prompt.buildPacketPrompt(packet('steer-packet'), [])).toContain('remove steer canary');
    expect((await route.DELETE(request('DELETE', { id: `steer:${removed.id}` }))).status).toBe(200);
    expect(await prompt.buildPacketPrompt(packet('steer-packet'), [])).not.toContain('remove steer canary');
    expect(await prompt.buildPacketPrompt(packet('steer-packet'), [])).toContain('keep steer canary');
    expect(lanes.getLaneEvents(lane.id, 10).map(e => e.id)).toEqual(expect.arrayContaining([removed.id, kept.id]));
    expect(await brainReasons()).not.toContain('remove steer canary');
  });

  it('paginates and searches the whole retained ledger, beyond the contextual retrieval scan and across repository scopes', async () => {
    await loadRoute();
    const lane = lanes.createLane({ repoPath: repo, branch: 'fixture', runtime: 'codex', packetId: 'history' });
    const events = await import('@/lib/lane/events');
    const oldest = events.recordLaneEvent(lane.id, 'steered_packet', 'orchestrator', { packetId: 'history', source: 'operator', message: 'old retained needle' });
    for (let index = 0; index < 205; index++) events.recordLaneEvent(lane.id, 'steered_packet', 'orchestrator', { source: 'operator', message: `newer correction ${index}` });
    const query = '?limit=50&repoPath=' + encodeURIComponent(repo);
    const first = await (await route.GET(request('GET', undefined, operator, query))).json();
    const second = await (await route.GET(request('GET', undefined, operator, query + '&offset=50'))).json();
    expect(first.corrections).toHaveLength(50); expect(first.hasMore).toBe(true);
    expect(second.corrections).toHaveLength(50);
    expect(new Set([...first.corrections, ...second.corrections].map(c => c.id)).size).toBe(100);
    const search = await (await route.GET(request('GET', undefined, operator, query + '&query=old%20retained'))).json();
    expect(search.corrections.map((c: { id: string }) => c.id)).toEqual([`steer:${oldest.id}`]);
    const foreign = await (await route.GET(request('GET', undefined, operator, '?repoPath=' + encodeURIComponent(join(root, 'other'))))).json();
    expect(foreign.corrections).toEqual([]);
  });

  it('refuses anonymous, worker and device reads/deletes at the handler and retains data on invalid selection', async () => {
    await loadRoute();
    const worker = (await import('@/lib/auth/worker-token')).getOrCreateLocalWorkerToken();
    for (const token of ['invalid', worker, device]) for (const method of ['GET', 'DELETE'] as const) {
      expect((await route[method](request(method, method === 'DELETE' ? { id: 'steer:missing' } : undefined, token))).status).toBe(403);
    }
    for (const id of ['../approval', 'unqualified', 'approval:']) expect((await route.DELETE(request('DELETE', { id }))).status).toBe(400);
    expect((await route.DELETE(request('DELETE', { id: 'approval:missing' }))).status).toBe(404);
  });

  it('rolls back the recall exclusion and revision if persistence fails', async () => {
    await loadRoute();
    const primed = await rejection('prime-forget-ledger');
    expect((await route.DELETE(request('DELETE', { id: primed.id }))).status).toBe(200);
    const selected = await rejection('rollback-feedback');
    const { readMemoryRevision } = await import('@/lib/cortex/memory-revision');
    const revision = readMemoryRevision();
    db.getSqlite().exec("CREATE TRIGGER refuse_correction_forget BEFORE INSERT ON forgotten_operator_corrections BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END");
    try {
      expect((await route.DELETE(request('DELETE', { id: selected.id }))).status).toBe(500);
      expect(await brainReasons()).toContain(selected.reason);
      expect(readMemoryRevision()).toBe(revision);
    } finally { db.getSqlite().exec('DROP TRIGGER refuse_correction_forget'); }
  });

  it('exposes older and expired outcomes in a bounded inventory and deletes with the listed project identity', async () => {
    const outcomes = await import('@/app/api/cortex/recent-outcomes/route');
    const insert = db.getSqlite().prepare(`INSERT INTO session_outcomes
      (id, project_id, repo_path, runtime, outcome, summary, started_at, completed_at)
      VALUES (?, ?, ?, 'codex', 'succeeded', ?, datetime('now'), datetime('now'))`);
    for (let index = 0; index < 55; index++) insert.run(`outcome-${index}`, 'prior-project', repo, `Retained history ${index}`);
    db.getSqlite().prepare("UPDATE session_outcomes SET valid_to = '2001-01-01T00:00:00Z' WHERE id = 'outcome-54'").run();
    const inventoryRequest = (query: string) => new NextRequest(`http://localhost/api/cortex/recent-outcomes?inventory=true${query}`, { headers: { authorization: `Bearer ${operator}` } });
    const firstResponse = await outcomes.GET(inventoryRequest('&limit=50'));
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json(); const second = await (await outcomes.GET(inventoryRequest('&offset=50&limit=50'))).json();
    expect(first.outcomes).toHaveLength(50); expect(first.hasMore).toBe(true); expect(second.outcomes).toHaveLength(5);
    expect(new Set([...first.outcomes, ...second.outcomes].map(row => row.id)).size).toBe(55);
    const recent = await (await outcomes.GET(new NextRequest(`http://localhost/api/cortex/recent-outcomes?repoPath=${encodeURIComponent(repo)}&projectId=prior-project`))).json();
    expect(recent.outcomes).toHaveLength(3);
    expect(recent.outcomes.map((row: { id: string }) => row.id)).not.toContain('outcome-54');
    expect((await (await outcomes.GET(inventoryRequest('&repoPath=' + encodeURIComponent(join(root, 'foreign'))))).json()).outcomes).toEqual([]);
    expect((await outcomes.GET(inventoryRequest('&limit=1000'))).status).toBe(400);
    const selected = (await (await outcomes.GET(inventoryRequest('&query=Retained%20history%2054'))).json()).outcomes[0];
    expect(selected).toMatchObject({ id: 'outcome-54', projectId: 'prior-project', repoPath: repo });
    const deleted = await outcomes.DELETE(new NextRequest('http://localhost/api/cortex/recent-outcomes', { method: 'DELETE',
      headers: { authorization: `Bearer ${operator}` }, body: JSON.stringify({ id: selected.id, repoPath: selected.repoPath, projectId: selected.projectId }) }));
    expect(deleted.status).toBe(200);
    expect(db.getSqlite().prepare('SELECT count(*) AS n FROM session_outcomes').get()).toEqual({ n: 54 });
    for (const token of ['invalid', (await import('@/lib/auth/worker-token')).getOrCreateLocalWorkerToken(), device]) {
      expect((await outcomes.GET(new NextRequest(inventoryRequest('').url, { headers: { authorization: `Bearer ${token}` } }))).status).toBe(403);
    }
  });

  it('can forget an explicitly selected legacy outcome without a project or repository binding', async () => {
    const outcomes = await import('@/app/api/cortex/recent-outcomes/route');
    db.getSqlite().prepare(`INSERT INTO session_outcomes (id, project_id, repo_path, runtime, outcome, summary, started_at, completed_at)
      VALUES ('legacy-unscoped', NULL, '', 'codex', 'succeeded', 'Legacy retained outcome', datetime('now'), datetime('now'))`).run();
    const listed = await outcomes.GET(new NextRequest('http://localhost/api/cortex/recent-outcomes?inventory=true&query=Legacy', { headers: { authorization: `Bearer ${operator}` } }));
    const selected = (await listed.json()).outcomes[0];
    expect(selected).toMatchObject({ id: 'legacy-unscoped', repoPath: '', projectId: null });
    expect((await outcomes.DELETE(new NextRequest('http://localhost/api/cortex/recent-outcomes', { method: 'DELETE', body: JSON.stringify({ id: selected.id, repoPath: selected.repoPath, projectId: selected.projectId }) }))).status).toBe(200);
    expect(db.getSqlite().prepare("SELECT id FROM session_outcomes WHERE id = 'legacy-unscoped'").get()).toBeUndefined();
  });
});
