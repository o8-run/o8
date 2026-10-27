import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, lstatSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, expect, it, vi } from 'vitest';
import type { AgentRuntime } from '@/lib/runtimes/types';

const fixture = vi.hoisted(() => ({ runtimes: [] as AgentRuntime[] }));
vi.mock('@/lib/runtimes', () => ({ getAllRuntimes: () => fixture.runtimes }));
const root = mkdtempSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'idle-launch-'));
const repo = join(root, 'repo');
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
vi.stubEnv('O8_TEST_IDLE_LAUNCH_ROOT', join(root, 'sessions'));
const [{ createOwnedSessionStore }, { createDeclarativeAgentRuntime }, registry, inventory, route] = await Promise.all([
  import('@/lib/runtimes/shared/owned-session/store'), import('@/lib/runtimes/shared/declarative-agent-runtime'),
  import('@/lib/lane/registry'), import('@/lib/runtime/inventory'), import('@/app/api/runtime/inventory/route'),
]);
const store = createOwnedSessionStore({
  runtimeId: 'antigravity', surfaceIdPrefix: 'antigravity-owned:', rootEnvVar: 'O8_TEST_IDLE_LAUNCH_ROOT',
  rootDefault: join(root, 'sessions'), binaryName: 'node', binaryEnvOverride: 'O8_TEST_IDLE_LAUNCH_BIN', humanLabel: 'Fixture', squadShortName: 'Fixture',
  launchArgs: () => [], resumeArgs: () => [], parseRunLog: () => ({ entries: [], outcome: 'running', completedTurn: false }),
});
fixture.runtimes = [createDeclarativeAgentRuntime({ runtimeId: 'antigravity', displayName: 'Fixture',
  surfaceIdPrefix: 'antigravity-owned:', supportsResume: true, costTelemetry: false }, store)];
afterAll(async () => {
  await store.sweepOrphanedSessions(new Set(), 0);
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function snapshot() {
  inventory.invalidateRuntimeInventoryCache();
  const response = await route.GET(new NextRequest('http://localhost/api/runtime/inventory?fresh=1'));
  expect(response.status).toBe(200);
  return response.json();
}
function seed(id: string, ageMs: number, threadId?: string) {
  const sessionDir = join(root, 'sessions', id);
  mkdirSync(sessionDir, { recursive: true });
  const at = new Date(Date.now() - ageMs).toISOString();
  const surfaceId = `antigravity-owned:${id}`;
  const lane = registry.createLane({ repoPath: repo, branch: `fixture/${id}`, baseBranch: 'main', runtime: 'antigravity' });
  registry.attachSession(lane.id, surfaceId, 'system');
  registry.setLaneStatus(lane.id, 'running', 'system', 'session_launched');
  writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({ surfaceId, sessionDir, repoPath: repo, cwd: repo,
    laneId: lane.id, title: id, createdAt: at, updatedAt: at, initialPrompt: 'fixture', latestPrompt: 'fixture',
    latestSummary: 'fixture', recentRuns: [], runIdentityLedger: { version: 1, totalRuns: 0, complete: true }, threadId }));
  return { sessionDir, lane };
}
it('reports a process-free awaiting-thread IDE session as blocked through the inventory route', async () => {
  const { sessionDir } = seed('young', 0);
  const result = await snapshot();
  expect(result.agents.find((agent: { id: string }) => agent.id === 'antigravity-owned:young')?.statusEvidence.state).toBe('blocked');
  expect(existsSync(sessionDir)).toBe(true);
});
it('retires an old process-free IDE launch while preserving its archived receipt and a resumable session', async () => {
  const stale = seed('stale', 31_000);
  const resumable = seed('resumable', 31_000, 'fixture-thread');
  await vi.waitFor(async () => {
    const result = await snapshot();
    expect(result.agents.some((agent: { id: string }) => agent.id === 'antigravity-owned:stale')).toBe(false);
    expect(existsSync(stale.sessionDir)).toBe(false);
  });
  expect(JSON.parse(readFileSync(join(root, 'sessions-archive/stale/session.json'), 'utf8')).orphanedReason).toContain('runtime_launch_timeout');
  expect(registry.getLane(stale.lane.id)?.status).not.toBe('running');
  expect(existsSync(resumable.sessionDir)).toBe(true);
});
it('refuses redirected session metadata without writing or archiving the external directory', async () => {
  const { sessionDir } = seed('redirected', 31_000);
  const external = join(root, 'external');
  mkdirSync(external);
  const canary = join(external, 'session.json');
  writeFileSync(canary, 'external canary');
  const file = join(sessionDir, 'session.json');
  const record = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...record, sessionDir: external }));
  await snapshot();
  expect(existsSync(sessionDir)).toBe(true);
  expect(existsSync(external)).toBe(true);
  expect(readFileSync(canary, 'utf8')).toBe('external canary');
});
it('preserves a finished receipt with unknown process clearance', async () => {
  const { sessionDir } = seed('unknown-process', 31_000);
  const file = join(sessionDir, 'session.json');
  const record = JSON.parse(readFileSync(file, 'utf8'));
  mkdirSync(join(sessionDir, 'runs'));
  const stdoutPath = join(sessionDir, 'runs/out');
  const stderrPath = join(sessionDir, 'runs/err');
  writeFileSync(stdoutPath, ''); writeFileSync(stderrPath, '');
  writeFileSync(file, JSON.stringify({ ...record, runIdentityLedger: { version: 1, totalRuns: 1, complete: true }, recentRuns: [{ id: 'unknown', mode: 'launch', prompt: 'fixture',
    pid: 99999999, startedAt: record.createdAt, finishedAt: record.createdAt, outcome: 'finished', stdoutPath, stderrPath }] }));
  await snapshot();
  expect(existsSync(sessionDir)).toBe(true);
});

