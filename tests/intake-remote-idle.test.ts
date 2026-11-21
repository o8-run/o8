import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import { resolveRepoPath } from '@/lib/intake/resolve-repo';
import { getRemoteSlug } from '@/lib/intake/remote-slug';

const state = vi.hoisted(() => ({ systemPath: '' }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn((file: string, args: string[], options: object = {}) => {
      // Model an observable system config on hosts without one. All repository
      // operations and config discovery still go through the real executable.
      if (args.includes('--system')) return `file:${state.systemPath}\0core.pager\ncat\0`;
      return actual.execFileSync(file, args, {
        ...options,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      });
    }),
  };
});

const directory = getDataDir();
mkdirSync(directory, { recursive: true });
state.systemPath = join(directory, 'system.cfg');
writeFileSync(state.systemPath, '[core]\n pager = cat\n');
let sequence = 0;
function fixture() {
  const repo = join(directory, `remote-${++sequence}`);
  execFileSync('git', ['init', '--quiet', repo]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/registered.git'], { cwd: repo });
  writeFileSync(join(directory, 'repos.json'), JSON.stringify({ repos: [{ localPath: repo }] }));
  return repo;
}

afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe('idle intake remote resolution', () => {
  it('reuses unchanged real remote lookups through the registry entry point', () => {
    const repo = fixture();
    expect(resolveRepoPath('example/registered')).toBe(repo);
    const git = vi.mocked(execFileSync).mockClear();
    for (let index = 0; index < 20; index += 1) expect(resolveRepoPath('example/registered')).toBe(repo);
    expect(git).not.toHaveBeenCalled();
  });

  it('caches a registered repository with no origin until an origin is added', () => {
    const repo = join(directory, `remote-${++sequence}`);
    execFileSync('git', ['init', '--quiet', repo]);
    writeFileSync(join(directory, 'repos.json'), JSON.stringify({ repos: [{ localPath: repo }] }));
    expect(resolveRepoPath('example/elsewhere')).toBeNull();
    const git = vi.mocked(execFileSync).mockClear();
    for (let index = 0; index < 20; index += 1) expect(resolveRepoPath('example/elsewhere')).toBeNull();
    expect(git).not.toHaveBeenCalled();
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/elsewhere.git'], { cwd: repo });
    expect(resolveRepoPath('example/elsewhere')).toBe(repo);
  });

  it('detects a changed remote immediately and does not reuse a removed registry entry', () => {
    const repo = fixture();
    expect(resolveRepoPath('example/registered')).toBe(repo);
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/example/changed.git'], { cwd: repo });
    expect(resolveRepoPath('example/registered')).toBeNull();
    expect(resolveRepoPath('example/changed')).toBe(repo);
    writeFileSync(join(directory, 'repos.json'), JSON.stringify({ repos: [] }));
    expect(resolveRepoPath('example/changed')).toBeNull();
  });

  it('invalidates on system configuration changes', () => {
    const repo = fixture();
    expect(getRemoteSlug(repo)).toBe('example/registered');
    writeFileSync(state.systemPath, '[core]\n pager = less\n');
    const git = vi.mocked(execFileSync).mockClear();
    expect(getRemoteSlug(repo)).toBe('example/registered');
    expect(git).toHaveBeenCalled();
  });

  it('keeps included configuration uncached and follows edits to the included file', () => {
    const repo = fixture();
    expect(getRemoteSlug(repo)).toBe('example/registered');
    const included = join(directory, 'included.cfg');
    writeFileSync(included, '[remote "origin"]\n url = https://github.com/example/included.git\n');
    execFileSync('git', ['config', '--unset-all', 'remote.origin.url'], { cwd: repo });
    execFileSync('git', ['config', 'include.path', included], { cwd: repo });
    expect(getRemoteSlug(repo)).toBe('example/included');
    writeFileSync(included, '[remote "origin"]\n url = https://github.com/example/edited.git\n');
    expect(getRemoteSlug(repo)).toBe('example/edited');
  });

  it('does not memoize a transient Git failure', () => {
    const repo = fixture();
    const original = vi.mocked(execFileSync).getMockImplementation()!;
    let failed = false;
    vi.mocked(execFileSync).mockImplementation((...args) => {
      if (!failed && Array.isArray(args[1]) && args[1][0] === 'remote') {
        failed = true;
        throw new Error('temporary process failure');
      }
      return original(...args);
    });
    try {
      expect(getRemoteSlug(repo)).toBeNull();
      expect(getRemoteSlug(repo)).toBe('example/registered');
    } finally { vi.mocked(execFileSync).mockImplementation(original); }
  });

  it('uses fresh Git results when config overrides are present', () => {
    const repo = fixture();
    expect(getRemoteSlug(repo)).toBe('example/registered');
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'url.https://github.com/example/override.git.insteadOf');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'https://github.com/example/registered.git');
    expect(getRemoteSlug(repo)).toBe('example/override');
    expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).not.toContain('override.git');
  });
});
