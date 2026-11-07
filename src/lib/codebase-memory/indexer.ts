/**
 * Boot indexer for codebase-memory-mcp.
 *
 * Closes #741 (epic #738 Context Engine v2). On o8 boot:
 *   1. Wait for the codebase-memory-mcp binary (#739 download) to be ready.
 *   2. Read ~/.o8/repos.json (the registry from src/lib/repos/registry.ts).
 *   3. For each repo:
 *      - Skip if HEAD matches the persisted last-indexed HEAD (cache hit).
 *      - Skip + mark deferred if the repo on disk is > 500 MB.
 *      - Otherwise queue an index_repository call. Concurrency capped at 2.
 *   4. Persist the new HEAD on success so the next boot is a no-op.
 *
 * The boot pass is fire-and-forget: it returns immediately and runs in the
 * background. Each transition publishes the shared read-only snapshot used
 * by both transports.
 *
 * Failure policy: every error is logged with the [codebase-memory] prefix
 * and recorded on the per-repo entry. Nothing here can block the Next.js
 * server boot or hard-crash the process.
 */

import 'server-only';

import { execFile } from '@/lib/providers/child-process';
import { promisify } from 'node:util';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listRepos } from '@/lib/repos/registry';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { resolveCodebaseMemoryBin, waitForCodebaseMemoryBin } from './binary';
import { callCodebaseMemoryTool } from './mcp-client';
import { getRecordedHead, recordIndexedHead } from './state-store';
import { INDEX_STATE_PUBLISH_INTERVAL_MS, publishIndexState, readIndexState } from './live-state';
import { isNativeCortexReader } from '@/lib/cortex/owner-process';
import type { IndexState, RepoIndexEntry, RepoIndexStatus } from './types';

/**
 * Directory names skipped by the indexer at index time (these are the trees
 * the codebase-memory-mcp binary itself ignores). `measureRepoSize` MUST
 * apply the same set when summing bytes — otherwise it counts trees that
 * will never be indexed and inflates the size to multi-GB on JS repos with
 * a chunky `node_modules`. #896.
 */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'target',
  '.next',
  'dist',
  'build',
  'out',
  'coverage',
]);

const execFileAsync = promisify(execFile);

/** Repos larger than this on disk are deferred to manual re-index. */
const DEFAULT_MAX_REPO_SIZE_BYTES = 500 * 1024 * 1024;

/** Concurrent index_repository calls — disk thrash guard. */
const DEFAULT_INDEX_CONCURRENCY = 2;

/** How long to wait for the binary on first boot before giving up. */
const BINARY_WAIT_TIMEOUT_MS = 5 * 60_000;

/** Tool exposed by codebase-memory-mcp (#738/#739). */
const INDEX_TOOL_NAME = 'index_repository';

/** Cap for the manual size walk so a giant node_modules doesn't stall boot.
 *  Raised from 1,500 → 100,000 (#850) — cortex-ide alone has 61,887 entries
 *  after excluding node_modules/.git/target/.next/dist, so the previous cap
 *  deferred our primary dogfood repo on every boot. The walk is fast (sub-
 *  100ms even at 60k entries on SSD) so the cap is only a paranoia bound. */
const SIZE_WALK_ENTRY_CAP = 100_000;

// Live in-process state. Reset on server restart — that's fine since the
// next boot pass repopulates it.
const stateByRepoId = new Map<string, RepoIndexEntry>();
let bootRan = false;
let bootInFlight = false;

function logInfo(msg: string, ...rest: unknown[]) {
  console.log(`[codebase-memory] ${msg}`, ...rest);
}
function logWarn(msg: string, ...rest: unknown[]) {
  console.warn(`[codebase-memory] ${msg}`, ...rest);
}

function setEntry(entry: RepoIndexEntry) {
  stateByRepoId.set(entry.repoId, entry);
  publishIndexState(getIndexState());
}

function patchEntry(repoId: string, patch: Partial<RepoIndexEntry>) {
  const existing = stateByRepoId.get(repoId);
  if (!existing) return;
  setEntry({ ...existing, ...patch });
}

export function getIndexState(): IndexState {
  const entries = Array.from(stateByRepoId.values()).sort((a, b) =>
    a.repoName.localeCompare(b.repoName),
  );
  const inFlight = entries.some((e) => e.status === 'pending' || e.status === 'indexing');
  return {
    bootRan,
    inFlight,
    entries,
  };
}

async function getCurrentHead(localPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', localPath, 'rev-parse', 'HEAD'], {
      windowsHide: true,
      maxBuffer: 64 * 1024,
      timeout: 10_000,
    });
    const head = stdout.trim();
    return head || null;
  } catch {
    return null;
  }
}

