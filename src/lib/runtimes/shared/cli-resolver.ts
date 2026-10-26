import { childEnvironment } from '@/lib/providers/spawn-environment';
/**
 * Shared CLI binary resolver for o8 runtime adapters.
 *
 * Provides a consistent, caching mechanism to locate CLI binaries (codex,
 * claude, gemini, opencode, …) across all the environments where o8 runs:
 * - Standard PATH installs (npm global, brew, cargo)
 * - Version managers (nvm, fnm, asdf, volta) wired only to the login shell
 * - Tauri / Finder-launched apps whose child PATH is stripped to a bare minimum
 *
 * Resolution order (first hit wins):
 *   1. process.env[spec.envOverride]   — e.g. O8_CODEX_BIN
 *   2. which <binary>                  — uses the child process's PATH
 *   3. Login-shell probe               — $SHELL -lc 'command -v <binary>'
 *      catches nvm/fnm/volta/asdf because those tools init via shell rc files
 *   4. Static fallback paths           — ~/.npm-global, ~/.asdf/shims, etc.
 */

import { execFile } from '@/lib/providers/child-process';
import { access, constants, stat } from 'node:fs';
import path from 'node:path';

import { executableSuffixes, pathLookupProgram, pickLookupResult } from '@/lib/runtimes/shared/cli-locate';
import { promisify } from 'node:util';

import { ensureCliSymlink, wellKnownCliDirs } from './cli-locate';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { pathWithNodeRuntime } from '@/lib/util/node-on-path';

const execFileAsync = promisify(execFile);
const statAsync = promisify(stat);
const accessAsync = promisify(access);

// ── Public types ──────────────────────────────────────────────────────────────

export interface ResolvedCli {
  /** Absolute path, symlinks resolved where possible. */
  path: string;
  /** Which strategy found this binary. */
  source: 'env' | 'which' | 'login-shell' | 'scan' | 'npm-global' | 'asdf' | 'volta' | 'fnm' | 'brew' | 'default';
  /** Parsed version string (if versionArgs were provided and succeeded). */
  version?: string;
  /** Unix timestamp (ms) when this result was resolved. */
  detectedAt: number;
  /** The env-var name that triggered resolution (if source === 'env'). */
  envHint?: string;
}

export interface CliResolverSpec {
  /** Logical name for the runtime, e.g. 'codex', 'claude-code', 'gemini', 'cursor'. */
  runtimeId: string;
  /** The binary name to search for: 'codex', 'claude', etc. */
  binaryName: string;
  /**
   * Primary env-var override key (convention: O8_<RUNTIME>_BIN, e.g. O8_CODEX_BIN).
   * Checked first. If set, it must point to an executable regular file.
   */
  envOverride: string;
  /** Additional env-var overrides checked after envOverride (e.g. CLAUDE_BIN). */
  extraEnvOverrides?: string[];
  /** Extra binary names to check alongside binaryName (e.g. ['claude-code']). */
  aliases?: string[];
  /** Args to pass when probing for the version, defaults to ['--version']. */
  versionArgs?: string[];
  versionTimeoutMs?: number;
  /** Prepared child boundary for isolated discovery and version probes. */
  probeEnvironment?: NodeJS.ProcessEnv;
  /** Regex to extract a semver-like version from the version output. */
  versionPattern?: RegExp;
  /**
   * Oldest CLI version this adapter's protocol assumptions have been validated
   * against. Older installs get a LOUD console warning (never a hard block —
   * the operator may know better). Falls back to KNOWN_MIN_VERSIONS by
   * runtimeId when unset.
   */
  minVersion?: string;
}

/** Thrown when a binary cannot be found via any strategy. */
export class CliNotFoundError extends Error {
  public readonly triedPaths: string[];

  constructor(binaryName: string, triedPaths: string[]) {
    super(
      `[cli-resolver] Binary '${binaryName}' not found. Tried: ${triedPaths.join(', ')}`,
    );
    this.name = 'CliNotFoundError';
    this.triedPaths = triedPaths;
  }
}

// ── Version skew armor ────────────────────────────────────────────────────────

/**
 * Oldest CLI versions the adapters in this repo are known to work against.
 * Applied to every resolveCli call for that runtimeId regardless of which
 * call site built the spec. Keep entries conservative — only versions that
 * the dispatch path has actually been validated on.
 */
const KNOWN_MIN_VERSIONS: Record<string, string> = {
  // codex exec --json + `-c model_reasoning_effort=...` config syntax —
  // validated on codex-cli 0.130.0; older builds used different flags
  // (`--reasoning-effort`) and different JSON event names.
  codex: '0.130.0',
};

