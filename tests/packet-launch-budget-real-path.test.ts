import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

vi.mock('@/lib/codex/live-capacity', () => ({ readLiveCodexRuntimeCapacity: vi.fn(async () => ({ runtime: 'codex', identityId: null, status: 'unavailable',
  reason: 'fixture', observedAt: null, source: null, confidence: null, buckets: [] })) }));
vi.mock('@/lib/claude-code/live-capacity', () => ({ readClaudeAccountCapacity: vi.fn(async () => ({ runtime: 'claude-code', identityId: null, status: 'unavailable',
  reason: 'fixture', observedAt: null, source: null, confidence: null, buckets: [] })) }));
vi.mock('@/lib/workspace/exact-parent-operation', async original => ({ ...await original<typeof import('@/lib/workspace/exact-parent-operation')>() }));

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({
  ensureDispatchBackendReady: vi.fn(async () => ({ ready: true })),
}));
vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>() }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn() }));
vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed', probePath: '/', availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000, totalBytes: 100_000_000_000, error: null,
  })),
}));

const root = realpathSync(mkdtempSync(path.join(process.env.CORTEX_IDE_DATA_DIR!, 'launch-budget-')));
const repo = path.join(root, 'repo');
const bin = path.join(root, 'bin');
const hold = path.join(root, 'hold-installer');
const installing = path.join(root, 'installer-started');
const concurrent = process.env.O8_SPEED_CONCURRENT === '1';
const slowRefill = process.env.O8_SPEED_COLD_DURING_REFILL === '1';
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

interface OutputObservation { cwd: string; prepared: boolean; outputAt: number; startedAt: string }
function observeOutput(workspace: string): OutputObservation | undefined {
  const ownedRoot = path.join(root, 'owned-qoder');
  if (!existsSync(ownedRoot)) return undefined;
  for (const name of readdirSync(ownedRoot)) {
    const file = path.join(ownedRoot, name, 'session.json');
    if (!existsSync(file)) continue;
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    for (const run of [saved.activeRun, ...(saved.recentRuns ?? [])].filter(Boolean)) {
      if (!existsSync(run.stdoutPath)) continue;
      for (const line of readFileSync(run.stdoutPath, 'utf8').split('\n')) {
        try {
          const row = JSON.parse(line);
          if (row.message?.content === 'SPEED_READY' && row.fixture?.cwd === realpathSync(workspace)) {
            return { ...row.fixture, startedAt: run.startedAt };
          }
        } catch { /* A trailing partial stdout line is not an observation. */ }
      }
    }
  }
  return undefined;
}

afterAll(async () => {
  const lanes = await import('@/lib/lane/registry');
  const { routeAction } = await import('@/lib/runtimes/registry');
  for (const id of ['pkt-launch-budget', 'pkt-launch-budget-two']) {
    const lane = lanes.findLatestLaneByPacket(id);
    if (lane?.sessionKey) await routeAction('qoder', 'interrupt', lane.sessionKey);
  }
  const pool = await import('@/lib/worktree/launch');
  await pool.shutdownWarmPacketWorktrees();
  const { readWorktreeMetaSnapshot } = await import('@/lib/worktree/metadata-store');
  expect(Object.values(await readWorktreeMetaSnapshot(repo)).filter(entry => entry.warmPool)).toHaveLength(0);
  const { probeLiveProcessInside } = await import('@/lib/worktree/live-process-guard');
  const { readProcessCwdSnapshot } = await import('@/lib/runtime/process-cwd-snapshot');
  await vi.waitFor(async () => expect((await probeLiveProcessInside(root, {
    readSnapshot: () => readProcessCwdSnapshot({ forceRefresh: true }),
  })).status).toBe('clear'), { timeout: 10_000 });
  const { closeDb } = await import('@/lib/db');
  closeDb();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
  Object.assign(process.env, oldEnv);
  rmSync(root, { recursive: true, force: true });
}, 600_000);

