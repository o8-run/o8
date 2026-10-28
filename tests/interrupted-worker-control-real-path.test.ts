import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';

// Only provider readiness/output and notification transport are fixtures. The
// dispatch, process, interrupt, archive, control and persisted membership are real.
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ assertRuntimeDispatchable: vi.fn(async () => {}) }));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: vi.fn(async () => ({ ready: true })) }));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn() }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => true) }));
vi.mock('@/lib/skeleton/autoscan', () => ({ triggerScan: vi.fn(), triggerScanIfStale: vi.fn(), startChangePolling: vi.fn(), stopChangePolling: vi.fn() }));
vi.mock('@/lib/codex/service-tier-catalogue', () => ({ getCodexSpeedCatalogue: async () => ({ models: { 'gpt-5.6-terra': [] } }) }));

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-interrupted-control-')));
const data = join(root, 'data');
const bin = join(root, 'codex');
mkdirSync(join(data, 'chat-history'), { recursive: true });
for (const [key, value] of Object.entries({ O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data,
  CORTEX_IDE_DB_PATH: join(data, 'cortex-ide.db'), CORTEX_IDE_OWNED_CODEX_ROOT: join(data, 'owned-codex'), O8_CODEX_BIN: bin })) vi.stubEnv(key, value);
writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli 1.0.0'); process.exit(0); }
const emit = value => console.log(JSON.stringify({...value, timestamp:new Date().toISOString()}));
const first = !fs.existsSync('edit.txt');
const noThread = process.argv.some(arg => arg.includes('NO_THREAD'));
if (!first || !noThread) emit({type:'thread.started',thread_id:'saved-worker-thread'});
emit({type:'item.completed',item:{id:'summary',type:'agent_message',text:'TRANSCRIPT_4965: wrote edit.txt; verification remains.'}});
if (first) { fs.writeFileSync('edit.txt','PRESERVED_4965'); setInterval(()=>{},1000); }
else {
  fs.writeFileSync('resumed.json',JSON.stringify(process.argv));
  fs.appendFileSync('edit.txt','\\nRESUMED');
  emit({type:'turn.completed',usage:{input_tokens:0,output_tokens:0}});
}
`);
chmodSync(bin, 0o755);
const { POST: delegate } = await import('@/app/api/orchestrator/delegate/route');
const { POST: control } = await import('@/app/api/agent-control/action/route');
const { GET: membership } = await import('@/app/api/orchestrator/shared-team/active/route');
const { GET: sessionSummary } = await import('@/app/api/runtime/session-summary/route');
const { fastDelegationCapability } = await import('@/lib/orchestrator/fast-delegation-auth');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const owned = await import('@/lib/codex/owned');
const { closeDb } = await import('@/lib/db');
const surfaces: string[] = [];
function git(repo: string, ...args: string[]) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim(); }
function record(surface: string): OwnedSessionRecord {
  const suffix = join(surface.slice('codex-owned:'.length), 'session.json');
  const live = join(data, 'owned-codex', suffix);
  return JSON.parse(readFileSync(existsSync(live) ? live : join(data, 'owned-codex-archive', suffix), 'utf8'));
}
async function action(surface: string, kind: string, id = `${kind}-${surface}`) {
  const response = await control(new NextRequest('http://localhost/api/agent-control/action', { method: 'POST',
    headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
    body: JSON.stringify({ ref: { kind: 'session', id: surface }, action: { kind }, clientMutationId: id }) }));
  return { status: response.status, body: await response.json() };
}
async function card(repo: string, thread: string) {
  const response = await membership(new NextRequest(`http://localhost/api/orchestrator/shared-team/active?${new URLSearchParams({ repoPath: repo, threadId: thread })}`, { headers: { authorization: `Bearer ${getOrCreateWsToken()}` } }));
  return (await response.json()).workers;
}
async function interrupted(id: string, noThread = false) {
  const base = join(data, `base-${id}`); const repo = join(data, `checkout-${id}`); const thread = `thoughts-${id}`;
  execFileSync('git', ['init', '-q', '-b', 'main', base]);
  git(base, '-c', 'user.name=o8 fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
  git(base, 'worktree', 'add', '-q', '-b', `worker/${id}`, repo, 'HEAD');
  const { addRepo } = await import('@/lib/repos/registry'); await addRepo(repo);
  writeFileSync(join(data, 'chat-history', `${thread}.json`), JSON.stringify({ repoPath: repo, backend: 'codex', messages: [
    { id: 'user', role: 'user', content: 'Recover this worker', timestamp: 1 },
    { id: 'assistant', role: 'assistant', content: 'Starting worker', backend: 'codex', timestamp: 2,
      receipt: { leadModel: 'gpt-5.6-terra', effort: 'low', pickedMode: 'fast', permissionMode: 'full' } },
  ] }));
  const response = await delegate(new NextRequest('http://localhost/api/orchestrator/delegate', { method: 'POST',
    body: JSON.stringify({ repoPath: repo, prompt: noThread ? 'NO_THREAD' : 'Write edit.txt then wait', taskName: id,
      runtime: 'codex', model: 'gpt-5.6-terra', requestedEffort: 'low', checkoutMode: 'shared', parentThreadId: thread,
      fastCapability: fastDelegationCapability(repo, thread), assignedPaths: ['edit.txt', 'resumed.json'], clientMutationId: `launch-${id}` }) }));
  const launched = await response.json(); expect(response.status, JSON.stringify(launched)).toBe(200);
  const surface = launched.surfaceId as string; surfaces.push(surface);
  await vi.waitFor(() => expect(existsSync(join(repo, 'edit.txt'))).toBe(true));
  expect((await action(surface, 'interrupt')).status).toBe(200);
  await vi.waitFor(async () => {
    await owned.getOwnedCodexFleetAdditions({ fresh: true });
    expect(record(surface).activeRun).toBeUndefined();
    expect(record(surface).recentRuns[0].outcome).toBe('interrupted');
  });
  expect((await card(repo, thread))[0]).toMatchObject({ sessionKey: surface, status: 'interrupted' });
  const summary = await sessionSummary(new NextRequest(`http://localhost/api/runtime/session-summary?sessionKey=${encodeURIComponent(surface)}`,
    { headers: { authorization: `Bearer ${getOrCreateWsToken()}` } }));
  expect(summary.status).toBe(200);
  expect(await summary.json()).toMatchObject({ session: { status: 'interrupted' }, recovery: { actions: ['resume', 'retire'], worktreePath: repo } });
  return { repo, thread, surface, branch: launched.branch as string };
}
beforeAll(async () => {
  const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
  await updateOperatorDefaults({ workerRuntimes: ['codex'], defaultDispatchRuntime: 'codex' });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
});
afterAll(async () => {
  for (const surface of surfaces) if (record(surface).activeRun) await owned.interruptOwnedCodexSession(surface);
  const timer = (globalThis as unknown as Record<symbol, NodeJS.Timeout | undefined>)[Symbol.for('o8.ownedSession.refreshTimer.codex')];
  if (timer) clearInterval(timer);
  closeDb(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true });
});
it('resumes the interrupted saved session through the control route, preserving its worktree and edits', async () => {
  const worker = await interrupted('saved'); const before = record(worker.surface);
  expect((await card(worker.repo, worker.thread))[0]).toMatchObject({ recovery: { actions: ['resume', 'retire'], worktreePath: worker.repo, branch: worker.branch } });
  const resumed = await action(worker.surface, 'resume');
  expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
  expect(resumed.body.result.target).toMatchObject({ worktreePath: worker.repo, branch: worker.branch });
  await vi.waitFor(() => expect(readFileSync(join(worker.repo, 'edit.txt'), 'utf8')).toBe('PRESERVED_4965\nRESUMED'));
  const after = record(worker.surface);
  expect(after.surfaceId).toBe(before.surfaceId); expect(after.threadId).toBe(before.threadId);
  expect(after.cwd).toBe(before.cwd); expect(git(worker.repo, 'branch', '--show-current')).toBe(worker.branch);
  expect(JSON.parse(readFileSync(join(worker.repo, 'resumed.json'), 'utf8'))).toContain('saved-worker-thread');
  expect((await action(worker.surface, 'resume')).body.result.replayed).toBe(true);
}, 60_000);
it('retries an archived interrupted worker without a runtime thread as a fresh run with its transcript', async () => {
  const worker = await interrupted('cold', true);
  expect((await owned.archiveOwnedCodexSession(worker.surface)).archived).toBe(true);
  const resumed = await action(worker.surface, 'retry');
  expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
  await vi.waitFor(() => expect(existsSync(join(worker.repo, 'resumed.json'))).toBe(true));
  const args = JSON.parse(readFileSync(join(worker.repo, 'resumed.json'), 'utf8')) as string[];
  expect(args).not.toContain('resume'); expect(args.join(' ')).toContain('TRANSCRIPT_4965');
  expect(record(worker.surface).recentRuns[0].mode).toBe('launch');
  expect(readFileSync(join(worker.repo, 'edit.txt'), 'utf8')).toBe('PRESERVED_4965\nRESUMED');
}, 60_000);
it('retires a worker while retaining committed and uncommitted edits and reports their location', async () => {
  const worker = await interrupted('retire');
  git(worker.repo, 'add', 'edit.txt');
  git(worker.repo, '-c', 'user.name=o8 fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'worker edit');
  const head = git(worker.repo, 'rev-parse', 'HEAD');
  writeFileSync(join(worker.repo, 'uncommitted.txt'), 'KEEP_UNCOMMITTED');
  expect((await owned.archiveOwnedCodexSession(worker.surface)).archived).toBe(true);
  const retired = await action(worker.surface, 'retire');
  expect(retired.status, JSON.stringify(retired.body)).toBe(200);
  expect(retired.body.result.note).toContain(worker.repo); expect(retired.body.result.note).toContain(worker.branch);
  expect(git(worker.repo, 'rev-parse', 'HEAD')).toBe(head);
  expect(readFileSync(join(worker.repo, 'uncommitted.txt'), 'utf8')).toBe('KEEP_UNCOMMITTED');
  expect(record(worker.surface).activeRun).toBeUndefined();
  expect((await card(worker.repo, worker.thread))[0]).toMatchObject({ status: 'retired', recovery: { actions: [], worktreePath: worker.repo, branch: worker.branch } });
  expect((await action(worker.surface, 'retire')).body.result.replayed).toBe(true);
}, 60_000);
