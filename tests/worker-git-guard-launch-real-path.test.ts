import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { requireBwrap } from '@/lib/runtimes/shared/owned-session/sandbox-linux';

// The owned launch passes the worker's branch to the sandbox: the lane's from
// its record, or else the one its session recorded at creation. The generated
// policy limits the shared Git metadata to that branch.
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (
      command: string,
      args: string[] = [],
      options: import('node:child_process').SpawnOptions = {},
    ) => options.env?.O8_OWNED_RUN_MARKER
      ? spawnMock(command, args, options)
      : actual.spawn(command, args, options),
  };
});

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>(),
  ensureDispatchBackendReady: vi.fn(async () => ({ ready: true, reason: 'http_200', waitedMs: 0, attempts: 1 })),
}));

vi.mock('@/lib/claude-code/codex-subscription-proxy', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/claude-code/codex-subscription-proxy')>(),
  ensureClaudeCodeWorkerConfigDir: vi.fn(async (sessionDir: string) => {
    const configDir = path.join(sessionDir, 'worker-config');
    mkdirSync(configDir, { recursive: true });
    return configDir;
  }),
}));

vi.mock('@/lib/runtimes/shared/auth-detect', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtimes/shared/auth-detect')>(),
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));

const sandboxUsable = process.platform === 'darwin'
  ? existsSync('/usr/bin/sandbox-exec')
  : process.platform === 'linux' && await requireBwrap().then(() => true, () => false);

const tempRoot = realpathSync(mkdtempSync(path.join(os.homedir(), '.tmp-o8-git-guard-launch-')));
const dataDir = path.join(tempRoot, 'data');
const repoPath = path.join(tempRoot, 'repo');
const controlledEnvKeys = [
  'CORTEX_IDE_DATA_DIR', 'O8_DATA_DIR', 'CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT', 'O8_CLAUDE_CODE_BIN',
  'O8_CRASH_SURVIVABLE_WORKERS', 'O8_SKIP_PRELAUNCH_TYPECHECK', 'O8_WORKER_SANDBOX',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
] as const;
const priorEnv: Record<string, string | undefined> = {};

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=o8 test',
  '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The sandbox policy the launch handed to the worker's spawn, behind its credential wrapper. */
function launchedPolicy(): string {
  const args = (spawnMock.mock.calls.at(-1)?.[1] ?? []) as string[];
  const sandbox = args.indexOf(process.platform === 'darwin' ? '/usr/bin/sandbox-exec' : '--unshare-pid');
  expect(sandbox, JSON.stringify(args.filter((arg) => arg.length < 200))).toBeGreaterThan(-1);
  return process.platform === 'darwin' ? readFileSync(args[args.indexOf('-f', sandbox) + 1], 'utf8') : args.join('\n');
}

describe.runIf(sandboxUsable).sequential('worker Git guard through the owned launch', () => {
  beforeAll(async () => {
    for (const key of controlledEnvKeys) priorEnv[key] = process.env[key];
    mkdirSync(dataDir, { recursive: true });
    git(tempRoot, 'init', '-q', '-b', 'main', repoPath);
    writeFileSync(path.join(repoPath, 'README.md'), 'git guard launch fixture\n');
    git(repoPath, 'add', 'README.md');
    git(repoPath, 'commit', '-qm', 'fixture');

    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    process.env.O8_DATA_DIR = dataDir;
    process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = path.join(tempRoot, 'owned');
    process.env.O8_CLAUDE_CODE_BIN = process.execPath;
    process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';
    process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
    process.env.O8_WORKER_SANDBOX = 'on';
    process.env.ANTHROPIC_API_KEY = '';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'synthetic-git-guard-fixture';

    spawnMock.mockImplementation(() => ({ pid: 424_243, stdin: { end: vi.fn() }, unref: vi.fn(), once: vi.fn() }));
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));

    const { addRepo } = await import('@/lib/repos/registry');
    const { writeClaudeCodeWorkerProfile } = await import('@/lib/claude-code/worker-profile');
    await addRepo(repoPath);
    await writeClaudeCodeWorkerProfile({ source: 'native', model: null, codexModel: null, repoSkillAllowlist: [] });
  });

  afterAll(async () => {
    const { closeDb } = await import('@/lib/db');
    closeDb();
    vi.unstubAllGlobals();
    for (const key of controlledEnvKeys) {
      if (priorEnv[key] === undefined) delete process.env[key];
      else process.env[key] = priorEnv[key];
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("limits a lane worker to the branch in its lane record", async () => {
    const worktree = path.join(tempRoot, 'lane-checkout');
    git(repoPath, 'worktree', 'add', '-q', '-b', 'inline/checked-out', worktree, 'main');
    git(repoPath, 'branch', 'lane-record/pkt-guard', 'main');
    const { createLane } = await import('@/lib/lane/registry');
    const lane = createLane({
      repoPath, worktreePath: worktree, branch: 'lane-record/pkt-guard', baseBranch: 'main',
      runtime: 'claude-code', label: 'git guard lane',
    });
    const { launchOwnedClaudeCodeSession } = await import('@/lib/claude-code/owned');
    const launched = await launchOwnedClaudeCodeSession({ cwd: worktree, prompt: 'Guarded lane run.', laneId: lane.id });
    expect(launched.ok, JSON.stringify(launched)).toBe(true);
    const policy = launchedPolicy();
    const refs = path.join(realpathSync(repoPath), '.git', 'refs', 'heads');
    expect(policy).toContain(path.join(refs, 'lane-record'));
    expect(policy).not.toContain(path.join(refs, 'inline'));
  }, 120_000);

  it('limits a worker in a linked worktree with no lane to the branch its session recorded', async () => {
    const worktree = path.join(tempRoot, 'session-checkout');
    git(repoPath, 'worktree', 'add', '-q', '-b', 'session-branch/scratch', worktree, 'main');
    const { launchOwnedClaudeCodeSession } = await import('@/lib/claude-code/owned');
    const launched = await launchOwnedClaudeCodeSession({ cwd: worktree, prompt: 'Guarded session run.' });
    expect(launched.ok, JSON.stringify(launched)).toBe(true);
    const policy = launchedPolicy();
    const common = path.join(realpathSync(repoPath), '.git');
    expect(policy).toContain(path.join(common, 'refs', 'heads', 'session-branch'));
    expect(policy).toContain(path.join(common, 'worktrees', 'session-checkout', 'commondir'));
  }, 120_000);
});
