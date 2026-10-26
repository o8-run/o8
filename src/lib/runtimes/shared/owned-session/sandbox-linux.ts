/**
 * Linux backend for the Tier-2 worker sandbox (#1325): renders the same
 * canonical policy that `buildSeatbeltProfile` turns into SBPL as a bubblewrap
 * (`bwrap`) mount namespace.
 *
 * The root filesystem is bound read-only, then:
 * - HOME, `/tmp`, and the operator's XDG runtime dir (D-Bus, keyring and
 *   other session sockets) are masked with empty tmpfs mounts. `/tmp` stays a
 *   private writable scratch area; the others are remounted read-only at the end.
 * - Toolchain read roots inside a masked tree are bound back read-only.
 * - The worktree, repo, git metadata, TMPDIR and toolchain caches are bound
 *   read-write.
 * - Secret roots (`~/.o8`, `~/.tauri`, `~/.config/gh`, data dirs, …) are hidden
 *   wherever they would otherwise be visible.
 * - Narrow re-opens follow, then immutable files and read-only packet paths are
 *   bound read-only LAST, so they win over every grant above (the same
 *   last-match-wins order the seatbelt profile relies on).
 *
 * Network is shared with the host, matching the macOS profile's
 * `(allow network*)`, so the RF-1 HTTP path to the loopback API keeps working.
 * The worker gets its own PID namespace and session (`--new-session`), so it
 * cannot read other processes' environments through /proc or push keystrokes
 * into the launching terminal with TIOCSTI.
 *
 * Exec and basename denials have no mount-namespace equivalent, so callers that
 * need them are refused rather than run with a weaker policy.
 */

import { stat, writeFile } from 'node:fs/promises';
import { access, constants as fsConstants } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from '@/lib/providers/child-process';
import { SandboxUnavailableError } from './sandbox-error';
import { homeToolchainPolicy } from './sandbox-toolchain';
import type { PreparedSandbox, PrepareWorkerSandboxInput, SeatbeltProfileInput } from './sandbox';

const execFileAsync = promisify(execFile);

/** Fixed install locations only: a PATH lookup could pick up a planted binary. */
export const BWRAP_CANDIDATE_PATHS = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap'] as const;

export type PathKind = 'dir' | 'file';

export interface BwrapPolicyContext {
  /** Kind of every policy path that exists on the host. Absent means missing. */
  kinds: ReadonlyMap<string, PathKind>;
  /** The operator's XDG runtime dir (e.g. /run/user/1000), when it exists. */
  runtimeDir?: string;
}

/** Namespace flags shared by the launch and the availability probe. */
const BASE_ARGS = [
  '--die-with-parent', '--new-session', '--unshare-pid',
  '--ro-bind', '/', '/',
  '--dev-bind', '/dev', '/dev',
  '--proc', '/proc',
] as const;

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function pathIsWithin(child: string, parent: string): boolean {
  if (child === parent || parent === '/') return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
}

/** Refuse policy features a mount namespace cannot express. Fail-closed. */
export function assertBwrapExpressible(input: Pick<PrepareWorkerSandboxInput,
  'finalDenyExecPaths' | 'finalDenyExecNamePrefixes' | 'finalDenyReadBasenames'
  | 'finalAllowExecPaths' | 'finalCredentialPolicy'>): void {
  const unsupported = [
    input.finalDenyExecPaths?.length ? 'executable denials' : '',
    input.finalDenyExecNamePrefixes?.length ? 'executable-name denials' : '',
    input.finalDenyReadBasenames?.length ? 'basename read denials' : '',
    input.finalAllowExecPaths?.length ? 'executable re-opens' : '',
    input.finalCredentialPolicy ? 'the credential lock policy' : '',
  ].filter(Boolean);
  if (unsupported.length) {
    throw new SandboxUnavailableError(
      `This launch needs ${unsupported.join(', ')}, which the Linux worker sandbox (bubblewrap) `
      + 'cannot enforce yet. Refusing to run it with a weaker policy.',
    );
  }
}

type MountState = 'ro' | 'rw' | 'hidden';

/** Parents before children, so a later parent bind never covers a child grant. */
function byDepth(paths: string[]): string[] {
  return [...paths].sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
}

/**
 * Build the bwrap argument vector (without the trailing command). Pure and
 * deterministic given canonical policy paths and their host kinds.
 */
