import { assertNotKnowledgeSource, normalizeKnowledgeWritePath } from '@/lib/cortex/knowledge/sources';
import 'server-only';
import { RepoFolderError } from './folder-error';

import { execFile } from '@/lib/providers/child-process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, mkdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getDataDir } from '@/lib/data-dir-migration';
import { isOrchestratorHomePath } from '@/lib/orchestrator/repo-path';
import { readJsonFile, writeJsonFile } from '@/lib/fs/json';
import type {
  RepoRegistryEntry,
  RepoRegistryStore,
  RepoSetupConfig,
  RepoWorkspaceManifestCache,
  ValidatedRepoCandidate,
} from './types';
import { isRepoWorkspaceIsolationPreference } from './types';
import { readCurrentOrigin } from './remote';
import { emitProductEvent } from '@/lib/analytics/server';
import { withStoragePressurePolicyLock } from '@/lib/orchestrator/storage-pressure-policy-lock';
import { getRepoDispatchAdmission } from '@/lib/lane/repo-preflight';
import { dependencyInstallCommandForManager } from '@/lib/workspace/dependency-manager-contract';
import { loadWorkspaceManifest, workspaceManifestPath } from '@/lib/workspace/manifest';
import { assertWorktreeMetadataEntryBudget, readBoundedMaintenanceFile,
  worktreeMetadataReadLimit } from '@/lib/worktree/maintenance-budget';

const execFileAsync = promisify(execFile);

const REGISTRY_DIR = getDataDir();
const REGISTRY_PATH = path.join(REGISTRY_DIR, 'repos.json');
const AUTO_DETECTED_DEPENDENCY_INSTALL_COMMANDS = new Set([
  'npm ci --prefer-offline',
  'npm install',
  'pnpm install --frozen-lockfile',
  'yarn install --frozen-lockfile',
  'yarn install --immutable',
  'bun install --frozen-lockfile',
  'bun install',
]);

function nowIso() {
  return new Date().toISOString();
}

function normalizeSetupConfig(setup: Partial<RepoSetupConfig> | null | undefined): RepoSetupConfig {
  const installCommand = setup?.installCommand?.trim() || null;
  return {
    envMode: setup?.envMode ?? 'copy',
    envFiles: Array.isArray(setup?.envFiles) ? setup.envFiles : ['.env', '.env.local'],
    installCommand,
    installOnCreateWorkspace: setup?.installOnCreateWorkspace ?? Boolean(installCommand),
    buildCommand: setup?.buildCommand?.trim() || null,
    runBuildOnCreateWorkspace: setup?.runBuildOnCreateWorkspace ?? false,
    devCommand: setup?.devCommand?.trim() || null,
    defaultPort: setup?.defaultPort ?? null,
    workspaceIsolationPreference: isRepoWorkspaceIsolationPreference(setup?.workspaceIsolationPreference)
      ? setup.workspaceIsolationPreference
      : 'auto',
  };
}

function reconcileDetectedSetup(
  stored: Partial<RepoSetupConfig> | null | undefined,
  detected: RepoSetupConfig,
): RepoSetupConfig {
  const normalized = normalizeSetupConfig(stored ?? detected);
  if (detected.installCommand === null
    && normalized.installCommand !== null
    && AUTO_DETECTED_DEPENDENCY_INSTALL_COMMANDS.has(normalized.installCommand)) {
    return {
      ...normalized,
      installCommand: null,
      installOnCreateWorkspace: false,
    };
  }
  return normalized;
}

function normalizeRepoEntry(repo: RepoRegistryEntry): RepoRegistryEntry {
  return {
    ...repo,
    defaultBranch: repo.defaultBranch || 'main',
    isGitRepo: repo.isGitRepo ?? true,
    storagePressureParkingDisabled: repo.storagePressureParkingDisabled ?? false,
    setup: normalizeSetupConfig(repo.setup),
  };
}

