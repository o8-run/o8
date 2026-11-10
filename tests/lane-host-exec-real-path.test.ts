import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { delimiter, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// o8 typechecks, commits, pushes and merges a lane's work outside the worker
// sandbox. None of that may run code from the lane's checkout or its tree:
// not a compiler or package config the worker installed, and not a Git hook.
const root = realpathSync(mkdtempSync(join(os.tmpdir(), 'o8-lane-host-exec-')));
const dataDir = join(root, 'data');
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
const marker = join(root, 'ran.txt');

const { createLane } = await import('@/lib/lane/registry');
const { performWorktreeSideMerge } = await import('@/lib/lane/worktree-side-merge');
const { runLaneRebaseTypecheck } = await import('@/lib/lane/rebase-typecheck');
const { NO_REPOSITORY_TYPESCRIPT } = await import('@/lib/lane/typecheck-availability');
const { runCompletionVerification } = await import('@/lib/supervisor/completion-verification');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { bindOwnedPacketSession } = await import('./helpers/managed-packet-worktree');

// Fixture Git never runs the hooks under test.
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null',
  '-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function writeExecutable(path: string, text: string) {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

const HOOKS = ['pre-commit', 'post-commit', 'pre-push', 'post-checkout', 'post-merge', 'post-rewrite', 'reference-transaction'];
function writeHooks(dir: string) {
  mkdirSync(dir, { recursive: true });
  for (const hook of HOOKS) writeExecutable(join(dir, hook), `#!/bin/sh\necho ${hook} >> ${JSON.stringify(marker)}\n`);
}

// A compiler and package config a worker leaves in its checkout's node_modules.
// Its typescript/bin/tsc reports an error, so taking the checkout (or the merge
// clone, whose node_modules links to it) for the repository's install fails.
function plantLaneCompiler(checkout: string) {
  mkdirSync(join(checkout, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(join(checkout, 'node_modules', 'typescript', 'bin'), { recursive: true });
  writeFileSync(join(checkout, 'node_modules', 'typescript', 'package.json'), '{"name":"typescript"}\n');
  writeExecutable(join(checkout, 'node_modules', '.bin', 'tsc'), `#!/bin/sh\necho lane-tsc >> ${JSON.stringify(marker)}\n`);
  writeFileSync(join(checkout, 'node_modules', 'typescript', 'bin', 'tsc'),
    'console.log("src/index.ts(1,1): error TS9999: the lane checkout\'s compiler ran");\nprocess.exit(2);\n');
}

// A repository install whose compiler reports one type error.
function repositoryCompiler(installRoot: string) {
  mkdirSync(join(installRoot, 'node_modules', 'typescript', 'bin'), { recursive: true });
  writeFileSync(join(installRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    "console.log(\"src/index.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.\");\nprocess.exit(2);\n");
}

let count = 0;
async function laneFixture(options: { typescript?: boolean; setup?: (repo: string) => void } = {}) {
  const name = `case-${++count}`;
  const origin = join(root, `${name}-origin.git`);
  const repo = join(root, `${name}-repo`);
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, repo);
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  if (options.typescript) {
    writeFileSync(join(repo, 'tsconfig.json'), '{"compilerOptions":{"noEmit":true},"include":["src"]}\n');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'index.ts'), 'export const ok: string = "base";\n');
  }
  options.setup?.(repo);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  const packetId = `pkt-host-exec-${count}`;
  const branch = `inline/host-exec-${count}`;
  const worktree = await getWorktreeManager(repo).create({
    agentType: 'codex', taskName: packetId, branchName: branch, baseBranch: 'main', packetId,
    skipSetup: true, isolationPreference: 'git-worktree',
  });
  const sessionKey = await bindOwnedPacketSession(repo, worktree, { packetId, branch });
  writeFileSync(join(worktree.path, 'file.txt'), 'base\nworker\n');
  git(worktree.path, 'add', '-A');
  git(worktree.path, 'commit', '-qm', 'worker change');
  const lane = createLane({ repoPath: repo, worktreePath: worktree.path, branch, baseBranch: 'main', runtime: 'codex', packetId, sessionKey });
  return { origin, repo, checkout: worktree.path, lane };
}

const merge = (lane: ReturnType<typeof createLane>) => performWorktreeSideMerge({
  lane,
  command: { verb: 'merge', laneId: lane.id, actor: 'system', orchestratorReviewed: true },
  actor: 'system',
  gateResult: { passed: true, violations: [] },
  createLaneActionApproval: async (_lane, _actor, input) => ({ ok: false, laneId: lane.id, note: input.note }),
});

const ran = () => (existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n') : []);

beforeAll(async () => {
  // The storage governor is not under test; keep its reserve out of the way.
  await updateOperatorDefaults({ productTelemetryEnabled: false, storageReserveRatio: 0.0001, storageReserveFloorGb: 0.001 });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('host typechecks of lane work', () => {
  it("merges with the typecheck recorded as skipped when the repository has no TypeScript, never running the lane checkout's compiler", async () => {
    const f = await laneFixture({ typescript: true });
    plantLaneCompiler(f.checkout);
    rmSync(marker, { force: true });

    const result = await merge(f.lane);

    expect(result.ok, result.note).toBe(true);
    expect(result.checks?.find((check) => check.name === 'typecheck')).toEqual({ name: 'typecheck', verdict: 'skipped', detail: NO_REPOSITORY_TYPESCRIPT });
    expect(ran(), ran().join(",")).toEqual([]);
  }, 120_000);

  it("runs the repository's compiler for the merge typecheck", async () => {
    const f = await laneFixture({ typescript: true });
    plantLaneCompiler(f.checkout);
    repositoryCompiler(f.repo);
    rmSync(marker, { force: true });

    const result = await runLaneRebaseTypecheck({ cwd: f.checkout, installRoot: f.repo, actualBranch: f.lane.branch!, logPrefix: 'test' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.output).toContain('error TS2322');
    expect(ran(), ran().join(",")).toEqual([]);
  }, 120_000);

  it("verifies a completed lane with the repository's compiler, never the checkout's", async () => {
    const f = await laneFixture({ typescript: true });
    plantLaneCompiler(f.checkout);
    rmSync(marker, { force: true });

    expect(await runCompletionVerification(f.checkout, 'main', f.repo)).toMatchObject({ ok: true });
    expect(ran(), ran().join(",")).toEqual([]);

    repositoryCompiler(f.repo);
    const failed = await runCompletionVerification(f.checkout, 'main', f.repo);
    expect(failed).toMatchObject({ ok: false, kind: 'typecheck' });
    expect(failed.output).toContain('error TS2322');
    expect(ran(), ran().join(",")).toEqual([]);
  }, 120_000);
});

describe('host Git for a lane merge', () => {
  it("runs no hook from the lane's tree when the repository sets a relative hooks path", async () => {
    const f = await laneFixture();
    git(f.repo, 'config', 'core.hooksPath', '.githooks');
    writeHooks(join(f.checkout, '.githooks'));
    git(f.checkout, 'add', '-A');
    git(f.checkout, 'commit', '-qm', 'worker hooks');
    rmSync(marker, { force: true });

    const result = await merge(f.lane);

    expect(result.ok, result.note).toBe(true);
    expect(ran(), ran().join(",")).toEqual([]);
  }, 120_000);

  it("runs no hook from the merge clone's tree when the global config sets a relative hooks path", async () => {
    const f = await laneFixture();
    writeHooks(join(f.checkout, '.githooks'));
    git(f.checkout, 'add', '-A');
    git(f.checkout, 'commit', '-qm', 'worker hooks');
    // o8 passes HOME, and so the home Git config, to the Git it runs.
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, '.gitconfig'), '[core]\n\thooksPath = .githooks\n[user]\n\tname = o8-test\n\temail = o8@example.test\n');
    rmSync(marker, { force: true });
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      const result = await merge(f.lane);
      expect(result.ok, result.note).toBe(true);
    } finally {
      process.env.HOME = previous;
    }
    expect(ran(), ran().join(",")).toEqual([]);
  }, 120_000);
});

// git-lfs runs from PATH; this wrapper records each call and runs the real one.
const lfsBinary = (() => {
  try { return execFileSync('sh', ['-c', 'command -v git-lfs'], { encoding: 'utf8' }).trim(); } catch { return ''; }
})();
const lfsLog = join(root, 'lfs.txt');

describe.runIf(Boolean(lfsBinary))('Git LFS on hook-free pushes', () => {
  const previousPath = process.env.PATH;
  beforeAll(() => {
    const bin = join(root, 'lfs-bin');
    mkdirSync(bin, { recursive: true });
    writeExecutable(join(bin, 'git-lfs'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(lfsLog)}\nexec ${JSON.stringify(lfsBinary)} "$@"\n`);
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`;
  });
  afterAll(() => { process.env.PATH = previousPath; });

  const lfsCalls = () => (existsSync(lfsLog) ? readFileSync(lfsLog, 'utf8').trim().split('\n') : []);
  const originObject = (origin: string, oid: string) => join(origin, 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid);

  // A repository that routes *.bin to Git LFS, and a lane that adds one.
  async function lfsLaneFixture() {
    const f = await laneFixture({
      setup: (repo) => {
        writeFileSync(join(repo, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
        git(repo, 'lfs', 'install', '--local', '--skip-repo');
      },
    });
    const content = `lane payload ${f.lane.id}\n`.repeat(64);
    writeFileSync(join(f.checkout, 'payload.bin'), content);
    git(f.checkout, 'add', 'payload.bin');
    git(f.checkout, 'commit', '-qm', 'worker adds a large file');
    expect(git(f.checkout, 'cat-file', '-p', 'HEAD:payload.bin')).toContain('git-lfs.github.com/spec/v1');
    return { ...f, oid: createHash('sha256').update(content).digest('hex') };
  }

  it('uploads the lane\'s LFS files before pushing the merge', async () => {
    const f = await lfsLaneFixture();
    rmSync(lfsLog, { force: true });

    const result = await merge(f.lane);

    expect(result.ok, result.note).toBe(true);
    expect(result.pushedToOrigin, result.pushError).toBe(true);
    expect(existsSync(originObject(f.origin, f.oid))).toBe(true);
    expect(lfsCalls().some((call) => call.startsWith('push origin '))).toBe(true);
  }, 120_000);

  it('makes no Git LFS call for a repository without LFS', async () => {
    const f = await laneFixture();
    rmSync(lfsLog, { force: true });

    const result = await merge(f.lane);

    expect(result.ok, result.note).toBe(true);
    expect(result.pushedToOrigin, result.pushError).toBe(true);
    expect(lfsCalls()).toEqual([]);
  }, 120_000);

  it("gives a lane checkout's LFS upload the same trusted credential helpers as its push", async () => {
    const f = await lfsLaneFixture();
    const home = join(root, 'lfs-credential-home');
    mkdirSync(home, { recursive: true });
    const helper = 'store --file=/nonexistent/o8-test-credentials';
    writeFileSync(join(home, '.gitconfig'), `[credential]\n\thelper = ${helper}\n[user]\n\tname = o8-test\n\temail = o8@example.test\n`);
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      const { laneGitInvocation } = await import('@/lib/lane/lane-git');
      const sha = git(f.checkout, 'rev-parse', 'HEAD');
      const credentials = (args: string[]) => args.filter((arg, index) => args[index - 1] === '-c' && arg.startsWith('credential.'));
      const push = credentials(laneGitInvocation(f.checkout, f.repo, ['push', 'origin', sha]).args);
      const upload = credentials(laneGitInvocation(f.checkout, f.repo, ['lfs', 'push', 'origin', sha]).args);
      expect(push).toContain(`credential.helper=${helper}`);
      expect(upload).toEqual(push);
    } finally {
      process.env.HOME = previous;
    }
  }, 120_000);

  it('pushes without an LFS upload when the lane adds LFS routing to a repository that did not use it', async () => {
    const f = await laneFixture({ setup: (repo) => git(repo, 'lfs', 'install', '--local', '--skip-repo') });
    writeFileSync(join(f.checkout, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    writeFileSync(join(f.checkout, '.lfsconfig'), '[lfs]\n\turl = http://127.0.0.1:9/\n');
    writeFileSync(join(f.checkout, 'payload.bin'), `lane payload ${f.lane.id}\n`.repeat(64));
    git(f.checkout, 'add', '-A');
    git(f.checkout, 'commit', '-qm', 'worker adds LFS routing');
    expect(git(f.checkout, 'cat-file', '-p', 'HEAD:payload.bin')).toContain('git-lfs.github.com/spec/v1');
    rmSync(lfsLog, { force: true });

    const result = await merge(f.lane);

    expect(result.ok, result.note).toBe(true);
    expect(result.pushedToOrigin, result.pushError).toBe(true);
    // git-lfs still runs as the repository's own clean and smudge filter.
    expect(lfsCalls().filter((call) => call.startsWith('push'))).toEqual([]);
  }, 120_000);

  it('does not push the merge when the LFS upload fails', async () => {
    const f = await lfsLaneFixture();
    git(f.repo, 'config', 'lfs.url', 'http://127.0.0.1:9/');
    const originMain = git(f.origin, 'rev-parse', 'refs/heads/main');

    const result = await merge(f.lane);

    expect(result.pushedToOrigin).toBe(false);
    expect(result.pushError).toContain('Git LFS upload to origin failed, so the push was not made');
    expect(git(f.origin, 'rev-parse', 'refs/heads/main')).toBe(originMain);
    expect(existsSync(originObject(f.origin, f.oid))).toBe(false);
  }, 120_000);
});
