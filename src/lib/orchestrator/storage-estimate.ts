import { readdir } from 'node:fs/promises';
import path from 'node:path';

import type { OrchestratorPacketStorageAdmission } from '@/lib/orchestrator/types';
import type { StorageDependencyCloneContract } from '@/lib/workspace/storage-dependency-contract';
import type { RepoSetupConfig } from '@/lib/repos/types';
import { resolveWorktreeRootLayout } from '@/lib/worktree/root-layout';
import type { DirectoryStorageTelemetry } from '@/lib/worktree/storage-telemetry';
import { detectDependencyInstallCommand } from '@/lib/workspace/dependency-install';
import { observeDependencyReuse, type DependencyReuseEstimate } from './storage-dependency-reuse';
import {
  measureDependencyTree,
  measureTrackedCheckout,
  readEstimateInput,
  type CheckoutStorageMeasurement,
} from './storage-estimate-measurement';

const MIB = 1024 * 1024;
// Startup files, transcripts and small edits, separate from the host's reserve policy.
const STARTUP_GROWTH_BYTES = 64 * MIB;
const WRITE_HEADROOM_RATIO = 1.25;
const COLD_LOCKED_PACKAGE_BYTES = MIB;
const COLD_DIRECT_PACKAGE_BYTES = 8 * MIB;
const ESTIMATE_TIMEOUT_MS = 5_000;

export interface RepoStorageEstimate {
  status: 'observed' | 'unknown';
  exactBytes: number | null;
  source: OrchestratorPacketStorageAdmission['estimateSource'];
  historySamples: number;
  workspacePaths: string[];
  error: string | null;
  /** Recomputed at the provisioning boundary before accepting a discounted reservation. */
  dependencyCloneContract?: StorageDependencyCloneContract;
  nativeInstallEstimateBytes?: number;
}

export interface RepoStorageEstimateDependencies {
  creationBaseCommit?: string;
  // Kept for compatibility; full-tree telemetry is not incremental-write evidence.
  readCachedMeasurement?: (targetPath: string) => DirectoryStorageTelemetry | null;
  refreshMeasurement?: (targetPath: string) => Promise<DirectoryStorageTelemetry>;
  defer?: (task: () => void) => void;
  measureCheckout?: (repoPath: string) => Promise<CheckoutStorageMeasurement>;
  measureDependencies?: (repoPath: string) => Promise<number | null>;
  readInput?: typeof readEstimateInput;
  readSetup?: (repoPath: string) => Promise<RepoSetupConfig | null>;
  detectInstall?: (repoPath: string) => Promise<string | null>;
  observeReuse?: typeof observeDependencyReuse;
}

