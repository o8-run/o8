import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { OrchestratorBackend, OrchestratorTurnOptions } from '@/lib/lane/orchestrator-backends/types';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { SharedWorkerReturnHooks } from '@/lib/orchestrator/shared-worker-returns';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';

// Provider boundaries are deterministic. Delegation, owned processes, metadata,
// transcript parsing, parent binding, delivery and canonical history are real.
// The fixed-output fixture accepts no commands. Use full permission so this
// lifecycle proof also runs on Linux; OS sandbox enforcement has separate tests.
const { sendTurn, publishMutation } = vi.hoisted(() => ({
  sendTurn: vi.fn(async (_repo: string, _message: string, onEvent: (event: OrchestratorEvent) => void, options?: OrchestratorTurnOptions) => {
    onEvent({ type: 'turn_receipt', leadModel: options!.model!, effort: 'low' });
    onEvent({ type: 'text', text: 'I received the worker results in their parent conversation.' });
    onEvent({ type: 'done', sessionId: 'fixture-parent', cost: null });
  }),
  publishMutation: vi.fn(async () => true),
}));
vi.mock('@/lib/lane/orchestrator-backends/registry', () => ({ getOrchestratorBackend: () => ({
  id: 'codex', label: 'Codex', ensureSession: () => ({ sessionName: 'fixture-parent', status: 'ready' }),
  peekSession: () => ({ sessionName: 'fixture-parent', status: 'ready' }), sendTurn,
} satisfies OrchestratorBackend) }));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ assertRuntimeDispatchable: vi.fn(async () => {}) }));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: vi.fn(async () => ({ ready: true })) }));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn() }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: publishMutation }));
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
const parent = 'thoughts-return-parent';
const historyFile = join(data, 'chat-history', `${parent}.json`);
writeFileSync(historyFile, JSON.stringify({ repoPath: repo, backend: 'codex', messages: [
  { id: 'user-origin', role: 'user', content: 'Delegate two read-only inspections.', timestamp: 1 },
  { id: 'assistant-origin', role: 'assistant', content: 'Starting the workers.', backend: 'codex',
    model: 'gpt-5.6-terra', timestamp: 2, receipt: { leadModel: 'gpt-5.6-terra', effort: 'low',
      mode: 'multitask', pickedMode: 'fast', permissionMode: 'full' } },
] }));
const { POST } = await import('@/app/api/orchestrator/delegate/route');
const { fastDelegationCapability } = await import('@/lib/orchestrator/fast-delegation-auth');
const { GET: transcriptRoute } = await import('@/app/api/runtime/transcript/route');
const owned = await import('@/lib/codex/owned');
const { createSharedWorkerHeartbeat } = await import('@/lib/ws-server/shared-worker-heartbeat');
const { listSharedWorkerReturns, stopSharedWorkerReturns } = await import('@/lib/orchestrator/shared-worker-returns');
const { readSharedCheckoutTeam } = await import('@/lib/orchestrator/shared-checkout-team');
const { getSqlite, closeDb } = await import('@/lib/db');
const { readPersistedLlmChat } = await import('@/lib/llm/chat-history-store');
let busy = true;
const hooks = { readTranscript: async (surface: string, limit: number) => {
  const response = await transcriptRoute(new NextRequest(`http://localhost/api/runtime/transcript?sessionKey=${encodeURIComponent(surface)}&limit=${limit}`));
  expect(response.status).toBe(200);
  return (await response.json()).transcript as Awaited<ReturnType<SharedWorkerReturnHooks['readTranscript']>>;
},
  isBusy: () => busy, registerAbort: () => () => {}, publish: vi.fn() };
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
  const { addRepo } = await import('@/lib/repos/registry'); await addRepo(repo);
  const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
  await updateOperatorDefaults({ reviewContinuation: true, workerRuntimes: ['codex'], defaultDispatchRuntime: 'codex' });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
  heartbeat = createSharedWorkerHeartbeat(hooks);
});
afterAll(async () => {
  for (const surface of surfaces) { if (record(surface).activeRun) await owned.interruptOwnedCodexSession(surface); }
  const timer = (globalThis as unknown as Record<symbol, NodeJS.Timeout | undefined>)[Symbol.for('o8.ownedSession.refreshTimer.codex')];
  if (timer) clearInterval(timer);
  closeDb(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true });
});
it('delivers real launched workers to the exact persisted parent, survives restart and never replays or wakes after Stop', async () => {
  const first = await launch('first'); const second = await launch('second');
  expect(readSharedCheckoutTeam({ repoPath: repo, parentThreadId: parent })?.members.map(row => row.parentTurnId))
    .toEqual(['assistant-origin', 'assistant-origin']);
  heartbeat();
  await vi.waitFor(() => expect(listSharedWorkerReturns(parent)).toHaveLength(2));
  expect(listSharedWorkerReturns(parent).every(row => row.summary.startsWith('Unique worker result')), JSON.stringify({ returns: listSharedWorkerReturns(parent), transcript: await hooks.readTranscript(first, 80), run: record(first).recentRuns[0] })).toBe(true);
  expect(sendTurn).not.toHaveBeenCalled();
  // Reopen persistence and recover the missing-parent crash window from membership.
  getSqlite().prepare('DELETE FROM shared_worker_returns').run();
  getSqlite().prepare('DELETE FROM shared_worker_parents').run(); closeDb();
  // A completed process may be archived before the supervisor restarts.
  expect((await owned.archiveOwnedCodexSession(first)).archived).toBe(true);
  const { readOwnedRecoveryState } = await import('@/lib/runtimes/shared/owned-session/automatic-recovery');
  expect(await readOwnedRecoveryState(first, { includeArchived: true })).toMatchObject({ outcome: 'finished', automaticRecoveryAllowed: false });
  heartbeat = createSharedWorkerHeartbeat(hooks); busy = false; heartbeat();
  await vi.waitFor(() => expect(listSharedWorkerReturns(parent).map(row => row.status)).toEqual(['delivered', 'delivered']));
  expect(sendTurn).toHaveBeenCalledTimes(1);
  expect(sendTurn.mock.calls[0][0]).toBe(repo);
  expect(sendTurn.mock.calls[0][1]).toContain(first); expect(sendTurn.mock.calls[0][1]).toContain(second);
  expect(sendTurn.mock.calls[0][3]).toMatchObject({ threadId: parent, model: 'gpt-5.6-terra', thinkingEffort: 'low', permissionMode: 'full' });
  expect(readPersistedLlmChat(parent)?.history.messages.at(-1)?.content).toContain('received the worker results');
  expect(readPersistedLlmChat('thoughts-unrelated')).toBeNull();
  heartbeat(); await new Promise(resolve => setTimeout(resolve, 80));
  expect(sendTurn).toHaveBeenCalledTimes(1); expect(publishMutation).toHaveBeenCalled();
  // A new originating assistant turn is still bound through the same public entry.
  const third = await launch('third'); stopSharedWorkerReturns(repo, parent);
  heartbeat = createSharedWorkerHeartbeat(hooks); heartbeat();
  await vi.waitFor(() => expect(listSharedWorkerReturns(parent).find(row => row.surface_id === third)?.status).toBe('held'));
  expect(sendTurn).toHaveBeenCalledTimes(1);
}, 60_000);
