import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

vi.mock('@/lib/lane/merge-decomposition', () => ({ enqueueMergeDecompositions: async () => '' }));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-update-merge-')));
vi.stubEnv('O8_DATA_DIR', join(root, 'data'));
vi.stubEnv('CORTEX_IDE_DATA_DIR', join(root, 'data'));
vi.stubEnv('O8_SKIP_PRELAUNCH_TYPECHECK', '1');
const { createLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const { performWorktreeSideMerge } = await import('@/lib/lane/worktree-side-merge');
const mergeGit = await import('@/lib/lane/worktree-merge-git');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { bindOwnedPacketSession } = await import('./helpers/managed-packet-worktree');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
await import('@/lib/orchestrator/control-plane');
beforeAll(() => { execFileSync('cargo', ['build', '--manifest-path', 'crates/o8-restart-safety/Cargo.toml', '--example', 'admission'], { env: { ...process.env, CARGO_BUILD_JOBS: '2', CARGO_TARGET_DIR: 'src-tauri/target' }, stdio: 'pipe' }); }, 120_000);
afterAll(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

async function makeLane(name: string) {
  await updateOperatorDefaults({ productTelemetryEnabled: false, storageReserveRatio: 0.0001, storageReserveFloorGb: 0.001 });
  const repo = join(root, `${name}-repo`);
  const origin = join(root, `${name}-origin.git`);
  git(root, 'init', '--bare', origin);
  git(root, 'clone', origin, repo);
  git(repo, 'checkout', '-b', 'main');
  git(repo, 'config', 'user.name', 'o8-test'); git(repo, 'config', 'user.email', 'o8@example.test');
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  git(repo, 'add', 'file.txt'); git(repo, 'commit', '-m', 'base'); git(repo, 'push', '-u', 'origin', 'main');
  const branch = `inline/update-${name}`;
  const packetId = `pkt-update-${name}`;
  const manager = getWorktreeManager(repo);
  const worktree = await manager.create({ agentType: 'codex', taskName: packetId, branchName: branch,
    baseBranch: 'main', packetId, skipSetup: true, isolationPreference: 'git-worktree' });
  const sessionKey = await bindOwnedPacketSession(repo, worktree, { packetId, branch });
  writeFileSync(join(worktree.path, 'file.txt'), 'base\nworker\n');
  git(worktree.path, 'add', 'file.txt'); git(worktree.path, 'commit', '-m', 'worker change');
  const lane = createLane({ repoPath: repo, worktreePath: worktree.path, branch, baseBranch: 'main',
    runtime: 'codex', packetId, sessionKey });
  setLaneStatus(lane.id, 'reviewing', 'system');
  return { repo, origin, lane, manager };
}

it('excludes a merge during native drain and holds admitted publication through settlement', async () => {
  const { origin, lane, manager } = await makeLane('merge');
  const merge = () => performWorktreeSideMerge({ lane, command: { verb: 'merge', laneId: lane.id, actor: 'system',
    orchestratorReviewed: true }, actor: 'system', gateResult: { passed: true, violations: [] },
    createLaneActionApproval: async (_lane, _actor, input) => ({ ok: false, laneId: lane.id, note: input.note }) });
  // Retirement has its own real-path suite. Keep this test at publication and
  // lane settlement rather than invoking the unrelated workspace retire queue.
  const cleanup = vi.spyOn(manager, 'cleanup').mockResolvedValue(false);
  const directory = join(root, 'data/cli-operation-admission');
  const id = randomUUID(); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${id}.json`), JSON.stringify({ version: 1, id, kind: 'restart', pid: process.pid,
    startedAt: new Date().toISOString(), stage: 'preparing' }));
  try {
    expect(await merge()).toMatchObject({ ok: false, reason: 'app_restart_pending' });
    expect(getLane(lane.id)?.status).toBe('reviewing');
    expect(git(origin, 'show', 'main:file.txt')).toBe('base');
  } finally { rmSync(directory, { recursive: true }); }
  const started = join(root, 'publishing'); const released = join(root, 'release-publication');
  // Hold o8's push of main until the admitted publication has been checked.
  const publishBase = mergeGit.pushExactBase;
  const push = vi.spyOn(mergeGit, 'pushExactBase').mockImplementation(async (...args) => {
    writeFileSync(started, '');
    while (!existsSync(released)) await new Promise((resolve) => setTimeout(resolve, 20));
    return publishBase(...args);
  });
  const pending = merge();
  try {
    await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 10_000 });
    const files = readdirSync(join(root, 'data/work-launches'));
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(root, 'data/work-launches', files[0]), 'utf8'))).toMatchObject({ pid: process.pid, ownerIdentity: { version: 1 } });
    expect(getLane(lane.id)?.status).toBe('merging');
  } finally { writeFileSync(released, 'settle'); }
  expect(await pending).toMatchObject({ ok: true, pushedToOrigin: true });
  expect(readdirSync(join(root, 'data/work-launches'))).toEqual([]);
  expect(getLane(lane.id)?.status).toBe('completed');
  cleanup.mockRestore();
  push.mockRestore();
}, 90_000);


it('refuses real PR publication under a native reservation before pushing or creating a receipt', async () => {
  const { repo, origin, lane } = await makeLane('publication');
  const { dispatch } = await import('@/lib/lane/commands');
  const native = spawn(join(process.cwd(), 'src-tauri/target/debug/examples/admission'), [join(root, 'data'), 'reserve'], { stdio: 'pipe' });
  let output = ''; native.stdout.on('data', chunk => { output += String(chunk); });
  try {
    await vi.waitFor(() => expect(output.trim()).toMatch(/^[a-f0-9-]{36}$/));
    const result = await dispatch({ verb: 'create_pr', laneId: lane.id, actor: 'user' });
    expect(result).toMatchObject({ ok: false, reason: 'app_restart_pending' });
    expect(git(origin, 'for-each-ref', '--format=%(refname)', `refs/heads/${lane.branch}`)).toBe('');
    expect(getLane(lane.id)).toMatchObject({ status: 'reviewing', prNumber: null });
    expect(git(repo, 'status', '--porcelain')).toBe('');
  } finally { const exited = once(native, 'exit'); native.stdin.end('cancel\n'); await exited; }
}, 90_000);

it.each(['merge', 'publication'] as const)('reclaims a killed %s owner before Git or publication starts', async (operation) => {
  const { repo, origin, lane } = await makeLane(`crashed-${operation}`);
  const { withRepoActionLock } = await import('@/lib/lane/repo-action-lock');
  let unlock!: () => void;
  let locked!: () => void;
  const ready = new Promise<void>(resolve => { locked = resolve; });
  const holding = withRepoActionLock(repo, async () => { locked(); await new Promise<void>(resolve => { unlock = resolve; }); });
  await ready;
  const child = spawn(process.execPath, ['./node_modules/vitest/vitest.mjs', 'run',
    `tests/fixtures/worktree-${operation === 'merge' ? 'side-merge' : 'publication'}-child.test.ts`, '--reporter=dot'], { env: { ...process.env,
      O8_TEST_DATA_DIR_PINNED: join(root, 'data'), O8_TEST_MERGE_LANE_ID: lane.id,
      O8_TEST_MERGE_RESULT_PATH: join(root, 'crash-result') }, stdio: 'pipe' });
  let output = ''; child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { output += String(chunk); });
  let ownerPid: number | undefined;
  try {
    await vi.waitFor(() => {
      const files = readdirSync(join(root, 'data/work-launches'));
      expect(files, output).toHaveLength(1);
      ownerPid = JSON.parse(readFileSync(join(root, 'data/work-launches', files[0]), 'utf8')).ownerPid;
      expect(ownerPid).not.toBe(process.pid);
    }, { timeout: 45_000 });
    expect(() => execFileSync(join(process.cwd(), 'src-tauri/target/debug/examples/admission'), [join(root, 'data')], { stdio: 'pipe' })).toThrow();
    const exited = once(child, 'exit'); process.kill(ownerPid!, 'SIGKILL'); await exited;
    expect(git(origin, 'show', 'main:file.txt')).toBe('base');
    expect(git(origin, 'for-each-ref', '--format=%(refname)', `refs/heads/${lane.branch}`)).toBe('');
    expect(getLane(lane.id)?.prNumber).toBeNull();
    expect(existsSync(join(root, 'crash-result'))).toBe(false);
    execFileSync(join(process.cwd(), 'src-tauri/target/debug/examples/admission'), [join(root, 'data')], { stdio: 'pipe' });
    expect(readdirSync(join(root, 'data/work-launches'))).toEqual([]);
    expect(existsSync(join(root, 'data/native-cleanup'))).toBe(true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    unlock(); await holding;
  }
}, 90_000);


it('holds real PR publication through its receipt and records live work before forced native cleanup', async () => {
  const { origin, lane } = await makeLane('live-publication');
  const { dispatch } = await import('@/lib/lane/commands');
  const directory = join(root, 'bin'); mkdirSync(directory, { recursive: true });
  const started = join(root, 'gh-started'); const released = join(root, 'release-gh');
  const executable = join(directory, 'gh');
  writeFileSync(executable, `#!/bin/sh\ntouch '${started}'\nwhile [ ! -f '${released}' ]; do sleep 0.02; done\nprintf 'https://example.test/pull/4189\\n'\n`);
  chmodSync(executable, 0o700);
  const previousPath = process.env.PATH; process.env.PATH = `${directory}:${previousPath ?? ''}`;
  const pending = dispatch({ verb: 'create_pr', laneId: lane.id, actor: 'user' });
  try {
    await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 10_000 });
    expect(git(origin, 'rev-parse', `refs/heads/${lane.branch}`)).toBe(git(lane.worktreePath!, 'rev-parse', 'HEAD'));
    expect(getLane(lane.id)?.outcome).not.toBe('pr_opened');
    const files = readdirSync(join(root, 'data/work-launches')); expect(files).toHaveLength(1);
    const work = JSON.parse(readFileSync(join(root, 'data/work-launches', files[0]), 'utf8'));
    expect(work).toMatchObject({ label: `PR publication ${lane.id}`, pid: process.pid, ownerIdentity: { version: 1 } });
    const admission = join(process.cwd(), 'src-tauri/target/debug/examples/admission');
    expect(() => execFileSync(admission, [join(root, 'data')], { stdio: 'pipe' })).toThrow();
    execFileSync(admission, [join(root, 'data'), 'force'], { stdio: 'pipe' });
    const receipts = readdirSync(join(root, 'data/forced-restarts'));
    expect(receipts.some(name => readFileSync(join(root, 'data/forced-restarts', name), 'utf8').includes(work.id))).toBe(true);
    expect(readdirSync(join(root, 'data/work-launches'))).toHaveLength(1);
  } finally { writeFileSync(released, 'settle'); process.env.PATH = previousPath; }
  expect(await pending).toMatchObject({ ok: true });
  expect(getLane(lane.id)).toMatchObject({ outcome: 'pr_opened', prNumber: 4189 });
  expect(readdirSync(join(root, 'data/work-launches'))).toEqual([]);
}, 90_000);

