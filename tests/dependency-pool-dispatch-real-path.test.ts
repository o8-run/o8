import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({
  ensureDispatchBackendReady: vi.fn(async () => ({ ready: true })),
}));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn() }));
vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed', probePath: '/', availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000, totalBytes: 100_000_000_000, error: null,
  })),
}));

const root = realpathSync(mkdtempSync(path.join(process.env.CORTEX_IDE_DATA_DIR!, 'dependency-pool-dispatch-')));
const repo = path.join(root, 'repo');
const bin = path.join(root, 'bin');
const capture = path.join(root, 'spawn.json');
const oldEnv = { ...process.env };
const npmCli = process.env.npm_execpath!;
Object.assign(process.env, {
  CORTEX_IDE_DATA_DIR: root,
  O8_DATA_DIR: root,
  O8_WORKTREE_ROOT: path.join(root, 'worktrees'),
  O8_OWNED_QODER_ROOT: path.join(root, 'owned-qoder'),
  O8_QODER_BIN: path.join(bin, 'qodercli'),
  O8_CRASH_SURVIVABLE_WORKERS: '0', O8_PACKAGED_APP: '0',
  O8_APFS_DEPENDENCY_IMAGES: '0', O8_APFS_COW_WORKSPACES: '1',
  O8_SKIP_PRELAUNCH_TYPECHECK: '1',
  PATH: `${bin}${path.delimiter}${process.env.PATH}`,
});

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
}

afterAll(async () => {
  const { waitForDependencyDirectoryPool } = await import('@/lib/workspace/dependency-directory-pool');
  await waitForDependencyDirectoryPool();
  const { closeDb } = await import('@/lib/db');
  closeDb();
  vi.unstubAllGlobals();
  for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
  Object.assign(process.env, oldEnv);
  rmSync(root, { recursive: true, force: true });
});

