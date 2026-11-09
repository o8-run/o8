import { getDataDir } from '@/lib/data-dir-migration';
import { resolveGitBinary } from '@/lib/git/binary';
import { childEnvironment } from '@/lib/providers/spawn-environment';
import { execFile, execFileSync, type ExecFileSyncOptions } from '@/lib/providers/child-process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync,
  renameSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import path from 'node:path';

import { materializationAwareExecFile } from '@/lib/worktree/materialization-execution';

export class LaneGitMetadataError extends Error {
  constructor() {
    super('Lane Git metadata disagrees with the host repository.');
    this.name = 'LaneGitMetadataError';
  }
}

/** Inherited Git routing, config injection and executable overrides are untrusted. */
export function laneGitEnvironment(ignoreGlobalConfig = false): NodeJS.ProcessEnv {
  const env = childEnvironment();
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  delete env.NODE_OPTIONS;
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0',
    ...(ignoreGlobalConfig ? { GIT_CONFIG_GLOBAL: devNull } : {}) };
}

export function laneGitArguments(args: readonly string[]): string[] {
  const command = args[0];
  return ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${devNull}`,
    '-c', 'commit.gpgSign=false', '-c', 'submodule.recurse=false', '-c', 'core.pager=cat',
    '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
    ...args.slice(0, 1),
    ...(['diff', 'show', 'log'].includes(command) ? ['--no-ext-diff', '--no-textconv'] : []),
    ...args.slice(1)];
}

export interface LaneGitOptions {
  timeout?: number;
  maxBuffer?: number;
  /** Host-created temporary index, never inherited from the lane. */
  indexFile?: string;
  /** Host-created administration directory used in place of the checkout's own. */
  adminDir?: string;
  identity?: { name: string; email: string };
}

/** One host Git read the invocation checks need. Its stdout comes back to the plan. */
interface GitRead {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  maxBuffer?: number;
}
type GitPlan<T> = Generator<GitRead, T, string>;

const GIT_READ_TIMEOUT_MS = 5000;

/** Runs a plan with blocking reads, for synchronous callers. */
function runGitPlanSync<T>(plan: GitPlan<T>): T {
  let step = plan.next();
  while (!step.done) {
    let output: string;
    try {
      output = execFileSync(resolveGitBinary(), step.value.args, { cwd: step.value.cwd, env: step.value.env, encoding: 'utf8',
        timeout: GIT_READ_TIMEOUT_MS, ...(step.value.maxBuffer ? { maxBuffer: step.value.maxBuffer } : {}),
        stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      step = plan.throw(error);
      continue;
    }
    step = plan.next(output);
  }
  return step.value;
}

/**
 * Runs the same plan without holding the event loop (#3565). A failed read
 * reaches the plan as `execFileSync` reports it: the exit code is `status`.
 */
async function runGitPlan<T>(plan: GitPlan<T>): Promise<T> {
  let step = plan.next();
  while (!step.done) {
    const read = step.value;
    const result = await new Promise<{ output: string } | { error: unknown }>((resolve) => {
      execFile(resolveGitBinary(), read.args, { cwd: read.cwd, env: read.env, encoding: 'utf8', timeout: GIT_READ_TIMEOUT_MS,
        ...(read.maxBuffer ? { maxBuffer: read.maxBuffer } : {}) }, (error, stdout) => {
        if (!error) { resolve({ output: stdout }); return; }
        const code = (error as { code?: unknown }).code;
        resolve({ error: Object.assign(error, { status: typeof code === 'number' ? code : null }) });
      }).stdin?.end();
    });
    step = 'error' in result ? plan.throw(result.error) : plan.next(result.output);
  }
  return step.value;
}

function* configEntries(cwd: string, env: NodeJS.ProcessEnv, scope: 'effective' | 'system' | 'global', pattern: string): GitPlan<Array<[string, string]>> {
  try {
    const output: string = yield { args: [...laneGitArguments([]), 'config',
      ...(scope === 'effective' ? [] : [`--${scope}`, '--includes']), '--null', '--get-regexp', pattern],
    cwd, env, maxBuffer: 512 * 1024 };
    return output.split('\0').filter(Boolean).map((entry) => {
      const split = entry.indexOf('\n');
      if (split < 0) throw new LaneGitMetadataError();
      return [entry.slice(0, split), entry.slice(split + 1)];
    });
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

/** Reset executable transport config, then restore only trusted system and global credentials. */
function* transportArguments(cwd: string, env: NodeJS.ProcessEnv): GitPlan<string[]> {
  const pattern = '^(core\\.(sshcommand|askpass)|credential(\\..*)?\\.helper)$';
  if ((yield* configEntries(cwd, env, 'effective', '^remote\\..*\\.vcs$')).length) {
    // A vcs value can select a lane-owned git-remote-* executable even for a
    // file URL. There is no command flag that safely clears this setting.
    throw new LaneGitMetadataError();
  }
  // System config (for example a platform keychain helper) is read explicitly,
  // since lane Git runs with GIT_CONFIG_NOSYSTEM; Git applies it before global.
  const trusted = [...yield* configEntries(cwd, env, 'system', pattern), ...yield* configEntries(cwd, env, 'global', pattern)];
  const effective = yield* configEntries(cwd, env, 'effective', pattern);
  const args = ['-c', 'protocol.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'core.sshCommand=ssh', '-c', 'core.askPass=',
    '-c', 'credential.helper='];
  const protocols = new Set(['file', 'git', 'ssh', 'http', 'https']);
  for (const [key] of yield* configEntries(cwd, env, 'effective', '^protocol\\..*\\.allow$')) {
    args.push('-c', `${key}=never`);
  }
  for (const protocol of protocols) args.push('-c', `protocol.${protocol}.allow=always`);
  const keys = new Set([...effective, ...trusted].map(([key]) => key));
  for (const key of keys) {
    if (/^credential\..+\.helper$/.test(key)) args.push('-c', `${key}=`);
  }
  // Empty helper values reset Git's multi-valued list. Re-append the operator's
  // system then global entries in order, including URL-scoped helpers and resets.
  for (const [key, value] of trusted) {
    args.push('-c', `${key}=${value}`);
  }
  return args;
}

function realDirectory(directory: string): string {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LaneGitMetadataError();
  return realpathSync(directory);
}

function readPointer(file: string, prefix = ''): string {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) throw new LaneGitMetadataError();
  const value = readFileSync(file, 'utf8').trim();
  if (!value.startsWith(prefix) || !value.slice(prefix.length).trim()) throw new LaneGitMetadataError();
  return realpathSync(path.resolve(path.dirname(file), value.slice(prefix.length).trim()));
}

/** Find linked administration from host backlinks, never from the lane's pointer. */
function* resolveGitDirectories(worktreePath: string, repoPath: string, env: NodeJS.ProcessEnv): GitPlan<{ worktree: string; admin: string; common: string }> {
  try {
    const worktree = realDirectory(worktreePath);
    const dotGit = path.join(worktree, '.git');
    const host = realDirectory(repoPath);
    const commonOutput: string = yield { args: laneGitArguments([
      'rev-parse', '--path-format=absolute', '--git-common-dir',
    ]), cwd: host, env };
    const common = realDirectory(commonOutput.trim());
    const matches: string[] = [];
    const entries = path.join(common, 'worktrees');
    let names: string[] = [];
    try { names = readdirSync(entries); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const name of names) {
      const admin = path.join(entries, name);
      try {
        if (readPointer(path.join(realDirectory(admin), 'gitdir')) === dotGit) matches.push(admin);
      } catch (error) {
        // A prunable, missing sibling worktree does not invalidate this lane.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const stat = lstatSync(dotGit);
    if (matches.length) {
      if (matches.length !== 1 || !stat.isFile() || stat.isSymbolicLink()) throw new LaneGitMetadataError();
      const admin = realDirectory(matches[0]);
      if (readPointer(dotGit, 'gitdir:') !== admin || readPointer(path.join(admin, 'commondir')) !== common) {
        throw new LaneGitMetadataError();
      }
      return { worktree, admin, common };
    }
    // Independent CoW clones own a real .git directory below their root.
    const admin = realDirectory(dotGit);
    if (admin !== dotGit || path.relative(worktree, admin) !== '.git') throw new LaneGitMetadataError();
    try {
      lstatSync(path.join(admin, 'commondir'));
      throw new LaneGitMetadataError();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { worktree, admin, common: admin };
  } catch (error) {
    if (error instanceof LaneGitMetadataError) throw error;
    throw new LaneGitMetadataError();
  }
}

// Entries at the top of a repository's own Git dir that its operator may link
// elsewhere. Lane Git neither writes them through a link nor runs hooks.
const OPERATOR_GIT_ENTRIES = new Set(['config', 'description', 'hooks', 'info', 'objects', 'refs', 'packed-refs',
  'worktrees', 'modules', 'lfs', 'branches', 'remotes']);

function assertNoLinkInside(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new LaneGitMetadataError();
    if (entry.isDirectory()) assertNoLinkInside(path.join(directory, entry.name));
  }
}

/** No component of `relative` below `root` may be a symbolic link. */
function assertNoLinkAlong(root: string, relative: string): void {
  const parts = relative.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new LaneGitMetadataError();
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new LaneGitMetadataError();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

/**
 * A lane's worker can write its checkout's Git state, even in the worker
 * sandbox. Git follows a symbolic link when it appends a reflog, writes a
 * commit message or reads a ref, and never creates one there itself. So no
 * link may sit in the checkout's state, at the ref HEAD names, or at that
 * ref's reflog.
 */
function assertCheckoutStateIsGits({ admin, common }: { admin: string; common: string }): void {
  try {
    if (admin !== common) {
      assertNoLinkInside(admin);
    } else {
      for (const entry of readdirSync(admin, { withFileTypes: true })) {
        if (OPERATOR_GIT_ENTRIES.has(entry.name)) continue;
        if (entry.isSymbolicLink()) throw new LaneGitMetadataError();
        if (entry.isDirectory()) assertNoLinkInside(path.join(admin, entry.name));
      }
    }
    const head = readFileSync(path.join(admin, 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref:')) {
      const ref = head.slice('ref:'.length).trim();
      assertNoLinkAlong(common, ref);
      assertNoLinkAlong(common, `logs/${ref}`);
    }
  } catch (error) {
    if (error instanceof LaneGitMetadataError) throw error;
    throw new LaneGitMetadataError();
  }
}

interface LaneGitInvocation { args: string[]; env: NodeJS.ProcessEnv; cwd: string }

function* laneGitInvocationPlan(worktreePath: string, repoPath: string, args: readonly string[], ignoreGlobalConfig: boolean,
  options: LaneGitOptions): GitPlan<LaneGitInvocation> {
  const env = laneGitEnvironment(ignoreGlobalConfig);
  const directories = yield* resolveGitDirectories(worktreePath, repoPath, env);
  assertCheckoutStateIsGits(directories);
  Object.assign(env, { GIT_DIR: options.adminDir ?? directories.admin, GIT_COMMON_DIR: directories.common,
    GIT_WORK_TREE: directories.worktree });
  if (options.indexFile) env.GIT_INDEX_FILE = options.indexFile;
  if (options.identity) Object.assign(env, {
    GIT_AUTHOR_NAME: options.identity.name, GIT_AUTHOR_EMAIL: options.identity.email,
    GIT_COMMITTER_NAME: options.identity.name, GIT_COMMITTER_EMAIL: options.identity.email,
  });
  const safe = laneGitArguments([]);
  let keys = '';
  try {
    keys = yield { args: [...safe, 'config', '--null', '--name-only', '--get-regexp',
      '^filter\..*\.(clean|smudge|process|required)$'], cwd: directories.worktree, env, maxBuffer: 512 * 1024 };
  } catch (error) {
    if ((error as { status?: number }).status !== 1) throw error;
  }
  const drivers = new Set<string>();
  for (const key of keys.split('\0').filter(Boolean)) {
    const match = /^filter\.(.+)\.(clean|smudge|process|required)$/.exec(key);
    if (!match) throw new LaneGitMetadataError();
    drivers.add(match[1]);
  }
  const filters: string[] = [];
  for (const driver of drivers) {
    for (const field of ['clean', 'smudge', 'process', 'required']) {
      filters.push('-c', `filter.${driver}.${field}=${field === 'required' ? 'false' : ''}`);
    }
  }
  // Revalidate after enumeration. Command-line routing pins these directories,
  // but a concurrently introduced filter driver remains an enumeration race.
  const repeated = yield* resolveGitDirectories(worktreePath, repoPath, laneGitEnvironment(ignoreGlobalConfig));
  if (JSON.stringify(repeated) !== JSON.stringify(directories)) throw new LaneGitMetadataError();
  const isTransport = ['fetch', 'push', 'ls-remote', 'credential'].includes(args[0]);
  const transport = isTransport ? yield* transportArguments(directories.worktree, env) : [];
  if (isTransport) env.GIT_PROXY_COMMAND = '';
  // Remote upload/receive-pack config is first-value wins. Command flags take
  // precedence even when a later -c remote.* override would be ignored.
  const program = ['fetch', 'ls-remote'].includes(args[0]) ? ['--upload-pack=git-upload-pack']
    : args[0] === 'push' ? ['--receive-pack=git-receive-pack'] : [];
  // A split index would keep its shared part in the host directory.
  const commitDirectory = options.adminDir ? ['-c', 'core.splitIndex=false'] : [];
  // The caller's path, not its resolved form, so a workspace being materialized
  // there is checked at exec time like any other Git command run in it.
  return { args: [...filters, ...transport, ...commitDirectory,
    ...laneGitArguments(program.length ? [args[0], ...program, ...args.slice(1)] : args)],
  env, cwd: path.resolve(worktreePath) };
}

export function laneGitInvocation(worktreePath: string, repoPath: string, args: readonly string[], ignoreGlobalConfig = false, options: LaneGitOptions = {}) {
  return runGitPlanSync(laneGitInvocationPlan(worktreePath, repoPath, args, ignoreGlobalConfig, options));
}

/** The same checks as `laneGitInvocation`, with its Git reads off the event loop (#3565). */
export function laneGitInvocationAsync(worktreePath: string, repoPath: string, args: readonly string[], ignoreGlobalConfig = false, options: LaneGitOptions = {}) {
  return runGitPlan(laneGitInvocationPlan(worktreePath, repoPath, args, ignoreGlobalConfig, options));
}

export function laneGitSync(worktreePath: string, repoPath: string, args: readonly string[], options: ExecFileSyncOptions & LaneGitOptions = {}): string {
  const invocation = laneGitInvocation(worktreePath, repoPath, args, false, options);
  return execFileSync(resolveGitBinary(), invocation.args, { windowsHide: true, timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024, ...options, ...invocation, encoding: 'utf8' }).toString();
}

export async function laneGit(worktreePath: string, repoPath: string, args: readonly string[],
  options: LaneGitOptions = {}) {
  const invocation = await laneGitInvocationAsync(worktreePath, repoPath, args, false, options);
  return materializationAwareExecFile('git', invocation.args, { windowsHide: true, timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024, ...options, cwd: invocation.cwd, env: invocation.env });
}

/**
 * Before o8 commits or merges in a lane checkout on the lane's behalf: HEAD
 * must name the lane's branch, since the worker can point it anywhere. A lane
 * without a recorded branch is not checked.
 */
export async function assertLaneHeadOnBranch(worktreePath: string, repoPath: string, branch: string | null | undefined): Promise<void> {
  if (!branch?.trim()) return;
  let ref = '';
  try {
    ({ stdout: ref } = await laneGit(worktreePath, repoPath, ['symbolic-ref', '-q', 'HEAD'], { timeout: 5000 }));
  } catch (error) {
    if (error instanceof LaneGitMetadataError) throw error;
    // Exit 1: HEAD is detached.
  }
  if (String(ref).trim() !== `refs/heads/${branch.trim()}`) throw new LaneGitMetadataError();
}

export interface LaneCommitDirectory {
  /** Pass to every `laneGit` call that stages or commits. */
  options: { adminDir: string; indexFile: string };
  /** Replaces the checkout's index with the staged one, by rename. */
  syncIndex(): void;
}

/**
 * Runs `run` with a host-owned administration directory for committing onto
 * `refs/heads/<branch>`. A worker can change its checkout's HEAD, index, commit
 * message and HEAD log at any moment, including while o8 commits. Git given
 * this directory reads and writes none of them: its HEAD names the branch, and
 * its index starts as a copy of the checkout's.
 */
export async function withLaneCommitDirectory<T>(worktreePath: string, repoPath: string, branch: string,
  run: (directory: LaneCommitDirectory) => Promise<T>): Promise<T> {
  const { admin, common } = await runGitPlan(resolveGitDirectories(worktreePath, repoPath, laneGitEnvironment()));
  // The worker sandbox denies the data dir, unlike the system temp dir.
  const root = path.join(getDataDir(), 'lane-git');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await removeAbandonedCommitDirectories(root);
  const adminDir = await mkdtemp(path.join(root, COMMIT_DIRECTORY_PREFIX));
  try {
    const indexFile = path.join(adminDir, 'index');
    await writeFile(path.join(adminDir, 'HEAD'), `ref: refs/heads/${branch}\n`);
    // Git's ref store reads this file, not GIT_COMMON_DIR.
    await writeFile(path.join(adminDir, 'commondir'), `${common}\n`);
    const options = { adminDir, indexFile };
    if (!copyCheckoutIndex(path.join(admin, 'index'), indexFile)) {
      await laneGit(worktreePath, repoPath, ['read-tree', `refs/heads/${branch}`], options);
    }
    return await run({ options, syncIndex: () => replaceCheckoutIndex(indexFile, admin) });
  } finally {
    await rm(adminDir, { recursive: true, force: true });
  }
}

const COMMIT_DIRECTORY_PREFIX = 'commit-';
/** Far longer than any commit's Git timeouts. */
const ABANDONED_COMMIT_DIRECTORY_MS = 60 * 60 * 1000;

/** A commit directory outlives its commit only when o8 exits mid-commit. */
async function removeAbandonedCommitDirectories(root: string): Promise<void> {
  const now = Date.now();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(COMMIT_DIRECTORY_PREFIX)) continue;
    const directory = path.join(root, entry.name);
    try {
      if (now - (await stat(directory)).mtimeMs > ABANDONED_COMMIT_DIRECTORY_MS) {
        await rm(directory, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function copyCheckoutIndex(source: string, target: string): boolean {
  let fd: number;
  try {
    fd = openSync(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new LaneGitMetadataError();
  }
  try {
    if (!fstatSync(fd).isFile()) throw new LaneGitMetadataError();
    writeFileSync(target, readFileSync(fd), { flag: 'wx', mode: 0o600 });
  } finally {
    closeSync(fd);
  }
  return true;
}

function replaceCheckoutIndex(source: string, admin: string): void {
  // A new name never follows an existing link, and rename replaces the entry.
  const staged = path.join(admin, `index.o8-${randomUUID()}`);
  writeFileSync(staged, readFileSync(source), { flag: 'wx' });
  renameSync(staged, path.join(admin, 'index'));
}