it('dispatches through a matching warm worktree without dependency preparation', async () => {
  mkdirSync(repo);
  mkdirSync(bin);
  git('init', '-q', '-b', 'main');
  const npmVersion = execFileSync(process.execPath, [npmCli, '--version'], { encoding: 'utf8' }).trim();
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\nvendor/\n.env\n.env.local\n');
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
  // Required ignored assets are provided with a private directory clone.
  mkdirSync(path.join(repo, 'vendor'));
  for (let index = 0; index < 2_000; index += 1) {
    writeFileSync(path.join(repo, 'vendor', `${index}.js`), `module.exports = ${index};\n`);
  }
  mkdirSync(path.join(repo, 'node_modules', 'fixture'), { recursive: true });
  writeFileSync(path.join(repo, 'node_modules', 'fixture', 'index.js'), 'module.exports = 42;\n');
  writeFileSync(path.join(repo, 'node_modules', 'fixture', 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  writeFileSync(path.join(repo, 'node_modules', '.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: installedPackages }));
  writeFileSync(path.join(repo, 'README.md'), 'source WIP\n');
  writeFileSync(path.join(repo, '.env'), 'FIXTURE_SETTING=source-only\n');
  // The external package-manager fixture never installs packages or uses the network.
  writeFileSync(path.join(bin, 'npm'), [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const cp = require('node:child_process');",
    ...(process.env.O8_SPEED_DEPENDENCY_PAYLOAD ? [
      `const payload = ${JSON.stringify(path.resolve(process.env.O8_SPEED_DEPENDENCY_PAYLOAD))};`,
    ] : ['const payload = null;']),
    `const npmCli = ${JSON.stringify(npmCli)};`,
    "const args = process.argv.slice(2);",
    "if (args[0] !== 'ci') { const result = cp.spawnSync(process.execPath, [npmCli, ...args], { stdio: 'inherit' }); process.exit(result.status ?? 1); }",
    "fs.writeFileSync('installer-fallback.txt', 'ci\\n');",
    ...(slowRefill ? [`if (require('node:path').basename(process.cwd()).startsWith('warm-')) { fs.writeFileSync(${JSON.stringify(installing)}, 'ready'); while (fs.existsSync(${JSON.stringify(hold)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); }`] : []),
    "if (payload) fs.cpSync(payload, 'node_modules', { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });",
    "fs.mkdirSync('node_modules/fixture', { recursive: true });",
    "for (let i = 0; i < 64; i++) fs.writeFileSync('node_modules/fixture/data-' + i, 'fixture');",
    "const path = require('node:path');",
    "const contained = path.relative(process.cwd(), process.env.HOME).startsWith('.o8-install-runtime/');",
    "const isolatedConfig = process.env.npm_config_userconfig === path.join(path.dirname(process.env.HOME), 'config/user.rc') && process.env.npm_config_globalconfig === path.join(path.dirname(process.env.HOME), 'config/global.rc');",
    "fs.writeFileSync('installer-runtime.json', JSON.stringify({ contained, isolatedConfig }));",
    "fs.writeFileSync('node_modules/fixture/index.js', 'module.exports = 42;\\n');",
    ...(process.env.O8_SPEED_ABSOLUTE_LINK ? ["fs.symlinkSync(require('node:path').resolve('node_modules/fixture/index.js'), 'node_modules/fixture/absolute');"] : []),
    "const result = cp.spawnSync(process.execPath, [npmCli, 'rebuild', '.', '--offline'], { stdio: 'inherit' }); process.exit(result.status ?? 1);",
  ].join('\n'));
  chmodSync(path.join(bin, 'npm'), 0o755);
  writeFileSync(path.join(bin, 'qodercli'), [
    '#!/usr/bin/env node',
    "if (process.argv.includes('--version')) { console.log('qodercli 1.0.0'); process.exit(0); }",
    "console.log(JSON.stringify({ type: 'assistant', message: { content: 'SPEED_READY' }, fixture: { cwd: process.cwd(), prepared: require('node:fs').existsSync('generated.ready'), outputAt: Date.now() } }));",
    // Keep the fixture signalable until the real owned runtime records its PID.
    // Test cleanup interrupts only the session returned by this dispatch.
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  chmodSync(path.join(bin, 'qodercli'), 0o755);
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
  const packets = concurrent ? [packet, { ...packet, id: packet.id + '-two', branchTarget: packet.branchTarget + '-two' }] : [packet];
  const state = { missionId: 'launch-budget', repoPath: repo, packets, updatedAt: new Date().toISOString() } as OrchestratorMissionState;
  control.writeOrchestratorControlPlaneState(state);
  const readMainHooks = () => { try { return git('config', '--local', '--get', 'core.hooksPath'); } catch { return null; } };
  const mainHooks = readMainHooks();
  const warm = process.env.O8_SPEED_WARM !== '0';
  const invalidation = process.env.O8_SPEED_INVALIDATION;
  const bindingFault = process.env.O8_SPEED_BINDING_FAULT === '1';
  const inodeSwap = process.env.O8_SPEED_INODE_SWAP === '1';
  const hooksFault = process.env.O8_SPEED_HOOKS_FAULT;
  const nonRelocatable = process.env.O8_SPEED_ABSOLUTE_LINK === '1';
  if (process.env.O8_SPEED_REMOTE_MAIN === '1') {
    const remote = path.join(root, 'remote.git');
    execFileSync('git', ['clone', '--bare', repo, remote], { stdio: 'pipe' });
    execFileSync('git', ['--git-dir=' + remote, 'update-ref', 'refs/heads/main', git('rev-parse', 'HEAD')]);
    git('remote', 'set-url', 'origin', remote);
    git('fetch', 'origin', 'main');
  }
  const pool = await import('@/lib/worktree/launch');
  const prepare = pool.prepareWarmPacketWorktrees;
  const capacity = process.env.O8_SPEED_DEPENDENCY_PAYLOAD && !concurrent ? 1 as const : 2 as const;
  const warmOptions = { capacity, repoRoot: repo, agentType: 'qoder', baseBranch: 'main', repoSetup: { ...registration.setup, installCommand: 'npm ci --offline' } };
  let prepared: Promise<void> | undefined;
  let preparationFinished = false;
  if (slowRefill) {
    writeFileSync(hold, 'hold');
    prepared = prepare(warmOptions).then(() => { preparationFinished = true; });
    await vi.waitFor(() => expect(existsSync(installing)).toBe(true), { timeout: 60_000 });
  } else if (nonRelocatable) await expect(prepare(warmOptions)).rejects.toThrow('non-relocatable');
  else if (warm) await prepare(warmOptions);
  const { readWorktreeMetaSnapshot } = await import('@/lib/worktree/metadata-store');
  const unused = Object.values(await readWorktreeMetaSnapshot(repo)).filter(entry => entry.warmPool);
  if (warm && !nonRelocatable && !slowRefill) {
    expect(unused).toHaveLength(capacity);
    for (const entry of unused) {
      expect(entry.packetId).toBeUndefined();
      expect(entry.creationOwner).toBeDefined();
      expect(existsSync(path.join(entry.materializationIdentity!.canonicalPath, '.env'))).toBe(false);
    }
  }
  if (invalidation === 'main') git('update-ref', 'refs/heads/main', 'HEAD');
  if (invalidation === 'lock') writeFileSync(path.join(repo, 'package-lock.json'), readFileSync(path.join(repo, 'package-lock.json'), 'utf8') + '\n');
  if (bindingFault) {
    const parent = await import('@/lib/workspace/exact-parent-operation');
    const rename = parent.renameExactChildDirectory;
    vi.spyOn(parent, 'renameExactChildDirectory').mockImplementationOnce(async (...args) => {
      await rename(...args);
      throw new Error('Fixture failure immediately after rename');
    });
  }
  let swapped: string | undefined;
  if (inodeSwap) {
    swapped = unused[0]!.materializationIdentity!.canonicalPath;
    renameSync(swapped, swapped + '.retained');
    mkdirSync(swapped);
  }
  let restoreHooks: (() => void) | undefined;
  if (hooksFault) {
    const file = path.join(unused[0]!.materializationIdentity!.canonicalPath, '.claude/settings.local.json');
    const content = readFileSync(file, 'utf8');
    if (hooksFault === 'inode') {
      renameSync(file, file + '.retained');
      writeFileSync(file, content);
      restoreHooks = () => { rmSync(file); renameSync(file + '.retained', file); };
    } else {
      writeFileSync(file, '{}');
      restoreHooks = () => writeFileSync(file, content);
    }
  }
  const hit = warm && !invalidation && !nonRelocatable && !slowRefill;
  const launchBudgetMs = hit ? 3_000 : 60_000;
  const dispatchStartedAt = Date.now();
  const started = performance.now();
  const result = await runDispatchTick(state, { launchBudget: { maxLaunches: concurrent ? 2 : 1 } });
  if (slowRefill) {
    expect(preparationFinished).toBe(false);
    rmSync(hold);
    await prepared;
  }
  if (concurrent) {
    expect(result.packets.map(row => row.status)).toEqual(['launching', 'launching']);
    const paths = packets.map(row => lanes.findLatestLaneByPacket(row.id)!.worktreePath!);
    expect(new Set(paths).size).toBe(2);
    for (const workspace of paths) {
      if (hit) expect(unused.map(row => row.materializationIdentity!.inode)).toContain(lstatSync(workspace).ino);
      try {
        await vi.waitFor(() => expect(observeOutput(workspace)?.prepared).toBe(true), { timeout: 10_000 });
      } catch (error) {
        const diagnostics = readdirSync(path.join(root, 'owned-qoder')).flatMap(name => {
          const file = path.join(root, 'owned-qoder', name, 'session.json');
          if (!existsSync(file)) return [];
          const saved = JSON.parse(readFileSync(file, 'utf8'));
          return [saved.activeRun, ...(saved.recentRuns ?? [])].filter(Boolean).map(run => {
            const stdout = existsSync(run.stdoutPath) ? readFileSync(run.stdoutPath, 'utf8') : '';
            const stderr = existsSync(run.stderrPath) ? readFileSync(run.stderrPath, 'utf8') : '';
            return { status: run.status, exitCode: run.exitCode, ready: stdout.includes('SPEED_READY'),
              fixture: stdout.includes('fixture'), stderr: stderr.slice(-800).replace(/\/[^\s"']+/g, '<fixture-path>') };
          });
        });
        process.stdout.write('[fixture-output-diagnostic] ' + JSON.stringify(diagnostics) + '\n');
        throw error;
      }
    }
    return;
  }
  const elapsedMs = Math.round(performance.now() - started);
  if (bindingFault || inodeSwap || hooksFault) {
    restoreHooks?.();
    if (swapped) {
      expect(readdirSync(swapped)).toHaveLength(0);
      rmSync(swapped, { recursive: true });
      renameSync(swapped + '.retained', swapped);
    }
    expect(result.packets[0]?.status).toBe('blocked');
    const retained = Object.values(await readWorktreeMetaSnapshot(repo));
    expect(retained.filter(entry => entry.packetId)).toHaveLength(0);
    expect(retained.filter(entry => entry.warmPool)).toHaveLength(2);
    for (const entry of unused) expect(lstatSync(entry.materializationIdentity!.canonicalPath).ino).toBe(entry.materializationIdentity!.inode);
    return;
  }
  const lane = lanes.findLatestLaneByPacket(packet.id);
  const events = lane ? lanes.getLaneEvents(lane.id, 200) : [];
  const launched = events.find((event) => event.payload.eventLabel === 'session_launched');
  const timings = events.filter((event) => event.verb === 'worktree_preparation_timing').map((event) => event.payload);
  const sessionMs = launched ? new Date(launched.timestamp).getTime() - dispatchStartedAt : null;
  process.stdout.write('[packet-launch-budget] ' + JSON.stringify({ elapsedMs, sessionMs, timings, launched: Boolean(launched) }) + '\n');
  expect(result.packets[0]?.status, result.packets[0]?.blockedReason ?? undefined).toBe('launching');
  expect(launched).toBeDefined();
  expect(events.some((event) => event.verb === 'dependency_materialized')).toBe(true);
  const workspace = lane!.worktreePath!;
  expect(existsSync(path.join(workspace, '.env'))).toBe(false);
  expect(readFileSync(path.join(repo, '.env'), 'utf8')).toBe('FIXTURE_SETTING=source-only\n');
  if (hit) expect(unused.map(entry => entry.materializationIdentity!.inode)).toContain(lstatSync(workspace).ino);
  if (invalidation) expect(unused.map(entry => entry.materializationIdentity!.inode)).not.toContain(lstatSync(workspace).ino);
  await vi.waitFor(() => expect(observeOutput(workspace)).toBeDefined(), { timeout: 10_000 });
  const output = observeOutput(workspace)!;
  expect(realpathSync(output.cwd)).toBe(realpathSync(workspace));
  expect(output.prepared).toBe(true);
  expect(readFileSync(path.join(workspace, 'README.md'), 'utf8')).toBe(invalidation === 'main' || process.env.O8_SPEED_REMOTE_MAIN === '1' ? 'donor documentation update\n' : 'committed\n');
  const outputAt = output.outputAt;
  const { persistedWorkerStages } = await import(/* @vite-ignore */ path.resolve('scripts/speed/workers.mjs'));
  const stages = persistedWorkerStages(root, packet.id, dispatchStartedAt, Date.parse(output.startedAt));
  const receipt = { dispatchToOutputMs: outputAt - dispatchStartedAt, sessionMs, stages,
    spawnToOutputMs: outputAt - Date.parse(output.startedAt), warm };
  process.stdout.write('[packet-launch-output] ' + JSON.stringify(receipt) + '\n');
  if (process.env.O8_SPEED_RECEIPT) writeFileSync(process.env.O8_SPEED_RECEIPT, JSON.stringify(receipt));
  expect.soft(receipt.dispatchToOutputMs).toBeLessThan(launchBudgetMs);
  if (hit) expect.soft(stages.dependencyProvisioningMs).toBe(0);
  else expect(stages.dependencyProvisioningMs).toBeGreaterThan(0);
  if (process.platform !== 'darwin') {
    expect(JSON.parse(readFileSync(path.join(workspace, 'installer-runtime.json'), 'utf8'))).toEqual({ contained: true, isolatedConfig: true });
    expect(readdirSync(path.join(workspace, '.o8-install-runtime'))).toHaveLength(0);
  }
  if (process.platform === 'darwin') {
    const { WorktreeManager } = await import('@/lib/worktree/manager');
    const managed = await new WorktreeManager(repo).list();
    expect(managed.find((entry) => entry.path === workspace)?.hydrationPaths).toContain('vendor');
    expect(readFileSync(path.join(workspace, 'vendor/1999.js'), 'utf8')).toBe('module.exports = 1999;\n');
    writeFileSync(path.join(workspace, 'vendor/1999.js'), 'worker asset');
    expect(readFileSync(path.join(repo, 'vendor/1999.js'), 'utf8')).toBe('module.exports = 1999;\n');
  }
  const privateFile = path.join(workspace, 'node_modules', 'fixture', 'index.js');
  expect(lstatSync(privateFile).ino).not.toBe(lstatSync(path.join(repo, 'node_modules', 'fixture', 'index.js')).ino);
  writeFileSync(privateFile, 'worker mutation\n');
  expect(readFileSync(path.join(repo, 'node_modules', 'fixture', 'index.js'), 'utf8')).toBe('module.exports = 42;\n');
  expect(readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('source WIP\n');
  expect(sessionMs).toBeLessThan(60_000);
  expect(elapsedMs).toBeLessThan(60_000);
  if (process.platform !== 'darwin') return;
  expect(existsSync(path.join(workspace, 'installer-fallback.txt'))).toBe(false);
  expect(events.filter((event) => event.verb === 'worktree_preparation_timing'
    && event.payload.stage === 'dependency_selection').map((event) => event.payload)).toContainEqual(
    expect.objectContaining({ path: 'directory-clone', reason: 'matching-inputs' }),
  );
  expect(lstatSync(path.join(workspace, '.git')).isDirectory()).toBe(true);
  expect(existsSync(path.join(workspace, '.git/objects/info/alternates'))).toBe(false);
  expect(timings.map((timing) => timing.stage)).toEqual(process.platform === 'darwin' ? ['clone', 'checkout', 'asset_hydration', 'dependency_selection', 'dependency_materialization'] : ['dependency_materialization']);
  const workerGit = (...args: string[]) => execFileSync('git', args, {cwd:workspace, encoding:'utf8', stdio:'pipe'}).trim();
  const mainHead = git('rev-parse', 'refs/heads/main');
  workerGit('update-ref', '-d', 'refs/heads/main');
  workerGit('config', '--local', 'core.hooksPath', 'packet-hooks');
  workerGit('tag', 'packet-only');
  workerGit('update-ref', 'refs/stash', 'HEAD');
  expect(git('rev-parse', 'refs/heads/main')).toBe(mainHead);
  expect(readMainHooks()).toBe(mainHooks);
  expect(git('tag', '--list', 'packet-only')).toBe('');
  expect(git('for-each-ref', '--format=%(refname)', 'refs/stash')).toBe('');
  const unpublished = execFileSync('git', ['hash-object', '-w', '--stdin'], {cwd:workspace, input:'unpublished packet object', encoding:'utf8'}).trim();
  git('reflog', 'expire', '--expire=now', '--all');
  git('gc', '--prune=now');
  git('worktree', 'prune', '--expire=now');
  expect(workerGit('cat-file', '-p', unpublished)).toBe('unpublished packet object');
}, 600_000);
