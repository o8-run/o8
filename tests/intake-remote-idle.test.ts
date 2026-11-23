import * as childProcess from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import { createRepoPathResolver, resolveRepoPath } from '@/lib/intake/resolve-repo';

// Count every child process the resolver could start. Fixtures run Git through
// the real module, so only calls made after `quiet()` count.
const spawned = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const counted = <T extends (...args: never[]) => unknown>(fn: T) =>
    ((...args: Parameters<T>) => { spawned.calls += 1; return fn(...args); }) as unknown as T;
  return {
    ...actual,
    spawn: counted(actual.spawn), spawnSync: counted(actual.spawnSync), exec: counted(actual.exec),
    execSync: counted(actual.execSync), execFile: counted(actual.execFile), execFileSync: counted(actual.execFileSync),
  };
});

const directory = getDataDir();
mkdirSync(directory, { recursive: true });
let sequence = 0;
function git(cwd: string, ...args: string[]) {
  childProcess.execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
}
function register(repos: Array<{ localPath: string; remoteUrl?: string | null }>) {
  writeFileSync(join(directory, 'repos.json'), JSON.stringify({ repos }));
}
function fixture(origin: string | null) {
  const repo = join(directory, `remote-${++sequence}`);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '--quiet');
  if (origin) git(repo, 'remote', 'add', 'origin', origin);
  return repo;
}
const quiet = () => { spawned.calls = 0; };

afterEach(() => { vi.clearAllMocks(); });

describe('idle intake remote resolution', () => {
  it('resolves a registered repository without starting Git', () => {
    const repo = fixture('https://github.com/example/registered.git');
    register([{ localPath: repo }]);
    quiet();
    for (let index = 0; index < 20; index += 1) expect(resolveRepoPath('example/registered')).toBe(repo);
    expect(spawned.calls).toBe(0);
  });

  it('answers "no origin" without Git and sees an origin added later', () => {
    const repo = fixture(null);
    register([{ localPath: repo, remoteUrl: null }]);
    quiet();
    for (let index = 0; index < 20; index += 1) expect(resolveRepoPath('example/elsewhere')).toBeNull();
    expect(spawned.calls).toBe(0);
    git(repo, 'remote', 'add', 'origin', 'git@github.com:example/elsewhere.git');
    expect(resolveRepoPath('example/elsewhere')).toBe(repo);
  });

  it('detects a changed remote immediately and does not reuse a removed registry entry', () => {
    const repo = fixture('https://github.com/example/registered.git');
    register([{ localPath: repo }]);
    expect(resolveRepoPath('example/registered')).toBe(repo);
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/example/changed.git');
    expect(resolveRepoPath('example/registered')).toBeNull();
    expect(resolveRepoPath('example/changed')).toBe(repo);
    register([]);
    expect(resolveRepoPath('example/changed')).toBeNull();
  });

  it('reads the registry once per resolver, however many names it is asked about', () => {
    const repos = ['one', 'two', 'three'].map((name) => fixture(`https://github.com/example/${name}.git`));
    register(repos.map((localPath) => ({ localPath })));
    const resolve = createRepoPathResolver();
    expect(resolve('example/one')).toBe(repos[0]);
    register([]);
    expect(resolve('example/three')).toBe(repos[2]);
    expect(resolve('example/missing')).toBeNull();
    expect(createRepoPathResolver()('example/three')).toBeNull();
  });

  it('keeps the saved remote when the config needs Git to read', () => {
    const repo = fixture(null);
    const included = join(directory, `included-${sequence}.cfg`);
    writeFileSync(included, '[remote "origin"]\n url = https://github.com/example/included.git\n');
    git(repo, 'config', 'include.path', included);
    register([{ localPath: repo, remoteUrl: 'https://github.com/example/saved.git' }]);
    quiet();
    expect(resolveRepoPath('example/saved')).toBe(repo);
    expect(spawned.calls).toBe(0);
  });

  it('follows a linked worktree to the shared config', () => {
    const main = fixture('https://github.com/example/shared.git');
    git(main, 'commit', '--quiet', '--allow-empty', '-m', 'init', '--no-gpg-sign');
    const linked = join(directory, `linked-${sequence}`);
    git(main, 'worktree', 'add', '--quiet', '--detach', linked);
    register([{ localPath: linked }]);
    quiet();
    expect(resolveRepoPath('example/shared')).toBe(linked);
    expect(spawned.calls).toBe(0);
  });
});