/**
 * Best-effort repo size in bytes. We capped the recursion at
 * SIZE_WALK_ENTRY_CAP to avoid spending boot time enumerating huge trees;
 * past that cap we treat the repo as "definitely big" and defer it.
 *
 * Skips the same directories as the indexer (SKIP_DIRS) so the measured
 * size reflects what's actually indexable. Previously we statSync()'d the
 * skipped dirs and added their reported size — which on macOS returned
 * inflated block-aligned values (e.g. cortex-ide's node_modules pushed the
 * total to 1.6 GB and tripped the 500 MB defer cap on every boot). #896.
 *
 * Returns:
 *   - bytes when fully measured under the cap
 *   - null when measurement failed (treat as small/unknown — proceed)
 *   - Number.POSITIVE_INFINITY when we hit the cap (treat as oversize)
 */
function measureRepoSize(localPath: string): number | null {
  let total = 0;
  let entriesSeen = 0;
  const stack: string[] = [localPath];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let dirents: ReturnType<typeof readdirSync>;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      entriesSeen += 1;
      if (entriesSeen > SIZE_WALK_ENTRY_CAP) {
        return Number.POSITIVE_INFINITY;
      }
      // Skip the same dirs the indexer skips. Don't stat them — those
      // trees will never be indexed, so their bytes don't count toward
      // the size budget.
      if (SKIP_DIRS.has(dirent.name)) {
        continue;
      }
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        // #896: skip nested git worktrees. A linked worktree has a `.git`
        // FILE (gitdir pointer) at its root rather than a directory; the
        // codebase-memory-mcp binary descends into nested .git/worktrees
        // separately, so counting them again here both inflates the size
        // and explodes the SIZE_WALK_ENTRY_CAP on repos that use o8's
        // .claude/worktrees/* dispatch flow.
        if (isLinkedWorktreeRoot(full)) {
          continue;
        }
        stack.push(full);
        continue;
      }
      try {
        const s = statSync(full);
        total += s.size;
      } catch {
        /* ignore */
      }
    }
  }
  return total;
}

/**
 * A linked git worktree root has a `.git` FILE (containing `gitdir: ...`)
 * rather than a `.git` directory. Detecting this lets us prune entire
 * agent-spawn worktrees (e.g. `.claude/worktrees/agent-*`) from the size
 * walk. #896.
 */
