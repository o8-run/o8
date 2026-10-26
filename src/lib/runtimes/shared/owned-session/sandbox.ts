/**
 * Tier-2 worker sandboxing (#1325) — OS-level isolation for locally-dispatched
 * workers.
 *
 * o8 spawns local Codex/Claude workers as the operator's OWN uid. Tier-1 (the
 * RF-1 request-principal model) stops a prompt-injected worker from driving the
 * `o8` CLI to resolve its own approvals, but it does NOT stop a fully-malicious
 * worker that reads the operator's on-disk secrets directly
 * (`~/.o8/ws-token`, `~/.o8/worker-token`, the `/tmp/tauri-mcp-o8-*` webview
 * socket + its `.token` sidefile) and impersonates the operator.
 *
 * This module wraps the worker child process with macOS `sandbox-exec` and a
 * generated seatbelt (SBPL) profile: deny-by-default file access, with reads
 * scoped to the toolchain/system paths node/git/codex/claude need, read+write
 * scoped to the packet worktree + repo + TMPDIR, network allowed (so the RF-1
 * HTTP path to the gated loopback API keeps working), and EXPLICIT denials on
 * `~/.o8`, `~/.tauri`, and the webview socket so those secrets are unreachable.
 *
 * NOTE: `sandbox-exec` is deprecated by Apple (since 10.14) but remains fully
 * functional and is still how Chrome/Firefox/many tools sandbox helpers today.
 * The module is intentionally shaped as a policy backend so a future
 * container/uid backend can slot in behind {@link prepareWorkerSandbox} without
 * touching the spawn chokepoint.
 *
 * FEATURE GATE: off by default. Enable with `O8_WORKER_SANDBOX=on` (or
 * 1/true/yes). When ON the semantics are FAIL-CLOSED — if the profile cannot be
 * built (non-macOS host, missing `sandbox-exec`, unwritable profile file) the
 * caller refuses to spawn rather than silently running the worker unsandboxed.
 */

import { lstat, realpath, writeFile } from 'node:fs/promises';
import { access, constants as fsConstants } from 'node:fs/promises';
import { execFile } from '@/lib/providers/child-process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { backingProjectConfigPaths } from './project-config';
import { ownerInstructionPaths } from './owner-instructions';

const execFileAsync = promisify(execFile);

/** Absolute path to Apple's seatbelt runner. */
export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

/** Raised when a sandbox was requested but cannot be provided. Fail-closed. */
export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxUnavailableError';
  }
}

/**
 * Is Tier-2 worker sandboxing enabled? Off by default so day-one dispatch can
 * never be bricked; the operator opts in via `O8_WORKER_SANDBOX`.
 */
export function workerSandboxEnabled(): boolean {
  const raw = process.env.O8_WORKER_SANDBOX?.trim().toLowerCase();
  if (!raw) return false;
  return raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes';
}

/** SBPL string-literal escaping — backslashes and double-quotes. */
function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** `(subpath "…")` filter, SBPL-escaped. */
function subpath(p: string): string {
  return `(subpath ${sbplString(p)})`;
}

function regexFragment(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&').replace(/"/g, '\\"');
}

/** Resolve existing ancestors too, so missing policy files retain canonical denials. */
async function safeRealpath(p: string): Promise<string> {
  let current = path.resolve(p);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(current), ...missing);
    } catch (error) {
      const parent = path.dirname(current);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === current) {
        throw new SandboxUnavailableError(`Cannot resolve sandbox policy path '${p}'.`);
      }
      // A dangling symlink is not a missing tail: its eventual target could
      // differ from this lexical path. Refuse it instead of guessing a grant.
      const existing = await lstat(current).catch((statError: NodeJS.ErrnoException) => {
        if (statError.code === 'ENOENT') return null;
        throw new SandboxUnavailableError(`Cannot inspect sandbox policy path '${p}'.`);
      });
      if (existing) throw new SandboxUnavailableError(`Unresolved sandbox policy path '${p}'.`);
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** unique, order-preserving. */
function uniq(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

/** Is `child` the same path as, or nested inside, `parent`? */
function pathIsWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const normalizedParent = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return child.startsWith(normalizedParent);
}

/**
 * Refuse a profile whose final allow and final deny sets overlap.
 *
 * The two blocks are emitted allow-then-deny so last-match-wins keeps the deny
 * authoritative, but an overlap is still a policy contradiction: it means a
 * caller believes a subtree is writable while the profile denies it. Failing
 * closed here surfaces the contradiction at launch instead of at the first
 * mysterious EPERM inside the worker.
 */
