import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';

const { readiness } = vi.hoisted(() => ({ readiness: vi.fn(async () => ({ ready: true })) }));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ assertRuntimeDispatchable: vi.fn(async () => {}) }));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: readiness }));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn() }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => true) }));
vi.mock('@/lib/skeleton/autoscan', () => ({ triggerScan: vi.fn(), triggerScanIfStale: vi.fn(), startChangePolling: vi.fn(), stopChangePolling: vi.fn() }));
vi.mock('@/lib/codex/service-tier-catalogue', () => ({ getCodexSpeedCatalogue: async () => ({ models: { 'gpt-5.6-terra': [] }, reasoningEfforts: { 'gpt-5.6-terra': ['low'] } }) }));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-review-author-')));
const data = join(root, 'data'); const repo = join(data, 'repo'); const bin = join(root, 'codex');
mkdirSync(join(data, 'chat-history'), { recursive: true }); mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
execFileSync('git', ['-C', repo, '-c', 'user.name=o8 test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
for (const [key, value] of Object.entries({ O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data,
  CORTEX_IDE_DB_PATH: join(data, 'cortex-ide.db'), CORTEX_IDE_OWNED_CODEX_ROOT: join(data, 'owned-codex'),
  O8_CODEX_BIN: bin, O8_CRASH_SURVIVABLE_WORKERS: '0', O8_WORKER_SANDBOX: '0' })) vi.stubEnv(key, value);
writeFileSync(bin, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('codex-cli 1.0.0'); process.exit(0); }
const emit = value => console.log(JSON.stringify({...value, timestamp: new Date().toISOString()}));
emit({type:'thread.started', thread_id:'fixture-worker'});
const finish = () => { emit({type:'item.completed', item:{id:'answer', type:'agent_message', text:'Corrected result'}}); emit({type:'turn.completed',usage:{input_tokens:0,output_tokens:0}}); };
const fs = require('node:fs');
const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(join(root, 'release-worker'))})) { clearInterval(timer); finish(); } }, 25);
`); chmodSync(bin, 0o755);
const parent = 'thoughts-correction-parent';
for (const thread of [parent, 'thoughts-other']) writeFileSync(join(data, 'chat-history', `${thread}.json`), JSON.stringify({ repoPath: repo, backend: 'codex', messages: [
  { id: 'user-origin', role: 'user', content: 'Delegate inspections.', timestamp: 1 },
  { id: 'assistant-origin', role: 'assistant', content: 'Starting workers.', backend: 'codex', model: 'gpt-5.6-terra', timestamp: 2,
    receipt: { leadModel: 'gpt-5.6-terra', effort: 'low', mode: 'multitask', pickedMode: 'fast', permissionMode: 'full' } },
] }));
const { POST: delegate } = await import('@/app/api/orchestrator/delegate/route');
const corrections = await import('@/app/api/orchestrator/worker-corrections/route');
const { fastDelegationCapability } = await import('@/lib/orchestrator/fast-delegation-auth');
const { holdWorkerCorrections } = await import('@/lib/orchestrator/worker-corrections');
const owned = await import('@/lib/codex/owned');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { closeDb } = await import('@/lib/db');
const surfaces: string[] = [];
function record(surface: string): OwnedSessionRecord {
  return JSON.parse(readFileSync(join(data, 'owned-codex', surface.slice('codex-owned:'.length), 'session.json'), 'utf8'));
}
function request(body: unknown, token = getOrCreateWsToken()) {
  return new NextRequest('http://localhost/api/orchestrator/worker-corrections', { method: 'POST',
    headers: { host: 'localhost', authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function launch(id: string, running = false) {
  rmSync(join(root, 'release-worker'), { force: true });
  const response = await delegate(new NextRequest('http://localhost/api/orchestrator/delegate', { method: 'POST', body: JSON.stringify({
    prompt: running ? 'KEEP_RUNNING' : `Inspect ${id}`, repoPath: repo, taskName: id, runtime: 'codex', model: 'gpt-5.6-terra', requestedEffort: 'low',
    checkoutMode: 'shared', parentThreadId: parent, fastCapability: fastDelegationCapability(repo, parent), assignedPaths: [`src/${id}`], readOnly: false, clientMutationId: id,
  }) }));
  const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(200);
  surfaces.push(body.surfaceId);
  writeFileSync(join(root, 'release-worker'), 'release');
  await vi.waitFor(async () => { await owned.getOwnedCodexFleetAdditions({ fresh: true }); expect(record(body.surfaceId).threadId).toBeTruthy();
    if (!running) expect(record(body.surfaceId).activeRun).toBeUndefined(); }, { timeout: 15000, interval: 80 });
  const session = record(body.surfaceId); return { surfaceId: body.surfaceId, runId: (session.activeRun ?? session.recentRuns[0]).id };
}
beforeAll(async () => {
  const { addRepo } = await import('@/lib/repos/registry'); await addRepo(repo);
  const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
  await updateOperatorDefaults({ workerRuntimes: ['codex'], defaultDispatchRuntime: 'codex' });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
});
afterAll(async () => {
  for (const surface of surfaces) if (existsSync(join(data, 'owned-codex', surface.slice('codex-owned:'.length), 'session.json')) && record(surface).activeRun) await owned.interruptOwnedCodexSession(surface);
  const timer = (globalThis as unknown as Record<symbol, NodeJS.Timeout | undefined>)[Symbol.for('o8.ownedSession.refreshTimer.codex')];
  if (timer) clearInterval(timer);
  closeDb(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true });
});

const { POST: submitReview } = await import('@/app/api/orchestrator/review/route');
const { createLane, updateLane, listLanes } = await import('@/lib/lane/registry');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const control = await import('@/lib/orchestrator/control-plane');
const { getSqlite } = await import('@/lib/db');
let packetId = 'pkt-review-author';
const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
let reviewSequence = 0;
async function reviewedAuthor(name: string) {
  packetId = `pkt-${name}`;
  for (const lane of listLanes().filter(lane => lane.packetId === packetId)) updateLane(lane.id, { packetId: '' });
  const target = await launch(name);
  const lane = createLane({ repoPath: repo, branch: 'main', runtime: 'codex', packetId, ownership: 'managed' });
  updateLane(lane.id, { sessionKey: target.surfaceId, status: 'reviewing' });
  control.writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'review-author-fixture', repoPath: repo,
    packets: [{ id: packetId, referenceLabel: 'REVIEW', title: 'Repair fixture', summary: 'Repair fixture', runtime: 'codex',
      status: 'awaiting_review', queueState: 'queued', releaseState: 'pending', wave: 1, dependencyPacketIds: [], dependencyLabels: [],
      blockedReason: null, lane: null, review: null, workspaceTargetPath: repo, branchTarget: 'main',
      orchestratorThreadId: parent, launchContext: { source: 'desktop', presentation: 'tab', repoContext: 'registered', workMode: 'edit' },
    } as never] });
  const review = await saveReview();
  return { target, review, lane };
}
async function saveReview() {
  const res = await submitReview(new NextRequest('http://localhost/api/orchestrator/review', { method: 'POST',
    headers: { host: 'localhost', authorization: `Bearer ${getOrCreateWsToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ packetId, approved: false, reviewedHeadSha: head, clientMutationId: `finding-${++reviewSequence}`,
      findings: [{ file: 'README.md', severity: 'bug', description: `Preserve the original request ${reviewSequence}.`, status: 'deferred', fixSuggestion: 'Keep the original request in the response.' }] }),
  }));
  const value = await res.json(); expect(res.status, JSON.stringify(value)).toBe(200);
  return control.readOrchestratorControlPlaneState().packets.find(p => p.id === packetId)!.review!;
}
function reviewBody(target: {surfaceId: string; runId: string}, review: {auditApprovalId?: string | null}) {
  return { repoPath: repo, threadId: parent, review: { packetId, approvalId: review.auditApprovalId, reviewedHeadSha: head, ...target } };
}
async function settled(surface: string) {
  await vi.waitFor(async () => { await owned.getOwnedCodexFleetAdditions({ fresh: true }); expect(record(surface).activeRun).toBeUndefined(); }, { timeout: 15000, interval: 80 });
}

