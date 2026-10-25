import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn() }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn() }));
// Receipt transitions do not depend on a host-wide process census. The adjacent
// warm-packet-safety suite exercises the real live-process retention guard.
vi.mock('@/lib/worktree/live-process-guard', async original => ({
  ...await original<typeof import('@/lib/worktree/live-process-guard')>(),
  allowWorktreeRemoval: async () => true,
}));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, statfs: vi.fn(async (file: string) => {
    const info = await actual.statfs(file);
    return file.includes('warm-safety-') ? { ...info, blocks: Math.floor(4 * 1024 ** 3 / info.bsize) } : info;
  }) };
});
vi.mock('@/lib/worktree/storage-telemetry', async original => ({
  ...await original<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({ accountingStatus: 'observed', probePath: '/',
    availableBytes: 90_000_000_000, freeBytes: 90_000_000_000, totalBytes: 100_000_000_000, error: null })),
}));

const npmCli = process.env.npm_execpath!;
const npmVersion = execFileSync(process.execPath, [npmCli, '--version'], { encoding: 'utf8' }).trim();
const root = realpathSync(mkdtempSync(join(process.env.O8_READY_CRASH_ROOT ?? process.env.CORTEX_IDE_DATA_DIR!, 'warm-safety-')));
let directory: string;
let repo: string;
let close: (() => void) | undefined;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();

let preparedFixture: Awaited<ReturnType<typeof fixture>> | undefined;
let heldSlots = 0;
let retainedNote: string | undefined;
let crashChild: ChildProcess | undefined;
let crashError = '';

function fileEvent(file: string, child?: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { watcher.close(); child?.off('exit', exited); };
    const exited = () => { cleanup(); reject(new Error(`Crash fixture exited before ${file}: ${crashError}`)); };
    const watcher = watch(dirname(file), () => {
      if (existsSync(file)) { cleanup(); resolve(); }
    });
    watcher.once('error', error => { cleanup(); reject(error); });
    child?.once('exit', exited);
    if (existsSync(file)) { cleanup(); resolve(); }
  });
}