export function assertNoRegrantOverlap(
  finalAllowReadWritePaths: string[],
  finalDenyWritePaths: string[],
): void {
  for (const allowed of finalAllowReadWritePaths) {
    for (const denied of finalDenyWritePaths) {
      if (pathIsWithin(allowed, denied) || pathIsWithin(denied, allowed)) {
        throw new SandboxUnavailableError(
          `Sandbox policy conflict: '${allowed}' is re-opened for writes while '${denied}' is `
          + 'write-denied. Refusing to build a profile whose allow and deny sets overlap.',
        );
      }
    }
  }
}

/** Refuse a runtime-state allow that resolves to a protected parent root. */
export function assertNarrowRuntimeStateRegrants(
  allowedPaths: string[],
  protectedRoots: string[],
): void {
  for (const allowed of allowedPaths) {
    if (!path.isAbsolute(allowed)) {
      throw new SandboxUnavailableError(
        `Sandbox runtime state path '${allowed}' is not absolute. Refusing an ambiguous regrant.`,
      );
    }
    for (const protectedRoot of protectedRoots) {
      if (pathIsWithin(protectedRoot, allowed)) {
        throw new SandboxUnavailableError(
          `Sandbox runtime state path '${allowed}' would re-open protected root '${protectedRoot}'.`,
        );
      }
    }
  }
}

function expandHomePath(value: string, home: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === '~') return home;
  if (trimmed.startsWith(`~${path.sep}`)) return path.join(home, trimmed.slice(2));
  return path.isAbsolute(trimmed) ? trimmed : null;
}

function workerPathReadRoots(home: string): string[] {
  return uniq((process.env.PATH ?? '')
    .split(path.delimiter)
    .map((entry) => expandHomePath(entry, home))
    .filter((entry): entry is string => Boolean(entry)));
}

/** Git worktrees keep their mutable index/refs under the backing repo, outside cwd. */
export async function resolveGitSandboxPaths(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
      { windowsHide: true, cwd, encoding: 'utf8', timeout: 5_000 },
    );
    return uniq(String(stdout).split(/\r?\n/).map((entry) => entry.trim()));
  } catch {
    return [];
  }
}

/** Package root for an npm-installed binary target, including scoped packages. */
function nodePackageRoot(binaryPath: string): string | null {
  const parsed = path.parse(binaryPath);
  const segments = binaryPath.slice(parsed.root.length).split(path.sep);
  const nodeModulesIndex = segments.lastIndexOf('node_modules');
  if (nodeModulesIndex < 0 || !segments[nodeModulesIndex + 1]) return null;
  const packageSegments = segments[nodeModulesIndex + 1].startsWith('@') ? 2 : 1;
  const end = nodeModulesIndex + 1 + packageSegments;
  if (segments.length < end) return null;
  return path.join(parsed.root, ...segments.slice(0, end));
}

export interface FinalCredentialPolicy {
  lockPath: string; readFiles: string[]; readDirectories: string[];
}

export interface SeatbeltProfileInput {
  /** The worktree / repo cwd the worker runs in (read+write). */
  worktreePath: string;
  /** The backing repo path the worktree needs (read+write; often === worktree). */
  repoPath: string;
  /** Operator HOME — used to locate the secret trees that must be denied. */
  homeDir: string;
  /** TMPDIR the toolchain scribbles into (read+write). */
  tmpDir: string;
  /** Extra read+write roots (e.g. a worktree's parent `.git`). */
  extraReadWritePaths?: string[];
  /** Extra read-only roots (toolchain dirs resolved by the caller). */
  extraReadPaths?: string[];
  /** Absolute PATH entries used to discover nested CLIs. */
  pathReadRoots?: string[];
  /** Additional credential/control-plane roots that must stay unreachable. */
  extraDenyPaths?: string[];
  /** Narrow state roots re-opened after broad secret-tree denials. */
  trustedReadWritePaths?: string[];
  /** Files or subtrees denied after trusted state is re-opened. */
  finalDenyPaths?: string[];
  /** Narrow state roots re-opened after a final parent-subtree denial. */
  finalAllowReadWritePaths?: string[];
  /** Executables denied after the broad process-exec allow. */
  finalDenyExecPaths?: string[];
  /** Executable basename prefixes denied regardless of installation path. */
  finalDenyExecNamePrefixes?: string[];
  /** Exact basenames denied read access regardless of installation path. */
  finalDenyReadBasenames?: string[];
  /** Files or subtrees that remain readable but cannot be modified. */
  finalDenyWritePaths?: string[];
  /** Files kept immutable after a narrow mutable state root is re-opened. */
  finalImmutableWritePaths?: string[];
  /** Exact directory objects kept immutable; their contents retain existing grants. */
  finalImmutableAncestorPaths?: string[];
  /** Exact files re-opened for reads after a parent subtree is denied. */
  finalAllowReadPaths?: string[];
  /** Exact executables re-opened after a parent subtree is exec-denied. */
  finalAllowExecPaths?: string[];
  /**
   * Read-only packet write denials, emitted as the FINAL block of the profile.
   * Separate from {@link finalDenyWritePaths} so it lands after every allow —
   * including the narrow re-opens — without reordering the existing
   * deny-parent / re-open-child idiom other callers depend on.
   */
  readOnlyDenyWritePaths?: string[];
  finalCredentialPolicy?: FinalCredentialPolicy;
}