it('delivers the persisted finding once through the correction route, preserving the worker and unresolved review', async () => {
  const { target, review } = await reviewedAuthor('review-author');
  const before = record(target.surfaceId);
  const body = reviewBody(target, review);
  const [response, duplicate] = await Promise.all([corrections.POST(request(body)), corrections.POST(request(body))]); const value = await response.json();
  expect((await duplicate.json()).receipt.id).toBe(value.receipt.id);
  expect(response.status, JSON.stringify(value)).toBe(200);
  expect(value.receipt.deliveries[0].status).toBe('delivered');
  await settled(target.surfaceId);
  const after = record(target.surfaceId);
  expect(after).toMatchObject({ repoPath: before.repoPath, model: before.model, threadId: before.threadId });
  expect(after.recentRuns[0].prompt).toContain(review.auditApprovalId);
  expect(after.recentRuns[0].prompt).toContain('Preserve the original request');
  expect(after.recentRuns[0].prompt).toContain('Independent verification');
  expect(control.readOrchestratorControlPlaneState().packets[0].review?.approved).toBe(false);
  const count = after.recentRuns.length;
  closeDb();
  expect((await corrections.POST(request(body))).status).toBe(200);
  expect(record(target.surfaceId).recentRuns).toHaveLength(count);
  expect(getSqlite().prepare('SELECT COUNT(*) AS n FROM worker_corrections').get()).toEqual({ n: 1 });
  const history = await corrections.GET(new NextRequest(`http://localhost/api/orchestrator/worker-corrections?${new URLSearchParams({ repoPath: repo, threadId: parent })}`, { headers: { host: 'localhost', authorization: `Bearer ${getOrCreateWsToken()}` } }));
  expect((await history.json()).corrections[0].id).toBe(value.receipt.id);
}, 60000);

