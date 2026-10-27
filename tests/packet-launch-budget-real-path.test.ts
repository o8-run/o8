import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

// The scheduler and materializer stay real. Only the unavailable OS clone
// boundary is modeled; these timings cannot establish physical block sharing.
vi.mock('@/lib/workspace/dependency-materializer', async original => {
  const actual = await original<typeof import('@/lib/workspace/dependency-materializer')>();
  return { ...actual, materializeDependencyInstall: (workspace: string, command: string, options: Parameters<typeof actual.materializeDependencyInstall>[2]) => {
    return actual.materializeDependencyInstall(workspace, command, process.env.O8_SPEED_SHRINKWRAP === '1'
      ? { ...options, platform: 'darwin', useDependencyPool: process.env.O8_SPEED_DEPENDENCY_DEFECT ? options?.useDependencyPool !== false : false } : options);
  } };
});
vi.mock('@/lib/worktree/materialization-leaf-io', async original => {
  const actual = await original<typeof import('@/lib/worktree/materialization-leaf-io')>();
  return { ...actual, clonePinnedWorkspaceDirectory: async (...args: Parameters<typeof actual.clonePinnedWorkspaceDirectory>) => {
    if (process.env.O8_SPEED_SHRINKWRAP !== '1' || process.platform === 'darwin') return actual.clonePinnedWorkspaceDirectory(...args);
    const { cp, lstat } = await import('node:fs/promises');
    const target = path.join(args[0], args[2]);
    await cp(args[3], target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    const stat = await lstat(target);
    return { disposition: 'created' as const, device: stat.dev, inode: stat.ino, sourceChanged: false };
  } };
});

vi.mock('@/lib/workspace/dependency-pool-publication', async original => {
  const actual = await original<typeof import('@/lib/workspace/dependency-pool-publication')>();
  return { ...actual, publishDependencyPoolTree: async (...args: Parameters<typeof actual.publishDependencyPoolTree>) => {
    if (!process.env.O8_SPEED_DEPENDENCY_DEFECT || process.platform === 'darwin') return actual.publishDependencyPoolTree(...args);
    const { rename, lstat } = await import('node:fs/promises');
    const target = path.join(args[0], 'node_modules');
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await rename(path.join(args[2].canonicalPath, 'node_modules'), target);
  } };
});

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
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, statfs: vi.fn(async (file: string) => {
    const info = await actual.statfs(file);
    // OS capability fixture: model a kernel-bounded volume for small worktrees.
    // The budget case deliberately uses the real, unbounded cloud filesystem.
    return file.includes('launch-budget-') && process.env.O8_SPEED_WARM_ADVERSARY !== 'budget'
      ? { ...info, blocks: Math.floor(4 * 1024 ** 3 / info.bsize) } : info;
  }) };
});
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
let policyHolder: ChildProcess | undefined;
let warmVisitor: ChildProcess | undefined;
const adversary = process.env.O8_SPEED_WARM_ADVERSARY;
const retainedFixture = !!adversary || process.env.O8_SPEED_ABSOLUTE_LINK === '1'
  || process.env.O8_SPEED_BINDING_FAULT === '1' || !!process.env.O8_SPEED_HOOKS_FAULT;
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

// The installer/runtime fixture has no provider account. Keep the real child
// credential guard enabled and supply an explicitly credential-free environment.
const { providerCredentialName } = await import('@/lib/providers/spawn-environment');
for (const key of Object.keys(process.env)) if (providerCredentialName(key)) delete process.env[key];

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
}