/**
 * Build the seatbelt (SBPL) profile text. Pure + deterministic given canonical
 * inputs, so it is unit-testable in isolation. Caller is responsible for
 * canonicalising paths (see {@link prepareWorkerSandbox}).
 *
 * Ordering matters: SBPL is LAST-MATCH-WINS, so the secret denials are emitted
 * AFTER every allow — they override any broad allow that happened to match.
 */
export function buildSeatbeltProfile(input: SeatbeltProfileInput): string {
  const home = input.homeDir.replace(/\/+$/, '');

  // System + toolchain read roots. node/git/codex/claude read dylibs, configs,
  // and CLI shims from all over the system; deny-default reads without these
  // would break the worker outright. HOME is deliberately NOT allowed wholesale
  // — only the specific toolchain subdirs below — so `~/.o8` stays denied.
  const systemReadRoots = uniq([
    '/usr', '/bin', '/sbin', '/System', '/Library', '/private/var',
    '/private/etc', '/etc', '/var', '/opt', '/dev', '/Applications',
    '/tmp', '/private/tmp',
  ]);

  // User-owned CLI/global prefixes are executable inputs, never general HOME.
  const homeToolchainReadDirs = uniq([
    '.nvm', '.volta', '.n', '.local', '.npm-global', '.config', '.asdf',
    '.rustup', '.cargo', '.bun', '.deno', 'bin', 'Library/pnpm',
  ].map((d) => path.join(home, d)));

  // Normal packet work writes caches and model-CLI session state. Global
  // executable prefixes remain read-only above so a worker cannot persist a
  // replacement npm/cargo binary outside its packet.
  const homeToolchainWriteDirs = uniq([
    '.npm', '.cache', '.yarn', '.pnpm-store',
    path.join('.cargo', 'registry'), path.join('.cargo', 'git'),
    path.join('.bun', 'install', 'cache'), '.deno', '.codex', '.claude', '.gemini',
    path.join('.config', 'gemini'),
  ].map((d) => path.join(home, d)));

  // Individual dotfiles the CLIs read (git identity, npm registry, etc.).
  // `.zshenv` is deliberately ABSENT: it commonly exports the operator's API
  // keys, and workers inherit their env from the trusted parent — a shell that
  // can't read it just skips it.
  const homeToolchainFiles = uniq([
    '.gitconfig', '.gitignore', '.npmrc', '.yarnrc',
  ].map((f) => path.join(home, f)));
  // Claude Code 2.1.x persists per-project/session state in this legacy root
  // file even when its main state directory is ~/.claude.
  const homeToolchainMutableFiles = [path.join(home, '.claude.json')];
  const homeToolchainMutableFileFilters = homeToolchainMutableFiles.flatMap((file) => [
    `(literal ${sbplString(file)})`,
    `(regex #"^${regexFragment(file)}(?:\\..*)?$")`,
  ]);

  const readRoots = uniq([
    ...systemReadRoots,
    ...homeToolchainReadDirs,
    ...homeToolchainWriteDirs,
    ...(input.pathReadRoots ?? []),
    ...(input.extraReadPaths ?? []),
  ]);

  const rwRoots = uniq([
    input.worktreePath,
    input.repoPath,
    input.tmpDir,
    ...homeToolchainWriteDirs,
    ...(input.extraReadWritePaths ?? []),
  ]);

  // Secret trees that must be unreachable regardless of anything above.
  const secretRoots = uniq([
    path.join(home, '.o8'),
    path.join(home, '.cortex-ide'),
    path.join(home, '.tauri'),
    // gh CLI credential store (~/.config/gh/hosts.yml holds the operator's
    // GitHub OAuth token). `.config` is read-allowed above for git's sake;
    // workers report through the `o8` CLI and never need gh, so cut this off.
    path.join(home, '.config', 'gh'),
    ...(input.extraDenyPaths ?? []),
  ]);

  // Keep model credentials and launch policy immutable even though the CLIs
  // need mutable session databases inside the same home directories.
  const immutableToolchainPaths = uniq([
    '.codex/auth.json', '.codex/config.toml', '.codex/AGENTS.md',
    '.codex/agents', '.codex/plugins', '.codex/rules', '.codex/skills',
    '.claude/.credentials.json', '.claude/settings.json', '.claude/settings.local.json',
    '.claude/agents', '.claude/hooks', '.claude/mcp-servers', '.claude/plugins',
    '.claude/skills', '.claude/statusline.sh',
    '.gemini/google_accounts.json', '.gemini/settings.json', '.gemini/policies',
    '.gemini/skills', '.gemini/trustedFolders.json',
  ].map((entry) => path.join(home, entry)));

  const trustedReadWritePaths = uniq(input.trustedReadWritePaths ?? []);
  const finalDenyPaths = uniq(input.finalDenyPaths ?? []);
  const finalAllowReadWritePaths = uniq(input.finalAllowReadWritePaths ?? []);
  const finalDenyExecPaths = uniq(input.finalDenyExecPaths ?? []);
  const finalDenyExecNamePrefixes = uniq(input.finalDenyExecNamePrefixes ?? []);
  const finalDenyReadBasenames = uniq(input.finalDenyReadBasenames ?? []);
  const finalDenyWritePaths = uniq(input.finalDenyWritePaths ?? []);
  const finalImmutableWritePaths = uniq([
    ...immutableToolchainPaths,
    ...(input.finalImmutableWritePaths ?? []),
  ]);
  const finalAllowReadPaths = uniq(input.finalAllowReadPaths ?? []);
  const finalImmutableAncestors = uniq(input.finalImmutableAncestorPaths ?? []);
  if (finalImmutableAncestors.some(p => !path.isAbsolute(p))) throw new SandboxUnavailableError('Immutable ancestor paths must be absolute.');
  const finalAllowExecPaths = uniq(input.finalAllowExecPaths ?? []);
  const readOnlyDenyWritePaths = uniq(input.readOnlyDenyWritePaths ?? []);
  const policy = input.finalCredentialPolicy;
  const policyReadFilters = policy ? [policy.lockPath, ...policy.readFiles].map(p => `(literal ${sbplString(p)})`).concat(policy.readDirectories.map(subpath)) : [];
  if (policy) {
    if ([policy.lockPath, ...policy.readFiles, ...policy.readDirectories].some(p => !path.isAbsolute(p)) || path.basename(policy.lockPath) !== '.provider-keys.lock') throw new SandboxUnavailableError('Invalid credential policy paths.');
    assertNarrowRuntimeStateRegrants(policy.readDirectories, [home, ...secretRoots]);
    if (policy.readDirectories.some(p => secretRoots.some(root => pathIsWithin(p, root)))
      || policy.readFiles.some(p => secretRoots.some(root => pathIsWithin(p, root)) && p !== path.join(path.dirname(policy.lockPath), 'provider-launch-policy.json'))) throw new SandboxUnavailableError('Credential policy grant would expose protected data.');
    assertNoRegrantOverlap([policy.lockPath], readOnlyDenyWritePaths);
  }

  const lines: string[] = [
    '(version 1)',
    '',
    ';; Tier-2 worker sandbox (#1325). sandbox-exec is deprecated-but-functional.',
    ';; Deny-by-default; last matching rule wins.',
    '(deny default)',
    '',
    ';; --- process / IPC / mach (needed to exec node + toolchain) ---',
    '(allow process-exec*)',
    '(allow process-fork)',
    '(allow process-info*)',
    '(allow signal (target self))',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm*)',
    '(allow system-socket)',
    '',
    ';; --- network: RF-1 HTTP to the gated loopback API must keep working ---',
    '(allow network*)',
    '',
    ';; --- metadata reads globally (path resolution / stat) ---',
    '(allow file-read-metadata)',
    '',
    ';; --- read: system + toolchain roots ---',
    `(allow file-read*`,
    // The root directory entry itself: dyld/exec abort (SIGABRT) at launch
    // without read access to "/", even though every real payload lives under a
    // subpath below. `literal` grants only the "/" dirent, not a recursive `/`.
    '  (literal "/")',
    ...readRoots.map((p) => `  ${subpath(p)}`),
    ...homeToolchainFiles.map((p) => `  (literal ${sbplString(p)})`),
    ...homeToolchainMutableFileFilters.map((filter) => `  ${filter}`),
    ')',
    '',
    ';; --- read+write: packet, Git metadata, TMPDIR, and tool state ---',
    `(allow file-read* file-write*`,
    ...rwRoots.map((p) => `  ${subpath(p)}`),
    ...homeToolchainMutableFileFilters.map((filter) => `  ${filter}`),
    ')',
    '',
    ';; --- write: scratch devices ---',
    `(allow file-write-data`,
    `  (literal "/dev/null")`,
    `  (literal "/dev/dtracehelper")`,
    `  (literal "/dev/tty")`,
    ')',
    '',
    ';; --- DENY the operator secrets LAST so they win over any allow above ---',
    `(deny file-read* file-write*`,
    ...secretRoots.map((p) => `  ${subpath(p)}`),
    ')',
    ';; webview control socket (+ its .token sidefile) — deny both /tmp forms',
    '(deny file-read* file-write*',
    '  (regex #"^/private/tmp/tauri-mcp-o8-")',
    '  (regex #"^/tmp/tauri-mcp-o8-")',
    ')',
    ';; existing tmux servers can otherwise spawn an unsandboxed child',
    '(deny file-read* file-write*',
    '  (regex #"^/private/tmp/tmux-")',
    '  (regex #"^/tmp/tmux-")',
    ')',
    '(deny network-outbound',
    '  (remote unix-socket (regex #"^/private/tmp/tmux-"))',
    '  (remote unix-socket (regex #"^/tmp/tmux-"))',
    ')',
    ...(trustedReadWritePaths.length ? [
      ';; explicitly re-open narrow runtime state inside a denied parent',
      '(allow file-read* file-write*',
      ...trustedReadWritePaths.map((p) => `  ${subpath(p)}`),
      ')',
    ] : []),
    ...(finalDenyPaths.length ? [
      ';; keep credential-bearing files closed inside trusted runtime state',
      '(deny file-read* file-write*',
      ...finalDenyPaths.flatMap((p) => [
        `  (literal ${sbplString(p)})`,
        `  ${subpath(p)}`,
      ]),
      ')',
    ] : []),
    ...(finalDenyExecPaths.length ? [
      ';; prevent a sandboxed process from re-launching protected runtimes',
      '(deny process-exec',
      ...finalDenyExecPaths.flatMap((p) => [
        `  (literal ${sbplString(p)})`,
        `  ${subpath(p)}`,
      ]),
      ')',
    ] : []),
    ...(finalDenyExecNamePrefixes.length ? [
      '(deny process-exec',
      ...finalDenyExecNamePrefixes.map((name) => (
        `  (regex #"(^|/)${regexFragment(name)}(?:$|[-.])")`
      )),
      ')',
    ] : []),
    ...(finalDenyWritePaths.length ? [
      ';; immutable launch policy and guards',
      '(deny file-write* file-write-mode file-write-owner file-write-acl file-write-flags file-link file-clone',
      ...finalDenyWritePaths.flatMap((p) => [
        `  (literal ${sbplString(p)})`,
        `  ${subpath(p)}`,
      ]),
      ')',
    ] : []),
    ...(finalAllowReadWritePaths.length ? [
      ';; re-open only this launch\'s isolated mutable runtime state',
      '(allow file-read* file-write*',
      ...finalAllowReadWritePaths.map((p) => `  ${subpath(p)}`),
      ')',
    ] : []),
    ...(finalImmutableWritePaths.length ? [
      ';; keep policy files immutable inside the active state root',
      '(deny file-write* file-write-mode file-write-owner file-write-acl file-write-flags file-link file-clone',
      ...finalImmutableWritePaths.flatMap((p) => [
        `  (literal ${sbplString(p)})`,
        `  ${subpath(p)}`,
      ]),
      ')',
    ] : []),
    ...(finalDenyReadBasenames.length ? [
      '(deny file-read*',
      ...finalDenyReadBasenames.map((name) => (
        `  (regex #"(^|/)${regexFragment(name)}$")`
      )),
      ')',
    ] : []),
    ...(finalAllowReadPaths.length ? [
      ';; re-open only the active private runtime image for initial launch',
      '(allow file-read*',
      ...finalAllowReadPaths.map((p) => `  (literal ${sbplString(p)})`),
      ')',
    ] : []),
    ...(finalAllowExecPaths.length ? [
      '(allow process-exec',
      ...finalAllowExecPaths.map((p) => `  (literal ${sbplString(p)})`),
      ')',
    ] : []),
    ...(policy ? [
      ';; final credential check: immutable policy/code reads and existing lock data only',
      '(deny file-write* file-write-mode file-write-owner file-write-acl file-write-flags file-link file-clone',
      ...policyReadFilters.map(filter => `  ${filter}`), ')',
      '(allow file-read*', ...policyReadFilters.map(filter => `  ${filter}`), ')',
      `(allow file-write-data (literal ${sbplString(policy.lockPath)}))`,
      `(deny file-write-create file-write-unlink file-write-mode file-write-owner file-write-acl file-write-flags file-link file-clone (literal ${sbplString(policy.lockPath)}))`,
    ] : []),
    ...(finalImmutableAncestors.length ? [
      ';; keep verified CLI ancestors immutable without denying their contents',
      '(deny file-write* file-write-mode file-write-owner file-write-acl file-write-flags file-link file-clone',
      ...finalImmutableAncestors.map(p => `  (literal ${sbplString(p)})`),
      ')',
    ] : []),
    ...(readOnlyDenyWritePaths.length ? [
      // DEAD LAST, deliberately. SBPL is last-match-wins, so emitting the
      // read-only denial after EVERY allow — including the narrow re-opens
      // above, e.g. an identity config home — means nothing later in the
      // profile can regrant write access to the repository. The existing
      // deny-a-parent / re-open-a-narrow-child idiom other callers rely on is
      // untouched, because this is a separate block rather than a reordering
      // of theirs.
      ';; read-only packet: repository stays readable, every write refused',
      '(deny file-write* file-write-mode file-write-owner file-write-acl file-write-flags file-link file-clone',
      ...readOnlyDenyWritePaths.flatMap((p) => [
        `  (literal ${sbplString(p)})`,
        `  ${subpath(p)}`,
      ]),
      ')',
    ] : []),
    '',
  ];

  return lines.join('\n');
}