export function buildBwrapArgs(policy: SeatbeltProfileInput, context: BwrapPolicyContext): string[] {
  const home = policy.homeDir.replace(/\/+$/, '') || '/';
  if (home === '/') throw new SandboxUnavailableError('Refusing to sandbox a worker whose HOME is /.');
  const toolchain = homeToolchainPolicy(home);
  const exists = (p: string) => context.kinds.has(p);
  const args: string[] = [...BASE_ARGS];
  const mounts: Array<{ path: string; state: MountState }> = [{ path: '/', state: 'ro' }];
  // The mount that finally decides `p`: the latest one at `p` or an ancestor.
  const topMount = (p: string) => {
    for (let i = mounts.length - 1; i >= 0; i -= 1) {
      if (pathIsWithin(p, mounts[i].path)) return mounts[i];
    }
    return mounts[0];
  };
  const stateOf = (p: string): MountState => topMount(p).state;
  const bind = (p: string, state: 'ro' | 'rw') => {
    args.push(state === 'rw' ? '--bind' : '--ro-bind', p, p);
    mounts.push({ path: p, state });
  };
  // tmpfs masks are remounted read-only last, once every bind inside them exists.
  const remountReadOnly: Array<{ path: string; state: MountState }> = [];
  const hide = (p: string) => {
    const mount = { path: p, state: 'hidden' as const };
    if (context.kinds.get(p) === 'dir') {
      args.push('--tmpfs', p);
      remountReadOnly.push(mount);
    } else {
      args.push('--ro-bind', '/dev/null', p);
    }
    mounts.push(mount);
  };

  const masks = uniq(['/tmp', home, context.runtimeDir ?? '']).filter(exists);
  for (const mask of masks) {
    const mount = { path: mask, state: 'hidden' as const };
    args.push('--tmpfs', mask);
    mounts.push(mount);
    if (mask !== '/tmp') remountReadOnly.push(mount);
  }
  const masked = (p: string) => masks.some((mask) => pathIsWithin(p, mask));

  const readRoots = uniq([
    ...toolchain.readDirs, ...toolchain.files,
    ...(policy.pathReadRoots ?? []), ...(policy.extraReadPaths ?? []),
  ]).filter((p) => exists(p) && masked(p) && !masks.includes(p));
  for (const p of byDepth(readRoots)) bind(p, 'ro');

  const rwRoots = uniq([
    policy.worktreePath, policy.repoPath, policy.tmpDir,
    ...toolchain.writeDirs, ...toolchain.mutableFiles,
    ...(policy.extraReadWritePaths ?? []),
  ]);
  for (const p of byDepth(rwRoots)) {
    if (p === home) throw new SandboxUnavailableError(`Refusing to grant the whole HOME (${home}) read+write.`);
    // A private tmpfs already makes /tmp writable without exposing host files.
    if (!exists(p) || masks.includes(p)) continue;
    bind(p, 'rw');
  }

  const secretRoots = uniq([
    path.join(home, '.o8'), path.join(home, '.cortex-ide'), path.join(home, '.tauri'),
    path.join(home, '.config', 'gh'),
    ...(policy.extraDenyPaths ?? []), ...(policy.finalDenyPaths ?? []),
  ]);
  for (const p of secretRoots) {
    if (exists(p) && stateOf(p) !== 'hidden') hide(p);
  }

  for (const p of uniq([...(policy.trustedReadWritePaths ?? []), ...(policy.finalAllowReadWritePaths ?? [])])) {
    if (exists(p)) bind(p, 'rw');
  }
  for (const p of uniq(policy.finalAllowReadPaths ?? [])) {
    if (exists(p)) bind(p, 'ro');
  }
  const immutable = uniq([
    ...toolchain.immutablePaths,
    ...(policy.finalDenyWritePaths ?? []),
    ...(policy.finalImmutableWritePaths ?? []),
    ...(policy.readOnlyDenyWritePaths ?? []),
  ]);
  for (const p of immutable) {
    if (exists(p) && stateOf(p) === 'rw') bind(p, 'ro');
  }
  // Skip a mask a later bind replaced (e.g. HOME inside a granted TMPDIR):
  // remounting would hit that bind instead of the tmpfs.
  for (const mount of remountReadOnly) {
    if (topMount(mount.path) === mount) args.push('--remount-ro', mount.path);
  }
  return args;
}

