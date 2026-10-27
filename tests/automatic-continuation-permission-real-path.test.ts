import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { OrchestratorBackend } from '@/lib/lane/orchestrator-backends/types';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import { buildPiWriteHelper } from './helpers/pi-write-helper';
import type { SharedWorkerReturnHooks } from '@/lib/orchestrator/shared-worker-returns';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';

// Only the finite model transport and fixed-output worker binary are fixtures.
// Parent command confinement, delegation, recovery, admission and persistence are real.
const state = vi.hoisted(() => ({ backend: null as OrchestratorBackend | null }));
vi.mock('@/lib/lane/orchestrator-backends/registry', () => ({ getOrchestratorBackend: () => state.backend! }));

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ assertRuntimeDispatchable: vi.fn(async () => {}) }));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: vi.fn(async () => ({ ready: true })) }));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn() }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => true) }));
vi.mock('@/lib/skeleton/autoscan', () => ({ triggerScan: vi.fn(), triggerScanIfStale: vi.fn(), startChangePolling: vi.fn(), stopChangePolling: vi.fn() }));
vi.mock('@/lib/codex/service-tier-catalogue', () => ({ getCodexSpeedCatalogue: async () => ({ models: { 'gpt-5.6-terra': [] }, reasoningEfforts: { 'gpt-5.6-terra': ['low'] } }) }));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-worker-return-')));
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
emit({type:'thread.started', thread_id:'fixture-worker-' + process.pid});
emit({type:'item.completed', item:{id:'answer', type:'agent_message', text:'Unique worker result ' + process.pid}});
emit({type:'turn.completed', usage:{input_tokens:0, output_tokens:0}});
`); chmodSync(bin, 0o755);
let parent = 'thoughts-automatic-parent';
const { POST } = await import('@/app/api/orchestrator/delegate/route');
const { fastDelegationCapability } = await import('@/lib/orchestrator/fast-delegation-auth');
const { GET: transcriptRoute } = await import('@/app/api/runtime/transcript/route');
const owned = await import('@/lib/codex/owned');
const { createSharedWorkerHeartbeat } = await import('@/lib/ws-server/shared-worker-heartbeat');
const { listSharedWorkerReturns } = await import('@/lib/orchestrator/shared-worker-returns');
const { finishSharedCheckoutTeam } = await import('@/lib/orchestrator/shared-checkout-team');
const { getSqlite, closeDb } = await import('@/lib/db');
const { readPersistedLlmChat } = await import('@/lib/llm/chat-history-store');
let busy = true;
const hooks = { readTranscript: async (surface: string, limit: number) => {
  const response = await transcriptRoute(new NextRequest(`http://localhost/api/runtime/transcript?sessionKey=${encodeURIComponent(surface)}&limit=${limit}`));
  expect(response.status).toBe(200);
  return (await response.json()).transcript as Awaited<ReturnType<SharedWorkerReturnHooks['readTranscript']>>;
},
  isBusy: () => busy, registerAbort: () => () => {}, publish: vi.fn((_thread: string, session: string, event: string, payload: Record<string, unknown>) => chatHooks.publish(session, event, payload)) };