beforeEach(async context => {
  vi.resetModules();
  // Drive only explicit receipt operations. An unrelated periodic refill must
  // not race a slow host's handoff/crash or its cleanup assertions.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  directory = mkdtempSync(join(root, 'case-'));
  repo = join(directory, 'repo');
  const bin = join(directory, 'bin');
  mkdirSync(repo); mkdirSync(bin);
  vi.stubEnv('CORTEX_IDE_DATA_DIR', directory);
  vi.stubEnv('O8_DATA_DIR', directory);
  vi.stubEnv('O8_WORKTREE_ROOT', join(directory, 'worktrees'));
  vi.stubEnv('O8_SKIP_PRELAUNCH_TYPECHECK', '1');
  vi.stubEnv('O8_APFS_COW_WORKSPACES', '0');
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH}`);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'README.md'), 'original\n');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'warm-safety', version: '1.0.0', packageManager: `npm@${npmVersion}`,
    o8DependencyClone: { lifecycleInputs: [] } }));
  writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3,
    packages: { 'node_modules/fixture': { version: '1.0.0' } } }));
  writeFileSync(join(repo, 'o8.workspace.json'), JSON.stringify({ version: 1 }));
  git('init', '-q', '-b', 'main'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
  git('remote', 'add', 'origin', repo); git('fetch', 'origin', 'main');
  writeFileSync(join(bin, 'npm'), '#!/usr/bin/env node\n' + [
    "const fs = require('node:fs');",
    `if (process.argv[2] !== 'ci') { const p = require('node:child_process').spawnSync(process.execPath, [${JSON.stringify(npmCli)}, ...process.argv.slice(2)], { stdio: 'inherit' }); process.exit(p.status ?? 1); }`,
    "fs.mkdirSync('node_modules/fixture', { recursive: true });",
    "fs.writeFileSync('node_modules/fixture/package.json', '{\"name\":\"fixture\",\"version\":\"1.0.0\"}');",
    "fs.writeFileSync('node_modules/fixture/index.js', 'module.exports = 42;\\n');",
  ].join('\n'));
  chmodSync(join(bin, 'npm'), 0o755);
  heldSlots = 0; retainedNote = undefined;
  preparedFixture = undefined;
  if (context.task.name.includes('real post-commit crash') && process.env.O8_READY_CRASH_CHILD !== '1') {
    crashError = '';
    crashChild = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
      'tests/warm-packet-receipts-real-path.test.ts', '-t', 'real post-commit crash', '--maxWorkers=1'], {
      env: { ...process.env, O8_READY_CRASH_CHILD: '1', O8_READY_CRASH_ROOT: directory,
        O8_READY_CRASH_RECEIPT: join(directory, 'ready-crash.json'),
        O8_READY_CRASH_READY: join(directory, 'prepared'), O8_READY_CRASH_GO: join(directory, 'go') },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    crashChild.stderr!.on('data', chunk => { crashError += String(chunk); });
    await fileEvent(join(directory, 'prepared'), crashChild);
    return;
  }
  preparedFixture = await fixture();
  if (context.task.name.includes('approved empty manifest') || context.task.name.includes('post-initialization root replacement')
    || context.task.name.includes('real post-commit crash')) {
    await preparedFixture.pool.prepareWarmPacketWorktrees(preparedFixture.options, preparedFixture.manager);
  }
  if (context.task.name.includes('real post-commit crash')) {
    writeFileSync(process.env.O8_READY_CRASH_READY!, 'prepared');
    await fileEvent(process.env.O8_READY_CRASH_GO!);
  }
});

afterEach(async () => {
  try {
    if (preparedFixture) {
      await preparedFixture.pool.shutdownWarmPacketWorktrees();
      const tables = preparedFixture.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'warm_packet_slots'").get();
      if (tables) expect(preparedFixture.db.prepare('SELECT count(*) FROM warm_packet_slots').pluck().get()).toBe(heldSlots);
      if (retainedNote) expect(readFileSync(retainedNote, 'utf8')).toBe('retain unexpected bytes');
    }
  } finally {
    if (crashChild && crashChild.exitCode === null && crashChild.signalCode === null) {
      const exited = once(crashChild, 'exit');
      if (process.platform === 'win32') crashChild.kill('SIGKILL');
      else process.kill(-crashChild.pid!, 'SIGKILL'); // Only this owned fixture's process group.
      await exited;
    }
    crashChild = undefined;
    close?.(); close = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks(); vi.unstubAllEnvs();
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));


async function fixture() {
  const { WorktreeManager } = await import('@/lib/worktree/manager');
  const { getSqlite, closeDb } = await import('@/lib/db'); close = closeDb;
  const { addRepo, updateRepo } = await import('@/lib/repos/registry');
  const registration = await addRepo(repo);
  const setup = { ...registration.setup, workspaceIsolationPreference: 'git-worktree' as const,
    installOnCreateWorkspace: true, installCommand: 'npm ci --offline' };
  await updateRepo(registration.id, { setup });
  const budget = await import('@/lib/worktree/warm-packet-budget');
  // Model eligibility, retaining the host's actual filesystem/process guards.
  vi.spyOn(budget, 'supportsWarmPacketWorktrees').mockReturnValue(true);
  const pool = await import('@/lib/worktree/warm-packet-pool');
  const metadata = await import('@/lib/worktree/metadata-store');
  const manager = new WorktreeManager(repo);
  const options = { capacity: 1 as const, repoRoot: repo, agentType: 'codex', baseBranch: 'main', repoSetup: setup };
  return { manager, pool, metadata, options, db: getSqlite() };
}

it('hands off an approved empty manifest with its persisted receipt and the original warm inode', async () => {
  const f = preparedFixture!;
  const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
  await updateOperatorDefaults({ workspaceManifestPolicy: 'one-approval' });
  const policy = await import('@/lib/workspace/manifest/policy');
  const decision = await policy.resolveWorkspaceManifestExecution({ repoPath: repo,
    manifestSource: readFileSync(join(repo, 'o8.workspace.json')), policy: 'one-approval' });
  const approval = policy.findWorkspaceManifestApproval(repo, decision.manifestHash)!;
  const { resolveApproval } = await import('@/lib/approvals/store');
  resolveApproval(approval.id, 'approve', 'test');
  {
    const unused = Object.values(await f.metadata.readWorktreeMetaSnapshot(repo)).find(e => e.warmPool)!;
    const lanes = await import('@/lib/lane/registry');
    const packetId = 'warm-approved-manifest';
    const lane = lanes.createLane({ repoPath: repo, branch: 'packet/manifest', baseBranch: 'main',
      runtime: 'codex', packetId, baseCommit: git('rev-parse', 'HEAD') });
    lanes.setLaneStatus(lane.id, 'launching', 'system', 'fixture');
    const prepared = await f.manager.create({ agentType: 'codex', taskName: packetId, packetId, laneId: lane.id,
      branchName: lane.branch, baseBranch: 'main', repoSetup: f.options.repoSetup, managed: true });
    const meta = (await f.metadata.readWorktreeMetaSnapshot(repo))[prepared.id]!;
    expect(meta.materializationIdentity?.inode).toBe(unused.materializationIdentity!.inode);
    const { readWorkspaceManifestReceipt } = await import('@/lib/workspace/manifest/lifecycle');
    expect(await readWorkspaceManifestReceipt(prepared.path)).toMatchObject({ packetId, laneId: lane.id, state: 'completed' });
    expect(lanes.getLaneEvents(lane.id, 100).some(e => e.verb === 'workspace_manifest_applied')).toBe(true);
  }
});

it('releases the warm slot atomically with ready despite a real post-commit crash', async () => {
  const f = preparedFixture!;
  const packetId = 'warm-ready-crash';
  if (process.env.O8_READY_CRASH_CHILD === '1') {
    const lanes = await import('@/lib/lane/registry');
    const lane = lanes.createLane({ repoPath: repo, branch: 'packet/ready-crash', baseBranch: 'main',
      runtime: 'codex', packetId, baseCommit: git('rev-parse', 'HEAD') });
    lanes.setLaneStatus(lane.id, 'launching', 'system', 'fixture');
    const leases = await import('@/lib/worktree/metadata-transaction-lease');
    const release = leases.releaseMetadataTransactionLease;
    vi.spyOn(leases, 'releaseMetadataTransactionLease').mockImplementation(lease => {
      const snapshot = leases.readMetadataTransactionStateSnapshot(lease.metadataRoot, f.db);
      const entries = JSON.parse(snapshot?.payload ?? '{}').worktrees ?? {};
      const ready = Object.values(entries).some(e => {
        const entry = e as { packetId?: string; status?: string };
        return entry.packetId === packetId && entry.status === 'ready';
      });
      if (ready) {
        writeFileSync(process.env.O8_READY_CRASH_RECEIPT!, JSON.stringify({ repo, directory, ready }));
        // This is after the authoritative ready commit, before the manager's
        // former separate slot deletion. No throw/rollback substitutes for death.
        process.kill(process.pid, 'SIGKILL');
      }
      return release(lease);
    });
    await f.manager.create({ agentType: 'codex', taskName: packetId, packetId, laneId: lane.id,
      branchName: lane.branch, baseBranch: 'main', repoSetup: f.options.repoSetup, managed: true });
    throw new Error('The fixture did not reach its committed-ready crash point');
  }
  const receipt = join(directory, 'ready-crash.json');
  const exited = once(crashChild!, 'exit');
  writeFileSync(join(directory, 'go'), 'launch');
  const [code] = await exited;
  expect(code, crashError).not.toBe(0);
  const crashed = JSON.parse(readFileSync(receipt, 'utf8')) as { repo: string; directory: string; ready: boolean };
  expect(crashed.ready).toBe(true);
  // Probe from another process, not an inherited in-memory pool or DB handle.
  const probe = join(directory, 'ready-probe.json');
  const script = `const budget = require('./src/lib/worktree/warm-packet-budget');
    const db = require('./src/lib/db').getSqlite();
    const before = db.prepare('SELECT count(*) FROM warm_packet_slots').pluck().get();
    const tokens = [budget.reserveWarmPacketSlot(${JSON.stringify(crashed.repo)}), budget.reserveWarmPacketSlot(${JSON.stringify(crashed.repo)})];
    require('node:fs').writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ before, tokens }));
    require('./src/lib/db').closeDb();`;
  execFileSync(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx', '-e', script],
    { env: { ...process.env, CORTEX_IDE_DATA_DIR: crashed.directory, O8_DATA_DIR: crashed.directory,
      CORTEX_IDE_DB_PATH: join(crashed.directory, 'cortex-ide.db'), O8_WORKTREE_ROOT: join(crashed.directory, 'worktrees') }, stdio: 'pipe' });
  const result = JSON.parse(readFileSync(probe, 'utf8')) as { before: number; tokens: Array<string | null> };
  expect(result.before).toBe(0);
  expect(result.tokens.every(Boolean)).toBe(true);
});

it('releases both pre-creation admission failures and can refill again', async () => {
  const f = preparedFixture!;
  const admission = await import('@/lib/worktree/launch-storage-admission');
  const enter = vi.spyOn(admission, 'withManagedWorktreeStorageAdmission');
  {
    for (let i = 0; i < 2; i++) {
      enter.mockRejectedValueOnce(new Error('Fixture admission refused before tree creation'));
      await expect(f.pool.prepareWarmPacketWorktrees(f.options, f.manager)).rejects.toThrow('Fixture admission refused');
    }
    expect(f.db.prepare('SELECT count(*) FROM warm_packet_slots').pluck().get()).toBe(0);
    const leaf = await import('@/lib/worktree/materialization-leaf-io');
    const ensure = leaf.ensurePinnedWorkspaceDirectory;
    let fencedCreates = 0;
    vi.spyOn(leaf, 'ensurePinnedWorkspaceDirectory').mockImplementation((...args) => {
      if (args[2].startsWith('warm-')) {
        expect(f.db.prepare('SELECT materialization_started FROM warm_packet_slots').all()).toEqual([{ materialization_started: 1 }]);
        fencedCreates++;
      }
      return ensure(...args);
    });
    await f.pool.prepareWarmPacketWorktrees(f.options, f.manager);
    expect(fencedCreates).toBe(1);
    expect(Object.values(await f.metadata.readWorktreeMetaSnapshot(repo)).filter(e => e.warmPool)).toHaveLength(1);
  }
  enter.mockRestore();
});

it('rejects a post-initialization root replacement without adopting or deleting it', async () => {
  const f = preparedFixture!;
  const lanes = await import('@/lib/lane/registry');
  const packetId = 'warm-root-replacement';
  const lane = lanes.createLane({ repoPath: repo, branch: 'packet/replacement', baseBranch: 'main',
    runtime: 'codex', packetId, baseCommit: git('rev-parse', 'HEAD') });
  lanes.setLaneStatus(lane.id, 'launching', 'system', 'fixture');
  let workspace = '';
  let targetId = '';
  heldSlots = 1;
  await expect(f.manager.create({ agentType: 'codex', taskName: packetId, packetId, laneId: lane.id,
    branchName: lane.branch, baseBranch: 'main', repoSetup: f.options.repoSetup, managed: true,
    beforeReady: info => {
      workspace = info.path;
      targetId = info.id;
      renameSync(workspace, workspace + '.retained'); mkdirSync(workspace);
      retainedNote = join(workspace, 'operator-notes.txt'); writeFileSync(retainedNote, 'retain unexpected bytes');
    },
  })).rejects.toThrow();
  expect(readFileSync(join(workspace + '.retained', 'README.md'), 'utf8')).toBe('original\n');
  const entries = await f.metadata.readWorktreeMetaSnapshot(repo);
  expect(entries[targetId]?.status).not.toBe('ready');
});

it('recovers empty durable reservations after their owning process exits', async () => {
  const f = preparedFixture!;
  const script = `const { reserveWarmPacketSlot } = require('./src/lib/worktree/warm-packet-budget');
    reserveWarmPacketSlot(${JSON.stringify(repo)}); reserveWarmPacketSlot(${JSON.stringify(repo)});
    require('./src/lib/db').closeDb();`;
  execFileSync(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx', '-e', script],
    { env: process.env, stdio: 'pipe' });
  expect(f.db.prepare('SELECT count(*) FROM warm_packet_slots').pluck().get()).toBe(2);
  {
    await f.pool.prepareWarmPacketWorktrees(f.options, f.manager);
    expect(Object.values(await f.metadata.readWorktreeMetaSnapshot(repo)).filter(e => e.warmPool)).toHaveLength(1);
  }
});

it('keeps a dead creator charged while its pinned mkdir child can still mutate', async () => {
  const f = preparedFixture!;
  const release = join(directory, 'resume-child');
  const done = join(directory, 'child-created');
  const preload = join(directory, 'pause-mkdir.cjs');
  // Pause the actual pinned helper immediately before its mkdir, not a modeled
  // promise in the creator. Killing the creator leaves this mutator alive.
  writeFileSync(preload, `const fs = require('node:fs'); const mkdir = fs.mkdirSync;
    fs.mkdirSync = function(target, ...args) {
      if (!String(target).startsWith('warm-')) return mkdir.call(fs, target, ...args);
      process.stdout.write('fixture-paused\\n');
      while (!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      const result = mkdir.call(fs, target, ...args);
      fs.writeFileSync(${JSON.stringify(done)}, 'created'); return result;
    };`);
  const script = `const fs = require('node:fs'); const cp = require('node:child_process');
    const originalSpawn = cp.spawn;
    cp.spawn = function(command, args, options) {
      const paused = args.includes('ensure-directory');
      const child = originalSpawn(command, paused ? ['--require', ${JSON.stringify(preload)}, ...args] : args, options);
      if (paused) child.stdout.once('data', () => process.send({ helper: child.pid, workspace }));
      return child;
    };
    const budget = require('./src/lib/worktree/warm-packet-budget');
    const token = budget.reserveWarmPacketSlot(${JSON.stringify(repo)});
    const base = require('./src/lib/worktree/root-layout').resolveWorktreeRootLayout(${JSON.stringify(repo)}).primaryBase;
    fs.mkdirSync(base, { recursive: true });
    const workspace = require('node:path').join(base, 'warm-' + token + '-index.noindex');
    (async () => {
      const identity = await require('./src/lib/worktree/materialization-identity').captureWorktreeMaterializationIdentity(base);
      if (budget.markWarmPacketMaterializationStarted) budget.markWarmPacketMaterializationStarted(${JSON.stringify(repo)}, token);
      await require('./src/lib/worktree/materialization-leaf-io').ensurePinnedWorkspaceDirectory(base, identity, 'warm-' + token + '-index.noindex');
    })().catch(error => { console.error(error); process.exit(1); });`;
  const owner = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx', '-e', script],
    { env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let helper: number | undefined;
  let replacement: string | null = null;
  const budget = await import('@/lib/worktree/warm-packet-budget');
  try {
    const paused = await Promise.race([
      once(owner, 'message').then(([message]) => message as { helper: number; workspace: string }),
      once(owner, 'exit').then(([code]) => { throw new Error(`Creator exited before its helper paused: ${code}`); }),
    ]);
    helper = paused.helper;
    const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited;
    expect(existsSync(paused.workspace)).toBe(false);
    heldSlots = 1;
    replacement = budget.reserveWarmPacketSlot(repo);
    expect(f.db.prepare('SELECT count(*) FROM warm_packet_slots').pluck().get()).toBe(2);
    const completed = new Promise<void>(resolve => {
      const watcher = watch(directory, () => { if (existsSync(done)) { watcher.close(); resolve(); } });
    });
    writeFileSync(release, 'continue'); await completed;
    expect(existsSync(paused.workspace)).toBe(true);
  } finally {
    if (replacement) budget.releaseUnmaterializedWarmPacketSlot(repo, replacement);
    owner.kill('SIGKILL');
    if (helper) { try { process.kill(helper, 'SIGKILL'); } catch {} }
  }
});


it("does not recover another live creator's empty reservations", async () => {
  const f = preparedFixture!;
  const budget = await import('@/lib/worktree/warm-packet-budget');
  const tokens = [budget.reserveWarmPacketSlot(repo)!, budget.reserveWarmPacketSlot(repo)!];
  await f.pool.prepareWarmPacketWorktrees(f.options, f.manager);
  expect(Object.values(await f.metadata.readWorktreeMetaSnapshot(repo)).filter(e => e.warmPool)).toHaveLength(0);
  expect(f.db.prepare('SELECT count(*) FROM warm_packet_slots').pluck().get()).toBe(2);
  for (const token of tokens) expect(budget.releaseUnmaterializedWarmPacketSlot(repo, token)).toBe(true);
});

it('retains and charges an unexpected tree while recovering the other empty slot', async () => {
  const f = preparedFixture!;
  const tokenFile = join(directory, 'slots.json');
  const script = `const { reserveWarmPacketSlot } = require('./src/lib/worktree/warm-packet-budget');
    const tokens = [reserveWarmPacketSlot(${JSON.stringify(repo)}), reserveWarmPacketSlot(${JSON.stringify(repo)})];
    require('node:fs').writeFileSync(${JSON.stringify(tokenFile)}, JSON.stringify(tokens));require('./src/lib/db').closeDb();`;
  execFileSync(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx', '-e', script],
    { env: process.env, stdio: 'pipe' });
  const [token] = JSON.parse(readFileSync(tokenFile, 'utf8')) as string[];
  const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
  const unexpected = join(resolveWorktreeRootLayout(repo).primaryBase, `warm-${token}-index.noindex`);
  mkdirSync(unexpected, { recursive: true });
  retainedNote = join(unexpected, 'operator-notes.txt'); writeFileSync(retainedNote, 'retain unexpected bytes');
  heldSlots = 1;
  await f.pool.prepareWarmPacketWorktrees(f.options, f.manager);
  expect(f.db.prepare('SELECT count(*) FROM warm_packet_slots').pluck().get()).toBe(2);
  expect(Object.values(await f.metadata.readWorktreeMetaSnapshot(repo)).filter(e => e.warmPool)).toHaveLength(1);
});
