import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Health and completion transports are fixtures; process, packet, worktree and persistence paths are real.
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: vi.fn(async () => ({ ready: true, reason: 'http_200', waitedMs: 0, attempts: 1, lastCheck: {} })) }));
vi.mock('@/lib/runtime/pty-bridge', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/runtime/pty-bridge')>(), spawnBridgeTerminalSession: vi.fn(async () => { throw new Error('fixture uses detached process'); }) }));

const root = realpathSync(mkdtempSync(join(homedir(), '.tmp-o8-muse-worker-')));
const repo = join(root, 'repo');
const configA = join(root, 'config-a');
const dataA = join(root, 'data-a');
const sessions = join(root, 'sessions');
process.env.CORTEX_IDE_DATA_DIR = join(root, 'operator');
process.env.O8_DATA_DIR = join(root, 'operator');
process.env.O8_OWNED_MUSE_ROOT = sessions;
process.env.O8_MUSE_BIN = join(root, 'muse');
process.env.XDG_CONFIG_HOME = configA;
process.env.XDG_DATA_HOME = dataA;
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
process.env.O8_WORKER_SANDBOX = 'off';
process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';
const surfaces: string[] = [];
beforeEach(() => { process.env.XDG_CONFIG_HOME = configA; process.env.XDG_DATA_HOME = dataA; });

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
  mkdirSync(repo); mkdirSync(configA); mkdirSync(dataA);
  execFileSync('git', ['init', '-qb', 'main'], { cwd: repo });
  writeFileSync(join(repo, 'tracked.txt'), 'unchanged\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'base'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', repo], { cwd: repo });
  writeFileSync(join(root, 'fixture.cjs'), `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('Muse Code 1.4.7'); process.exit(0); }
const session = args.includes('--session-id') ? args[args.indexOf('--session-id')+1] : 'native-fixture-session';
const emit = (type, payload) => console.log(JSON.stringify({schema_version:1,stream:{kind:'session',id:session},payload_type:type,durability:'durable',payload}));
emit('session.run.linked', {run_stream:{id:'root-run'}});
let denied = null;
if (args.at(-1).includes('write-denied')) { try { fs.writeFileSync('tracked.txt', 'changed'); denied=false; } catch { denied=true; } }
const result = { args, config: process.env.XDG_CONFIG_HOME, data: process.env.XDG_DATA_HOME, key: process.env.META_API_KEY, auth: process.env.MUSE_AUTH_PATH, denied };
if (args.at(-1).includes('hold')) setInterval(()=>{},1000);
else emit('run.terminal.completed', {terminal:'completed',text:JSON.stringify(result)});
`);
  writeFileSync(join(root, 'muse'), `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${join(root, 'fixture.cjs')}' "$@"\n`); chmodSync(join(root, 'muse'), 0o700);
  const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
  await updateOperatorDefaults({ productTelemetryEnabled: false, storageReserveRatio: 0.0001, storageReserveFloorGb: 0.001 });
  await (await import('@/lib/repos/registry')).addRepo(repo);
  await import('@/lib/runtime/actions');
}, 120_000);