it('refuses stale code, another parent, a replaced run, and an operator stop without sending', async () => {
  const { target, review } = await reviewedAuthor('refusals');
  const body = reviewBody(target, review);
  expect((await corrections.POST(request({ ...body, threadId: 'thoughts-other' }))).status).toBe(409);
  expect((await corrections.POST(request({ ...body, review: { ...body.review, runId: 'replaced' } }))).status).toBe(409);
  expect((await corrections.POST(request(body, 'not-operator'))).status).toBe(403);
  execFileSync('git', ['-C', repo, '-c', 'user.name=o8 test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'moved']);
  expect((await corrections.POST(request(body))).status).toBe(409);
  execFileSync('git', ['-C', repo, 'checkout', '-B', 'main', head]);
  await control.withLockedState(state => { state.packets[0].operatorStopped = true; });
  expect((await corrections.POST(request(body))).status).toBe(409);
  expect(record(target.surfaceId).recentRuns).toHaveLength(1);
}, 60000);

it('counts earlier repair attempts and all delivered review rounds toward the two-round budget', async () => {
  const { target, review } = await reviewedAuthor('budget');
  await control.withLockedState(state => { state.packets[0].attemptCount = 1; });
  const first = await corrections.POST(request(reviewBody(target, review)));
  expect(first.status, JSON.stringify(await first.clone().json())).toBe(200);
  await settled(target.surfaceId);
  const session = record(target.surfaceId);
  const nextTarget = { surfaceId: target.surfaceId, runId: session.recentRuns[0].id };
  const nextReview = await saveReview();
  const second = await corrections.POST(request(reviewBody(nextTarget, nextReview)));
  expect(second.status).toBe(409);
  expect((await second.json()).error).toContain('budget');
  expect(record(target.surfaceId).recentRuns).toHaveLength(2);
}, 60000);

it('keeps an interrupted admission inspectable and never sends it again after restart', async () => {
  const { target, review } = await reviewedAuthor('interrupted');
  let release!: () => void;
  readiness.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { ready: true }; });
  const body = reviewBody(target, review);
  const pending = corrections.POST(request(body));
  await vi.waitFor(() => expect(release).toBeTypeOf('function'), { timeout: 15000 });
  holdWorkerCorrections({ repoPath: repo, threadId: parent }); release();
  const value = await (await pending).json();
  expect(value.receipt.deliveries[0].status).toBe('held');
  closeDb();
  const replay = await (await corrections.POST(request(body))).json();
  expect(replay.receipt.id).toBe(value.receipt.id);
  expect(replay.receipt.deliveries[0].status).toBe('held');
  expect(record(target.surfaceId).recentRuns).toHaveLength(1);
}, 60000);