export interface PreparedSandbox {
  /** The wrapper binary to spawn instead of the raw CLI (sandbox-exec). */
  binary: string;
  /** `['-f', <profilePath>, <origBinary>, ...origArgs]`. */
  args: string[];
  /** Where the generated profile was written. */
  profilePath: string;
  /** The profile text (for logging / tests). */
  profileText: string;
}

export interface PrepareWorkerSandboxInput {
  runId: string;
  /** Directory to write the generated `<runId>.sb` profile into. */
  profileDir: string;
  /** The worker's cwd (packet worktree). */
  cwd: string;
  /** The backing repo path (read+write). */
  repoPath: string;
  /** The resolved CLI binary path being wrapped. */
  binary: string;
  /** The CLI args. */
  args: string[];
  homeDir?: string;
  tmpDir?: string;
  /** Extra read+write roots (e.g. the main repo `.git` a worktree needs). */
  extraReadWritePaths?: string[];
  /** Extra read-only roots (e.g. node runtime dir, CLI binary dir). */
  extraReadPaths?: string[];
  /** Read only the linked checkout's exact backing project configuration. */
  readBackingProjectConfig?: boolean;
  /** Exact immutable owner policies for native workers; never external carriers. */
  readOwnerInstructions?: boolean;
  extraDenyPaths?: string[];
  trustedReadWritePaths?: string[];
  finalDenyPaths?: string[];
  finalAllowReadWritePaths?: string[];
  finalDenyExecPaths?: string[];
  finalDenyExecNamePrefixes?: string[];
  finalDenyReadBasenames?: string[];
  finalDenyWritePaths?: string[];
  finalImmutableWritePaths?: string[];
  finalImmutableAncestorPaths?: string[];
  finalAllowReadPaths?: string[];
  finalAllowExecPaths?: string[];
  /**
   * Read-only packet enforcement. When true the worktree, backing repo, and the
   * git metadata dirs this function ALREADY resolved to grant write access are
   * appended to the final write denials, so the kernel refuses every repository
   * write.
   *
   * The git probe deliberately happens once, here. A caller that ran its own
   * probe could disagree with the grant (different cwd, different realpath, a
   * transient failure) and deny a narrower set than it just granted. If the
   * single probe yields nothing for a read-only run this function throws rather
   * than granting un-denied git paths — fail-closed, never a silent widening.
   */
  enforceReadOnly?: boolean;
  finalCredentialPolicy?: FinalCredentialPolicy;
}

