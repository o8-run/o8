import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';

const { readiness } = vi.hoisted(() => ({ readiness: vi.fn(async () => ({ ready: true })) }));
const reviewer = vi.hoisted(() => ({ prompts: [] as string[], sessions: [] as string[],
  beforeVerdict: null as (() => void) | null, approve: true }));
vi.mock('@/lib/lane/orchestrator-backends/registry', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/lane/orchestrator-backends/registry')>();
  const backend = {
    id: 'codex' as const, label: 'Fixture independent reviewer',
    peekSession: () => ({ sessionName: 'correction-reviewer', status: 'ready' as const }),
    ensureSession: () => ({ sessionName: 'correction-reviewer', status: 'ready' as const }),
    async sendTurn(_repo: string, prompt: string, onEvent: (event: { type: 'text'; text: string }) => void,
      options?: { threadId?: string | null }) {
      reviewer.prompts.push(prompt); reviewer.sessions.push(options?.threadId ?? '');
      reviewer.beforeVerdict?.();
      onEvent({ type: 'text', text: reviewer.approve ? 'CODEX_AUTO_REVIEW: {"approved":true,"findings":[]}'
        : 'CODEX_AUTO_REVIEW: {"approved":false,"findings":[{"file":"answer.txt","severity":"note","description":"The saved finding is still unresolved.","status":"deferred"}]}' });
    },
  };
  return { ...actual, getActiveReviewerBackend: () => backend, getOrchestratorBackend: () => backend };
});
vi.mock('@/lib/lane/packet-explainer-queue', () => ({ drainPacketExplainerQueue: vi.fn(async () => {}),
  enqueuePacketExplainer: vi.fn(async () => {}), notifyCorrectnessReviewQueued: vi.fn(), startPacketExplainerQueueDrain: vi.fn(() => () => {}) }));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ assertRuntimeDispatchable: vi.fn(async () => {}) }));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: readiness }));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn() }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => true) }));
