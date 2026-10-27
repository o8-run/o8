import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
import { probeOwnedProcessIdentity } from '@/lib/runtimes/shared/owned-session/process-identity';
import { buildPiWriteHelper } from './helpers/pi-write-helper';

const root = realpathSync(mkdtempSync(join(getDataDir(), 'claude-server-restart-')));
const repo = join(root, 'repo');
const binary = join(root, 'claude-fixture.mjs');
const threadId = '671d7c73-b85f-4489-90ec-05d95af4776a';
let helper: string;
let server: ChildProcess | undefined;
let port = 0;
let output = '';
let surfaceId = '';
let laneId = '';
let pid = 0;
let providerPid = 0;
let start = '';
let launchBody: Record<string, unknown>;
const startTime = (workerPid: number) => execFileSync('ps', ['-o', 'lstart=', '-p', String(workerPid)], { encoding: 'utf8' }).trim();
const sessionPath = () => join(root, 'owned-claude-code', surfaceId.slice('claude-code-owned:'.length), 'session.json');
const session = (): OwnedSessionRecord => JSON.parse(readFileSync(sessionPath(), 'utf8'));
async function waitFor(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error(`${label}: ${output.slice(-4_000)}`);
}
async function api<T>(path: string, body?: unknown, status = 200): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body ? 'POST' : 'GET',
    headers: { authorization: 'Bearer offline-claude-restart-token', 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) })
    .catch(error => { throw new Error(`${path}: ${String(error)}\n${output.slice(-4_000)}`, { cause: error }); });
  const value = await response.json();
  if (response.status !== status) throw new Error(`${response.status}: ${JSON.stringify(value)}\n${output.slice(-4_000)}`);
  return value as T;
}
async function startServer(identityHelper = helper) {
  output = '';
  server = spawn(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'tests/fixtures/codex-restart-server.ts'], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, NODE_ENV: 'test',
      O8_DATA_DIR: root, CORTEX_IDE_DATA_DIR: root, CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT: join(root, 'owned-claude-code'),
      O8_WORKTREE_ROOT: join(root, 'worktrees'), O8_CLAUDE_CODE_BIN: binary, O8_PI_WRITE_BIN: identityHelper,
      CLAUDE_CONFIG_DIR: join(root, 'operator-fixture'), ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-restart-fixture',
      O8_WORKER_SANDBOX: 'off', O8_SKIP_PRELAUNCH_TYPECHECK: '1', O8_CRASH_SURVIVABLE_WORKERS: '1',
      O8_RESTART_FIXTURE_ROOT: root, O8_RESTART_FIXTURE_RUNTIME: 'claude-code', O8_API_PORT: '0' } });
  const child = server;
  child.stdout?.on('data', chunk => { output += String(chunk); });
  child.stderr?.on('data', chunk => { output += String(chunk); });
  let ready = false;
  child.on('message', message => { port = (message as { port: number }).port; ready = true; });
  await waitFor(() => { if (child.exitCode !== null) throw new Error(output); return ready; }, 'server ready');
}
async function stopServer(signal: NodeJS.Signals) {
  const child = server;
  server = undefined;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close'); child.kill(signal); await closed;
}
const state = () => api<{ alive?: boolean; lane: { sessionKey: string; status: string } }>(`/api/fixture/state?surface=${encodeURIComponent(surfaceId)}&lane=${laneId}`);
const transcript = (cursor?: string) => api<{ transcript: Array<{ id: string; text: string }> }>(`/api/runtime/transcript?sessionKey=${encodeURIComponent(surfaceId)}&limit=1000${cursor ? `&sinceId=${encodeURIComponent(cursor)}` : ''}`);

beforeAll(async () => {
  helper = process.env.O8_PI_WRITE_BIN || buildPiWriteHelper();
  mkdirSync(repo); mkdirSync(join(root, 'operator-fixture'));
  writeFileSync(join(root, 'ws-token'), 'offline-claude-restart-token', { mode: 0o600 });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); writeFileSync(join(repo, 'README.md'), 'offline fixture\n'); git('add', 'README.md');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture');
  execFileSync('git', ['clone', '--bare', repo, join(root, 'origin.git')], { stdio: 'pipe' }); git('remote', 'add', 'origin', join(root, 'origin.git'));
  copyFileSync('tests/fixtures/claude-restart-worker.mjs', binary); chmodSync(binary, 0o700);
  await startServer();
  laneId = (await api<{ id: string }>('/api/fixture/lane', {})).id;
  launchBody = { runtime: 'claude-code', cwd: repo, repoPath: repo, prompt: 'Keep the packet alive through restart.',
    clientMutationId: 'claude-restart-once', packetId: 'pkt-restart-fixture', existingLaneId: laneId,
    branchName: 'inline/restart-fixture', baseBranch: 'main', isolate: true, skipSetup: true,
    claudeCodeCarrier: 'native', claudeCodeModel: 'claude-opus-5', effort: 'high', workMode: 'edit' };
  const result = await api<{ ok: boolean; surfaceId: string }>('/api/runtime/launch', launchBody);
  expect(result, output).toMatchObject({ ok: true }); surfaceId = result.surfaceId;
  await waitFor(() => existsSync(join(root, 'launches.jsonl')), 'worker ready');
  providerPid = JSON.parse(readFileSync(join(root, 'launches.jsonl'), 'utf8').trim()).pid;
  pid = session().activeRun!.pid; start = startTime(pid);
}, 180_000);