interface OutputObservation { pid?: number; cwd: string; prepared: boolean; outputAt: number; startedAt: string }
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
  if (process.env.O8_SPEED_DEPENDENCY_DEFECT) await (await import('@/lib/workspace/dependency-directory-pool')).waitForDependencyDirectoryPool();
  if (warmVisitor && warmVisitor.exitCode === null && warmVisitor.signalCode === null) {
    const exited = new Promise<void>(resolve => warmVisitor!.once('close', () => resolve()));
    warmVisitor.kill();
    await exited;
  }
  if (policyHolder && policyHolder.exitCode === null && policyHolder.signalCode === null) {
    const exited = new Promise<void>(resolve => policyHolder!.once('close', () => resolve()));
    policyHolder.kill();
    await exited;
  }
  const lanes = await import('@/lib/lane/registry');
  const { routeAction } = await import('@/lib/runtimes/registry');
  for (const id of ['pkt-launch-budget', 'pkt-launch-budget-two']) {
    const lane = lanes.findLatestLaneByPacket(id);
    if (lane?.sessionKey) await routeAction('qoder', 'interrupt', lane.sessionKey);
  }
  const pool = await import('@/lib/worktree/launch');
  try { await pool.shutdownWarmPacketWorktrees(); }
  catch (error) { if (!retainedFixture) throw error; }
  const { readWorktreeMetaSnapshot } = await import('@/lib/worktree/metadata-store');
  if (!retainedFixture) expect(Object.values(await readWorktreeMetaSnapshot(repo)).filter(entry => entry.warmPool)).toHaveLength(0);
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
  writeFileSync(path.join(repo, process.env.O8_SPEED_SHRINKWRAP === '1' ? 'npm-shrinkwrap.json' : 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: installedPackages }));
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
  writeFileSync(path.join(repo, 'node_modules', 'fixture', 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', ...(process.env.O8_SPEED_DEPENDENCY_DEFECT ? { main: 'index.js', bin: 'bin.js' } : {}) }));
  if (process.env.O8_SPEED_DEPENDENCY_DEFECT) {
    mkdirSync(path.join(repo, 'node_modules/.bin'));
    writeFileSync(path.join(repo, 'node_modules/fixture/bin.js'), '#!/usr/bin/env node\n');
    symlinkSync('../fixture/bin.js', path.join(repo, 'node_modules/.bin/o8-fixture'));
  }
  writeFileSync(path.join(repo, 'node_modules', '.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: installedPackages }));
  if (process.env.O8_SPEED_SHRINKWRAP === '1') await (await import('./fixtures/dependency-payload-launch.fixture')).installPayloadBaseline(repo, npmVersion);
  if (process.env.O8_SPEED_SHRINKWRAP_STALE === 'lockfile') {
    const lock = path.join(repo, 'npm-shrinkwrap.json');
    writeFileSync(lock, readFileSync(lock, 'utf8') + '\n');
  }
  if (process.env.O8_SPEED_SHRINKWRAP_STALE === 'installed') {
    writeFileSync(path.join(repo, 'node_modules/fixture/package.json'), '{"name":"fixture","version":"0.9.0"}');
  }
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
    `fs.appendFileSync(${JSON.stringify(path.join(root, 'installer-starts'))}, 'ci\\n');`,
    ...(adversary === 'unsealed' ? [`fs.writeFileSync('unique-notes.txt', 'unfinished installer note'); fs.writeFileSync(${JSON.stringify(path.join(root, 'failed-warm-path'))}, process.cwd()); process.exit(42);`] : []),
    ...(adversary === 'installer-chain' ? ["fs.mkdirSync('sub'); fs.symlinkSync('..', 'sub/back'); fs.symlinkSync('sub/back/..', 'escape');"] : []),
    ...(slowRefill ? [`if (require('node:path').basename(process.cwd()).startsWith('warm-')) { fs.writeFileSync(${JSON.stringify(installing)}, 'ready'); while (fs.existsSync(${JSON.stringify(hold)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); }`] : []),
    "if (payload) fs.cpSync(payload, 'node_modules', { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });",
    "fs.mkdirSync('node_modules/fixture', { recursive: true });",
    ...(process.env.O8_SPEED_DEPENDENCY_DEFECT ? [
      `fs.writeFileSync('node_modules/.package-lock.json', ${JSON.stringify(JSON.stringify({ lockfileVersion: 3, packages: installedPackages }))});`,
      `fs.writeFileSync('node_modules/fixture/package.json', ${JSON.stringify(JSON.stringify({ name: 'fixture', version: '1.0.0', main: 'index.js', bin: 'bin.js' }))});`,
    ] : []),
    "for (let i = 0; i < 64; i++) fs.writeFileSync('node_modules/fixture/data-' + i, 'fixture');",
    "const path = require('node:path');",
    "const contained = path.relative(process.cwd(), process.env.HOME).startsWith('.o8-install-runtime/');",
    "const isolatedConfig = process.env.npm_config_userconfig === path.join(path.dirname(process.env.HOME), 'config/user.rc') && process.env.npm_config_globalconfig === path.join(path.dirname(process.env.HOME), 'config/global.rc');",
    "fs.writeFileSync('installer-runtime.json', JSON.stringify({ contained, isolatedConfig }));",
    "fs.writeFileSync('node_modules/fixture/index.js', 'module.exports = 42;\\n');",
    ...(process.env.O8_SPEED_DEPENDENCY_DEFECT ? [
      "fs.mkdirSync('node_modules/.cache/deep', { recursive: true }); fs.writeFileSync('node_modules/.cache/deep/data.js', 'module.exports = 42;\\n');",
    ] : []),
    "fs.mkdirSync('node_modules/.bin', { recursive: true }); fs.writeFileSync('node_modules/fixture/bin.js', '#!/usr/bin/env node\\n'); fs.symlinkSync('../fixture/bin.js', 'node_modules/.bin/o8-fixture');",
    ...(process.env.O8_SPEED_ABSOLUTE_LINK ? ["fs.symlinkSync(require('node:path').resolve('node_modules/fixture/index.js'), 'node_modules/fixture/absolute');"] : []),
    "const result = cp.spawnSync(process.execPath, [npmCli, 'rebuild', '.', '--offline'], { stdio: 'inherit' }); process.exit(result.status ?? 1);",
  ].join('\n'));
  chmodSync(path.join(bin, 'npm'), 0o755);
  writeFileSync(path.join(bin, 'qodercli'), [
    '#!/usr/bin/env node',
    "if (process.argv.includes('--version')) { console.log('qodercli 1.0.0'); process.exit(0); }",
    ...(process.env.O8_SPEED_DEPENDENCY_DEFECT ? ["if (require(require('node:path').join(process.cwd(), 'node_modules/fixture')) !== 42 || require(require('node:path').join(process.cwd(), 'node_modules/.cache/deep/data.js')) !== 42) throw new Error('Required dependency payload is corrupt');"] : []),
    "console.log(JSON.stringify({ type: 'assistant', message: { content: 'SPEED_READY' }, fixture: { pid: process.pid, cwd: process.cwd(), prepared: require('node:fs').existsSync('generated.ready'), outputAt: Date.now() } }));",
    // Keep the fixture signalable until the real owned runtime records its PID.
    // Test cleanup interrupts only the session returned by this dispatch.
    ...(process.env.O8_SPEED_DEPENDENCY_DEFECT ? [
      "const fs = require('node:fs'); let written = false; setInterval(() => { if (!written && fs.existsSync('write-payload')) { const value = fs.readFileSync('write-payload', 'utf8'); fs.writeFileSync('node_modules/fixture/index.js', 'module.exports = ' + value + ';\\n'); fs.writeFileSync('node_modules/.cache/deep/data.js', 'module.exports = ' + value + ';\\n'); fs.writeFileSync('payload-written', 'done'); written = true; } }, 10);",
    ] : ['setInterval(() => {}, 1000);']),
  ].join('\n'));
  chmodSync(path.join(bin, 'qodercli'), 0o755);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  const [{ addRepo, updateRepo, findRepoByLocalPath }, { runDispatchTick }, lanes, control] = await Promise.all([
    import('@/lib/repos/registry'), import('@/lib/orchestrator/scheduling'),
    import('@/lib/lane/registry'), import('@/lib/orchestrator/control-plane'),
  ]);
  const credentials = await import('@/lib/runtimes/shared/owned-session/credential-spawn');
  const checkedSpawn = vi.spyOn(credentials, 'spawnCredentialCheckedChild');
  const registration = await addRepo(repo);
  await updateRepo(registration.id, { setup: { ...registration.setup, workspaceIsolationPreference: 'auto', ...(process.env.O8_SPEED_SHRINKWRAP === '1' ? { installOnCreateWorkspace: true } : {}), installCommand: 'npm ci --offline' } });
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
  const warm = process.env.O8_SPEED_WARM !== '0' && process.platform === 'linux' && process.env.O8_SPEED_MAC_ASSERTIONS !== '1' && process.env.O8_SPEED_SHRINKWRAP !== '1';
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
  const { WorktreeManager } = await import('@/lib/worktree/manager');
  const originalPrepare = WorktreeManager.prototype.prepareWarmWorktree;
  const preparationCalls = process.env.O8_SPEED_POLICY_CONTENTION === '1' || adversary
    ? vi.spyOn(WorktreeManager.prototype, 'prepareWarmWorktree') : undefined;
  const capacity = process.env.O8_SPEED_DEPENDENCY_PAYLOAD && !concurrent ? 1 as const : 2 as const;
  const warmOptions = { capacity, repoRoot: repo, agentType: 'qoder', baseBranch: 'main', repoSetup: (await findRepoByLocalPath(repo))!.setup };
  const intervals = vi.spyOn(globalThis, 'setInterval');
  if (adversary === 'unsealed') {
    await expect(prepare(warmOptions)).rejects.toThrow();
    const source = readFileSync(path.join(root, 'failed-warm-path'), 'utf8');
    expect(readFileSync(path.join(source, 'unique-notes.txt'), 'utf8')).toBe('unfinished installer note');
    return;
  }
  if (adversary === 'installer-chain') {
    await expect(prepare(warmOptions)).rejects.toThrow(/escaping|symlink/);
    return;
  }
  if (adversary === 'budget') {
    await expect(prepare(warmOptions)).rejects.toThrow(/bounded filesystem/);
    expect(preparationCalls).not.toHaveBeenCalled();
    expect(existsSync(path.join(root, 'installer-starts'))).toBe(false);
    return;
  }
  if (adversary === 'apfs-exclude') {
    preparationCalls!.mockImplementation(async function (this: InstanceType<typeof WorktreeManager>, opts, created) {
      const prepared = await originalPrepare.call(this, opts, created);
      const target = prepared.worktree.path;
      const cloned = path.join(root, 'private-clone');
      execFileSync('git', ['clone', '--no-hardlinks', '--quiet', repo, cloned]);
      rmSync(path.join(target, '.git'));
      renameSync(path.join(cloned, '.git'), path.join(target, '.git'));
      execFileSync('git', ['-C', target, 'config', 'core.excludesFile', path.join(target, '.git/info/generated-excludes')]);
      return prepared;
    });
    await expect(prepare(warmOptions)).rejects.toThrow(/relocat|private Git|linked Git/);
    return;
  }
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
  const settingsBefore = new Map(unused.map(entry => {
    const file = path.join(entry.materializationIdentity!.canonicalPath, '.claude/settings.local.json');
    return [entry.id, { inode: lstatSync(file).ino, content: readFileSync(file, 'utf8') }];
  }));
  if (warm && !nonRelocatable && !slowRefill) {
    expect(unused).toHaveLength(capacity);
    for (const entry of unused) {
      expect(entry.packetId).toBeUndefined();
      expect(entry.creationOwner).toBeDefined();
      expect(existsSync(path.join(entry.materializationIdentity!.canonicalPath, '.env'))).toBe(false);
    }
  }
  if (adversary === 'dirty-shutdown' || adversary === 'dirty-invalidation' || adversary === 'git-admin') {
    const source = unused[0]!.materializationIdentity!.canonicalPath;
    if (adversary === 'git-admin') execFileSync('git', ['-C', source, '-c', 'user.name=o8-test', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'unique fixture commit']);
    else {
      writeFileSync(path.join(source, 'unique-notes.txt'), 'unique fixture notes');
      writeFileSync(path.join(source, 'README.md'), 'unique tracked edit');
    }
    if (adversary === 'dirty-invalidation') {
      git('update-ref', 'refs/heads/main', 'HEAD');
      await expect(prepare(warmOptions)).rejects.toThrow();
    } else await expect(pool.shutdownWarmPacketWorktrees()).rejects.toThrow();
    if (adversary === 'git-admin') expect(execFileSync('git', ['-C', source, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim()).toBe('unique fixture commit');
    else {
      expect(readFileSync(path.join(source, 'unique-notes.txt'), 'utf8')).toBe('unique fixture notes');
      expect(readFileSync(path.join(source, 'README.md'), 'utf8')).toBe('unique tracked edit');
    }
    return;
  }
  if (adversary === 'dirty-purge' || adversary === 'live-purge' || adversary === 'live-purge-paused') {
    const retirement = await import('@/lib/workspace/exact-managed-directory-retirement');
    const original = retirement.retireExactManagedDirectory;
    let retained = '';
    let calls = 0;
    vi.spyOn(retirement, 'retireExactManagedDirectory').mockImplementationOnce(input => original({ ...input, beforeRetirementPurge: async candidate => {
      calls += 1;
      if (adversary === 'dirty-purge' && !retained) {
        retained = candidate;
        writeFileSync(path.join(candidate, 'late-notes.txt'), 'late fixture notes');
      } else if (adversary !== 'dirty-purge' && calls === (adversary === 'live-purge' ? 1 : 2)) {
        retained = candidate;
        warmVisitor = spawn(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"], { cwd: candidate, stdio: ['ignore', 'pipe', 'pipe'] });
        await new Promise<void>((resolve, reject) => { warmVisitor!.once('error', reject); warmVisitor!.stdout!.once('data', () => resolve()); });
      }
    } }));
    await expect(new WorktreeManager(repo).retireWarmWorktree(unused[0]!.id)).rejects.toThrow();
    if (adversary === 'dirty-purge') expect(readFileSync(path.join(retained, 'late-notes.txt'), 'utf8')).toBe('late fixture notes');
    else expect(readFileSync(path.join(retained, 'README.md'), 'utf8')).toBe('committed\n');
    return;
  }
  if (adversary === 'disabled' || adversary === 'disabled-registry') {
    preparationCalls!.mockClear();
    const retires = vi.spyOn(WorktreeManager.prototype, 'retireWarmWorktree');
    await updateRepo(registration.id, { setup: { ...registration.setup, installOnCreateWorkspace: false } });
    const { scheduleWarmPacketWorktrees } = await import('@/lib/worktree/warm-packet-pool');
    if (adversary === 'disabled') scheduleWarmPacketWorktrees({ ...warmOptions, repoSetup: { ...warmOptions.repoSetup, installOnCreateWorkspace: false } }, new WorktreeManager(repo));
    writeFileSync(path.join(repo, 'package-lock.json'), readFileSync(path.join(repo, 'package-lock.json'), 'utf8') + '\n');
    const refresh = intervals.mock.calls.find(([, delay]) => delay === 30_000)![0] as () => void;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    refresh();
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    // Drain the real async registry check started by the timer before asserting
    // no installer/retirement effects. No wall-clock sleep or wider deadline.
    await prepare(warmOptions);
    expect(preparationCalls).not.toHaveBeenCalled();
    expect(retires).not.toHaveBeenCalled();
    return;
  }
  if (adversary === 'restart') {
    const other = path.join(root, 'other');
    execFileSync('git', ['clone', '--quiet', repo, other]);
    await addRepo(other);
    vi.resetModules();
    const fresh = await import('@/lib/worktree/launch');
    const OtherManager = (await import('@/lib/worktree/manager')).WorktreeManager;
    const creates = vi.spyOn(OtherManager.prototype, 'prepareWarmWorktree');
    await fresh.prepareWarmPacketWorktrees({ ...warmOptions, repoRoot: other });
    const count = creates.mock.calls.length;
    await fresh.shutdownWarmPacketWorktrees();
    await pool.shutdownWarmPacketWorktrees();
    expect(count).toBe(0);
    return;
  }
  if (adversary === 'live') {
    const source = unused[0]!.materializationIdentity!.canonicalPath;
    warmVisitor = spawn(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"], { cwd: source, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => { warmVisitor!.once('error', reject); warmVisitor!.stdout!.once('data', () => resolve()); });
  }
  if (adversary === 'moved-head') {
    const verification = await import('@/lib/workspace/dependency-materialization-verification');
    const original = verification.verifyDependencyMaterialization;
    vi.spyOn(verification, 'verifyDependencyMaterialization').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      execFileSync('git', ['-C', args[0], 'update-ref', 'HEAD', git('rev-parse', 'HEAD')]);
      return result;
    });
  }
  if (adversary === 'metadata-revoked') {
    const guard = await import('@/lib/worktree/live-process-guard');
    const original = guard.allowWorktreeRemoval;
    vi.spyOn(guard, 'allowWorktreeRemoval').mockImplementationOnce(async (...args) => {
      const clear = await original(...args);
      const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
      await withWorktreeMetaTransaction(repo, async transaction => {
        const entry = (await transaction.readAll())[unused[0]!.id]!;
        await transaction.save(entry.id, { ...entry, warmPool: { ...entry.warmPool!, held: true } });
      });
      return clear;
    });
  }
  if (adversary === 'dependency-link' || adversary === 'dependency-bytes' || adversary === 'env') {
    const source = unused[0]!.materializationIdentity!.canonicalPath;
    if (adversary === 'dependency-link') {
      writeFileSync(path.join(root, 'outside-note'), 'retain outside');
      symlinkSync(path.join(root, 'outside-note'), path.join(source, 'node_modules/fixture/escape'));
    } else if (adversary === 'env') writeFileSync(path.join(source, '.env'), 'UNEXPECTED_FIXTURE=value');
    else writeFileSync(path.join(source, 'node_modules/fixture/index.js'), 'unexpected dependency bytes');
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
  if (process.env.O8_SPEED_POLICY_CONTENTION === '1') {
    // Check the requested rename seams before the real credential-checked spawn.
    // A separate holder releases the real SQLite lock independently of this event loop.
    const marker = path.join(root, 'policy-locked');
    const sqlite = createRequire(import.meta.url).resolve('better-sqlite3');
    policyHolder = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      const Database = require(${JSON.stringify(sqlite)});
      const lock = new Database(${JSON.stringify(path.join(root, '.provider-keys.lock'))});
      process.stdin.once('data', () => {
        lock.exec('BEGIN EXCLUSIVE');
        fs.writeFileSync(${JSON.stringify(marker)}, 'locked');
        setTimeout(() => { lock.close(); process.stdin.destroy(); }, 200);
      });
      process.stdout.write('ready');
    `], { env: { NODE_ENV: 'test' }, stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      policyHolder!.once('error', reject);
      policyHolder!.stdout!.once('data', () => resolve());
    });
    const credentials = await import('@/lib/runtimes/shared/owned-session/credential-spawn');
    const original = credentials.spawnCredentialCheckedChild;
    vi.spyOn(credentials, 'spawnCredentialCheckedChild').mockImplementationOnce(input => {
      const workspace = input.session.repoPath;
      const atWorkspace = (...args: string[]) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim();
      // 1. Git directory, reciprocal worktree pointer, index and HEAD binding.
      expect(realpathSync(atWorkspace('rev-parse', '--show-toplevel'))).toBe(realpathSync(workspace));
      const gitdir = path.resolve(workspace, readFileSync(path.join(workspace, '.git'), 'utf8').trim().slice(8));
      expect(realpathSync(readFileSync(path.join(gitdir, 'gitdir'), 'utf8').trim())).toBe(realpathSync(path.join(workspace, '.git')));
      expect(existsSync(path.join(gitdir, 'index'))).toBe(true);
      expect(atWorkspace('diff', '--cached', '--exit-code')).toBe('');
      expect(atWorkspace('symbolic-ref', 'HEAD')).toBe('refs/heads/' + lanes.findLatestLaneByPacket(packet.id)!.branch);
      expect(atWorkspace('rev-parse', 'HEAD')).toBe(git('rev-parse', 'main'));
      // 2. Relative dependency/bin links and the actual runtime executable.
      expect(readlinkSync(path.join(workspace, 'node_modules/.bin/o8-fixture'))).toBe('../fixture/bin.js');
      expect(realpathSync(path.join(workspace, 'node_modules/.bin/o8-fixture'))).toBe(path.join(workspace, 'node_modules/fixture/bin.js'));
      expect(realpathSync(input.binary)).toBe(realpathSync(path.join(bin, 'qodercli')));
      // 3. The moved settings inode/content and launch environment remain valid.
      const source = unused.find(entry => entry.materializationIdentity!.inode === lstatSync(workspace).ino)!;
      expect(lstatSync(path.join(workspace, '.claude/settings.local.json')).ino).toBe(settingsBefore.get(source.id)!.inode);
      expect(readFileSync(path.join(workspace, '.claude/settings.local.json'), 'utf8')).toBe(settingsBefore.get(source.id)!.content);
      expect(Object.values(input.env).some(value => unused.some(entry => value.includes(entry.materializationIdentity!.canonicalPath)))).toBe(false);
      // 4. Failure is induced before the scheduled refill's five-second window.
      expect(preparationCalls).toHaveBeenCalledTimes(capacity);
      process.stdout.write('[packet-binding-proof] git,index,head,links,runtime,settings,environment,refill passed\n');
      const child = original(input);
      policyHolder!.stdin!.end('lock');
      const deadline = Date.now() + 1000;
      while (!existsSync(marker) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
      expect(existsSync(marker)).toBe(true);
      return child;
    });
  }
  if (process.env.O8_SPEED_DEPENDENCY_DEFECT) await (await import('./fixtures/dependency-payload-launch.fixture')).preparePayloadPool(root, repo, npmVersion);
  const hit = warm && !invalidation && !nonRelocatable && !slowRefill;
  const launchBudgetMs = hit ? 3_000 : 60_000;
  const dispatchStartedAt = Date.now();
  const started = performance.now();
  let result = await runDispatchTick(state, { launchBudget: { maxLaunches: concurrent && !process.env.O8_SPEED_DEPENDENCY_DEFECT ? 2 : 1 } });
  if (concurrent && process.env.O8_SPEED_DEPENDENCY_DEFECT) result = await runDispatchTick(result, { launchBudget: { maxLaunches: 1 } });
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
    if (process.env.O8_SPEED_DEPENDENCY_DEFECT) await (await import('./fixtures/dependency-payload-launch.fixture')).assertPayloadWorkers({
      source: repo, workers: paths, observe: observeOutput,
      selections: packets.flatMap(row => lanes.getLaneEvents(lanes.findLatestLaneByPacket(row.id)!.id, 200).filter(event => event.verb === 'worktree_preparation_timing').map(event => event.payload)),
    });
    return;
  }
  const elapsedMs = Math.round(performance.now() - started);
  if (['live', 'dependency-link', 'dependency-bytes', 'env', 'moved-head', 'metadata-revoked'].includes(adversary ?? '')) {
    expect(result.packets[0]?.status).toBe('blocked');
    for (const entry of unused) expect(lstatSync(entry.materializationIdentity!.canonicalPath).ino).toBe(entry.materializationIdentity!.inode);
    if (adversary === 'env') expect(readFileSync(path.join(unused[0]!.materializationIdentity!.canonicalPath, '.env'), 'utf8')).toBe('UNEXPECTED_FIXTURE=value');
    if (adversary === 'dependency-bytes') expect(readFileSync(path.join(unused[0]!.materializationIdentity!.canonicalPath, 'node_modules/fixture/index.js'), 'utf8')).toBe('unexpected dependency bytes');
    if (adversary === 'dependency-link') expect(readFileSync(path.join(root, 'outside-note'), 'utf8')).toBe('retain outside');
    return;
  }
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
  expect(checkedSpawn).toHaveBeenCalled();
  expect(events.some((event) => event.verb === 'dependency_materialized')).toBe(true);
  const workspace = lane!.worktreePath!;
  expect(existsSync(path.join(workspace, '.env'))).toBe(false);
  expect(readFileSync(path.join(repo, '.env'), 'utf8')).toBe('FIXTURE_SETTING=source-only\n');
  if (hit) expect(unused.map(entry => entry.materializationIdentity!.inode)).toContain(lstatSync(workspace).ino);
  if (invalidation) expect(unused.map(entry => entry.materializationIdentity!.inode)).not.toContain(lstatSync(workspace).ino);
  try {
    await vi.waitFor(() => expect(observeOutput(workspace)).toBeDefined(), { timeout: 10_000 });
  } catch (error) {
    for (const name of readdirSync(path.join(root, 'owned-qoder'))) {
      const file = path.join(root, 'owned-qoder', name, 'session.json');
      if (!existsSync(file)) continue;
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      for (const run of [saved.activeRun, ...(saved.recentRuns ?? [])].filter(Boolean)) {
        const stderr = existsSync(run.stderrPath) ? readFileSync(run.stderrPath, 'utf8') : '';
        if (stderr.includes('SQLITE_BUSY')) process.stdout.write('[packet-runtime-refusal] SQLITE_BUSY; embedded child policy=' + stderr.includes('withO8ChildPolicy') + '\n');
      }
    }
    throw error;
  }
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
  if (process.platform !== 'darwin' && process.env.O8_SPEED_SHRINKWRAP !== '1') {
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
  if (process.env.O8_SPEED_SHRINKWRAP === '1') {
    const stale = process.env.O8_SPEED_SHRINKWRAP_STALE;
    expect(timings).toContainEqual(expect.objectContaining({ stage: 'dependency_selection',
      path: stale ? 'native-install' : 'directory-clone',
      reason: stale === 'lockfile' ? 'source-inputs-mismatch' : stale === 'installed' ? 'installed-graph-ineligible' : 'matching-inputs' }));
    expect(existsSync(path.join(workspace, 'installer-fallback.txt'))).toBe(Boolean(stale));
  }
  if (process.platform !== 'darwin' && process.env.O8_SPEED_MAC_ASSERTIONS !== '1') return;
  const clonedDependencies = timings.some(timing => timing.stage === 'dependency_selection' && timing.path === 'directory-clone');
  expect(existsSync(path.join(workspace, 'installer-fallback.txt'))).toBe(!clonedDependencies);
  // Warm selection and dependency-directory cloning are different paths. Only
  // a private Git clone can exercise the independent admin/object assertions.
  if (!lstatSync(path.join(workspace, '.git')).isDirectory()) return;
  expect(lstatSync(path.join(workspace, '.git')).isDirectory()).toBe(true);
  expect(existsSync(path.join(workspace, '.git/objects/info/alternates'))).toBe(false);
  expect(timings.map((timing) => timing.stage)).toEqual(expect.arrayContaining(['clone', 'checkout', 'asset_hydration', 'dependency_selection', 'dependency_materialization']));
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
}, process.env.O8_SPEED_DEPENDENCY_DEFECT ? 180_000 : 120_000);