async function directoryNames(base: string): Promise<string[]> {
  try {
    const entries = await readdir(base, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => path.join(base, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function observeRepoWorkspacePaths(repoPath: string): Promise<string[]> {
  const normalizedRepo = path.resolve(repoPath);
  const layout = resolveWorktreeRootLayout(normalizedRepo);
  const roots = [...layout.bases, path.join(normalizedRepo, '.claude', 'worktrees')];
  const nested = await Promise.all([...new Set(roots)].map(directoryNames));
  return [...new Set(nested.flat().map((candidate) => path.resolve(candidate)))].sort();
}

async function readRepoSetup(repoPath: string): Promise<RepoSetupConfig | null> {
  const { findRepoByLocalPath } = await import('@/lib/repos/registry');
  return (await findRepoByLocalPath(repoPath))?.setup ?? null;
}

function directDependencyCount(packageJson: string | null): number {
  if (!packageJson) return 0;
  const manifest = JSON.parse(packageJson) as Record<string, unknown>;
  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const dependencies = manifest[field];
    if (dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies)) {
      for (const name of Object.keys(dependencies)) names.add(name);
    }
  }
  return names.size;
}

async function coldDependencyBytes(
  repoPath: string,
  directCount: number,
  readInput: typeof readEstimateInput,
): Promise<number> {
  const lock = await readInput(repoPath, 'package-lock.json');
  if (lock) {
    const parsed = JSON.parse(lock) as { packages?: Record<string, unknown> };
    if (parsed.packages && typeof parsed.packages === 'object') {
      const packageCount = Object.keys(parsed.packages).filter((name) => name !== '').length;
      return Math.max(STARTUP_GROWTH_BYTES, packageCount * COLD_LOCKED_PACKAGE_BYTES);
    }
  }
  // Other lock formats do not expose unpacked byte sizes either. Keep a labelled,
  // direct-dependency estimate so a cold install can start without a fabricated 8 GiB floor.
  return Math.max(STARTUP_GROWTH_BYTES, directCount * COLD_DIRECT_PACKAGE_BYTES);
}

async function sourceInstallInputsMatch(
  repoPath: string,
  packageJson: string | null,
  readInput: typeof readEstimateInput,
): Promise<boolean> {
  if (packageJson !== await readEstimateInput(repoPath, 'package.json')) return false;
  for (const name of ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']) {
    const pinned = await readInput(repoPath, name);
    if (pinned === null) continue;
    // Binary lock decoding is not identity proof; use the labelled cold estimate.
    if (name === 'bun.lockb' || pinned !== await readEstimateInput(repoPath, name)) return false;
  }
  return true;
}

async function estimateRepo(
  repoPath: string,
  dependencies: RepoStorageEstimateDependencies,
): Promise<RepoStorageEstimate> {
  const baseCommit = dependencies.creationBaseCommit;
  if (baseCommit && !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(baseCommit)) {
    throw new Error('Workspace estimate requires an immutable creation commit.');
  }
  const readInput = dependencies.readInput ?? ((target: string, name: string) => (
    readEstimateInput(target, name, baseCommit)
  ));
  const [checkout, workspacePaths, setup, packageJson] = await Promise.all([
    dependencies.measureCheckout ? dependencies.measureCheckout(repoPath)
      : measureTrackedCheckout(repoPath, undefined, baseCommit),
    observeRepoWorkspacePaths(repoPath),
    (dependencies.readSetup ?? readRepoSetup)(repoPath),
    readInput(repoPath, 'package.json'),
  ]);
  const installCommand = setup
    ? setup.installOnCreateWorkspace ? setup.installCommand?.trim() : null
    : packageJson ? await (dependencies.detectInstall ?? ((target: string) => (
      detectDependencyInstallCommand(target, baseCommit ? {
        readPackage: async () => Buffer.from(packageJson),
        hasLockfile: async (name) => await readInput(target, name) !== null,
      } : undefined)
    )))(repoPath) : null;
  if (setup?.installOnCreateWorkspace && !installCommand) {
    throw new Error('Registered workspace setup has no required install command.');
  }
  let dependencyBytes = 0;
  let reuse: DependencyReuseEstimate | null = null;
  let error: string | null = null;
  if (installCommand) {
    const directCount = directDependencyCount(packageJson);
    const matchingInputs = !baseCommit || await sourceInstallInputsMatch(repoPath, packageJson, readInput)
      .catch(() => false);
    const measured = matchingInputs
      ? await (dependencies.measureDependencies ?? measureDependencyTree)(repoPath).catch(() => null)
      : null;
    const cold = await coldDependencyBytes(repoPath, directCount, readInput);
    dependencyBytes = Math.max(cold, measured ?? 0);
    if (measured === null || measured < cold) {
      error = 'Dependency growth is estimated from lock or manifest entries; installed bytes are not yet observed.';
    }
    if (baseCommit) {
      // An unavailable/changed donor keeps the native estimate. A successful
      // observation is not permission for a later native-install fallback.
      reuse = await (dependencies.observeReuse ?? observeDependencyReuse)(repoPath, baseCommit, installCommand).catch(() => null);
    }
  }
  // Checkout bytes and possible native dependency writes are charged once plus
  // proportional growth. Existing APFS/cache/worktree allocations are not added.
  // Image sharing is discounted only when the materializer can supply exact recipe authority.
  const nativeInstallEstimateBytes = Math.ceil((checkout.bytes + dependencyBytes) * WRITE_HEADROOM_RATIO)
    + STARTUP_GROWTH_BYTES;
  const cloneBytes = reuse ? Math.ceil((checkout.bytes + reuse.metadataBytes + reuse.nativeWriteBytes) * WRITE_HEADROOM_RATIO)
    + STARTUP_GROWTH_BYTES : nativeInstallEstimateBytes;
  const discounted = reuse !== null && cloneBytes < nativeInstallEstimateBytes;
  const exactBytes = discounted ? cloneBytes : nativeInstallEstimateBytes;
  if (!Number.isSafeInteger(exactBytes) || exactBytes <= 0) {
    throw new Error('Workspace growth estimate is outside the safe integer range.');
  }
  return {
    status: 'observed', exactBytes, source: discounted ? 'apfs-clone-growth' : 'source-size-fallback',
    historySamples: 0, workspacePaths, error: discounted
      ? 'APFS incremental growth is estimated from entry counts and native/startup headroom, not exact allocated blocks.' : error,
    ...(discounted ? { dependencyCloneContract: { creationBaseCommit: baseCommit!, recipeKey: reuse!.recipeKey,
      installCommand: installCommand!, dependencyBytes: reuse!.metadataBytes + reuse!.nativeWriteBytes }, nativeInstallEstimateBytes } : {}),
  };
}

export async function observeRepoStorageEstimate(
  repoPath: string,
  dependencies: RepoStorageEstimateDependencies = {},
): Promise<RepoStorageEstimate> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      estimateRepo(path.resolve(repoPath), dependencies),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Workspace growth measurement timed out.')), ESTIMATE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    return {
      status: 'unknown', exactBytes: null, source: 'unknown', historySamples: 0,
      workspacePaths: [], error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
