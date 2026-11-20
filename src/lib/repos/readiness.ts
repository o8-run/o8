import { execFile } from '@/lib/providers/child-process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RepoReadiness, RepoSetupConfig } from './types';
import { checkRepoOriginConfigured, getRepoOriginConfiguredOverride } from './origin-readiness';
import { getRepoDispatchAdmission } from '@/lib/lane/repo-preflight';
import { PACKET_ENVIRONMENT_SKIP_NOTE } from './environment-policy';
import { publishNativeRepoReadiness } from '@/lib/mcp/native-read-publication';

interface RepoReadinessInput {
  localPath: string;
  defaultBranch: string;
  setup: RepoSetupConfig;
}

const execFileAsync = promisify(execFile);
const READINESS_CACHE_TTL_MS = 10_000;
const readinessCache = new Map<string, { value: RepoReadiness; ts: number }>();

async function pathExists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function getCurrentBranch(repoPath: string, fallbackBranch: string) {
  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      windowsHide: true,
      cwd: repoPath,
      timeout: 5_000,
    });
    return stdout.trim() || fallbackBranch;
  } catch {
    return fallbackBranch;
  }
}

async function hasDirtyWorktree(repoPath: string) {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      windowsHide: true,
      cwd: repoPath,
      timeout: 5_000,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function findEnvFallback(repoPath: string, envFile: string) {
  if (envFile === '.env') {
    const localFallback = path.join(repoPath, '.env.local');
    if (await pathExists(localFallback)) return '.env.local';
  }
  return null;
}

function readinessLabel(state: RepoReadiness['state']) {
  switch (state) {
    case 'ready':
      return 'Ready';
    case 'needs_setup':
      return 'Needs setup';
    case 'blocked':
      return 'Blocked';
    case 'missing':
      return 'Folder missing';
    default:
      return 'Unknown';
  }
}

// Tracks in-flight background refreshes so a flood of stale-cache hits within
// the same window only schedules one underlying recompute per repo.
const inFlightRefreshes = new Map<string, Promise<RepoReadiness>>();

/** Private admission floor until the native reader owns this process cache. */
export function hasCachedRepoReadiness(): boolean { return readinessCache.size > 0; }

export function invalidateRepoReadiness(...repoPaths: string[]) {
  for (const repoPath of repoPaths) {
    readinessCache.delete(repoPath);
    publishNativeRepoReadiness(repoPath, undefined);
    inFlightRefreshes.delete(repoPath);
  }
}

/**
 * Read the last readiness result without starting filesystem or Git work.
 *
 * Repository discovery is a hot, fleet-sized path. Callers that only need the
 * registry must not turn one list request into several subprocesses per repo.
 * Exact readiness remains available through getRepoReadiness for the selected
 * repo and other safety-sensitive actions.
 */
export function getCachedRepoReadiness(repo: RepoReadinessInput): RepoReadiness | undefined {
  const cached = readinessCache.get(repo.localPath);
  if (!cached) return undefined;

  const originOverride = getRepoOriginConfiguredOverride(repo.localPath);
  if (originOverride !== null && cached.value.originConfigured !== originOverride) {
    return { ...cached.value, originConfigured: originOverride };
  }
  return cached.value;
}

export async function getRepoReadiness(repo: RepoReadinessInput): Promise<RepoReadiness> {
  const cacheKey = repo.localPath;
  const cached = readinessCache.get(cacheKey);
  const originOverride = getRepoOriginConfiguredOverride(repo.localPath);

  if (cached) {
    const fresh = Date.now() - cached.ts < READINESS_CACHE_TTL_MS;
    if (!fresh) {
      // Stale-while-revalidate: return the cached
      // value immediately and refresh in the background so /api/panel/repos
      // never spends 60 ms doing ~5 git execs per repo on a dashboard render.
      // Cold misses still recompute synchronously (the else branch below).
      void refreshRepoReadiness(repo).catch(() => undefined);
    }
    if (originOverride !== null && cached.value.originConfigured !== originOverride) {
      return { ...cached.value, originConfigured: originOverride };
    }
    return cached.value;
  }

  // Cold miss — must compute synchronously so the first caller gets real data.
  return refreshRepoReadiness(repo);
}

function refreshRepoReadiness(repo: RepoReadinessInput): Promise<RepoReadiness> {
  const cacheKey = repo.localPath;
  const existing = inFlightRefreshes.get(cacheKey);
  if (existing) return existing;

  const refresh = refreshRepoReadinessUncached(repo)
    .finally(() => inFlightRefreshes.delete(cacheKey));
  inFlightRefreshes.set(cacheKey, refresh);
  return refresh;
}

async function refreshRepoReadinessUncached(repo: RepoReadinessInput): Promise<RepoReadiness> {
  const cacheKey = repo.localPath;

  // #1565 — a registered repo whose folder is GONE must surface as its own
  // state at detection time. Every probe below fails soft (git errors →
  // fallbacks), so a deleted/moved checkout used to read as 'unknown' (or
  // even 'ready' via the saved contract) and the operator only learned the
  // truth from a failed spawn.
  const dispatchAdmission = getRepoDispatchAdmission(repo.localPath);
  if (!dispatchAdmission.ok) {
    const state = dispatchAdmission.failedCheck === 'repository_folder_exists' ? 'missing' : 'blocked';
    const value: RepoReadiness = {
      state,
      label: readinessLabel(state),
      summary: dispatchAdmission.message,
      dispatchable: false,
      nextAction: dispatchAdmission.correctiveAction,
      failedCheck: dispatchAdmission.failedCheck,
      correctiveAction: dispatchAdmission.correctiveAction,
      currentBranch: null,
      onDefaultBranch: null,
      originConfigured: false,
      dirty: false,
      missingEnvFiles: [],
    };
    readinessCache.set(cacheKey, { value, ts: Date.now() });
    publishNativeRepoReadiness(cacheKey, value.state);
    return value;
  }

  const currentBranch = await getCurrentBranch(repo.localPath, repo.defaultBranch || 'main');
  const [dirty, packageJsonExists, nodeModulesExists, originConfigured, missingEnvFiles] = await Promise.all([
    hasDirtyWorktree(repo.localPath),
    pathExists(path.join(repo.localPath, 'package.json')),
    pathExists(path.join(repo.localPath, 'node_modules')),
    checkRepoOriginConfigured(repo.localPath),
    Promise.all(
      (repo.setup.envMode === 'skip' ? [] : repo.setup.envFiles).map(async (file) => {
        const exists = await pathExists(path.join(repo.localPath, file));
        return exists ? null : file;
      }),
    ).then((files) => files.filter((file): file is string => Boolean(file))),
  ]);

  const onDefaultBranch = currentBranch ? currentBranch === repo.defaultBranch : null;
  const hasRunnableContract = Boolean(repo.setup.devCommand || repo.setup.buildCommand);
  const hasInstallContract = Boolean(repo.setup.installCommand);
  const installLooksNeeded = Boolean(
    packageJsonExists
    && repo.setup.installOnCreateWorkspace
    && repo.setup.installCommand
    && !nodeModulesExists,
  );

  let state: RepoReadiness['state'] = 'unknown';
  let summary = 'No saved repo setup contract yet.';
  let nextAction: string | undefined;
  let failedCheck: string | undefined;
  let correctiveAction: string | undefined;

  const envFallbacks = new Map<string, string>();
  await Promise.all(
    missingEnvFiles.map(async (file) => {
      const fallback = await findEnvFallback(repo.localPath, file);
      if (fallback) envFallbacks.set(file, fallback);
    }),
  );

  if (missingEnvFiles.length > 0) {
    state = 'needs_setup';
    failedCheck = 'environment_files';
    const missingWithFallback = missingEnvFiles.filter((file) => envFallbacks.has(file));
    if (missingWithFallback.length > 0) {
      const file = missingWithFallback[0];
      const fallback = envFallbacks.get(file);
      summary = `Missing env file ${file}, but ${fallback} is present locally.`;
      nextAction = `Copy ${fallback} to ${file}, or change the repo env mode before trusting runtime validation.`;
    } else {
      summary = `Missing env files: ${missingEnvFiles.join(', ')}.`;
      nextAction = 'Restore the missing env files or change the repo env mode before trusting runtime validation.';
    }
    correctiveAction = nextAction;
  } else if (installLooksNeeded) {
    state = 'needs_setup';
    summary = `Dependencies still need setup with ${repo.setup.installCommand}.`;
    nextAction = `Run ${repo.setup.installCommand} before treating this checkout as runnable.`;
  } else if (hasRunnableContract) {
    state = 'ready';
    summary = `Runnable contract is saved on ${currentBranch}.${dirty ? ' Working tree has local changes.' : ''}`;
    if (onDefaultBranch && dirty) {
      nextAction = 'Prefer a worktree or branch before steering a larger change from the default branch.';
    }
  } else if (hasInstallContract) {
    state = 'needs_setup';
    summary = 'Install metadata is saved, but no dev/build command is configured yet.';
    nextAction = 'Save a dev or build command so the IDE can verify this repo end to end.';
  } else {
    state = 'ready';
    summary = `Repository is ready for mission work on ${currentBranch}.${dirty ? ' Working tree has local changes.' : ''}`;
  }

  const value: RepoReadiness = {
    state,
    label: readinessLabel(state),
    summary: repo.setup.envFiles.length > 0
      ? `${summary} ${PACKET_ENVIRONMENT_SKIP_NOTE}`
      : summary,
    dispatchable: true,
    nextAction,
    failedCheck,
    correctiveAction,
    currentBranch,
    onDefaultBranch,
    originConfigured,
    dirty,
    missingEnvFiles,
  };

  readinessCache.set(cacheKey, { value, ts: Date.now() });
  publishNativeRepoReadiness(cacheKey, value.state);
  return value;
}

export async function enrichRepoReadiness<T extends RepoReadinessInput>(repo: T): Promise<T & { readiness: RepoReadiness }> {
  const readiness = await getRepoReadiness(repo);
  return {
    ...repo,
    readiness,
  };
}

export async function enrichRepoReadinessFresh<T extends RepoReadinessInput>(repo: T): Promise<T & { readiness: RepoReadiness }> {
  const readiness = await refreshRepoReadiness(repo);
  return {
    ...repo,
    readiness,
  };
}

export function enrichRepoReadinessFromCache<T extends RepoReadinessInput>(repo: T): T & { readiness?: RepoReadiness } {
  const readiness = getCachedRepoReadiness(repo);
  const repoWithoutReadiness = { ...repo } as T & { readiness?: RepoReadiness };
  delete repoWithoutReadiness.readiness;
  return readiness ? { ...repoWithoutReadiness, readiness } : repoWithoutReadiness;
}

export async function enrichRepoReadinessList<T extends RepoReadinessInput>(repos: T[]): Promise<Array<T & { readiness: RepoReadiness }>> {
  return Promise.all(repos.map((repo) => enrichRepoReadiness(repo)));
}