let heartbeat: () => void;
const surfaces: string[] = [];
function record(surface: string): OwnedSessionRecord {
  const suffix = join(surface.slice('codex-owned:'.length), 'session.json');
  const live = join(data, 'owned-codex', suffix);
  return JSON.parse(readFileSync(existsSync(live) ? live : join(data, 'owned-codex-archive', suffix), 'utf8'));
}
async function launch(id: string) {
  const response = await POST(new NextRequest('http://localhost/api/orchestrator/delegate', { method: 'POST',
    body: JSON.stringify({ prompt: `Inspect ${id}`, repoPath: repo, taskName: id, runtime: 'codex',
      model: 'gpt-5.6-terra', requestedEffort: 'low', checkoutMode: 'shared', parentThreadId: parent,
      fastCapability: fastDelegationCapability(repo, parent), assignedPaths: [`src/${id}`],
      readOnly: false, clientMutationId: id }) }));
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  const surface = body.surfaceId as string; surfaces.push(surface);
  await vi.waitFor(async () => {
    await owned.getOwnedCodexFleetAdditions({ fresh: true });
    expect(record(surface).activeRun).toBeUndefined();
    expect(record(surface).recentRuns[0]?.outcome).toBe('finished');
  }, { timeout: 15_000, interval: 50 });
  return surface;
}
beforeAll(async () => {
  buildPiWriteHelper();
  const { addRepo } = await import('@/lib/repos/registry'); await addRepo(repo);
  const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
  await updateOperatorDefaults({ reviewContinuation: true, workerRuntimes: ['codex'], defaultDispatchRuntime: 'codex' });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
  heartbeat = createSharedWorkerHeartbeat(hooks);
}, 600_000);
afterAll(async () => {
  for (const surface of surfaces) { if (record(surface).activeRun) await owned.interruptOwnedCodexSession(surface); }
  await pi.closeAll();
  const timer = (globalThis as unknown as Record<symbol, NodeJS.Timeout | undefined>)[Symbol.for('o8.ownedSession.refreshTimer.codex')];
  if (timer) clearInterval(timer);
  closeDb(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true });
});
const outside = join(root, 'outside.txt');
let step = 0;
const toolResults: unknown[] = [];
function answer(content: AssistantMessage['content'], stopReason: 'stop' | 'toolUse'): AssistantMessage {
  return { role: 'assistant', content, stopReason, model: 'fixture-model', api: 'openai-completions', provider: 'fixture',
    timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
const { createPiOrchestratorBackend } = await import('@/lib/lane/orchestrator-backends/pi');
const pi = createPiOrchestratorBackend({ stateRoot: () => join(root, 'pi-state'),
  openServers: async () => ({ servers: [], close: async () => {} }),
  transport: async function* () {
    const message = step++ % 2 === 0
      ? answer([{ type: 'toolCall', id: `write-${step}`, name: 'run_command',
        arguments: { command: `printf changed > '${outside}'` } }], 'toolUse')
      : answer([{ type: 'text', text: 'Command inspected.' }], 'stop');
    yield { type: 'start', partial: message } as AssistantMessageEvent;
    yield { type: 'done', reason: message.stopReason, message } as AssistantMessageEvent;
  } });
state.backend = pi;
const { POST: enqueue } = await import('@/app/api/orchestrator/composer-queue/route');
const { runBoundChatContinuation } = await import('@/lib/ws-server/bound-chat-continuation');
const { createComposerQueueHeartbeat } = await import('@/lib/ws-server/composer-queue-heartbeat');
const { readComposerSend } = await import('@/lib/orchestrator/composer-queue');
const { routeReviewContinuation } = await import('@/lib/orchestrator/review-continuation');
const { runReviewChatContinuation } = await import('@/lib/ws-server/review-chat-continuation');
const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { resolveChatTurnOrigin } = await import('@/lib/orchestrator/review-continuation-origin');
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
const chatHooks = { registerAbort: () => () => {}, publish: (_session: string, event: string, payload: Record<string, unknown>) => {
  if (event === 'tool-result') toolResults.push(payload);
} };
async function queuedOutside(id: string) {
  const response = await enqueue(new NextRequest('http://localhost/api/orchestrator/composer-queue', {
    method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify({ repoPath: repo, threadId: parent,
      id, intent: 'send-next', payload: { text: 'Inspect the selected command and delegate work.',
        wireMessage: 'Inspect the selected command and delegate work.', images: [], routing: {
          backend: 'pi', model: 'pi', effort: 'medium', permissionMode: 'outside-workspace',
          mode: 'fleet', pickedMode: 'fast', collide: false,
        } } }),
  }));
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  createComposerQueueHeartbeat({ ...hooks, isBusy: () => false,
    publish: (_thread, session, event, payload) => chatHooks.publish(session, event, payload) })();
  await vi.waitFor(() => expect(readComposerSend(id)?.status).toBe('applied'), { timeout: 30_000 });
  expect(readFileSync(outside, 'utf8')).toBe('changed');
  expect(readPersistedLlmChat(parent)?.history.messages.at(-1)?.receipt?.permissionMode).toBe('outside-workspace');
}
async function origin(id: string) {
  if (surfaces.length) await finishSharedCheckoutTeam({ repoPath: repo, parentThreadId: parent,
    reviewSummary: 'Fixed-output worker made no changes.', verification: 'Worker settled; checkout is clean.' });
  parent = `thoughts-automatic-${id}`;
  writeFileSync(join(data, 'chat-history', `${parent}.json`), JSON.stringify({ repoPath: repo, backend: 'pi', messages: [] }));
  await queuedOutside(`origin-${id}`);
  const resolved = resolveChatTurnOrigin({ repoPath: repo, threadId: parent, turnId: `assistant-queued-origin-${id}` });
  expect(resolved.kind).toBe('bound');
  if (resolved.kind !== 'bound') throw new Error('Missing origin');
  return resolved.origin;
}
function expectConfined() {
  const last = readPersistedLlmChat(parent)?.history.messages.at(-1);
  expect.soft(existsSync(outside), 'automatic command must not write outside the workspace').toBe(false);
  expect.soft(last?.receipt?.permissionMode).toBe('full');
  expect.soft(toolResults).toContainEqual(expect.objectContaining({ name: 'run_command',
    output: expect.stringMatching(/Exit code [1-9]\d*[\s\S]*this command runs confined/) }));
}
it('confines review continuation after an outside-workspace parent delegates, recording full', async () => {
  const expected = await origin('review');
  await launch('review-worker');
  const packetId = 'automatic-review-packet';
  const lane = createLane({ repoPath: repo, branch: 'main', runtime: 'codex', packetId });
  setLaneStatus(lane.id, 'reviewing', 'system', 'fixture_review_ready');
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'automatic-review', repoPath: repo,
    packets: [{ id: packetId, orchestratorThreadId: parent, orchestratorTurnId: expected.turnId } as OrchestratorPacket] });
  rmSync(outside); toolResults.length = 0;
  let continuation: Promise<void> | undefined;
  routeReviewContinuation(lane, () => false, (boundLane, boundOrigin) => {
    continuation = runReviewChatContinuation(boundLane, boundOrigin, 'Review the delegated work and inspect the command.', chatHooks);
  });
  expect(continuation).toBeDefined(); await continuation;
  expectConfined();
}, 90_000);
it.each([false, true])('confines shared-worker return after an outside-workspace delegation (recovery=%s)', async recover => {
  await origin(recover ? 'recovered' : 'shared');
  // The previous test owns a separate parent; keep its return out of this batch.
  busy = true;
  const surface = await launch(recover ? 'recovered-worker' : 'shared-worker');
  heartbeat = createSharedWorkerHeartbeat(hooks); heartbeat();
  await vi.waitFor(() => expect(listSharedWorkerReturns(parent)).toHaveLength(1));
  if (recover) {
    getSqlite().prepare('DELETE FROM shared_worker_returns WHERE surface_id = ?').run(surface);
    getSqlite().prepare('DELETE FROM shared_worker_parents WHERE surface_id = ?').run(surface);
    closeDb();
    expect((await owned.archiveOwnedCodexSession(surface)).archived).toBe(true);
    heartbeat = createSharedWorkerHeartbeat(hooks);
  }
  rmSync(outside); toolResults.length = 0;
  busy = false; heartbeat();
  await vi.waitFor(() => expect(listSharedWorkerReturns(parent).map(row => row.status)).toEqual(['delivered']), { timeout: 30_000 });
  expectConfined();
}, 90_000);
it('retains a deliberately queued operator Outside workspace choice after a confined turn', async () => {
  const expected = await origin('queued');
  rmSync(outside);
  await runBoundChatContinuation({ repoPath: repo, origin: { ...expected, permissionMode: 'full' },
    assistantMessageId: 'assistant-confined-before-queue', message: 'Inspect the command.', check: () => {} }, chatHooks);
  expect(existsSync(outside)).toBe(false);
  expect(readPersistedLlmChat(parent)?.history.messages.at(-1)?.receipt?.permissionMode).toBe('full');
  await pi.closeAll();
  await queuedOutside('operator-outside-again');
}, 90_000);