async function pathExists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function loadWorkspaceManifestCache(
  repoRoot: string,
): Promise<RepoWorkspaceManifestCache | undefined> {
  try {
    const manifest = await loadWorkspaceManifest(repoRoot);
    if (!manifest) return undefined;
    return {
      version: manifest.version,
      path: workspaceManifestPath(repoRoot),
      serviceNames: manifest.services?.map((service) => service.name) ?? [],
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function ensureRegistryDir() {
  await mkdir(REGISTRY_DIR, { recursive: true });
}


async function gitValue(repoRoot: string, args: string[]) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoRoot, ...args], {
      windowsHide: true,
      maxBuffer: 512 * 1024,
      timeout: 10_000,
    });
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

async function gitCommandSucceeds(repoRoot: string, args: string[]) {
  try {
    await execFileAsync('git', ['-C', repoRoot, ...args], {
      windowsHide: true,
      maxBuffer: 256 * 1024,
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

function normalizeBranchRef(value: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('refs/remotes/origin/')) {
    return trimmed.slice('refs/remotes/origin/'.length);
  }
  if (trimmed.startsWith('origin/')) {
    return trimmed.slice('origin/'.length);
  }
  return trimmed.split('/').pop() ?? trimmed;
}

export async function resolveDefaultBranch(repoRoot: string, isGitRepo = true) {
  if (!isGitRepo) return 'main';

  const remoteHead = normalizeBranchRef(
    await gitValue(repoRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']),
  );
  if (remoteHead) return remoteHead;

  if (await gitCommandSucceeds(repoRoot, ['show-ref', '--verify', '--quiet', 'refs/heads/main'])) {
    return 'main';
  }
  if (await gitCommandSucceeds(repoRoot, ['show-ref', '--verify', '--quiet', 'refs/heads/master'])) {
    return 'master';
  }

  const current = await gitValue(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current && current !== 'HEAD') return current;

  return 'main';
}

type PackageJsonShape = {
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

async function detectPackageManager(repoRoot: string, packageJson?: PackageJsonShape) {
  const packageManagerField = packageJson?.packageManager ?? '';
  if (packageManagerField.startsWith('pnpm@')) return 'pnpm';
  if (packageManagerField.startsWith('yarn@')) return 'yarn';
  if (packageManagerField.startsWith('bun@')) return 'bun';
  if (packageManagerField.startsWith('npm@')) return 'npm';

  if (await pathExists(path.join(repoRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await pathExists(path.join(repoRoot, 'yarn.lock'))) return 'yarn';
  if (await pathExists(path.join(repoRoot, 'bun.lockb'))) return 'bun';
  if (await pathExists(path.join(repoRoot, 'bun.lock'))) return 'bun';
  return 'npm';
}

async function detectSetupConfig(repoRoot: string): Promise<RepoSetupConfig> {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  let packageJson: PackageJsonShape | undefined;

  if (await pathExists(packageJsonPath)) {
    try {
      packageJson = await readJsonFile<PackageJsonShape>(packageJsonPath);
    } catch {
      packageJson = undefined;
    }
  }

  const hasPackageJson = Boolean(packageJson);
  const packageManager = await detectPackageManager(repoRoot, packageJson);
  const hasPackageLock = await pathExists(path.join(repoRoot, 'package-lock.json'));
  const hasBuildScript = Boolean(packageJson?.scripts?.build);

  let installCommand: string | null = null;
  if (hasPackageJson) {
    const declaredVersion = packageJson?.packageManager
      ?.match(new RegExp(`^${packageManager}@(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)`))?.[1]
      ?? null;
    const hasManagerLock = packageManager === 'npm'
      ? hasPackageLock
      : packageManager === 'pnpm'
        ? await pathExists(path.join(repoRoot, 'pnpm-lock.yaml'))
        : packageManager === 'yarn'
          ? await pathExists(path.join(repoRoot, 'yarn.lock'))
          : await pathExists(path.join(repoRoot, 'bun.lock'))
            || await pathExists(path.join(repoRoot, 'bun.lockb'));
    installCommand = dependencyInstallCommandForManager(
      packageManager,
      declaredVersion,
      hasManagerLock,
    );
  }

  let buildCommand: string | null = null;
  if (hasBuildScript) {
    if (packageManager === 'pnpm') buildCommand = 'pnpm build';
    else if (packageManager === 'yarn') buildCommand = 'yarn build';
    else if (packageManager === 'bun') buildCommand = 'bun run build';
    else buildCommand = 'npm run build';
  }

  // Auto-detect dev command
  let devCommand: string | null = null;
  let defaultPort: number | null = null;
  const hasDevScript = Boolean(packageJson?.scripts?.dev);
  const hasStartScript = Boolean(packageJson?.scripts?.start);
  if (hasDevScript) {
    if (packageManager === 'pnpm') devCommand = 'pnpm dev';
    else if (packageManager === 'yarn') devCommand = 'yarn dev';
    else if (packageManager === 'bun') devCommand = 'bun dev';
    else devCommand = 'npm run dev';
  } else if (hasStartScript) {
    if (packageManager === 'pnpm') devCommand = 'pnpm start';
    else if (packageManager === 'yarn') devCommand = 'yarn start';
    else if (packageManager === 'bun') devCommand = 'bun start';
    else devCommand = 'npm start';
  }
  // Try to detect port from scripts
  const devScript = packageJson?.scripts?.dev ?? packageJson?.scripts?.start ?? '';
  const portMatch = devScript.match(/(?:--port|PORT=|-p)\s*(\d+)/);
  if (portMatch) defaultPort = parseInt(portMatch[1], 10);
  // Common framework defaults
  if (!defaultPort && hasDevScript) {
    const deps = { ...packageJson?.dependencies, ...packageJson?.devDependencies };
    if (deps?.next) defaultPort = 3000;
    else if (deps?.vite) defaultPort = 5173;
    else if (deps?.['@angular/core']) defaultPort = 4200;
    else if (deps?.['react-scripts']) defaultPort = 3000;
    else if (deps?.nuxt) defaultPort = 3000;
    else if (deps?.svelte || deps?.['@sveltejs/kit']) defaultPort = 5173;
  }

  // Check for Go projects
  const hasGoMod = await pathExists(path.join(repoRoot, 'go.mod'));
  if (!devCommand && hasGoMod) {
    devCommand = 'go run .';
  }

  const envFiles = (await Promise.all(['.env', '.env.local'].map(async (file) => (
    await pathExists(path.join(repoRoot, file)) ? file : null
  )))).filter((file): file is string => Boolean(file));

  return {
    envMode: envFiles.length > 0 ? 'copy' : 'skip',
    envFiles,
    installCommand,
    installOnCreateWorkspace: Boolean(installCommand),
    buildCommand,
    runBuildOnCreateWorkspace: false,
    devCommand,
    defaultPort,
    workspaceIsolationPreference: 'auto',
  };
}

async function resolveRepoRoot(inputPath: string) {
  const expanded = inputPath.replace(/^~(?=\/|$)/, os.homedir());
  if (!expanded.trim()) {
    throw new RepoFolderError('Choose a folder or paste its full path.');
  }

  const resolved = normalizeKnowledgeWritePath(expanded);
  const stats = await stat(resolved).catch(() => null);
  if (!stats) {
    throw new RepoFolderError('Folder not found. Choose an existing folder or check the pasted path.');
  }
  if (!stats.isDirectory()) {
    throw new RepoFolderError('This is a file. Choose the folder containing your project.');
  }

  try {
    const { stdout } = await execFileAsync('git', ['-C', resolved, 'rev-parse', '--show-toplevel'], {
      windowsHide: true,
      maxBuffer: 256 * 1024,
      timeout: 10_000,
    });
    const repoRoot = stdout.replace(process.platform === 'win32' ? /\r?\n$/ : /\n$/, '');
    if (repoRoot) {
      const realRoot = await realpath(repoRoot).catch(() => repoRoot);
      return { localPath: path.resolve(realRoot), isGitRepo: true };
    }
  } catch {
    const realRoot = await realpath(resolved).catch(() => resolved);
    return { localPath: path.resolve(realRoot), isGitRepo: false };
  }

  const realRoot = await realpath(resolved).catch(() => resolved);
  return { localPath: path.resolve(realRoot), isGitRepo: false };
}

async function inspectLocalRepo(localPath: string): Promise<ValidatedRepoCandidate> {
  if (isOrchestratorHomePath(localPath)) {
    throw new Error('Home mode is not a registered repository.');
  }
  const { localPath: repoRoot } = await resolveRepoRoot(localPath);
  const isGitRepo = getRepoDispatchAdmission(repoRoot).ok;
  const [remoteUrl, defaultBranch, setup] = await Promise.all([
    isGitRepo ? gitValue(repoRoot, ['remote', 'get-url', 'origin']) : null,
    resolveDefaultBranch(repoRoot, isGitRepo),
    detectSetupConfig(repoRoot),
  ]);

  return {
    name: path.basename(repoRoot),
    localPath: repoRoot,
    remoteUrl,
    defaultBranch,
    isGitRepo,
    setup,
  };
}

function sortRepos(repos: RepoRegistryEntry[]) {
  return [...repos].sort((a, b) => {
    const aTime = new Date(a.lastOpenedAt ?? a.addedAt).getTime();
    const bTime = new Date(b.lastOpenedAt ?? b.addedAt).getTime();
    if (aTime !== bTime) return bTime - aTime;
    return a.name.localeCompare(b.name);
  });
}

// #1110 follow-up — short-TTL in-memory cache. /api/panel/repos used to spend
// ~60ms parsing this JSON on every dashboard render even after the readiness
// SWR landed; this drops steady-state reads to single-digit ms. All mutation
// paths (addRepo / updateRepo / removeRepo) invalidate via writeStore().
let _cachedStore: { value: RepoRegistryStore; ts: number } | null = null;
const STORE_CACHE_TTL_MS = 5_000;
let registryMutationQueue: Promise<void> = Promise.resolve();

function invalidateStoreCache() {
  _cachedStore = null;
}

async function readStore(): Promise<RepoRegistryStore> {
  // Automatic retirement must freshly admit this authority, including a cached registry.
  if (worktreeMetadataReadLimit() !== undefined) {
    const file = await readBoundedMaintenanceFile(REGISTRY_PATH);
    if (!file) return { version: 1, repos: [] };
    const parsed = JSON.parse(file.text) as Partial<RepoRegistryStore>;
    if (!Array.isArray(parsed.repos)) throw new Error('Repository registry is unreadable.');
    assertWorktreeMetadataEntryBudget(REGISTRY_PATH, parsed.repos.length);
    return { version: 1, repos: sortRepos(parsed.repos.map(normalizeRepoEntry)) };
  }
  if (_cachedStore && Date.now() - _cachedStore.ts < STORE_CACHE_TTL_MS) {
    return _cachedStore.value;
  }

  if (!(await pathExists(REGISTRY_PATH))) {
    const empty: RepoRegistryStore = { version: 1, repos: [] };
    _cachedStore = { value: empty, ts: Date.now() };
    return empty;
  }

  const parsed = await readJsonFile<Partial<RepoRegistryStore>>(REGISTRY_PATH).catch(() => null);
  if (!parsed || !Array.isArray(parsed.repos)) {
    throw new Error('Repository registry is unreadable. Check ~/.o8/repos.json.');
  }

  const value: RepoRegistryStore = {
    version: 1,
    repos: sortRepos((parsed.repos as RepoRegistryEntry[]).map(normalizeRepoEntry)),
  };
  _cachedStore = { value, ts: Date.now() };
  return value;
}

async function readStoreFresh(): Promise<RepoRegistryStore> {
  invalidateStoreCache();
  return readStore();
}

async function withRegistryMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = registryMutationQueue;
  let release!: () => void;
  registryMutationQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await withStoragePressurePolicyLock(operation);
  } finally {
    release();
  }
}

async function writeStore(store: RepoRegistryStore) {
  await ensureRegistryDir();
  await writeJsonFile(REGISTRY_PATH, {
    version: 1,
    repos: sortRepos(store.repos),
  });
  invalidateStoreCache();
}

/**
 * #748 — Recompute stack signatures whenever the registry mutates so the
 * cross-repo proposer always reads fresh data. Lazy-required so the cold
 * `addRepo` path doesn't pay for the import unless needed (and so test
 * harnesses that mock the registry don't drag in fs/cortex code).
 *
 * Fire-and-forget — the registry write returns immediately and the
 * recompute lands shortly after on a microtask. Failures are logged inside
 * `triggerSignatureRecompute` and never propagate.
 */
function fireSignatureRecompute(): void {
  try {
    const mod = require('@/lib/cortex/stack-signature') as
      | typeof import('@/lib/cortex/stack-signature')
      | undefined;
    mod?.triggerSignatureRecompute?.();
  } catch (error) {
    // Treat any import-time failure as a no-op. The boot tick will refresh
    // signatures on the next server restart even if this hook misfires.
    console.warn(
      '[repo-registry] signature recompute trigger failed:',
      error instanceof Error ? error.message : error,
    );
  }
  // #851 — Stack signatures change → cross-repo proposer's similarity
  // matrix changes → cache must drop so the next read sees the new repo
  // set. Lazy-required for the same reasons as the signature import.
  try {
    const mod = require('@/lib/cortex/cross-repo-proposer') as
      | typeof import('@/lib/cortex/cross-repo-proposer')
      | undefined;
    mod?.invalidateCrossRepoProposerCache?.();
  } catch (error) {
    console.warn(
      '[repo-registry] cross-repo cache invalidation failed:',
      error instanceof Error ? error.message : error,
    );
  }
}

export async function listRepos() {
  const store = await readStore();
  // Maintenance reads must remain bounded and read-only. Ordinary reads repair
  // moved remotes using local git config, then merge only that field under the
  // same mutation lock as add/update/remove so concurrent edits survive.
  if (worktreeMetadataReadLimit() !== undefined) return store.repos;
  const remotes = await Promise.all(store.repos.map(async repo => ({
    id: repo.id, localPath: repo.localPath, previousRemote: repo.remoteUrl,
    remote: repo.isGitRepo ? await readCurrentOrigin(repo.localPath) : undefined,
  })));
  if (!remotes.some(value => value.remote !== undefined && store.repos.find(repo => repo.id === value.id)?.remoteUrl !== value.remote)) return store.repos;
  return withRegistryMutation(async () => {
    const current = await readStoreFresh();
    let changed = false;
    const repos = current.repos.map(repo => {
      const value = remotes.find(remote => remote.id === repo.id && remote.localPath === repo.localPath);
      if (!value || value.remote === undefined || value.remote === repo.remoteUrl || value.previousRemote !== repo.remoteUrl) return repo;
      changed = true;
      return { ...repo, remoteUrl: value.remote };
    });
    if (changed) await writeStore({ version: 1, repos });
    return repos;
  });
}

/** Disk-fresh read for destructive policy decisions made under the registry mutation lock. */
export async function listReposFresh() {
  const store = await readStoreFresh();
  return store.repos;
}

/**
 * Synchronous pool lookup by id. Orchestrator thread-project validation has to
 * resolve virtual `repo:<id>` project ids on a synchronous path and cannot
 * await `listRepos()` (#2140). Shares the async read's cache and normalization
 * so both see the same pool; a missing or unreadable registry reads as an
 * empty pool, which the caller already handles as an unresolvable id.
 */
export function findRepoByIdSync(id: string): RepoRegistryEntry | null {
  if (!_cachedStore || Date.now() - _cachedStore.ts >= STORE_CACHE_TTL_MS) {
    try {
      const parsed = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as Partial<RepoRegistryStore> | null;
      if (!parsed || !Array.isArray(parsed.repos)) return null;
      _cachedStore = {
        value: {
          version: 1,
          repos: sortRepos((parsed.repos as RepoRegistryEntry[]).map(normalizeRepoEntry)),
        },
        ts: Date.now(),
      };
    } catch {
      return null;
    }
  }
  return _cachedStore.value.repos.find((repo) => repo.id === id) ?? null;
}

export async function findRepoByLocalPath(localPath: string) {
  const target = path.resolve(localPath);
  const repos = await listRepos();
  return repos.find((repo) => path.resolve(repo.localPath) === target) ?? null;
}

export async function validateRepo(localPath: string) {
  return inspectLocalRepo(localPath);
}

export async function addRepo(localPath: string) {
  assertNotKnowledgeSource(localPath);
  const candidate = await inspectLocalRepo(localPath);
  assertNotKnowledgeSource(candidate.localPath);
  const manifest = await loadWorkspaceManifestCache(candidate.localPath);
  const { entry, created } = await withRegistryMutation(async () => {
    assertNotKnowledgeSource(candidate.localPath);
    const store = await readStoreFresh();
    const now = nowIso();
    const existing = store.repos.find((repo) => repo.localPath === candidate.localPath);

    if (existing) {
      const updated: RepoRegistryEntry = {
        ...existing,
        name: candidate.name,
        remoteUrl: candidate.remoteUrl,
        defaultBranch: candidate.defaultBranch,
        isGitRepo: candidate.isGitRepo ?? true,
        setup: reconcileDetectedSetup(existing.setup, candidate.setup),
        manifest,
        lastOpenedAt: now,
      };
      const repos = store.repos.map((repo) => (repo.id === existing.id ? updated : repo));
      await writeStore({ version: 1, repos });
      return { entry: updated, created: false };
    }

    const added: RepoRegistryEntry = {
      id: randomUUID(),
      name: candidate.name,
      localPath: candidate.localPath,
      remoteUrl: candidate.remoteUrl,
      defaultBranch: candidate.defaultBranch,
      isGitRepo: candidate.isGitRepo ?? true,
      addedAt: now,
      lastOpenedAt: now,
      storagePressureParkingDisabled: false,
      setup: candidate.setup,
      manifest,
    };
    await writeStore({ version: 1, repos: [...store.repos, added] });
    return { entry: added, created: true };
  });

  fireSignatureRecompute();

  if (!created) return entry;

  // #1114 — fire-and-forget spec ingest so the Engineering Brain has
  // substrate to answer design/convention questions about this repo. Done
  // out-of-band so addRepo's response isn't blocked on disk scans. Errors
  // are logged but never raised; the registry write already succeeded.
  void scheduleSpecIngest(entry.localPath, entry.name);

  // Coarse product signal — a new repo was connected (#1249). hasRemote tells
  // local-only vs GitHub-connected; never the name/path/URL. Only the genuinely
  // new branch fires (the `existing` re-open above does not). Fire-and-forget.
  void emitProductEvent('repo.added', { hasRemote: !!candidate.remoteUrl, isGitRepo: candidate.isGitRepo ?? true });

  return entry;
}

async function scheduleSpecIngest(repoPath: string, repoSlug: string): Promise<void> {
  try {
    const { ingestRepoSpecs, purgeOrphanedSpecDirectives } = await import('@/lib/cortex/spec-ingest');
    const result = await ingestRepoSpecs(repoPath, repoSlug);
    console.log(
      `[spec-ingest] addRepo(${repoSlug}): scanned=${result.scannedFiles} written=${result.writtenDirectives} deletedStale=${result.deletedStaleDirectives}`,
    );

    // #1228 — auto-heal a repo rename. A rename surfaces as a fresh addRepo at
    // the new path: the ingest above writes the new slug's directives, but the
    // OLD slug's spec-ingest rows linger, orphaned — they match no live basename
    // yet still occupy FTS top-N slots, starving live directives. Purge any
    // spec-ingest slug claimed by no registered repo. Live slugs include BOTH
    // the registry name and the path basename, since directiveAppliesToRepo()
    // matches basename(repoPath).
    try {
      const repos = await listRepos();
      const liveSlugs = new Set<string>();
      for (const repo of repos) {
        if (repo.name) liveSlugs.add(repo.name.toLowerCase());
        try { liveSlugs.add(path.basename(repo.localPath).toLowerCase()); } catch { /* skip */ }
      }
      const orphan = purgeOrphanedSpecDirectives(liveSlugs);
      if (orphan.purged > 0) {
        console.log(
          `[spec-ingest] #1228 purged ${orphan.purged} orphaned directive(s) from stale slug(s): ${orphan.slugs.join(', ')}`,
        );
      }
    } catch (err) {
      console.error('[spec-ingest] #1228 orphan purge failed:', err);
    }
  } catch (err) {
    console.error(`[spec-ingest] addRepo(${repoSlug}) failed:`, err);
  }
}

export async function updateRepo(
  id: string,
  updates: {
    localPath?: string;
    setup?: RepoSetupConfig;
    lastOpenedAt?: string | null;
    storagePressureParkingDisabled?: boolean;
  },
) {
  assertNotKnowledgeSource(updates.localPath);
  const candidate = updates.localPath === undefined ? null : await inspectLocalRepo(updates.localPath);
  const manifest = candidate ? await loadWorkspaceManifestCache(candidate.localPath) : undefined;
  const next = await withRegistryMutation(async () => {
    const store = await readStoreFresh();
    const existing = store.repos.find((repo) => repo.id === id);
    if (!existing) throw new Error('Repository not found.');
    assertNotKnowledgeSource(candidate?.localPath ?? existing.localPath);
    if (candidate && store.repos.some((repo) => repo.id !== id && repo.localPath === candidate.localPath)) {
      throw new Error('Another registered repository already uses that folder.');
    }
    const updated: RepoRegistryEntry = {
      ...existing,
      ...(candidate ? {
        name: candidate.name,
        localPath: candidate.localPath,
        remoteUrl: candidate.remoteUrl,
        defaultBranch: candidate.defaultBranch,
        isGitRepo: candidate.isGitRepo,
        manifest,
      } : {}),
      setup: normalizeSetupConfig(updates.setup ?? existing.setup),
      lastOpenedAt: updates.lastOpenedAt === undefined ? existing.lastOpenedAt : updates.lastOpenedAt,
      storagePressureParkingDisabled: updates.storagePressureParkingDisabled
        ?? existing.storagePressureParkingDisabled,
    };
    await writeStore({
      version: 1,
      repos: store.repos.map((repo) => (repo.id === id ? updated : repo)),
    });
    return updated;
  });
  if (candidate) {
    fireSignatureRecompute();
    void scheduleSpecIngest(next.localPath, next.name);
  }
  return next;
}

export async function touchRepo(id: string, timestamp = nowIso()) {
  return updateRepo(id, { lastOpenedAt: timestamp });
}

export async function removeRepo(id: string) {
  await withRegistryMutation(async () => {
    const store = await readStoreFresh();
    if (!store.repos.some((repo) => repo.id === id)) throw new Error('Repository not found.');
    await writeStore({
      version: 1,
      repos: store.repos.filter((repo) => repo.id !== id),
    });
  });

  fireSignatureRecompute();
}

export function getRepoRegistryPath() {
  return REGISTRY_PATH;
}
