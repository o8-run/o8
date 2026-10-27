import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import { buildPiWriteHelper } from './helpers/pi-write-helper';

const preflight = vi.hoisted(() => ({ shift: false, clock: undefined as { mockRestore(): void } | undefined }));
vi.mock('@/lib/workspace/dependency-manager-executable', async original => {
  const actual = await original<typeof import('@/lib/workspace/dependency-manager-executable')>();
  return { ...actual, resolveReceiptedPackageManagerExecution: async (...args: Parameters<typeof actual.resolveReceiptedPackageManagerExecution>) => {
    const execution = await actual.resolveReceiptedPackageManagerExecution(...args);
    if (preflight.shift) preflight.clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 300_001);
    return execution;
  } };
});

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ assertRuntimeDispatchable: async () => undefined }));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: async () => ({ ready: true }) }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: async () => undefined }));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: async () => false }));
vi.mock('@/lib/worktree/storage-telemetry', async (original) => ({
  ...await original<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: async () => ({ accountingStatus: 'observed', probePath: '/',
    availableBytes: 90_000_000_000, freeBytes: 90_000_000_000, totalBytes: 100_000_000_000, error: null }),
}));

const root = mkdtempSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'launch-stages-'));
const binary = join(root, 'worker');
const capture = join(root, 'spawned');
const npmCli = process.env.O8_MEASURE_NPM_CLI ?? process.env.npm_execpath!;
const changes = {
  CORTEX_IDE_DATA_DIR: root, O8_DATA_DIR: root,
  O8_WORKTREE_ROOT: join(root, 'worktrees'), O8_OWNED_QODER_ROOT: join(root, 'owned'), O8_QODER_BIN: binary,
  O8_SKIP_PRELAUNCH_TYPECHECK: '1', O8_APFS_DEPENDENCY_IMAGES: '0', O8_CRASH_SURVIVABLE_WORKERS: '0', O8_PACKAGED_APP: '',
  PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH}`,
};
const previous = new Map(Object.keys(changes).map((name) => [name, process.env[name]]));
Object.assign(process.env, changes);
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
async function until(predicate: () => boolean) {
  const end = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('Fixture did not reach the launch stage.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeAll(async () => {
  if (process.platform !== 'win32') buildPiWriteHelper();
  mkdirSync(changes.CORTEX_IDE_DATA_DIR, { recursive: true });
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/npm'), `#!/usr/bin/env node
    const fs = require('node:fs'), cp = require('node:child_process');
    const args = process.argv.slice(2);
    if (args[0] !== 'ci' || fs.existsSync(${JSON.stringify(join(root, 'real-install'))})) {
      const result = cp.spawnSync(process.execPath, [${JSON.stringify(npmCli)}, ...args], { stdio: 'inherit' });
      process.exit(result.status ?? 1);
    }
    fs.mkdirSync('node_modules/.bin', { recursive: true });
    fs.cpSync('tool', 'node_modules/launch-tool', { recursive: true });
    fs.chmodSync('node_modules/launch-tool/index.js', 0o755);
    fs.symlinkSync('../launch-tool/index.js', 'node_modules/.bin/launch-check');
    const result = cp.spawnSync(process.execPath, ['install.cjs'], { stdio: 'inherit' });
    process.exit(result.status ?? 1);
  `);
  chmodSync(join(root, 'bin/npm'), 0o755);
  writeFileSync(binary, `#!/usr/bin/env node
    if (process.argv.includes('--version')) { console.log('worker 1.0.0'); process.exit(0); }
    require('node:fs').appendFileSync(${JSON.stringify(capture)}, 'spawned\\n');
    console.log('fixture complete');
    setTimeout(() => process.exit(0), 100);
  `);
  chmodSync(binary, 0o755);
  vi.stubGlobal('fetch', async () => Response.json({ ok: true }));
  const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
  await updateOperatorDefaults({ productTelemetryEnabled: false, storageReserveRatio: 0.0001, storageReserveFloorGb: 0.001 });
});
afterAll(async () => {
  const { closeDb } = await import('@/lib/db');
  closeDb();
  vi.unstubAllGlobals();
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

async function fixture(stalled: boolean | 'failed', id = stalled ? 'stalled-install' : 'stalled-runtime', source?: string, detached = false) {
  const repo = join(root, id);
  const entered = join(root, `${id}-install-started`);
  const completed = join(root, `${id}-install-completed`);
  const release = join(root, `${id}-release`);
  const cache = join(root, `${id}-cache`);
  const escaped = join(root, `${id}-detached`);
  if (source) {
    execFileSync('git', ['clone', '--local', '--no-hardlinks', '--single-branch', '-q', source, repo], { stdio: 'pipe' });
    git(repo, 'checkout', '-B', 'main');
    git(repo, 'remote', 'set-url', 'origin', repo);
    cpSync(join(source, 'node_modules'), join(repo, 'node_modules'), { recursive: true, mode: constants.COPYFILE_FICLONE });
    const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
    const certificate = process.env.NODE_EXTRA_CA_CERTS ?? process.env.SSL_CERT_FILE;
    if (proxy) {
      const parsed = new URL(proxy);
      if (parsed.username || parsed.password) throw new Error('Measurement proxy must not contain credentials.');
      let config = readFileSync(join(repo, '.npmrc'), 'utf8');
      config += `\nproxy=${JSON.stringify(proxy)}\nhttps-proxy=${JSON.stringify(proxy)}\n`;
      if (certificate) {
        copyFileSync(certificate, join(repo, '.measurement-ca.pem'));
        config += 'cafile=.measurement-ca.pem\n';
      }
      writeFileSync(join(repo, '.npmrc'), config);
      git(repo, 'add', '.npmrc', ...(certificate ? ['.measurement-ca.pem'] : []));
      git(repo, '-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'public download transport');
    }
    git(repo, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    git(repo, 'branch', '--set-upstream-to=origin/main', 'main');
  } else {
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    mkdirSync(join(repo, 'tool'));
    writeFileSync(join(repo, 'tool/package.json'), JSON.stringify({ name: 'launch-tool', version: '1.0.0', bin: { 'launch-check': 'index.js' } }));
    writeFileSync(join(repo, 'tool/index.js'), '#!/usr/bin/env node\nprocess.exit(0);\n');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'launch-stage-fixture', version: '1.0.0', private: true,
      scripts: { lint: 'launch-check', postinstall: 'node install.cjs' }, devDependencies: { 'launch-tool': 'file:tool' } }));
    const leaf = `const fs = require('node:fs');
      process.on('SIGTERM', () => {});
      fs.writeFileSync(${JSON.stringify(escaped)}, String(process.pid));
      setInterval(() => {}, 1000);`;
    const launcher = `const cp = require('node:child_process');
      const child = cp.spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], { detached: true, stdio: 'ignore' });
      child.unref();`;
    writeFileSync(join(repo, 'install.cjs'), `const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(cache)}, process.env.npm_config_cache);
      ${detached ? `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(launcher)}], { stdio: 'ignore' });
        child.once('exit', () => fs.writeFileSync(${JSON.stringify(entered)}, String(process.pid)));`
      : `fs.writeFileSync(${JSON.stringify(entered)}, String(process.pid));`}
      const done = () => { fs.writeFileSync(${JSON.stringify(completed)}, 'complete'); process.exit(0); };
      ${stalled === true ? `setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) done(); }, 10);` : stalled === 'failed' ? 'process.exit(1);' : 'done();'}
    `);
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], {
      cwd: repo, stdio: 'pipe', env: { PATH: process.env.PATH, NODE_ENV: 'test', npm_config_cache: join(root, 'cache') },
    });
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'fixture');
    git(repo, 'remote', 'add', 'origin', repo);
  }
  const { addRepo } = await import('@/lib/repos/registry');
  await addRepo(repo);
  const packet = { id, referenceLabel: id, title: 'Launch fixture', summary: 'Exercise launch stage deadlines.',
    workspaceTargetPath: repo, branchTarget: `packet/${id}`, runtime: 'qoder', dependencyLabels: [], dependencyPacketIds: [],
    queueState: 'queued', releaseState: 'pending', status: 'queued', blockedReason: null, lane: null, review: null,
    workerRouting: { requestedRuntime: 'qoder' } as OrchestratorPacket['workerRouting'] } as OrchestratorPacket;
  const state = { missionId: id, repoPath: repo, packets: [packet], updatedAt: new Date().toISOString() } as OrchestratorMissionState;
  const control = await import('@/lib/orchestrator/control-plane');
  control.writeOrchestratorControlPlaneState(state);
  return { id, state, entered, completed, release, cache, escaped };
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return false;
  }
}

it.runIf(process.platform !== 'win32' && !process.env.O8_MEASURE_CLEAN_DISPATCH)(
  'stops an owned detached orphan before returning the install deadline failure', async () => {
    const data = await fixture(true, 'detached-install', undefined, true);
    const { runDispatchTick } = await import('@/lib/orchestrator/scheduling');
    const lanes = await import('@/lib/lane/registry');
    const pending = runDispatchTick(data.state, { launchBudget: { maxLaunches: 1 } });
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore', env: { NODE_ENV: 'test' } });
    const unrelatedClosed = new Promise<void>(resolve => unrelated.once('close', () => resolve()));
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    let pid = 0;
    try {
      await until(() => existsSync(data.entered) && existsSync(data.escaped));
      pid = Number(readFileSync(data.escaped, 'utf8'));
      expect(alive(pid)).toBe(true);
      expect(Number(execFileSync('ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8' }).trim())).toBe(pid);
      clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 300_001);
      await pending;
      expect(alive(pid), 'owned detached lifecycle process must be stopped before dispatch returns').toBe(false);
      expect(alive(unrelated.pid!)).toBe(true);
      const lane = lanes.findLatestLaneByPacket(data.id)!;
      expect(lane.status).toBe('failed');
      expect(lane.outcomeNote).toContain('The install process group and its owned detached children were stopped.');
    } finally {
      clock?.mockRestore();
      writeFileSync(data.release, 'release');
      await pending.catch(() => undefined);
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
      unrelated.kill('SIGKILL');
      await unrelatedClosed;
    }
  },
);

it.skipIf(Boolean(process.env.O8_MEASURE_CLEAN_DISPATCH))('releases the cache lease after a stalled postinstall reaches its deadline', async () => {
  const data = await fixture(true, 'lease-timeout');
  const { runDispatchTick } = await import('@/lib/orchestrator/scheduling');
  const pending = runDispatchTick(data.state, { launchBudget: { maxLaunches: 1 } });
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await until(() => existsSync(data.entered));
    const cacheRoot = dirname(readFileSync(data.cache, 'utf8'));
    const leases = () => readdirSync(cacheRoot).filter(name => name.startsWith('.o8-active-'));
    expect(leases()).toHaveLength(1);
    clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 300_001);
    await pending;
    expect(leases(), 'a settled failed installer must not retain its cache reservation').toEqual([]);
    expect(existsSync(join(cacheRoot, '.o8-cache.json'))).toBe(true);
  } finally {
    clock?.mockRestore();
    writeFileSync(data.release, 'release');
    await pending.catch(() => undefined);
  }
});

it.skipIf(Boolean(process.env.O8_MEASURE_CLEAN_DISPATCH))('releases the cache lease when postinstall exits with a failure', async () => {
  const data = await fixture('failed', 'failed-install');
  const { runDispatchTick } = await import('@/lib/orchestrator/scheduling');
  const lanes = await import('@/lib/lane/registry');
  await runDispatchTick(data.state, { launchBudget: { maxLaunches: 1 } });
  expect(lanes.findLatestLaneByPacket(data.id)?.status).toBe('failed');
  const cacheRoot = dirname(readFileSync(data.cache, 'utf8'));
  expect(readdirSync(cacheRoot).filter(name => name.startsWith('.o8-active-'))).toEqual([]);
  expect(existsSync(join(cacheRoot, '.o8-cache.json'))).toBe(true);
});

it.skipIf(Boolean(process.env.O8_MEASURE_CLEAN_DISPATCH))('fails a dispatched lane at the package-manager invocation deadline and retires its lifecycle child', async () => {
  const data = await fixture(true);
  const { runDispatchTick } = await import('@/lib/orchestrator/scheduling');
  const lanes = await import('@/lib/lane/registry');
  const pending = runDispatchTick(data.state, { launchBudget: { maxLaunches: 1 } });
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await until(() => existsSync(data.entered));
    clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 300_001);
    const result = await pending;
    const lane = lanes.findLatestLaneByPacket(data.id)!;
    expect(lane.status).toBe('failed');
    expect(result.packets[0].blockedReason).toContain('dependency_install_timeout');
    expect(lanes.getLaneEvents(lane.id, 200)).toEqual(expect.arrayContaining([
      expect.objectContaining({ verb: 'worktree_preparation_timing', payload: expect.objectContaining({
        stage: 'dependency_install', phase: 'failed', reason: 'deadline_exceeded', elapsedMs: expect.any(Number),
      }) }),
    ]));
    const failed = lanes.getLaneEvents(lane.id, 200).find(event => event.verb === 'worktree_preparation_timing'
      && event.payload.stage === 'dependency_install' && event.payload.phase === 'failed');
    expect(failed?.payload.elapsedMs).toBeGreaterThanOrEqual(300_000);
    expect(failed?.payload.deadlineMs).toBe(300_000);
  } finally {
    clock?.mockRestore();
    writeFileSync(data.release, 'release');
    await pending.catch(() => undefined);
  }
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(existsSync(data.completed)).toBe(false);
  expect(existsSync(capture)).toBe(false);
});

it.skipIf(Boolean(process.env.O8_MEASURE_CLEAN_DISPATCH))('starts the install deadline after preparation and records their durations separately', async () => {
  const data = await fixture(false);
  const { runDispatchTick } = await import('@/lib/orchestrator/scheduling');
  const lanes = await import('@/lib/lane/registry');
  preflight.shift = true;
  try {
    await runDispatchTick(data.state, { launchBudget: { maxLaunches: 1 } });
    const lane = lanes.findLatestLaneByPacket(data.id)!;
    expect(lane.status).toBe('running');
    const events = lanes.getLaneEvents(lane.id, 200).filter(event => event.verb === 'worktree_preparation_timing');
    const preparation = events.find(event => event.payload.stage === 'dependency_preparation')!;
    expect(preparation?.payload.elapsedMs).toBeGreaterThanOrEqual(300_000);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ stage: 'dependency_install', phase: 'started', elapsedMs: 0 }) }),
      expect.objectContaining({ payload: expect.objectContaining({ stage: 'dependency_install', phase: 'completed', elapsedMs: 0 }) }),
    ]));
    await until(() => lanes.getLaneEvents(lane.id, 200).some(event => event.verb === 'runtime_process_exit'));
  } finally { preflight.clock?.mockRestore(); preflight.shift = false; }
});

it.skipIf(!process.env.O8_MEASURE_CLEAN_DISPATCH)('measures a clean dispatch with the parent dependency tree present', async () => {
  writeFileSync(join(root, 'real-install'), 'enabled');
  const data = await fixture(false, 'measured-dispatch', process.cwd());
  const { runDispatchTick } = await import('@/lib/orchestrator/scheduling');
  const lanes = await import('@/lib/lane/registry');
  const started = performance.now();
  const result = await runDispatchTick(data.state, { launchBudget: { maxLaunches: 1 } });
  const lane = lanes.findLatestLaneByPacket(data.id)!;
  const stages = lanes.getLaneEvents(lane.id, 500).filter(event => ['worktree_preparation_timing', 'runtime_launch_step'].includes(event.verb)).map(({ payload }) => ({
    stage: payload.stage ?? payload.step, phase: payload.phase, elapsedMs: payload.elapsedMs ?? payload.durationMs,
    deadlineMs: payload.deadlineMs, reason: payload.reason, completed: payload.completed,
  }));
  writeFileSync(process.env.O8_MEASURE_LAUNCH_OUTPUT!, JSON.stringify({ platform: process.platform, architecture: process.arch,
    totalMs: Math.round(performance.now() - started), status: lane.status, blocked: result.packets[0].status === 'blocked', stages }, null, 2));
  expect(stages.some(stage => stage.stage === 'dependency_install')).toBe(true);
  if (lane.status === 'running') await until(() => lanes.getLaneEvents(lane.id, 200).some(event => event.verb === 'runtime_process_exit'));
}, 360_000);