/**
 * Compare two dotted numeric version strings (e.g. '0.130.0' vs '0.9.1').
 * Returns <0 when a is older, 0 when equal, >0 when a is newer. Non-numeric
 * segments compare as 0 — good enough for the CLI versions we probe.
 * Exported for tests.
 */
export function compareCliVersions(a: string, b: string): number {
  const pa = a.split('.').map((s) => Number.parseInt(s, 10) || 0);
  const pb = b.split('.').map((s) => Number.parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Warn (never block) when the resolved CLI is older than the adapter's
 * validated minimum, or when the version could not be determined at all.
 * The 10-minute resolver cache naturally rate-limits these warnings.
 */
function warnOnVersionSkew(spec: CliResolverSpec, resolved: ResolvedCli): void {
  const minVersion = spec.minVersion ?? KNOWN_MIN_VERSIONS[spec.runtimeId];
  if (!resolved.version) {
    console.warn(
      `[cli-resolver] Could not determine the version of '${spec.binaryName}' at ${resolved.path}. `
      + `The ${spec.runtimeId} integration is version-sensitive — if dispatches fail with `
      + `unknown-flag or protocol errors, check '${spec.binaryName} --version' manually.`,
    );
    return;
  }
  if (minVersion && compareCliVersions(resolved.version, minVersion) < 0) {
    console.warn(
      `[cli-resolver] '${spec.binaryName}' v${resolved.version} at ${resolved.path} is OLDER than `
      + `v${minVersion}, the oldest version o8's ${spec.runtimeId} adapter has been validated against. `
      + `Flags and JSON output may differ; dispatches can fail in confusing ways. `
      + `Upgrade the CLI, or point ${spec.envOverride} at a newer install.`,
    );
  }
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 10 * 60_000; // 10 minutes

interface CacheEntry {
  resolved: ResolvedCli;
  cachedAt: number;
}

const resolverCache = new Map<string, CacheEntry>();

/**
 * Invalidate the cached resolution for one runtime, or all runtimes when
 * runtimeId is omitted.
 */
export function invalidateCliCache(runtimeId?: string): void {
  if (runtimeId === undefined) {
    resolverCache.clear();
    console.log('[cli-resolver] All CLI resolution cache entries cleared.');
  } else {
    const deleted = resolverCache.delete(runtimeId);
    if (deleted) {
      console.log(`[cli-resolver] Cache cleared for runtime '${runtimeId}'.`);
    }
  }
}

/**
 * Return the cached resolution for a runtime without triggering a new probe.
 * Returns undefined if not cached or if the entry has expired.
 */
export function getCachedCli(runtimeId: string): ResolvedCli | undefined {
  const entry = resolverCache.get(runtimeId);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    resolverCache.delete(runtimeId);
    return undefined;
  }
  return entry.resolved;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Returns true when the path exists and is executable. */
async function canExec(binPath: string): Promise<boolean> {
  try {
    if (!(await statAsync(binPath)).isFile()) return false;
    // Windows CLI shims are executed through cliInvocation, without POSIX mode bits.
    if (process.platform !== 'win32') await accessAsync(binPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe the binary version using the spec's versionArgs.
 * Returns undefined on any failure — version info is best-effort.
 */
async function probeVersion(
  binPath: string,
  spec: CliResolverSpec,
): Promise<string | undefined> {
  const args = spec.versionArgs ?? ['--version'];
  // A leading `\b` misses version strings where a letter is glued directly to
  // the digits (e.g. node's own `v22.23.2` — 'v' and '2' are both \w, so no
  // boundary exists between them and the whole probe silently reports
  // "could not determine version"). A negative digit-lookbehind still blocks
  // matching mid-number (won't split "12345.6.7"), but allows a `v` or other
  // non-digit prefix glued on.
  const pattern = spec.versionPattern ?? /(?<!\d)(\d+\.\d+\.\d+)\b/;
  try {
    const probe = cliInvocation(binPath, args);
    const { stdout, stderr } = await execFileAsync(probe.command, probe.args, {
      windowsHide: true,
      timeout: spec.versionTimeoutMs ?? 5_000,
      maxBuffer: 64 * 1024,
      env: spec.probeEnvironment ?? childEnvironment({ runtimeId: spec.runtimeId, env: { PATH: pathWithNodeRuntime(), FORCE_COLOR: '0', NO_COLOR: '1', ...(spec.runtimeId === 'muse' ? { MUSE_NO_AUTO_UPDATE: '1' } : {}) } }),
    });
    const combined = `${stdout}\n${stderr}`;
    const match = combined.match(pattern);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Static fallback directories, delegated to the shared cli-locate list so the
 * onboarding detect route and dispatch-time resolution can never disagree
 * about where CLIs live (the v0.1.548 "Claude not detected" class). Includes
 * ~/.local/bin (Claude native installer), ~/.claude/local, bun/pnpm/deno, and
 * per-version nvm/fnm bins that no login-shell probe reaches.
 */
function staticFallbackDirs(): Array<{ dir: string; source: ResolvedCli['source'] }> {
  return wellKnownCliDirs().map((dir) => ({ dir, source: 'scan' as const }));
}

/**
 * Determine the binary names to search for (primary + aliases).
 */
function binaryNames(spec: CliResolverSpec): string[] {
  return [spec.binaryName, ...(spec.aliases ?? [])];
}

function executableEnvKeys(spec: CliResolverSpec): string[] {
  // Older caller specs listed this data-home setting as an executable alias.
  // Ignore it centrally so a background caller cannot poison the shared cache.
  return [spec.envOverride, ...(spec.extraEnvOverrides ?? [])].filter((key) => key !== 'CODEX_HOME');
}

// ── Resolution strategies ─────────────────────────────────────────────────────

/** Strategy 1: explicit env-var overrides. */
async function resolveViaEnv(
  spec: CliResolverSpec,
): Promise<ResolvedCli | null> {
  const envKeys = executableEnvKeys(spec);
  for (const key of envKeys) {
    const value = process.env[key];
    if (!value) continue;
    if (!(await canExec(value))) {
      throw new Error(`Invalid executable override ${key}: expected an executable file.`);
    }
    console.log(`[cli-resolver] Using ${spec.binaryName} from env override ${key}='${value}'.`);
    const version = await probeVersion(value, spec);
    return {
      path: value,
      source: 'env',
      version,
      detectedAt: Date.now(),
      envHint: key,
    };
  }
  return null;
}

/** Strategy 2: `which <binary>` — relies on the child process PATH. */
async function resolveViaWhich(
  spec: CliResolverSpec,
): Promise<ResolvedCli | null> {
  for (const name of binaryNames(spec)) {
    try {
      // `which` is POSIX-only; Windows ships `where`, which prints one match
      // per line (and lists the extensionless npm script BEFORE the .cmd shim,
      // so take the first line Windows can actually execute).
      const { stdout } = await execFileAsync(pathLookupProgram(), [name], {
        windowsHide: true,
        timeout: 3_000,
        env: spec.probeEnvironment,
      });
      const found = pickLookupResult(stdout);
      if (!found) continue;
      console.log(`[cli-resolver] 'which ${name}' found: ${found}`);
      const version = await probeVersion(found, spec);
      return {
        path: found,
        source: 'which',
        version,
        detectedAt: Date.now(),
      };
    } catch {
      // which exited non-zero → binary not on PATH
    }
  }
  return null;
}

/**
 * Strategy 3: login-shell probe.
 *
 * Runs `$SHELL -lc 'command -v <binary>'`, which sources the user's shell
 * init files (~/.zshrc, ~/.bash_profile, …) where nvm/fnm/volta/asdf inject
 * themselves. This is the key strategy that survives Finder-launched apps with
 * a stripped PATH. Mirrors the Rust pattern in src-tauri/src/lib.rs.
 */
async function resolveViaLoginShell(
  spec: CliResolverSpec,
): Promise<ResolvedCli | null> {
  const userShell = process.env.SHELL;
  const shells: string[] = [];
  if (userShell) shells.push(userShell);
  // Fallback shell sequence matching the Rust implementation
  for (const sh of ['zsh', 'bash', 'sh']) {
    if (!shells.includes(sh)) shells.push(sh);
  }

  for (const sh of shells) {
    for (const name of binaryNames(spec)) {
      try {
        const { stdout } = await execFileAsync(sh, ['-l', '-c', `command -v ${name}`], {
          windowsHide: true,
          timeout: 10_000,
          env: spec.probeEnvironment ?? childEnvironment({ runtimeId: spec.runtimeId, env: { FORCE_COLOR: '0', NO_COLOR: '1' } }),
        });
        const found = stdout.trim();
        if (!found) continue;
        console.log(`[cli-resolver] Login-shell probe (${sh}) found ${name}: ${found}`);
        const version = await probeVersion(found, spec);
        return {
          path: found,
          source: 'login-shell',
          version,
          detectedAt: Date.now(),
        };
      } catch {
        // This shell or binary not available — try next
      }
    }
  }
  return null;
}

/** Strategy 4: static fallback paths. */
async function resolveViaStaticFallbacks(
  spec: CliResolverSpec,
): Promise<ResolvedCli | null> {
  const fallbacks = staticFallbackDirs();
  for (const { dir, source } of fallbacks) {
    for (const name of binaryNames(spec)) {
      // Windows marks executables by EXTENSION, and npm writes both an
      // extensionless POSIX script and a .cmd shim into the same directory.
      // Probing the bare name finds the script Windows cannot execute, and the
      // spawn then dies with EINVAL before a process exists. See #1758.
      for (const suffix of executableSuffixes()) {
      const candidate = path.join(dir, `${name}${suffix}`);
      if (await canExec(candidate)) {
        console.log(`[cli-resolver] Static fallback found ${name} at ${candidate} (source: ${source}).`);
        const version = await probeVersion(candidate, spec);
        return {
          path: candidate,
          source,
          version,
          detectedAt: Date.now(),
        };
      }
      }
    }
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve the absolute path for a CLI binary, using a layered strategy that
 * survives stripped PATH environments (Tauri/Finder-launched apps) and all
 * common version managers.
 *
 * Results are cached per runtimeId for 10 minutes. Call invalidateCliCache()
 * to force a fresh probe.
 *
 * Throws CliNotFoundError when the binary cannot be located anywhere.
 */
export async function resolveCli(spec: CliResolverSpec): Promise<ResolvedCli> {
  // Cache hit check
  const cached = getCachedCli(spec.runtimeId);
  if (cached) {
    return cached;
  }

  console.log(`[cli-resolver] Resolving '${spec.binaryName}' for runtime '${spec.runtimeId}'...`);

  // Single accept point: every successful strategy passes through the version
  // skew check before being cached, so the warning fires at most once per
  // cache fill (10-minute TTL).
  const accept = async (resolved: ResolvedCli): Promise<ResolvedCli | null> => {
    // A path that does not exist on this filesystem must never be cached OR
    // shimmed. Git-for-Windows answers `sh -lc 'command -v x'` with an MSYS
    // path (/c/Users/...) that Node cannot spawn; accepting it wrote a
    // forwarding shim into the o8 bin dir — the FIRST directory the scanner
    // checks — so one bad answer outlived its own cache TTL and kept being
    // rediscovered. Falling through to the next strategy is always better than
    // persisting an unspawnable answer.
    if (!(await canExec(resolved.path))) {
      console.warn(
        `[cli-resolver] Ignoring ${spec.binaryName} at ${resolved.path} (source: ${resolved.source}) — expected an executable file.`,
      );
      return null;
    }
    warnOnVersionSkew(spec, resolved);
    // Found outside the process PATH (login shell rc files, deep scan) →
    // repair the PATH story: link into ~/.o8/bin so plain `which`, PTY
    // terminals, and worker spawns find it too. Best-effort, never blocks.
    if (resolved.source !== 'env' && resolved.source !== 'which') {
      ensureCliSymlink(spec.binaryName, resolved.path);
    }
    resolverCache.set(spec.runtimeId, { resolved, cachedAt: Date.now() });
    return resolved;
  };

  const triedPaths: string[] = [];

  // --- Strategy 1: env overrides ---
  const fromEnv = await resolveViaEnv(spec);
  if (fromEnv) {
    const accepted = await accept(fromEnv);
    if (accepted) return accepted;
  }
  const envKeys = executableEnvKeys(spec).filter((k) => process.env[k]);
  if (envKeys.length === 0) {
    // Only record "tried env" when env vars weren't set — otherwise we already logged
    triedPaths.push(`env:${spec.envOverride}`);
  }

  // --- Strategy 2: which ---
  const fromWhich = await resolveViaWhich(spec);
  if (fromWhich) {
    const accepted = await accept(fromWhich);
    if (accepted) return accepted;
  }
  for (const name of binaryNames(spec)) {
    triedPaths.push(`which:${name}`);
  }

  // --- Strategy 3: login-shell ---
  const fromShell = await resolveViaLoginShell(spec);
  if (fromShell) {
    const accepted = await accept(fromShell);
    if (accepted) return accepted;
  }
  for (const name of binaryNames(spec)) {
    triedPaths.push(`login-shell:${name}`);
  }

  // --- Strategy 4: static fallbacks ---
  const fromFallback = await resolveViaStaticFallbacks(spec);
  if (fromFallback) {
    const accepted = await accept(fromFallback);
    if (accepted) return accepted;
  }
  for (const { dir } of staticFallbackDirs()) {
    for (const name of binaryNames(spec)) {
      triedPaths.push(path.join(dir, name));
    }
  }

  throw new CliNotFoundError(spec.binaryName, triedPaths);
}