it('refuses uncommitted code and an obsolete saved review without altering either finding', async () => {
  const { target, review } = await reviewedAuthor('stale-review');
  writeFileSync(join(repo, 'README.md'), 'unreviewed change');
  const dirty = await corrections.POST(request(reviewBody(target, review)));
  expect(dirty.status).toBe(409);
  expect((await dirty.json()).error).toContain('uncommitted');
  rmSync(join(repo, 'README.md'));
  const newer = await saveReview();
  const obsolete = await corrections.POST(request(reviewBody(target, review)));
  expect(obsolete.status).toBe(409);
  expect((await obsolete.json()).error).toContain('rejection changed');
  expect(control.readOrchestratorControlPlaneState().packets[0].review?.auditApprovalId).toBe(newer.auditApprovalId);
  expect(record(target.surfaceId).recentRuns).toHaveLength(1);
}, 60000);

it('routes the saved review through the published MCP correction tool without a manual feedback message', async () => {
  const { target, review } = await reviewedAuthor('mcp-review');
  const { CORTEX_WORKER_TOOLS } = await import('@/lib/mcp/cortex-worker-tools');
  const schema = CORTEX_WORKER_TOOLS.find(tool => tool.name === 'cortex_correct_workers');
  expect(schema?.inputSchema.properties).toHaveProperty('reviewSource');
  const { createCortexDelegationHandlers } = await import('@/lib/mcp/cortex-delegation-handlers');
  const handlers = createCortexDelegationHandlers({ repoPath: repo, parentThreadId: parent, apiBase: 'http://localhost', wsToken: getOrCreateWsToken(), fastCapability: '',
    apiFetch: async (path, options) => {
      expect(path).toBe('/api/orchestrator/worker-corrections');
      const response = await corrections.POST(request(JSON.parse(String(options?.body))));
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
      return response.json();
    } });
  const result = await handlers.handleCorrectWorkers({ targets: [target], reviewSource: {
    packetId, approvalId: review.auditApprovalId, reviewedHeadSha: head,
  } });
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(result.content[0].text).receipt.deliveries[0].status).toBe('delivered');
  await settled(target.surfaceId);
  expect(record(target.surfaceId).recentRuns[0].prompt).toContain(review.auditApprovalId);
}, 60000);

it('retains an unknown receipt when code changes during admission and never retries it as a new turn', async () => {
  const { target, review } = await reviewedAuthor('code-during-admission');
  let release!: () => void;
  readiness.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { ready: true }; });
  const body = reviewBody(target, review);
  const pending = corrections.POST(request(body));
  await vi.waitFor(() => expect(release).toBeTypeOf('function'), { timeout: 15000 });
  writeFileSync(join(repo, 'README.md'), 'changed during admission'); release();
  const value = await (await pending).json();
  expect(value.receipt.deliveries[0].status).toBe('unknown');
  expect(value.receipt.deliveries[0].note).toContain('uncommitted');
  rmSync(join(repo, 'README.md'));
  const replay = await (await corrections.POST(request(body))).json();
  expect(replay.receipt.id).toBe(value.receipt.id);
  expect(replay.receipt.deliveries[0].status).toBe('unknown');
  expect(record(target.surfaceId).recentRuns).toHaveLength(1);
}, 60000);
