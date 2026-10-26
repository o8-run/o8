import { execFileSync } from 'node:child_process';
import { chmodSync, constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

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

async function fixture(stalled: boolean, id = stalled ? 'stalled-install' : 'stalled-runtime', source?: string) {
  const repo = join(root, id);
  const entered = join(root, `${id}-install-started`);
  const completed = join(root, `${id}-install-completed`);
  const release = join(root, `${id}-release`);
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
    writeFileSync(join(repo, 'install.cjs'), `const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(entered)}, String(process.pid));
      const done = () => { fs.writeFileSync(${JSON.stringify(completed)}, 'complete'); process.exit(0); };
      ${stalled ? `setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) done(); }, 10);` : 'done();'}
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
  return { id, state, entered, completed, release };
}

it.skipIf(Boolean(process.env.O8_MEASURE_CLEAN_DISPATCH))('fails a dispatched lane at the package-manager invocation deadline and retires its lifecycle child', async () => {
  const data = await fixture(true);
  const { runDispatchTick } = await import('@/lib/orchestrator/scheduling');
  const lanes = await import('@/lib/lane/registry');
  const pending = runDispatchTick(data.state, { launchBudget: { maxLaunches: 1 } });
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await until(() => existsSync(data.entered));
    clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 300_001);
    const result = await Promise.race([pending, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Install did not honor its deadline.')), 2500))]);
    const lane = lanes.findLatestLaneByPacket(data.id)!;
    expect(lane.status).toBe('failed');
    expect(result.packets[0].blockedReason).toContain('dependency_install_timeout');
    expect(lanes.getLaneEvents(lane.id, 200)).toEqual(expect.arrayContaining([
      expect.objectContaining({ verb: 'worktree_preparation_timing', payload: expect.objectContaining({
        stage: 'dependency_install', phase: 'failed', reason: 'deadline_exceeded', elapsedMs: expect.any(Number),
      }) }),
    ]));
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