afterAll(async () => {
  await stopServer('SIGKILL');
  if (pid) { try { if (startTime(pid) === start) process.kill(-pid, 'SIGKILL'); } catch { /* Already exited. */ } }
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('Claude packet restart through the real launch route', () => {
  it('hands the provider a worker-owned pipe before any input is read', () => {
    expect(JSON.parse(readFileSync(join(root, 'launches.jsonl'), 'utf8').trim())).toMatchObject({ pid: providerPid, stdinIsFile: false });
  });

  it('survives TERM and KILL with the same identity, provider session, lane, offline transcript and launch receipt', async () => {
    const first = session().activeRun!;
    const actual = await probeOwnedProcessIdentity(pid);
    for (const [index, signal] of (['SIGTERM', 'SIGKILL'] as const).entries()) {
      const cursor = (await transcript()).transcript.at(-1)?.id;
      await stopServer(signal);
      if (index === 0) process.kill(providerPid, 'SIGUSR1');
      await waitFor(() => existsSync(join(root, 'heartbeat')), 'worker reads input after server death');
      rmSync(join(root, 'offline-written'), { force: true }); process.kill(providerPid, 'SIGUSR2');
      await waitFor(() => existsSync(join(root, 'offline-written')), 'output without server');
      expect(startTime(pid)).toBe(start);
      expect(JSON.parse(readFileSync(join(root, 'input.json'), 'utf8')).message.content).toContain('Keep the packet alive');
      await startServer();
      expect(await state()).toMatchObject({ alive: true, lane: { sessionKey: surfaceId, status: 'running' } });
      expect(session()).toMatchObject({ threadId, activeRun: { id: first.id, pid, processIdentityRequired: true } });
      expect(actual.state).toBe('live');
      if (actual.state === 'live') expect(session().activeRun?.processIdentity).toEqual(actual.identity);
      expect((await transcript(cursor)).transcript.some(entry => entry.text.includes('offline-output:'))).toBe(true);
      expect(await api('/api/runtime/launch', launchBody)).toMatchObject({ surfaceId, replayed: true });
      expect(readFileSync(join(root, 'launches.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    }
  }, 90_000);

  it('refuses live steering after reattachment without changing input or launching another worker', async () => {
    const before = session().activeRun!;
    const input = readFileSync(before.stdinPath!, 'utf8');
    expect(await api('/api/runtime/action', { action: 'steer', surfaceId,
      message: 'This must not reach the active worker.', clientMutationId: 'steer-claude-survivor' }, 400))
      .toMatchObject({ ok: false, status: 'unavailable', note: expect.stringContaining('active run') });
    expect(readFileSync(before.stdinPath!, 'utf8')).toBe(input);
    expect(readFileSync(join(root, 'input.json'), 'utf8')).toBe(input);
    expect(session().activeRun).toMatchObject({ id: before.id, pid, processIdentity: before.processIdentity });
    expect(startTime(pid)).toBe(start);
    expect(readFileSync(join(root, 'launches.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('holds missing, mismatched and unreadable identities without rebind, retry or Stop', async () => {
    const original = session();
    try {
      for (const missing of [false, true]) {
        const changed = structuredClone(original);
        if (missing) { delete changed.activeRun!.processIdentity; delete changed.activeRun!.processIdentityRequired; }
        else changed.activeRun!.processIdentity!.startId = 'different start';
        changed.recentRuns[0] = changed.activeRun!; writeFileSync(sessionPath(), JSON.stringify(changed));
        await stopServer('SIGTERM'); await startServer();
        expect((await state()).alive).not.toBe(true);
        expect(await api('/api/runtime/action', { action: 'interrupt', surfaceId, clientMutationId: `refuse-claude-${missing}` }, 400)).toMatchObject({ ok: false });
        expect(session().activeRun?.id).toBe(original.activeRun!.id);
        expect(startTime(pid)).toBe(start);
      }
      writeFileSync(sessionPath(), JSON.stringify(original));
      if (process.platform === 'darwin') {
        await stopServer('SIGTERM'); await startServer(join(root, 'missing-helper'));
        expect((await state()).alive).not.toBe(true);
        expect(await api('/api/runtime/action', { action: 'interrupt', surfaceId, clientMutationId: 'refuse-claude-unknown' }, 400)).toMatchObject({ ok: false });
      }
    } finally { writeFileSync(sessionPath(), JSON.stringify(original)); await stopServer('SIGTERM'); await startServer(); }
  }, 180_000);

  it('stops the same identified Claude worker after survivor reattachment', async () => {
    expect(await api('/api/runtime/action', { action: 'interrupt', surfaceId, clientMutationId: 'stop-claude-survivor' })).toMatchObject({ ok: true });
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'worker stopped');
    await state(); expect(session().activeRun).toBeUndefined();
  }, 30_000);
});