function isLinkedWorktreeRoot(dirPath: string): boolean {
  const candidate = join(dirPath, '.git');
  if (!existsSync(candidate)) return false;
  try {
    const stat = statSync(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Convert a repo's absolute path into the codebase-memory-mcp project
 * name. The binary uses the same convention: strip leading slash, replace
 * remaining slashes with hyphens. Mirrors `repoPathToProjectName` in
 * client.ts but kept local to avoid a server-only ↔ server-only cycle.
 */
function repoPathToProjectName(repoPath: string): string {
  return repoPath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\//g, '-');
}

/**
 * The codebase-memory-mcp binary writes per-project SQLite DBs to
 * `~/.cache/codebase-memory-mcp/<project-name>.db`. If that file exists
 * we know the repo has been indexed at least once, even if our local
 * state-store doesn't have a HEAD recorded. #896.
 */
function indexedDbExists(localPath: string): boolean {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  if (!home) return false;
  const project = repoPathToProjectName(localPath);
  const dbPath = join(home, '.cache', 'codebase-memory-mcp', `${project}.db`);
  return existsSync(dbPath);
}

interface RunIndexJobOpts {
  binPath: string;
  repo: RepoRegistryEntry;
  maxSizeBytes: number;
}

interface DeltaIndexOpts {
  binPath: string;
  repo: RepoRegistryEntry;
  currentHead: string;
}

/** Track in-flight delta indexes so concurrent boot passes don't double-fire. */
const deltaInFlight = new Set<string>();

/**
 * Fire a background re-index for a repo whose .db exists but whose HEAD
 * has moved since the last recorded index. Doesn't block the boot pass —
 * the UI shows 'cached' immediately and gets refreshed once the delta
 * finishes. #896.
 */
function scheduleDeltaIndex({ binPath, repo, currentHead }: DeltaIndexOpts): void {
  if (deltaInFlight.has(repo.id)) return;
  deltaInFlight.add(repo.id);
  setImmediate(async () => {
    try {
      logInfo(`delta-indexing ${repo.name} (HEAD ${currentHead.slice(0, 7)})`);
      const result = await callCodebaseMemoryTool({
        binPath,
        cwd: repo.localPath,
        toolName: INDEX_TOOL_NAME,
        args: { repo_path: repo.localPath },
      });
      if (!result.ok) {
        logWarn(`delta-index failed for ${repo.name}: ${result.error}`);
        return;
      }
      recordIndexedHead(repo.id, currentHead);
      patchEntry(repo.id, {
        status: 'ready' satisfies RepoIndexStatus,
        lastIndexedHead: currentHead,
        lastIndexedAt: new Date().toISOString(),
        error: null,
        durationMs: result.durationMs,
      });
      logInfo(`delta-indexed ${repo.name} in ${result.durationMs}ms`);
    } catch (err) {
      logWarn(`delta-index threw for ${repo.name}:`, err);
    } finally {
      deltaInFlight.delete(repo.id);
    }
  });
}

async function runIndexJob({ binPath, repo, maxSizeBytes }: RunIndexJobOpts): Promise<void> {
  const repoId = repo.id;

  // #896: short-circuit on prior-indexed DB. The codebase-memory-mcp binary
  // persists per-project SQLite at ~/.cache/codebase-memory-mcp/<name>.db,
  // so if that file exists the repo was already indexed in a prior boot
  // (or by direct CLI use). Skip the size walk entirely, mark it cached,
  // and let the delta-index timeline decide whether to refresh.
  if (indexedDbExists(repo.localPath)) {
    const currentHead = await getCurrentHead(repo.localPath);
    const recordedHead = getRecordedHead(repoId);
    logInfo(`cached ${repo.name}: prior MCP DB present — skipping size walk`);
    patchEntry(repoId, {
      status: 'cached' satisfies RepoIndexStatus,
      lastIndexedHead: currentHead ?? recordedHead ?? null,
    });
    if (currentHead && (!recordedHead || recordedHead !== currentHead)) {
      // HEAD drift: schedule a delta-index out of band. Logs only —
      // the boot pass returns immediately so the status route paints
      // 'cached' instead of churning on a re-index.
      scheduleDeltaIndex({ binPath, repo, currentHead });
    }
    return;
  }

  // Size guard. Defer oversize repos.
  let sizeBytes: number | null = null;
  try {
    sizeBytes = measureRepoSize(repo.localPath);
  } catch {
    sizeBytes = null;
  }
  if (sizeBytes !== null && sizeBytes !== Number.POSITIVE_INFINITY) {
    patchEntry(repoId, { sizeBytes });
  }
  if (sizeBytes !== null && sizeBytes > maxSizeBytes) {
    logInfo(`deferring ${repo.name}: size ${Math.round(sizeBytes / (1024 * 1024))} MB > limit`);
    patchEntry(repoId, {
      status: 'deferred' satisfies RepoIndexStatus,
      sizeBytes: sizeBytes === Number.POSITIVE_INFINITY ? null : sizeBytes,
    });
    return;
  }

  // HEAD-based cache check.
  const currentHead = await getCurrentHead(repo.localPath);
  if (!currentHead) {
    logWarn(`skipping ${repo.name}: not a git repo or HEAD unresolved`);
    patchEntry(repoId, { status: 'skipped' satisfies RepoIndexStatus });
    return;
  }
  const recordedHead = getRecordedHead(repoId);
  if (recordedHead && recordedHead === currentHead) {
    logInfo(`cached ${repo.name}: HEAD ${currentHead.slice(0, 7)} unchanged`);
    patchEntry(repoId, {
      status: 'cached' satisfies RepoIndexStatus,
      lastIndexedHead: currentHead,
    });
    return;
  }

  // Issue index_repository. cwd = repo root so the binary indexes the right tree.
  patchEntry(repoId, { status: 'indexing' satisfies RepoIndexStatus });
  logInfo(`indexing ${repo.name} (HEAD ${currentHead.slice(0, 7)})`);

  const result = await callCodebaseMemoryTool({
    binPath,
    cwd: repo.localPath,
    toolName: INDEX_TOOL_NAME,
    // #852: binary v0.6.0+ requires `repo_path`, not `path`. Passing the wrong
    // key returned `{ isError: true }` which the old mcp-client also dropped,
    // so the indexer marked every repo as cached without ever indexing.
    args: { repo_path: repo.localPath },
  });

  if (!result.ok) {
    logWarn(`index failed for ${repo.name}: ${result.error}`);
    patchEntry(repoId, {
      status: 'error' satisfies RepoIndexStatus,
      error: result.error,
      durationMs: result.durationMs,
    });
    return;
  }

  recordIndexedHead(repoId, currentHead);
  patchEntry(repoId, {
    status: 'ready' satisfies RepoIndexStatus,
    lastIndexedHead: currentHead,
    lastIndexedAt: new Date().toISOString(),
    error: null,
    durationMs: result.durationMs,
  });
  logInfo(`indexed ${repo.name} in ${result.durationMs}ms`);
}

/**
 * Drain the pending queue with bounded concurrency.
 *
 * Plain promise-pool. We don't pull in p-queue because the dep adds cost
 * and this is fewer than 50 lines.
 */
async function runWithConcurrency(
  jobs: Array<() => Promise<void>>,
  concurrency: number,
): Promise<void> {
  const active = new Set<Promise<void>>();
  for (const job of jobs) {
    const run = job().catch((err: unknown) => {
      logWarn('indexer worker threw:', err);
    });
    active.add(run);
    void run.finally(() => active.delete(run));
    if (active.size >= concurrency) {
      await Promise.race(active);
    }
  }
  await Promise.all(active);
}

export interface IndexAllOpts {
  /** Override max repo size. Defaults to 500 MB. */
  maxRepoSizeBytes?: number;
  /** Override concurrency. Defaults to 2. */
  concurrency?: number;
  /** Override the binary-wait deadline. */
  binaryWaitTimeoutMs?: number;
}

/**
 * Run a single boot pass. Idempotent — concurrent calls share state.
 * Resolves when every repo's index attempt has settled.
 */
export async function indexAllRepos(opts: IndexAllOpts = {}): Promise<IndexState> {
  if (isNativeCortexReader()) return readIndexState();
  if (bootInFlight) {
    return getIndexState();
  }
  bootInFlight = true;
  bootRan = true;
  publishIndexState(getIndexState());
  const heartbeat = setInterval(() => publishIndexState(getIndexState()), INDEX_STATE_PUBLISH_INTERVAL_MS);
  heartbeat.unref();

  const concurrency = opts.concurrency ?? DEFAULT_INDEX_CONCURRENCY;
  const maxSizeBytes = opts.maxRepoSizeBytes ?? DEFAULT_MAX_REPO_SIZE_BYTES;
  const waitMs = opts.binaryWaitTimeoutMs ?? BINARY_WAIT_TIMEOUT_MS;

  try {
    let repos: RepoRegistryEntry[];
    try {
      repos = await listRepos();
    } catch (err) {
      logWarn('failed to read repo registry:', err);
      return getIndexState();
    }

    if (repos.length === 0) {
      logInfo('no registered repos — boot pass is a no-op');
      return getIndexState();
    }

    // Initialize state for each repo so the status endpoint has something
    // to return immediately even before binary resolution.
    for (const repo of repos) {
      setEntry({
        repoId: repo.id,
        repoName: repo.name,
        localPath: repo.localPath,
        status: 'pending',
      });
    }

    // Resolve binary; wait for #739's download if necessary.
    let binPath = resolveCodebaseMemoryBin();
    if (!binPath) {
      logInfo('binary not yet available — waiting for #739 download');
      binPath = await waitForCodebaseMemoryBin(waitMs);
    }
    if (!binPath) {
      logWarn('binary unavailable after wait — marking all repos skipped');
      for (const repo of repos) {
        patchEntry(repo.id, {
          status: 'skipped' satisfies RepoIndexStatus,
          error: 'codebase-memory-mcp binary unavailable',
        });
      }
      return getIndexState();
    }

    logInfo(`boot pass: ${repos.length} repos, binary at ${binPath}`);

    const jobs: Array<() => Promise<void>> = repos.map(
      (repo) => () => runIndexJob({ binPath: binPath!, repo, maxSizeBytes }),
    );
    await runWithConcurrency(jobs, concurrency);

    const state = getIndexState();
    const ready = state.entries.filter((e) => e.status === 'ready').length;
    const cached = state.entries.filter((e) => e.status === 'cached').length;
    const deferred = state.entries.filter((e) => e.status === 'deferred').length;
    const errored = state.entries.filter((e) => e.status === 'error').length;
    logInfo(
      `boot pass complete: ${ready} indexed, ${cached} cached, ${deferred} deferred, ${errored} errored`,
    );
    return state;
  } finally {
    clearInterval(heartbeat);
    bootInFlight = false;
    publishIndexState(getIndexState());
  }
}

let bootHookFired = false;

/**
 * Idempotent trigger owned by Next startup through startStatusBootHooks.
 * Spawns indexAllRepos on setImmediate so startup returns immediately.
 * Read handlers must never call this trigger.
 *
 * Mirrors the `ensureBooted()` pattern in src/lib/skeleton/autoscan.ts.
 */
export function ensureCodebaseMemoryBootIndex(): void {
  if (isNativeCortexReader()) return;
  if (bootHookFired) return;
  bootHookFired = true;
  setImmediate(() => {
    void indexAllRepos().catch((err: unknown) => {
      logWarn('boot pass threw:', err);
    });
  });
}
