import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';

// #5799: the delegate route wrote its packet with no lane binding and never stored one, while Stop
// verifies the lane against that stored owner (#4028), so Stop refused every delegated packet.
// Only provider readiness/output and notification transport are fixtures. Delegation, the worker
// process, the lane command, the control-plane store and the state read are real.
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ assertRuntimeDispatchable: vi.fn(async () => {}) }));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: vi.fn(async () => ({ ready: true })) }));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn() }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => true), requestRealtimeRefresh: vi.fn() }));
vi.mock('@/lib/skeleton/autoscan', () => ({ triggerScan: vi.fn(), triggerScanIfStale: vi.fn(), startChangePolling: vi.fn(), stopChangePolling: vi.fn() }));
vi.mock('@/lib/codex/service-tier-catalogue', () => ({ getCodexSpeedCatalogue: async () => ({
  models: { 'gpt-5.6-terra': [] },
  reasoningEfforts: { 'gpt-5.6-terra': ['low'] },
}) }));

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-delegate-stop-')));
const data = join(root, 'data');
const bin = join(root, 'codex');
mkdirSync(join(data, 'chat-history'), { recursive: true });
for (const [key, value] of Object.entries({ O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data,
  CORTEX_IDE_DB_PATH: join(data, 'cortex-ide.db'), CORTEX_IDE_OWNED_CODEX_ROOT: join(data, 'owned-codex'), O8_CODEX_BIN: bin })) vi.stubEnv(key, value);
// A worker that writes its marker and keeps running until Stop interrupts it.
// Probes (`--version`, `app-server`) exit at once so nothing outlives the test.
writeFileSync(bin, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('codex-cli 1.0.0'); process.exit(0); }
if (!process.argv.includes('exec')) process.exit(0);
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'delegate-stop-thread', timestamp: new Date().toISOString() }));
require('node:fs').writeFileSync('started.txt', 'running');
setInterval(() => {}, 1000);
`);
chmodSync(bin, 0o755);
const { POST: delegate } = await import('@/app/api/orchestrator/delegate/route');
const { POST: laneCommand } = await import('@/app/api/lanes/route');
const { GET: missionState } = await import('@/app/api/orchestrator/state/route');
const { readOrchestratorControlPlaneState, withLockedState } = await import('@/lib/orchestrator/control-plane');
const { getLane } = await import('@/lib/lane/registry');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const owned = await import('@/lib/codex/owned');
const { closeDb } = await import('@/lib/db');
const surfaces: string[] = [];
const operator = () => ({ authorization: `Bearer ${getOrCreateWsToken()}` });
const git = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
function record(surface: string): OwnedSessionRecord | null {
  const path = join(data, 'owned-codex', surface.slice('codex-owned:'.length), 'session.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

// The default isolated checkout: the route writes a control-plane packet and the worker gets its own
// worktree. (A shared-checkout delegation takes a different path that writes no such packet.)
async function delegated(id: string) {
  const repo = join(data, `repo-${id}`);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, '-c', 'user.name=o8 fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
  const { addRepo } = await import('@/lib/repos/registry'); await addRepo(repo);
  const response = await delegate(new NextRequest('http://localhost/api/orchestrator/delegate', { method: 'POST',
    body: JSON.stringify({ repoPath: repo, prompt: 'Write started.txt then keep working', taskName: id,
      runtime: 'codex', model: 'gpt-5.6-terra', requestedEffort: 'low', clientMutationId: `launch-${id}` }) }));
  const launched = await response.json();
  expect(response.status, JSON.stringify(launched)).toBe(200);
  surfaces.push(launched.surfaceId as string);
  const worktree = launched.worktreePath as string;
  expect(worktree).toBeTruthy();
  await vi.waitFor(() => expect(existsSync(join(worktree, 'started.txt'))).toBe(true), { timeout: 20_000 });
  return { repo, laneId: launched.laneId as string, packetId: launched.packetId as string, surface: launched.surfaceId as string };
}

async function stop(laneId: string) {
  const response = await laneCommand(new NextRequest('http://localhost/api/lanes', { method: 'POST',
    headers: { ...operator(), 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'stop', laneId, actor: 'user' }) }));
  return { status: response.status, body: await response.json() as { ok: boolean; note?: string; lane?: { status: string } } };
}

async function statePacket(packetId: string) {
  const response = await missionState(new NextRequest('http://localhost/api/orchestrator/state', { headers: operator() }));
  expect(response.status).toBe(200);
  const body = await response.json() as { mission: { packets: Array<{ id: string; lane: Record<string, unknown> | null }> } };
  return body.mission.packets.find(packet => packet.id === packetId);
}

beforeAll(async () => {
  const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
  await updateOperatorDefaults({ workerRuntimes: ['codex'], defaultDispatchRuntime: 'codex' });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
});
afterAll(async () => {
  for (const surface of surfaces) if (record(surface)?.activeRun) await owned.interruptOwnedCodexSession(surface);
  const timer = (globalThis as unknown as Record<symbol, NodeJS.Timeout | undefined>)[Symbol.for('o8.ownedSession.refreshTimer.codex')];
  if (timer) clearInterval(timer);
  closeDb(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true });
});

it('stores the delegated lane as the packet owner, shows that owner, and lets Stop hold the packet (#5799)', async () => {
  const worker = await delegated('bound');
  const lane = getLane(worker.laneId)!;
  const stored = readOrchestratorControlPlaneState().packets.find(packet => packet.id === worker.packetId)!;
  expect(stored.lane).toMatchObject({ laneId: lane.id, sessionKey: lane.sessionKey, repoPath: lane.repoPath, runtime: lane.runtime });
  // Clients find a packet by its session key (the surface id), so the stored key must be the live one.
  expect(stored.lane?.sessionKey).toBe(worker.surface);

  // The state read shows the same owner Stop verifies, not one rebuilt from the lane table.
  const shown = await statePacket(worker.packetId);
  expect(shown?.lane).toMatchObject({ laneId: stored.lane!.laneId, sessionKey: stored.lane!.sessionKey,
    repoPath: stored.lane!.repoPath, worktreePath: stored.lane!.worktreePath });

  const stopped = await stop(worker.laneId);
  expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
  expect(stopped.body).toMatchObject({ ok: true });
  const held = readOrchestratorControlPlaneState().packets.find(packet => packet.id === worker.packetId)!;
  expect(held.operatorStopped).toBe(true);
  expect(getLane(worker.laneId)?.status).not.toBe('running');
}, 60_000);

it('refuses Stop on a packet delegated before the binding was stored with a reason, not a hang (#5799)', async () => {
  const worker = await delegated('legacy');
  // The row as the old delegate route left it: no stored binding.
  await withLockedState((current) => {
    const packet = current.packets.find(candidate => candidate.id === worker.packetId);
    if (packet) packet.lane = null;
  });
  expect(readOrchestratorControlPlaneState().packets.find(packet => packet.id === worker.packetId)?.lane).toBeNull();

  const started = Date.now();
  const refused = await stop(worker.laneId);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(refused.status).toBe(422);
  expect(refused.body.ok).toBe(false);
  expect(refused.body.note).toContain(`packet ${worker.packetId} has no stored lane binding`);
  // The legacy row keeps the rebuilt display, so the lane is still visible.
  expect((await statePacket(worker.packetId))?.lane).toMatchObject({ laneId: worker.laneId });
}, 60_000);