/** Every path whose host kind the policy builder needs. */
export function bwrapPolicyPaths(policy: SeatbeltProfileInput, runtimeDir?: string): string[] {
  const home = policy.homeDir.replace(/\/+$/, '');
  const toolchain = homeToolchainPolicy(home);
  return uniq([
    '/tmp', home, runtimeDir ?? '',
    ...Object.values(toolchain).flat(),
    policy.worktreePath, policy.repoPath, policy.tmpDir,
    path.join(home, '.o8'), path.join(home, '.cortex-ide'), path.join(home, '.tauri'),
    path.join(home, '.config', 'gh'),
    ...[
      policy.extraReadWritePaths, policy.extraReadPaths, policy.pathReadRoots, policy.extraDenyPaths,
      policy.trustedReadWritePaths, policy.finalDenyPaths, policy.finalAllowReadWritePaths,
      policy.finalDenyWritePaths, policy.finalImmutableWritePaths, policy.finalAllowReadPaths,
      policy.readOnlyDenyWritePaths,
    ].flatMap((list) => list ?? []),
  ]);
}

async function statKinds(paths: string[]): Promise<Map<string, PathKind>> {
  const kinds = new Map<string, PathKind>();
  await Promise.all(paths.map(async (p) => {
    const info = await stat(p).catch(() => null);
    if (info) kinds.set(p, info.isDirectory() ? 'dir' : 'file');
  }));
  return kinds;
}

function xdgRuntimeDir(): string | undefined {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  return uid === undefined ? undefined : `/run/user/${uid}`;
}

let verifiedBwrap: string | null = null;

/**
 * Locate bubblewrap and prove the kernel lets it build the namespaces the
 * worker sandbox uses (unprivileged user namespaces can be disabled by sysctl
 * or an LSM policy, e.g. Ubuntu's AppArmor userns restriction).
 */
export async function requireBwrap(): Promise<string> {
  if (verifiedBwrap) return verifiedBwrap;
  let found: string | null = null;
  for (const candidate of BWRAP_CANDIDATE_PATHS) {
    if (await access(candidate, fsConstants.X_OK).then(() => true, () => false)) {
      found = candidate;
      break;
    }
  }
  if (!found) {
    throw new SandboxUnavailableError(
      `bubblewrap (bwrap) is required for the Linux worker sandbox but was not found in ${BWRAP_CANDIDATE_PATHS.join(', ')}. `
      + 'Install it (e.g. `apt install bubblewrap`) or unset O8_WORKER_SANDBOX.',
    );
  }
  try {
    await execFileAsync(found, [...BASE_ARGS, '--', '/bin/true'], {
      windowsHide: true, encoding: 'utf8', timeout: 10_000,
    });
  } catch (error) {
    const detail = String((error as { stderr?: unknown }).stderr ?? '').trim() || (error as Error).message;
    throw new SandboxUnavailableError(
      `The kernel refused the worker sandbox namespaces (${found}: ${detail}). `
      + 'Unprivileged user namespaces may be disabled (kernel.unprivileged_userns_clone, '
      + 'or kernel.apparmor_restrict_unprivileged_userns on Ubuntu).',
    );
  }
  verifiedBwrap = found;
  return found;
}

export async function prepareBwrapSandbox(input: {
  bwrapPath: string;
  policy: SeatbeltProfileInput;
  profilePath: string;
  cwd: string;
  binary: string;
  args: string[];
}): Promise<PreparedSandbox> {
  const runtimeDir = xdgRuntimeDir();
  const kinds = await statKinds(bwrapPolicyPaths(input.policy, runtimeDir));
  const bwrapArgs = buildBwrapArgs(input.policy, { kinds, runtimeDir });
  const args = [...bwrapArgs, '--chdir', input.cwd, '--', input.binary, ...input.args];
  const profileText = `${[input.bwrapPath, ...args].join('\n')}\n`;
  try {
    await writeFile(input.profilePath, profileText, { mode: 0o600 });
  } catch (error) {
    throw new SandboxUnavailableError(
      `Failed to write bubblewrap policy to ${input.profilePath}: ${(error as Error).message}`,
    );
  }
  return { binary: input.bwrapPath, args, profilePath: input.profilePath, profileText };
}

/** Test seam: forget a cached probe result. */
export function resetBwrapProbeForTests(): void {
  verifiedBwrap = null;
}