afterAll(async () => {
  const { museOwnedStore } = await import('@/lib/muse/owned');
  for (const id of surfaces) await museOwnedStore.interrupt(id);
  (await import('@/lib/db')).closeDb();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

async function answer(id: string, expectedPrompt?: string) {
  const { museOwnedStore } = await import('@/lib/muse/owned');
  let text = '';
  await vi.waitFor(async () => {
    const tail = await museOwnedStore.getRuntimeTail(id);
    text = tail.entries.filter(entry => entry.kind === 'message').at(-1)?.text ?? '';
    expect(text).not.toBe('');
    if (expectedPrompt) expect(JSON.parse(text).args.at(-1)).toBe(expectedPrompt);
    expect(tail.surface.lifecycle?.lastOutcome).toBe('finished');
  }, { timeout: 20_000 });
  return JSON.parse(text) as { args: string[]; config: string; data: string; key: string; auth: string; denied: boolean };
}

describe.sequential('native worker dispatch through the managed entry point', () => {
  it('launches a persisted packet and resumes with its original account roots', async () => {
    const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
    const { createEmptyOrchestratorMissionState, normalizeOrchestratorMissionState } = await import('@/lib/orchestrator/store');
    const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const lane = createLane({ repoPath: repo, branch: 'packet/muse-fixture', baseBranch: 'main', runtime: 'muse', packetId: 'muse-fixture' });
    setLaneStatus(lane.id, 'launching', 'system', 'launch_requested');
    writeOrchestratorControlPlaneState(normalizeOrchestratorMissionState({ ...createEmptyOrchestratorMissionState(), missionId: 'muse-mission', repoPath: repo,
      packets: [{ id: 'muse-fixture', title: 'fixture', summary: 'fixture', runtime: 'muse', status: 'queued', queueState: 'queued', releaseState: 'pending' }] }));
    const { launchRuntimeSurface } = await import('@/lib/runtime/actions');
    process.env.META_API_KEY = 'fixture-key'; process.env.MUSE_AUTH_PATH = '/fixture/other-account';
    const launched = await launchRuntimeSurface({ runtime: 'muse', prompt: 'fixture', repoPath: repo, packetId: 'muse-fixture', existingLaneId: lane.id,
      isolate: true, skipSetup: true, baseBranch: 'main', branchName: 'packet/muse-fixture' });
    surfaces.push(launched.surfaceId);
    expect(launched.ok).toBe(true); expect(launched.worktree).not.toBeNull();
    const first = await answer(launched.surfaceId);
    expect(first).toMatchObject({ config: configA, data: dataA, key: '', auth: '' });
    process.env.XDG_CONFIG_HOME = join(root, 'config-b'); process.env.XDG_DATA_HOME = join(root, 'data-b');
    const { createOwnedSessionStore } = await import('@/lib/runtimes/shared/owned-session');
    const { museOwnedAdapter } = await import('@/lib/muse/owned');
    const cold = createOwnedSessionStore(museOwnedAdapter);
    expect((await cold.resume(launched.surfaceId, 'second')).ok).toBe(true);
    const resumed = await answer(launched.surfaceId, 'second\n\n'
      + 'The o8 command on PATH is verified for this run. Use o8 packet commands directly; do not construct source-loader wrappers.');
    expect(resumed).toMatchObject({ config: configA, data: dataA });
    expect(resumed.args).toEqual(expect.arrayContaining(['--session-id', 'native-fixture-session']));
    process.env.XDG_CONFIG_HOME = configA; process.env.XDG_DATA_HOME = dataA;
  }, 120_000);

  it.skipIf(process.platform !== 'darwin')('pins an existing work mode before spawn and enforces read-only writes on macOS', async () => {
    const { museRuntime } = await import('@/lib/runtimes/muse');
    const launched = await museRuntime.launch({ cwd: repo, prompt: 'write-denied', workMode: 'read-only' });
    surfaces.push(launched.sessionKey!); expect(launched.ok).toBe(true);
    const result = await answer(launched.sessionKey!);
    expect(result).toMatchObject({ denied: true, config: configA, data: dataA });
    expect(result.args).toEqual(expect.arrayContaining(['--disable-shell', '--disable-write']));
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('unchanged\n');
  }, 60_000);

  it('stops its real owned process without retiring the conversation', async () => {
    const { museOwnedStore } = await import('@/lib/muse/owned');
    const launched = await museOwnedStore.launch({ cwd: repo, prompt: 'hold', runtimeConfig: { workMode: 'write' } });
    surfaces.push(launched.surfaceId); expect(launched.ok).toBe(true);
    await vi.waitFor(async () => {
      const sources = await museOwnedStore.getTelemetrySources(launched.surfaceId);
      expect(sources?.stdoutPaths.some(file => readFileSync(file, 'utf8').includes('session.run.linked'))).toBe(true);
    }, { timeout: 10_000 });
    const stopped = await museOwnedStore.interrupt(launched.surfaceId);
    expect(stopped).toMatchObject({ interrupted: true });
    expect(await museOwnedStore.sessionState(launched.surfaceId)).toBe('active');
  }, 60_000);
});