it('recovers every lease kind on owner identity reuse and expires a live owner that never bound a PID', async () => {
  const { reserveWorkLaunch } = await import('@/lib/app-update/work-launch-admission');
  const { reserveCliInstaller } = await import('@/lib/setup/cli-operation-admission');
  const data = join(root, 'data');
  const workDirectory = join(data, 'work-launches');
  for (const label of ['terminal', 'merge', 'publication', 'worker']) reserveWorkLaunch(label).started(process.pid);
  const installer = reserveCliInstaller('fixture');
  const installerPath = join(data, 'cli-operation-admission', `${installer.id}.json`);
  const paths = [...readdirSync(workDirectory).map(name => join(workDirectory, name)), installerPath];
  for (const path of paths) {
    const work = JSON.parse(readFileSync(path, 'utf8'));
    work.ownerIdentity.startId += '-previous-process';
    writeFileSync(path, JSON.stringify(work));
  }
  writeFileSync(join(data, 'fixture-cli-update.lock'), readFileSync(installerPath));
  const admission = join(process.cwd(), 'src-tauri/target/debug/examples/admission');
  execFileSync(admission, [data], { stdio: 'pipe' });
  expect(readdirSync(workDirectory)).toEqual([]);
  expect(existsSync(join(data, 'fixture-cli-update.lock'))).toBe(false);
  const unbound = reserveWorkLaunch('never-bound');
  const path = join(workDirectory, readdirSync(workDirectory)[0]);
  const work = JSON.parse(readFileSync(path, 'utf8'));
  expect(work.ownerIdentity.version).toBe(1);
  expect(work.pid).toBeNull();
  expect(() => execFileSync(admission, [data], { stdio: 'pipe' })).toThrow();
  work.createdMonotonicMs = Number(process.hrtime.bigint()) / 1e6 - 31_000;
  writeFileSync(path, JSON.stringify(work));
  execFileSync(admission, [data], { stdio: 'pipe' });
  expect(readdirSync(workDirectory)).toEqual([]);
  unbound.release(); installer.release();
});
