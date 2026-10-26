import { describe, expect, it } from 'vitest';
import { assertBwrapExpressible, buildBwrapArgs, bwrapPolicyPaths, type PathKind } from './sandbox-linux';
import { SandboxUnavailableError } from './sandbox-error';
import type { SeatbeltProfileInput } from './sandbox';

const HOME = '/home/op';
const WORKTREE = '/home/op/src/app';

function policy(overrides: Partial<SeatbeltProfileInput> = {}): SeatbeltProfileInput {
  return { worktreePath: WORKTREE, repoPath: WORKTREE, homeDir: HOME, tmpDir: '/tmp', ...overrides };
}

function kinds(dirs: string[], files: string[] = []): Map<string, PathKind> {
  return new Map([...dirs.map((p) => [p, 'dir'] as const), ...files.map((p) => [p, 'file'] as const)]);
}

/** The flag that introduces `target` as a mount destination, or -1. */
function mountIndex(args: string[], flag: string, target: string): number {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== flag) continue;
    const dest = flag === '--tmpfs' || flag === '--remount-ro' ? args[i + 1] : args[i + 2];
    if (dest === target) return i;
  }
  return -1;
}

const baseDirs = ['/tmp', HOME, WORKTREE, `${HOME}/.config`, `${HOME}/.cache`, `${HOME}/.codex`];

describe('buildBwrapArgs — Linux worker sandbox policy', () => {
  it('binds the root read-only, keeps the host network, and isolates PID and session', () => {
    const args = buildBwrapArgs(policy(), { kinds: kinds(baseDirs) });
    expect(args.slice(0, 3)).toEqual(['--die-with-parent', '--new-session', '--unshare-pid']);
    expect(mountIndex(args, '--ro-bind', '/')).toBeGreaterThan(-1);
    expect(args).not.toContain('--unshare-net');
    expect(args).not.toContain('--unshare-all');
  });

  it('masks HOME, /tmp and the session runtime dir, and leaves only /tmp writable', () => {
    const args = buildBwrapArgs(policy(), { kinds: kinds([...baseDirs, '/run/user/1000']), runtimeDir: '/run/user/1000' });
    for (const mask of ['/tmp', HOME, '/run/user/1000']) expect(mountIndex(args, '--tmpfs', mask)).toBeGreaterThan(-1);
    expect(mountIndex(args, '--remount-ro', HOME)).toBeGreaterThan(-1);
    expect(mountIndex(args, '--remount-ro', '/run/user/1000')).toBeGreaterThan(-1);
    expect(mountIndex(args, '--remount-ro', '/tmp')).toBe(-1);
    // A private /tmp already satisfies TMPDIR; re-binding the host /tmp would expose its sockets.
    expect(mountIndex(args, '--bind', '/tmp')).toBe(-1);
  });

  it('limits writes to the worktree, git metadata and caches; toolchain prefixes stay read-only', () => {
    const gitDir = '/srv/repos/app.git';
    const args = buildBwrapArgs(policy({ extraReadWritePaths: [gitDir] }), {
      kinds: kinds([...baseDirs, gitDir, `${HOME}/.rustup`, `${HOME}/.pnpm-store`]),
    });
    for (const rw of [WORKTREE, gitDir, `${HOME}/.cache`, `${HOME}/.codex`, `${HOME}/.pnpm-store`]) {
      expect(mountIndex(args, '--bind', rw)).toBeGreaterThan(mountIndex(args, '--tmpfs', HOME));
    }
    expect(mountIndex(args, '--ro-bind', `${HOME}/.rustup`)).toBeGreaterThan(-1);
    expect(mountIndex(args, '--bind', `${HOME}/.rustup`)).toBe(-1);
    expect(mountIndex(args, '--ro-bind', `${HOME}/.config`)).toBeGreaterThan(-1);
    // Missing cache dirs are skipped rather than created.
    expect(mountIndex(args, '--bind', `${HOME}/.npm`)).toBe(-1);
  });

  it('hides secrets that would otherwise be visible, and only those', () => {
    const gh = `${HOME}/.config/gh`;
    const token = `${WORKTREE}/.o8-token`;
    const args = buildBwrapArgs(policy({ finalDenyPaths: [token] }), {
      kinds: kinds([...baseDirs, gh, `${HOME}/.o8`], [token]),
    });
    expect(mountIndex(args, '--tmpfs', gh)).toBeGreaterThan(mountIndex(args, '--ro-bind', `${HOME}/.config`));
    expect(mountIndex(args, '--remount-ro', gh)).toBeGreaterThan(-1);
    expect(args.join(' ')).toContain(`--ro-bind /dev/null ${token}`);
    // ~/.o8 is already under the HOME mask, so it needs no extra mount.
    expect(args).not.toContain(`${HOME}/.o8`);
  });

  it('re-opens a workspace that lives inside a hidden data root', () => {
    const data = '/srv/o8-data';
    const worktree = `${data}/worktrees/p1`;
    const args = buildBwrapArgs(policy({
      worktreePath: worktree, repoPath: worktree, extraDenyPaths: [data], trustedReadWritePaths: [worktree],
    }), { kinds: kinds([...baseDirs, data, worktree]) });
    const hidden = mountIndex(args, '--tmpfs', data);
    expect(hidden).toBeGreaterThan(mountIndex(args, '--bind', worktree));
    expect(args.lastIndexOf(worktree)).toBeGreaterThan(hidden);
  });

  it('binds immutable credentials and read-only packet paths read-only after every grant', () => {
    const auth = `${HOME}/.codex/auth.json`;
    const args = buildBwrapArgs(policy({ readOnlyDenyWritePaths: [WORKTREE] }), {
      kinds: kinds(baseDirs, [auth]),
    });
    expect(mountIndex(args, '--ro-bind', auth)).toBeGreaterThan(mountIndex(args, '--bind', `${HOME}/.codex`));
    const lastGrant = args.lastIndexOf('--bind');
    expect(mountIndex(args, '--ro-bind', WORKTREE)).toBeGreaterThan(lastGrant);
  });

  it('refuses to grant the whole HOME read+write', () => {
    expect(() => buildBwrapArgs(policy({ extraReadWritePaths: [HOME] }), { kinds: kinds(baseDirs) }))
      .toThrow(SandboxUnavailableError);
  });

  it('collects every policy path for host stat', () => {
    const paths = bwrapPolicyPaths(policy({ finalAllowReadPaths: ['/opt/x'] }), '/run/user/1000');
    expect(paths).toEqual(expect.arrayContaining(['/tmp', HOME, WORKTREE, '/run/user/1000', '/opt/x', `${HOME}/.config/gh`]));
  });
});

describe('assertBwrapExpressible', () => {
  it('accepts the normal worker policy', () => {
    expect(() => assertBwrapExpressible({})).not.toThrow();
  });

  it('refuses exec and basename denials instead of weakening them', () => {
    expect(() => assertBwrapExpressible({ finalDenyExecNamePrefixes: ['codex'] })).toThrow(/executable-name denials/);
    expect(() => assertBwrapExpressible({ finalDenyReadBasenames: ['codex'] })).toThrow(SandboxUnavailableError);
  });
});