it.skipIf(process.platform !== 'darwin')('dispatches from a ready dependency pool without a clone or install and persists the pool selection', async () => {
  mkdirSync(repo);
  mkdirSync(bin);
  git('init', '-q', '-b', 'main');
  const npmVersion = execFileSync(process.execPath, [npmCli, '--version'], { encoding: 'utf8' }).trim();
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\nvendor/\n');
  writeFileSync(path.join(repo, 'README.md'), 'committed\n');
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
    name: 'launch-budget-fixture', version: '1.0.0', packageManager: `npm@${npmVersion}`,
    o8DependencyClone: { lifecycleInputs: [] },
    scripts: {
      test: 'node -e "process.exit(0)"',
      prebuild: 'node -e "require(\'fs\').writeFileSync(\'generated.pre\',\'ready\')"',
      build: 'node -e "if(!require(\'fs\').existsSync(\'generated.pre\')||process.env.npm_config_offline!==\'true\')process.exit(41);require(\'fs\').writeFileSync(\'generated.ready\',\'ready\')"',
      postinstall: 'npm run build',
    },
  }));
  const installedPackages = { 'node_modules/fixture': { version: '1.0.0' } };
  writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: installedPackages }));
  mkdirSync(path.join(repo, 'tools'));
  writeFileSync(path.join(repo, 'tools/package.json'), '{"name":"unrelated-tool"}');
  git('add', '.');
  git('-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'fixture');
  git('-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '--allow-empty', '-qm', 'packet base');
  git('remote', 'add', 'origin', repo);
  // The running checkout advances while the packet remains pinned to main.
  git('checkout', '-qb', 'donor');
  writeFileSync(path.join(repo, 'README.md'), 'donor documentation update\n');
  git('add', 'README.md');
  git('-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'docs only');
  mkdirSync(path.join(repo, 'node_modules', 'fixture'), { recursive: true });
  writeFileSync(path.join(repo, 'node_modules', 'fixture', 'index.js'), 'module.exports = 42;\n');
  writeFileSync(path.join(repo, 'node_modules', 'fixture', 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  writeFileSync(path.join(repo, 'node_modules', '.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: installedPackages }));
  // The external package-manager fixture never installs packages or uses the network.
  writeFileSync(path.join(bin, 'npm'), [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const cp = require('node:child_process');",
    `const npmCli = ${JSON.stringify(npmCli)};`,
    "const args = process.argv.slice(2);",
    "if (args[0] !== 'ci') { const result = cp.spawnSync(process.execPath, [npmCli, ...args], { stdio: 'inherit' }); process.exit(result.status ?? 1); }",
    "fs.writeFileSync('installer-fallback.txt', 'ci\\n');",
    "fs.mkdirSync('node_modules/fixture', { recursive: true });",
    "fs.writeFileSync('node_modules/fixture/index.js', 'module.exports = 42;\\n');",
    "const result = cp.spawnSync(process.execPath, [npmCli, 'rebuild', '.', '--offline'], { stdio: 'inherit' }); process.exit(result.status ?? 1);",
  ].join('\n'));
  chmodSync(path.join(bin, 'npm'), 0o755);
  writeFileSync(path.join(bin, 'qodercli'), [
    '#!/usr/bin/env node',
    "if (process.argv.includes('--version')) { console.log('qodercli 1.0.0'); process.exit(0); }",
    `require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ cwd: process.cwd(), prepared: require('node:fs').existsSync('generated.ready') }));`,
  ].join('\n'));
  chmodSync(path.join(bin, 'qodercli'), 0o755);
  const { materializeDependencyInstall } = await import('@/lib/workspace/dependency-materializer');
  await materializeDependencyInstall(repo, 'npm ci --offline', { run: async () => {}, useDependencyPool: false });
  writeFileSync(path.join(repo, 'README.md'), 'source WIP\n');
  const seed = path.join(root, 'seed');
  execFileSync('git', ['clone', '--local', '-q', repo, seed]);
  await materializeDependencyInstall(seed, 'npm ci --offline', { cloneSourceWorkspace: repo, useDependencyPool: true });
  const { waitForDependencyDirectoryPool, dependencyDirectoryPoolStatus } = await import('@/lib/workspace/dependency-directory-pool');
  await waitForDependencyDirectoryPool();
  expect(await dependencyDirectoryPoolStatus()).toMatchObject({ state: 'ready', readyTrees: 2 });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  const [{ addRepo, updateRepo }, { runDispatchTick }, lanes, control] = await Promise.all([
    import('@/lib/repos/registry'), import('@/lib/orchestrator/scheduling'),
    import('@/lib/lane/registry'), import('@/lib/orchestrator/control-plane'),
  ]);
  const registration = await addRepo(repo);
  await updateRepo(registration.id, { setup: { ...registration.setup, workspaceIsolationPreference: 'auto', installCommand: 'npm ci --offline' } });
  const packet = {
    id: 'pkt-launch-budget', referenceLabel: 'LAUNCH-BUDGET', title: 'Launch fixture',
    summary: 'Measure dispatch to the persisted launch event.', workspaceTargetPath: repo,
    branchTarget: 'packet/launch-budget', runtime: 'qoder', dependencyLabels: [], dependencyPacketIds: [],
    queueState: 'queued', releaseState: 'pending', status: 'queued', blockedReason: null,
    lane: null, review: null, workerRouting: { requestedRuntime: 'qoder' } as OrchestratorPacket['workerRouting'],
  } as OrchestratorPacket;
  const state = { missionId: 'launch-budget', repoPath: repo, packets: [packet], updatedAt: new Date().toISOString() } as OrchestratorMissionState;
  control.writeOrchestratorControlPlaneState(state);
  const dispatchStartedAt = Date.now();
  const started = performance.now();
  const result = await runDispatchTick(state, { launchBudget: { maxLaunches: 1 } });
  const elapsedMs = Math.round(performance.now() - started);
  const lane = lanes.findLatestLaneByPacket(packet.id);
  const events = lane ? lanes.getLaneEvents(lane.id, 200) : [];
  const launched = events.find((event) => event.payload.eventLabel === 'session_launched');
  const timings = events.filter((event) => event.verb === 'worktree_preparation_timing').map((event) => event.payload);
  const sessionMs = launched ? new Date(launched.timestamp).getTime() - dispatchStartedAt : null;
  console.log('[packet-launch-budget]', JSON.stringify({ elapsedMs, sessionMs, timings, launched: Boolean(launched) }));
  expect(result.packets[0]?.status, result.packets[0]?.blockedReason ?? undefined).toBe('launching');
  expect(launched).toBeDefined();
  expect(events.some((event) => event.verb === 'dependency_materialized')).toBe(true);
  const workspace = lane!.worktreePath!;
  for (let attempt = 0; attempt < 100 && !existsSync(capture); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(realpathSync(JSON.parse(readFileSync(capture, 'utf8')).cwd)).toBe(realpathSync(workspace));
  expect(JSON.parse(readFileSync(capture, 'utf8')).prepared).toBe(true);
  expect(readFileSync(path.join(workspace, 'README.md'), 'utf8')).toBe('committed\n');
  const privateFile = path.join(workspace, 'node_modules', 'fixture', 'index.js');
  expect(lstatSync(privateFile).ino).not.toBe(lstatSync(path.join(repo, 'node_modules', 'fixture', 'index.js')).ino);
  writeFileSync(privateFile, 'worker mutation\n');
  expect(readFileSync(path.join(repo, 'node_modules', 'fixture', 'index.js'), 'utf8')).toBe('module.exports = 42;\n');
  expect(readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('source WIP\n');
  if (process.platform !== 'darwin') return;
  expect(existsSync(path.join(workspace, 'installer-fallback.txt'))).toBe(false);
  expect(events.filter((event) => event.verb === 'worktree_preparation_timing'
    && event.payload.stage === 'dependency_selection').map((event) => event.payload)).toContainEqual(
    expect.objectContaining({ path: 'dependency-pool', reason: 'matching-inputs' }),
  );
}, 240_000);