it('preserves an actual surviving process despite a finished journal', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true, stdio: 'ignore', env: { NODE_ENV: 'test', PATH: process.env.PATH, O8_OWNED_RUN_MARKER: 'fixture-survivor' },
  });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const { sessionDir } = seed('survivor', 31_000);
  const file = join(sessionDir, 'session.json');
  const record = JSON.parse(readFileSync(file, 'utf8'));
  mkdirSync(join(sessionDir, 'runs'));
  const stdoutPath = join(sessionDir, 'runs/out');
  const stderrPath = join(sessionDir, 'runs/err');
  writeFileSync(stdoutPath, ''); writeFileSync(stderrPath, '');
  writeFileSync(file, JSON.stringify({ ...record, runIdentityLedger: { version: 1, totalRuns: 1, complete: true }, recentRuns: [{ id: 'survivor', mode: 'launch', prompt: 'fixture',
    pid: child.pid, processGroupId: child.pid, processMarker: 'fixture-survivor', startedAt: record.createdAt,
    finishedAt: record.createdAt, outcome: 'finished', stdoutPath, stderrPath }] }));
  try {
    await snapshot();
    expect(existsSync(sessionDir)).toBe(true);
    expect(process.kill(child.pid!, 0)).toBe(true);
  } finally {
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.kill('SIGTERM'); await closed;
  }
});

it.each([undefined, { version: 1, totalRuns: null, complete: false }, { version: 1, totalRuns: 0, complete: 'yes' }])('retains unknown history instead of inferring zero runs (%j)', async ledger => {
  const { sessionDir } = seed(`ledger-${Math.random().toString(36).slice(2)}`, 31_000);
  const file = join(sessionDir, 'session.json');
  const record = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...record, runIdentityLedger: ledger }));
  await snapshot(); expect(existsSync(sessionDir)).toBe(true);
});

function outsideSnapshot(directory: string): unknown {
  const stat = lstatSync(directory);
  return { mode: stat.mode, mtimeMs: stat.mtimeMs, entries: readdirSync(directory).sort().map(name => {
    const target = join(directory, name); const entry = lstatSync(target);
    return { name, mode: entry.mode, mtimeMs: entry.mtimeMs,
      content: entry.isDirectory() ? outsideSnapshot(target) : readFileSync(target, 'utf8') };
  }) };
}

it('refuses a symlinked sessions-archive through inventory without changing anything outside the owned root', async () => {
  const outside = mkdtempSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'idle-launch-outside-archive-'));
  const archive = join(root, 'sessions-archive'); const heldArchive = `${archive}-held`;
  const hadArchive = existsSync(archive);
  if (hadArchive) renameSync(archive, heldArchive);
  const { sessionDir, lane } = seed('archive-symlink', 31_000);
  writeFileSync(join(outside, 'canary'), 'outside archive must remain unchanged');
  const before = outsideSnapshot(outside);
  const metadata = readFileSync(join(sessionDir, 'session.json'), 'utf8');
  symlinkSync(outside, archive, 'dir');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    // Fresh inventory can return while another owned discovery is settling.
    // Observe this exact refusal before checking the external canary.
    await vi.waitFor(async () => {
      await snapshot();
      expect(warning.mock.calls.flat().join(' ')).toMatch(/sessions-archive.*symbolic link/i);
    });
    expect.soft(outsideSnapshot(outside)).toEqual(before);
    expect.soft(existsSync(sessionDir)).toBe(true);
    if (existsSync(sessionDir)) expect.soft(readFileSync(join(sessionDir, 'session.json'), 'utf8')).toBe(metadata);
    expect.soft(registry.getLane(lane.id)?.status).not.toBe('failed');
    expect.soft(warning.mock.calls.flat().join(' ')).toMatch(/sessions-archive.*symbolic link/i);
  } finally {
    warning.mockRestore(); unlinkSync(archive);
    if (hadArchive) renameSync(heldArchive, archive);
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

it('skips a symlinked session directory through inventory without changing anything outside the owned root', async () => {
  const outside = mkdtempSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'idle-launch-outside-session-'));
  const { sessionDir, lane } = seed('session-symlink', 31_000);
  const externalSession = join(outside, 'session'); renameSync(sessionDir, externalSession);
  const file = join(externalSession, 'session.json');
  const record = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...record, sessionDir: externalSession }));
  const before = outsideSnapshot(outside);
  symlinkSync(externalSession, sessionDir, 'dir');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const result = await snapshot();
    expect(result.agents.some((agent: { id: string }) => agent.id === 'antigravity-owned:session-symlink')).toBe(false);
    expect.soft(outsideSnapshot(outside)).toEqual(before);
    expect.soft(registry.getLane(lane.id)?.status).toBe('running');
    expect.soft(warning.mock.calls.flat().join(' ')).toMatch(/session directory.*symbolic link/i);
  } finally {
    warning.mockRestore(); unlinkSync(sessionDir);
    rmSync(outside, { recursive: true, force: true });
  }
});