/**
 * Assemble the sandbox-exec invocation that wraps a worker child. FAIL-CLOSED:
 * throws {@link SandboxUnavailableError} on any host where the sandbox cannot
 * be provided, so the caller refuses to spawn rather than degrading to an
 * unsandboxed worker.
 */
export async function prepareWorkerSandbox(input: PrepareWorkerSandboxInput): Promise<PreparedSandbox> {
  if (process.platform !== 'darwin') {
    throw new SandboxUnavailableError(
      `Worker sandbox is macOS-only (sandbox-exec); host platform is '${process.platform}'. `
      + `Unset O8_WORKER_SANDBOX to dispatch unsandboxed.`,
    );
  }
  try {
    await access(SANDBOX_EXEC_PATH, fsConstants.X_OK);
  } catch {
    throw new SandboxUnavailableError(`sandbox-exec not found or not executable at ${SANDBOX_EXEC_PATH}.`);
  }

  const home = input.homeDir ?? os.homedir();
  const tmp = input.tmpDir ?? os.tmpdir();

  // Canonicalise so symlinked roots (/tmp → /private/tmp, worktrees) match the
  // kernel's realpath during policy evaluation. Include both the raw and
  // resolved form where they differ.
  const worktreeReal = await safeRealpath(input.cwd);
  const repoReal = await safeRealpath(input.repoPath);
  const tmpReal = await safeRealpath(tmp);
  const homeReal = await safeRealpath(home);
  const binaryDir = path.dirname(input.binary);
  const binaryDirReal = await safeRealpath(binaryDir);
  const binaryReal = await safeRealpath(input.binary);
  const binaryPackageRoot = nodePackageRoot(binaryReal);
  const nodeDir = path.dirname(process.execPath);
  const nodeDirReal = await safeRealpath(nodeDir);
  // ONE probe. Its result both grants git metadata access below and, for a
  // read-only run, feeds the write denials — the grant and the deny can never
  // disagree because they are the same array.
  const gitPaths = await resolveGitSandboxPaths(worktreeReal);
  if (input.enforceReadOnly && gitPaths.length === 0) {
    throw new SandboxUnavailableError(
      `Read-only packet requires an enforced sandbox, but git metadata paths could not be resolved `
      + `for ${worktreeReal}. Refusing to grant repository access that cannot be write-denied.`,
    );
  }

  const extraRW = uniq([
    input.cwd, worktreeReal,
    input.repoPath, repoReal,
    tmp, tmpReal,
    ...gitPaths,
    ...(input.extraReadWritePaths ?? []),
  ]);
  const extraRead = uniq([
    binaryDir, binaryDirReal, path.dirname(binaryReal),
    ...(binaryPackageRoot ? [binaryPackageRoot] : []),
    nodeDir, nodeDirReal,
    ...(input.extraReadPaths ?? []),
  ]);
  const resolveAll = async (paths: string[]): Promise<string[]> => {
    const resolved = await Promise.all(paths.map((value) => safeRealpath(value)));
    return uniq(paths.flatMap((value, index) => [value, resolved[index]]));
  };
  const configuredDataDirs = uniq([
    process.env.O8_DATA_DIR?.trim() ?? '',
    process.env.CORTEX_IDE_DATA_DIR?.trim() ?? '',
  ]).map((value) => expandHomePath(value, homeReal) ?? path.resolve(value))
    .filter((value): value is string => Boolean(value));
  const dataSecretRoots = await resolveAll([
    path.join(homeReal, '.o8'),
    path.join(homeReal, '.cortex-ide'),
    ...configuredDataDirs,
  ]);
  const projectConfigPaths = input.readBackingProjectConfig
    ? await backingProjectConfigPaths(gitPaths, worktreeReal, [homeReal, ...dataSecretRoots])
    : [];
  const workspacePaths = await resolveAll([
    input.cwd,
    worktreeReal,
    input.repoPath,
    repoReal,
    ...gitPaths,
  ]);
  const workspaceReopens = workspacePaths.filter((workspacePath) => (
    dataSecretRoots.some((secretRoot) => pathIsWithin(workspacePath, secretRoot))
  ));
  for (const workspacePath of workspaceReopens) {
    if (dataSecretRoots.includes(workspacePath)) {
      throw new SandboxUnavailableError(
        `Worker workspace ${workspacePath} is also a protected data root. Refusing to re-open the entire secret root.`,
      );
    }
  }
  const extraDeny = await resolveAll([
    ...configuredDataDirs,
    ...(input.extraDenyPaths ?? []),
  ]);
  const trustedReadWrite = await resolveAll([
    ...(input.trustedReadWritePaths ?? []),
    ...workspaceReopens,
  ]);
  const finalDeny = await resolveAll(input.finalDenyPaths ?? []);
  const finalAllowReadWrite = await resolveAll(input.finalAllowReadWritePaths ?? []);
  const finalDenyExec = await resolveAll(input.finalDenyExecPaths ?? []);
  const finalDenyExecNamePrefixes = uniq(input.finalDenyExecNamePrefixes ?? []);
  const finalDenyReadBasenames = uniq(input.finalDenyReadBasenames ?? []);
  const finalDenyWrite = await resolveAll(input.finalDenyWritePaths ?? []);
  // Same `gitPaths` array that was granted read+write in `extraRW` above. A
  // linked worktree keeps its index and refs under the BACKING repo, outside
  // cwd, so denying only the worktree would still let a read-only worker mutate
  // the index and commit.
  const readOnlyDenyWrite = input.enforceReadOnly
    ? workspacePaths
    : [];
  const finalImmutableWrite = await resolveAll([
    ...(input.finalImmutableWritePaths ?? []), ...projectConfigPaths,
  ]);
  const finalImmutableAncestors = await resolveAll(input.finalImmutableAncestorPaths ?? []);
  const finalAllowRead = await resolveAll([
    ...(input.finalAllowReadPaths ?? []), ...projectConfigPaths,
  ]);
  // Never resolve these again after validation: a replaced symlink must not
  // manufacture a grant on its new target. These remain exact literal paths.
  const ownerInstructions = input.readOwnerInstructions ? await ownerInstructionPaths(homeReal) : [];
  finalImmutableWrite.push(...ownerInstructions);
  finalAllowRead.push(...ownerInstructions);
  const finalAllowExec = await resolveAll(input.finalAllowExecPaths ?? []);
  const finalCredentialPolicy = input.finalCredentialPolicy ? {
    lockPath: await safeRealpath(input.finalCredentialPolicy.lockPath),
    readFiles: await resolveAll(input.finalCredentialPolicy.readFiles),
    readDirectories: await resolveAll(input.finalCredentialPolicy.readDirectories),
  } : undefined;
  if (input.finalCredentialPolicy && [input.finalCredentialPolicy.lockPath, ...input.finalCredentialPolicy.readFiles, ...input.finalCredentialPolicy.readDirectories].some(p => !path.isAbsolute(p))) throw new SandboxUnavailableError('Credential policy paths must be absolute.');

  // Runtime state may live inside the denied o8 data tree, but its grant must
  // stay narrower than HOME, any data root, and the session metadata root.
  // resolveAll includes symlink targets, so an apparently narrow symlink cannot
  // re-open one of those parents after canonicalisation.
  assertNarrowRuntimeStateRegrants(finalAllowReadWrite, await resolveAll([
    homeReal,
    ...dataSecretRoots,
    path.dirname(input.profileDir),
  ]));

  // Order alone already keeps the read-only denial authoritative. This refuses
  // the launch outright when a caller ALSO tries to re-open something inside
  // it, so a contradictory policy surfaces here instead of as a mysterious
  // EPERM inside the worker. Scoped to the read-only set: the deny-parent /
  // re-open-narrow-child idiom on `finalDenyWritePaths` is legitimate.
  assertNoRegrantOverlap(finalAllowReadWrite, readOnlyDenyWrite);

  const profileText = buildSeatbeltProfile({
    worktreePath: worktreeReal,
    repoPath: repoReal,
    homeDir: homeReal,
    tmpDir: tmpReal,
    extraReadWritePaths: extraRW,
    extraReadPaths: extraRead,
    pathReadRoots: await resolveAll(workerPathReadRoots(homeReal)),
    extraDenyPaths: extraDeny,
    trustedReadWritePaths: trustedReadWrite,
    finalDenyPaths: finalDeny,
    finalAllowReadWritePaths: finalAllowReadWrite,
    finalDenyExecPaths: finalDenyExec,
    finalDenyExecNamePrefixes,
    finalDenyReadBasenames,
    finalDenyWritePaths: finalDenyWrite,
    finalImmutableWritePaths: finalImmutableWrite,
    finalImmutableAncestorPaths: finalImmutableAncestors,
    finalAllowReadPaths: finalAllowRead,
    finalAllowExecPaths: finalAllowExec,
    readOnlyDenyWritePaths: readOnlyDenyWrite,
    finalCredentialPolicy,
  });

  const profilePath = path.join(input.profileDir, `${input.runId}.sb`);
  try {
    await writeFile(profilePath, profileText, { mode: 0o600 });
  } catch (error) {
    throw new SandboxUnavailableError(
      `Failed to write seatbelt profile to ${profilePath}: ${(error as Error).message}`,
    );
  }

  return {
    binary: SANDBOX_EXEC_PATH,
    args: ['-f', profilePath, input.binary, ...input.args],
    profilePath,
    profileText,
  };
}