// Keep dashboard discovery and quota polling inside the fixture boundary.
// Inventory still comes from the real owned-session store, including process
// observation; unrelated installed providers must not write lifecycle state.
vi.mock('@/lib/runtime/inventory', () => ({
  invalidateRuntimeInventoryCache: vi.fn(),
  getRuntimeInventorySnapshot: vi.fn(async (options: { fresh?: boolean } = {}) => {
    const { getOwnedCodexFleetAdditions } = await import('@/lib/codex/owned');
    const { agents, squads, events, artifacts } = await getOwnedCodexFleetAdditions(options);
    return { agents, squads, events, artifacts, generatedAt: new Date().toISOString(),
      meta: { mode: 'live', sourceLabel: 'Isolated test', mirrorMode: 'current-session-first', gatewayFreshness: 'fresh' } };
  }),
}));
vi.mock('@/lib/orchestrator/capacity-snapshots', () => ({ capturePacketCapacitySnapshot: vi.fn(async () => {}) }));
vi.mock('@/lib/skeleton/autoscan', () => ({ triggerScan: vi.fn(), triggerScanIfStale: vi.fn(), startChangePolling: vi.fn(), stopChangePolling: vi.fn() }));
vi.mock('@/lib/codex/service-tier-catalogue', () => ({ getCodexSpeedCatalogue: async () => ({ models: { 'gpt-5.6-terra': [] }, reasoningEfforts: { 'gpt-5.6-terra': ['low'] } }) }));
const sourceCheckout = process.cwd();
const sourceHead = execFileSync('git', ['-C', sourceCheckout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-review-author-')));
const data = join(root, 'data'); const repo = join(data, 'repo'); const bin = join(root, 'codex');
const bundledCliDir = join(root, 'cli');
// Build the real CLI once, as the packaged launch path does. Every author turn
// still copies and verifies it; repeated source builds must not serialize
// inside the runtime artifact lock while this handoff test is running.
execFileSync(process.execPath, [join(sourceCheckout, 'cli/esbuild.config.mjs'),
  '--worker-output', join(bundledCliDir, 'bin/o8.mjs')], {
  cwd: sourceCheckout, stdio: 'pipe', timeout: 30000, env: { PATH: process.env.PATH, NODE_ENV: 'test' },
});
mkdirSync(join(data, 'chat-history'), { recursive: true }); mkdirSync(repo);
// Telemetry resolves rollout paths independently of runtime inventory. Keep
// that lookup out of the developer's installed provider history as well.
mkdirSync(join(root, 'codex-home'));
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
execFileSync('git', ['-C', repo, '-c', 'user.name=o8 test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
for (const [key, value] of Object.entries({ O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data,
  CORTEX_IDE_DB_PATH: join(data, 'cortex-ide.db'), CORTEX_IDE_OWNED_CODEX_ROOT: join(data, 'owned-codex'),
  O8_CODEX_BIN: bin, O8_CRASH_SURVIVABLE_WORKERS: '0', O8_WORKER_SANDBOX: '0',
  O8_PACKAGED_APP: '0', O8_BUNDLED_MCP_DIR: bundledCliDir,
  CODEX_HOME: join(root, 'codex-home') })) vi.stubEnv(key, value);
writeFileSync(bin, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('codex-cli 1.0.0'); process.exit(0); }
if (!process.argv.includes('exec')) process.exit(0);
const fs = require('node:fs');
const cwd = fs.realpathSync(process.cwd());
if (cwd !== ${JSON.stringify(repo)} && !cwd.startsWith(${JSON.stringify(join(data, 'worktrees') + '/')})) {
 console.error('Fixture worker refused an unowned checkout'); process.exit(1);
}
const emit = value => console.log(JSON.stringify({...value, timestamp: new Date().toISOString()}));
emit({type:'thread.started', thread_id:'fixture-worker'});
const finish = () => {
if (cwd !== ${JSON.stringify(repo)}) {
 const {execFileSync} = require('node:child_process');
 require('node:fs').writeFileSync('answer.txt', 'fixture result');
 execFileSync('git', ['add', '--', 'answer.txt']);
 execFileSync('git', ['-c', 'user.name=o8 test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture author']);
}
emit({type:'item.completed', item:{id:'answer', type:'agent_message', text:'Corrected result'}}); emit({type:'turn.completed',usage:{input_tokens:0,output_tokens:0}}); };
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
// This fixture refreshes owned state explicitly. Stop background scans before
// any worker starts so none can outlive teardown and read the removed root.
const refreshTimer = (globalThis as unknown as Record<symbol, NodeJS.Timeout | undefined>)[Symbol.for('o8.ownedSession.refreshTimer.codex')];
if (refreshTimer) clearInterval(refreshTimer);
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
  closeDb(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true });
  expect(execFileSync('git', ['-C', sourceCheckout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(sourceHead);
});

const { POST: submitReview } = await import('@/app/api/orchestrator/review/route');
const { createLane, updateLane, listLanes } = await import('@/lib/lane/registry');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const control = await import('@/lib/orchestrator/control-plane');
const { getSqlite } = await import('@/lib/db');
// Load the real review modules before timing handoff execution, rather than
// charging first-use Vite transformation to the first packet's runtime bound.
const autoReview = await import('@/app/api/review/auto-review/route');
const { drainReviewQueue } = await import('@/lib/lane/auto-review');
const { capturePacketCompletionContext } = await import('@/lib/orchestrator/context-relay');
const { transitionPostCompletionLaneToReviewing } = await import('@/lib/supervisor/post-completion-packet');
let packetId = 'pkt-review-author';
const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
let reviewSequence = 0;
async function reviewedAuthor(name: string, description?: string) {
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
  const review = await saveReview(description);
  return { target, review, lane };
}
async function saveReview(description?: string) {
  const res = await submitReview(new NextRequest('http://localhost/api/orchestrator/review', { method: 'POST',
    headers: { host: 'localhost', authorization: `Bearer ${getOrCreateWsToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ packetId, approved: false, reviewedHeadSha: head, clientMutationId: `finding-${++reviewSequence}`,
      findings: [{ file: 'README.md', severity: 'bug', description: description ?? `Preserve the original request ${reviewSequence}.`, status: 'deferred', fixSuggestion: 'Keep the original request in the response.' }] }),
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

it('checks the reviewed code outside SQLite write transactions at admission and delivery', async () => {
  const { target, review } = await reviewedAuthor('git-without-write-lock');
  const laneGit = await import('@/lib/lane/lane-git');
  const original = laneGit.laneGitSync;
  const checked: string[] = [];
  const spy = vi.spyOn(laneGit, 'laneGitSync').mockImplementation((...args) => {
    if (args[0] === repo && ['rev-parse', 'status'].includes(args[2][0])) {
      checked.push(args[2][0]);
      expect(getSqlite().inTransaction, `Git ${args[2].join(' ')} held the SQLite transaction`).toBe(false);
    }
    return original(...args);
  });
  try {
    const response = await corrections.POST(request(reviewBody(target, review)));
    const value = await response.json();
    expect(response.status, JSON.stringify(value)).toBe(200);
    expect(value.receipt.deliveries[0].status).toBe('delivered');
    await settled(target.surfaceId);
    expect(checked.filter(command => command === 'rev-parse').length).toBeGreaterThanOrEqual(2);
    expect(checked.filter(command => command === 'status').length).toBeGreaterThanOrEqual(2);
  } finally { spy.mockRestore(); }
}, 60000);

it.each(['busy', 'stopped', 'moved-before-queue', 'dirty', 'moved', 'review-moved', 'reclaimed', 'stopped-after', 'interrupted', 'rejected', 'hold-retry', 'provider-retry', 'review-artifact', 'manual-after-saved', 'delivered'] as const)('hands a persisted rejection to a real isolated packet-bound author: %s', async outcome => {
  const deliveryExpected = outcome !== 'busy' && outcome !== 'stopped';
  rmSync(join(root, 'release-worker'), { force: true });
  const response = await delegate(new NextRequest('http://localhost/api/orchestrator/delegate', { method: 'POST',
    body: JSON.stringify({ prompt: 'Inspect the original request', repoPath: repo, taskName: `packet-bound-author-${outcome}`,
      runtime: 'codex', model: 'gpt-5.6-terra', requestedEffort: 'low', checkoutMode: 'isolated',
      parentThreadId: parent, clientMutationId: `isolated-review-author-5832-${outcome}` }) }));
  const launched = await response.json();
  expect(response.status, JSON.stringify(launched)).toBe(200);
  surfaces.push(launched.surfaceId);
  writeFileSync(join(root, 'release-worker'), 'release');
  await vi.waitFor(async () => {
    await owned.getOwnedCodexFleetAdditions({ fresh: true });
    expect(record(launched.surfaceId).activeRun).toBeUndefined();
  }, { timeout: 15000, interval: 80 });
  expect(record(launched.surfaceId).packetId).toBe(launched.packetId);
  const { dispatch } = await import('@/lib/lane/commands');
  const requested = await dispatch({ verb: 'request_review', laneId: launched.laneId, actor: 'system' });
  expect(requested.ok, JSON.stringify(requested)).toBe(true);
  packetId = launched.packetId;
  const packetHead = execFileSync('git', ['-C', launched.worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const saved = await submitReview(new NextRequest('http://localhost/api/orchestrator/review', { method: 'POST',
    headers: { host: 'localhost', authorization: `Bearer ${getOrCreateWsToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ packetId, approved: false, reviewedHeadSha: packetHead, clientMutationId: `packet-bound-rejection-${outcome}`,
      findings: [{ file: 'answer.txt', severity: 'note', description: 'Preserve the original request.', status: 'deferred' }] }) }));
  expect(saved.status, JSON.stringify(await saved.clone().json())).toBe(200);
  expect(control.readOrchestratorControlPlaneState().packets.find(p => p.id === packetId)?.status).toBe('awaiting_review');
  const review = control.readOrchestratorControlPlaneState().packets.find(p => p.id === packetId)!.review!;
  const target = { surfaceId: launched.surfaceId, runId: record(launched.surfaceId).recentRuns[0].id };
  const { readOwnedRecoveryState } = await import('@/lib/runtimes/shared/owned-session/automatic-recovery');
  expect(await readOwnedRecoveryState(target.surfaceId)).toMatchObject({
    automaticRecoveryAllowed: false, operatorCorrectionAllowed: true,
  });
  const { createCortexDelegationHandlers } = await import('@/lib/mcp/cortex-delegation-handlers');
  const { apiError } = await import('@/lib/mcp/api-error');
  const handlers = createCortexDelegationHandlers({ repoPath: repo, parentThreadId: parent, apiBase: 'http://localhost',
    wsToken: getOrCreateWsToken(), fastCapability: '', apiFetch: async (path, options) => {
      const result = options?.method === 'POST'
        ? await corrections.POST(request(JSON.parse(String(options.body))))
        : await corrections.GET(new NextRequest(`http://localhost${path}`, { headers: { authorization: `Bearer ${getOrCreateWsToken()}` } }));
      const value = await result.json();
      if (!result.ok) throw apiError(path, result.status, JSON.stringify(value));
      return value;
    } });
  const snapshot = JSON.parse((await handlers.handleCorrectWorkers({})).content[0].text);
  expect(snapshot.workers).toEqual(expect.arrayContaining([expect.objectContaining(target)]));
  const args = { targets: [target], reviewSource: { packetId, approvalId: review.auditApprovalId, reviewedHeadSha: packetHead } };
  expect(execFileSync('git', ['-C', launched.worktreePath, 'status', '--porcelain'], { encoding: 'utf8' }).trim(),
    'The author checkout must be clean before testing the intentional dirty-code refusal.').toBe('');
  const dirtyPath = join(launched.worktreePath, 'unreviewed.txt');
  writeFileSync(dirtyPath, 'unreviewed');
  const dirty = await handlers.handleCorrectWorkers(args);
  expect(dirty.isError).toBe(true);
  expect(dirty.content[0].text).toContain('uncommitted');
  expect(record(target.surfaceId).recentRuns).toHaveLength(1);
  rmSync(dirtyPath);
  if (outcome === 'busy') readiness.mockRejectedValueOnce(new Error('This worker still has an active run.'));
  if (outcome === 'interrupted') rmSync(join(root, 'release-worker'));
  let release!: () => void;
  let entered!: () => void;
  const atReadiness = new Promise<void>(resolve => { entered = resolve; });
  if (outcome === 'stopped') readiness.mockImplementationOnce(async () => {
    const held = new Promise<void>(resolve => { release = resolve; });
    entered(); await held; return { ready: true };
  });
  const pending = handlers.handleCorrectWorkers(args);
  if (outcome === 'stopped') {
    await Promise.race([atReadiness, pending.then(result => {
      throw new Error(`Correction returned before the readiness barrier: ${JSON.stringify(result)}`);
    })]);
    holdWorkerCorrections({ repoPath: repo, threadId: parent }); release();
  }
  const result = await pending;
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const value = JSON.parse(result.content[0].text);
  expect(value.receipt.deliveries[0].status).toBe(deliveryExpected ? 'delivered' : outcome === 'stopped' ? 'held' : 'unknown');
  if (outcome === 'interrupted') await owned.interruptOwnedCodexSession(target.surfaceId);
  await settled(target.surfaceId);
  const { drainQueuedPacketSteers } = await import('@/lib/orchestrator/operator-mission-service/steer-queue');
  await drainQueuedPacketSteers();
  const replay = JSON.parse((await handlers.handleCorrectWorkers(args)).content[0].text);
  expect(replay.receipt.id).toBe(value.receipt.id);
  expect(record(target.surfaceId).recentRuns).toHaveLength(deliveryExpected ? 2 : 1);
  if (deliveryExpected) expect(record(target.surfaceId).recentRuns[0].prompt).toContain(review.auditApprovalId);
  expect(control.readOrchestratorControlPlaneState().packets.find(p => p.id === packetId)?.review).toMatchObject({ approved: false,
    findings: [expect.objectContaining({ resolution: 'deferred' })] });
  expect((await readOwnedRecoveryState(target.surfaceId)).automaticRecoveryAllowed).toBe(false);
  if (deliveryExpected) {
    // Use the same production entry as the supervisor's completion callback.
    // Retire earlier fixture reviews so this drain only consumes this packet.
    getSqlite().prepare("UPDATE review_queue SET status = 'completed' WHERE lane_id != ?").run(launched.laneId);
    const enqueue = () => autoReview.POST(new NextRequest('http://localhost/api/review/auto-review', {
      method: 'POST', headers: { host: 'localhost', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'enqueue', laneId: launched.laneId }),
    }));
    const correctedHead = execFileSync('git', ['-C', launched.worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (outcome !== 'interrupted') expect(correctedHead).not.toBe(packetHead);
    transitionPostCompletionLaneToReviewing(launched.laneId, packetId);
    if (outcome !== 'interrupted') {
      await capturePacketCompletionContext(packetId, target.surfaceId);
    }
    const moveHead = () => execFileSync('git', ['-C', launched.worktreePath, '-c', 'user.name=o8 test',
      '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'unreviewed successor']);
    if (outcome === 'moved-before-queue') moveHead();
    if (outcome === 'dirty') writeFileSync(join(launched.worktreePath, 'unreviewed.txt'), 'unreviewed edit');
    if (outcome === 'hold-retry') {
      expect((await enqueue()).status).toBe(200);
      writeFileSync(join(launched.worktreePath, 'review-blocker.txt'), 'inspect before retry');
    }
    if (outcome === 'moved') {
      // Bind the completed correction, then move its code before reviewer entry.
      expect((await enqueue()).status).toBe(200); moveHead();
    }
    if (outcome === 'stopped-after') {
      const { POST: stop } = await import('@/app/api/orchestrator/stop-packet/route');
      const stopped = await stop(new NextRequest('http://localhost/api/orchestrator/stop-packet', { method: 'POST',
        headers: { host: 'localhost', authorization: `Bearer ${getOrCreateWsToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ packetId }) }));
      expect(stopped.status).toBe(200);
    }
    // Lose the completion HTTP acknowledgement, then restart. The persisted
    // correction source must still cause one independent review on the drain.
    if (outcome === 'delivered') closeDb();
    reviewer.prompts.length = 0; reviewer.sessions.length = 0;
    reviewer.beforeVerdict = outcome === 'review-moved' ? moveHead : outcome === 'reclaimed' ? () => {
      getSqlite().prepare("UPDATE review_queue SET claim_owner = 'replacement-owner' WHERE lane_id = ? AND status = 'in_progress'").run(launched.laneId);
    } : outcome === 'review-artifact' ? () => writeFileSync(join(launched.worktreePath, 'test-output.txt'), 'reviewer test output')
      : outcome === 'provider-retry' ? () => { throw new Error('Fixture reviewer temporarily unavailable'); } : null;
    reviewer.approve = outcome !== 'rejected';
    await drainReviewQueue();
    if (outcome === 'provider-retry') for (let round = 1; round < 5; round++) await drainReviewQueue();
    reviewer.beforeVerdict = null;
    if (outcome === 'hold-retry' || outcome === 'provider-retry') {
      const failed = getSqlite().prepare('SELECT id, status FROM review_queue WHERE lane_id = ? ORDER BY rowid DESC LIMIT 1')
        .get(launched.laneId) as { id: string; status: string };
      expect(failed.status).toBe('failed');
      if (outcome === 'hold-retry') rmSync(join(launched.worktreePath, 'review-blocker.txt'));
      const retry = await dispatch({ verb: 'request_review', laneId: launched.laneId, actor: 'user' });
      expect(retry.ok, JSON.stringify(retry)).toBe(true);
      const linked = getSqlite().prepare('SELECT review_id FROM correction_reviews WHERE correction_id = ?')
        .get(value.receipt.id) as { review_id: string };
      expect(linked.review_id).not.toBe(failed.id);
      expect((await enqueue()).status).toBe(200);
      reviewer.prompts.length = 0; reviewer.sessions.length = 0;
      await drainReviewQueue();
      expect(record(target.surfaceId).recentRuns).toHaveLength(2);
    }
    const { getApproval, listApprovalsForContext } = await import('@/lib/approvals/store');
    if (['moved-before-queue', 'dirty', 'moved', 'stopped-after', 'interrupted', 'review-moved', 'reclaimed'].includes(outcome)) {
      expect(reviewer.prompts).toHaveLength(['review-moved', 'reclaimed'].includes(outcome) ? 1 : 0);
      expect(listApprovalsForContext({ packetId }).filter(row => row.status === 'approved' && row.toolName === 'orchestrator_review')).toHaveLength(0);
      expect(getApproval(review.auditApprovalId!)?.status).toBe('rejected');
      return;
    }
    expect(reviewer.prompts).toHaveLength(1);
    expect(reviewer.prompts[0]).toContain(`Saved rejection: ${review.auditApprovalId}`);
    expect(reviewer.prompts[0]).toContain('Preserve the original request.');
    expect(reviewer.prompts[0]).toContain(`Corrected HEAD: ${correctedHead}`);
    expect(reviewer.sessions[0]).toMatch(/^thoughts-auto-review-primary-/);
    expect(reviewer.sessions[0]).not.toBe(record(target.surfaceId).threadId);
    expect((await enqueue()).status).toBe(200);
    if (outcome === 'delivered') closeDb();
    expect((await enqueue()).status).toBe(200);
    await drainReviewQueue();
    expect(reviewer.prompts).toHaveLength(1);
    expect(getApproval(review.auditApprovalId!)?.status).toBe('rejected');
    if (outcome === 'rejected') {
      const rejected = listApprovalsForContext({ packetId }).filter(row => row.status === 'rejected' && row.args?.reviewedHeadSha === correctedHead);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].args?.findings).toEqual([expect.objectContaining({ resolution: 'deferred' })]);
      const next = await handlers.handleCorrectWorkers({ targets: [{ surfaceId: target.surfaceId,
        runId: record(target.surfaceId).recentRuns[0].id }], reviewSource: { packetId,
        approvalId: rejected[0].id, reviewedHeadSha: correctedHead } });
      // Initial packet admission and this correction have spent the existing
      // budget. Re-review must not reset it or send another author turn.
      expect(next.isError).toBe(true);
      expect(next.content[0].text).toContain('budget');
      expect(record(target.surfaceId).recentRuns).toHaveLength(2);
      return;
    }
    const approved = listApprovalsForContext({ packetId }).filter(row => row.status === 'approved' && row.toolName === 'orchestrator_review');
    expect(approved).toHaveLength(1);
    expect(approved[0].args?.reviewedHeadSha).toBe(correctedHead);
    if (outcome === 'review-artifact') expect(readFileSync(join(launched.worktreePath, 'test-output.txt'), 'utf8')).toBe('reviewer test output');
    if (outcome === 'manual-after-saved') {
      const manual = await handlers.handleCorrectWorkers({ targets: [{ surfaceId: target.surfaceId,
        runId: record(target.surfaceId).recentRuns[0].id }], message: 'Make one more scoped correction.', mode: 'send', holdMerges: false,
        idempotencyKey: 'manual-after-saved-round' });
      expect(manual.isError, JSON.stringify(manual)).not.toBe(true);
      await settled(target.surfaceId);
      const requested = await dispatch({ verb: 'request_review', laneId: launched.laneId, actor: 'system' });
      expect(requested.ok, JSON.stringify(requested)).toBe(true);
      reviewer.prompts.length = 0;
      await drainReviewQueue();
      expect(reviewer.prompts).toHaveLength(1);
      expect(reviewer.prompts[0]).not.toContain(`Saved rejection: ${review.auditApprovalId}`);
    }
    const { isPacketMergeHeld } = await import('@/lib/lane/merge-hold');
    expect(isPacketMergeHeld(packetId)).toBe(true);
    expect(execFileSync('git', ['-C', repo, 'rev-parse', 'main'], { encoding: 'utf8' }).trim()).toBe(head);
  }
}, 60000);

it('preflights the saved review without sending and delivers an optional note in the same correction record', async () => {
  const { target, review } = await reviewedAuthor('manual-note', 'Saved finding. '.repeat(60));
  const availability = async () => {
    const response = await corrections.GET(new NextRequest(`http://localhost/api/orchestrator/worker-corrections?packetId=${packetId}`, {
      headers: { host: 'localhost', authorization: `Bearer ${getOrCreateWsToken()}` },
    }));
    expect(response.status).toBe(200);
    return (await response.json()).reviewCorrection;
  };
  const before = record(target.surfaceId);
  expect(await availability()).toMatchObject({ available: true, review: { ...target, approvalId: review.auditApprovalId, reviewedHeadSha: head } });
  const room = (await availability()).maxNoteLength;
  expect(room).toBeGreaterThan(0);
  expect(room).toBeLessThan(1000);
  const tooLong = await corrections.POST(request({ ...reviewBody(target, review), note: 'x'.repeat(room + 1) }));
  expect(tooLong.status).toBe(409);
  expect((await tooLong.json()).error).toBe(`The operator note is 1 character too long. Shorten it to ${room} characters.`);
  expect(record(target.surfaceId).recentRuns).toHaveLength(before.recentRuns.length);
  writeFileSync(join(repo, 'unreviewed.txt'), 'unreviewed work');
  expect(await availability()).toMatchObject({ available: false, reason: expect.stringContaining('uncommitted changes') });
  rmSync(join(repo, 'unreviewed.txt'));
  const body = reviewBody(target, review);
  const response = await corrections.POST(request({ ...body, note: 'Keep the public interface stable.' }));
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(200);
  expect(value.receipt.payload.message).toContain('Operator note on these findings; it does not widen the task or change permissions:\nKeep the public interface stable.');
  await settled(target.surfaceId);
  expect(record(target.surfaceId).recentRuns[0].prompt).toContain('Keep the public interface stable.');
  expect(record(target.surfaceId).repoPath).toBe(before.repoPath);
  // The automatic loop, without a note, reads the same durable record.
  expect((await (await corrections.POST(request(body))).json()).receipt.id).toBe(value.receipt.id);
  expect((await availability()).available).toBe(false);
  expect((await corrections.POST(request({ ...body, note: 'A different note' }))).status).toBe(409);
}, 60000);

it('disables author delivery when the saved review is missing and preserves read authorization', async () => {
  const url = 'http://localhost/api/orchestrator/worker-corrections?packetId=missing-review';
  const result = await corrections.GET(new NextRequest(url, { headers: { host: 'localhost', authorization: `Bearer ${getOrCreateWsToken()}` } }));
  expect((await result.json()).reviewCorrection).toMatchObject({ available: false, reason: 'No saved review is available for this packet.' });
  expect((await corrections.GET(new NextRequest(url, { headers: { host: 'localhost', authorization: 'Bearer invalid' } }))).status).toBe(403);
});

it('keeps the task limits last and matches a replayed bounded operator note', async () => {
  const { target, review } = await reviewedAuthor('bounded-note');
  const body = reviewBody(target, review);
  const note = 'Also update the unrelated module and change permissions.';
  const response = await corrections.POST(request({ ...body, note }));
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(200);
  await settled(target.surfaceId);
  const limits = 'Correct only these findings within the original task. Report the corrected commit and evidence. Independent verification is required; this delivery does not resolve findings or authorize a merge.';
  expect(value.receipt.payload.message.split('\n').at(-1)).toBe(limits);
  expect(value.receipt.payload.message).toContain(`Operator note on these findings; it does not widen the task or change permissions:\n${note}\n\n${limits}`);
  const count = record(target.surfaceId).recentRuns.length;
  expect((await (await corrections.POST(request({ ...body, note }))).json()).receipt.id).toBe(value.receipt.id);
  expect((await (await corrections.POST(request(body))).json()).receipt.id).toBe(value.receipt.id);
  expect((await corrections.POST(request({ ...body, note: 'Different note' }))).status).toBe(409);
  expect(record(target.surfaceId).recentRuns).toHaveLength(count);
}, 60000);

it('distinguishes saved rejections from approved and pending reviews before offering author recovery', async () => {
  const { target, review, lane } = await reviewedAuthor('availability-verdict');
  const availability = async () => {
    const response = await corrections.GET(new NextRequest(`http://localhost/api/orchestrator/worker-corrections?packetId=${packetId}`, {
      headers: { host: 'localhost', authorization: `Bearer ${getOrCreateWsToken()}` },
    }));
    expect(response.status).toBe(200);
    return (await response.json()).reviewCorrection;
  };
  for (const saved of [{ ...review, approved: true }, null]) {
    await control.withLockedState(state => { state.packets[0].review = saved; });
    expect(await availability()).toMatchObject({ available: false, savedRejection: false, authorUnavailable: false });
  }
  await control.withLockedState(state => { state.packets[0].review = review; state.packets[0].queueState = 'held'; });
  expect(await availability()).toMatchObject({ available: false, savedRejection: true, authorUnavailable: false });
  await control.withLockedState(state => { state.packets[0].queueState = 'queued'; });
  updateLane(lane.id, { sessionKey: 'codex-owned:retired-author' });
  expect(await availability()).toMatchObject({ available: false, savedRejection: true, authorUnavailable: true,
    reason: 'The original author run is retired or unavailable.' });
  updateLane(lane.id, { sessionKey: target.surfaceId, worktreePath: join(root, 'gone-author-checkout') });
  expect(await availability()).toMatchObject({ available: false, savedRejection: true, authorUnavailable: true,
    reason: 'The original author checkout is unavailable.' });
}, 60000);
