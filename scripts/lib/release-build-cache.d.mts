export const RELEASE_BUILD_CACHE_SCHEMA: 'o8/release-build-cache-entry/v1';
export const RELEASE_BUILD_CACHE_RECEIPT_SCHEMA: 'o8/release-build-cache-receipt/v1';
export const RELEASE_BUILD_CACHE_PHASES: readonly ['web', 'speech', 'native'];

export type ReleaseBuildCachePhase = typeof RELEASE_BUILD_CACHE_PHASES[number];

export interface ReleaseBuildCacheIdentity {
  phase: ReleaseBuildCachePhase;
  compatibility: Record<string, unknown>;
  compatibilitySha256: string;
  source: { head: string; tree: string; worktreeClean: boolean };
  sourceSha256: string;
  entrySha256: string;
}

export interface ReleaseBuildCacheAction {
  phase: ReleaseBuildCachePhase;
  status: 'hit_exact' | 'hit_compatible' | 'miss' | 'bypass' | 'captured' | 'already_captured';
  reason: string;
  durationMs: number;
  entrySha256?: string;
  producerSourceSha256?: string;
  archiveBytes?: number;
  estimatedSavedMs?: number | null;
}

export function resolveReleaseBuildCacheRoot(
  env?: NodeJS.ProcessEnv,
  options?: { warn?: (line: string) => void },
): string;
export function isReleaseBuildCacheSafetyError(error: unknown): boolean;
export function collectReleaseBuildCacheIdentity(
  root: string,
  phase: ReleaseBuildCachePhase,
  options?: { env?: NodeJS.ProcessEnv; buildOptions?: Record<string, unknown>; compilerEnvironment?: Record<string, string> },
): ReleaseBuildCacheIdentity;
export function restoreReleaseBuildCache(
  root: string,
  phase: ReleaseBuildCachePhase,
  options?: {
    runId?: string;
    identity?: ReleaseBuildCacheIdentity;
    cacheRoot?: string;
    env?: NodeJS.ProcessEnv;
    buildOptions?: Record<string, unknown>;
  },
): Promise<ReleaseBuildCacheAction>;
export function captureReleaseBuildCache(
  root: string,
  phase: ReleaseBuildCachePhase,
  options?: {
    runId?: string;
    identity?: ReleaseBuildCacheIdentity;
    cacheRoot?: string;
    env?: NodeJS.ProcessEnv;
    buildOptions?: Record<string, unknown>;
    buildDurationMs?: number;
  },
): Promise<ReleaseBuildCacheAction>;
export function createReleaseBuildCacheRunId(): string;
export function writeReleaseBuildCachePhaseReceipt(
  cacheRoot: string,
  runId: string,
  receipt: { phase: ReleaseBuildCachePhase; restore?: ReleaseBuildCacheAction; buildDurationMs?: number; capture?: ReleaseBuildCacheAction },
): void;
export function finalizeReleaseBuildCacheReceipt(
  cacheRoot: string,
  runId: string,
  summary: {
    outcome: 'PASS' | 'FAIL';
    source: Record<string, unknown>;
    buildDurationMs: number;
  },
  options?: { projectRoot?: string },
): Promise<{ receipt: Record<string, unknown>; receiptPath: string }>;
export const releaseBuildCacheInternals: {
  PHASE_CONFIG: Record<ReleaseBuildCachePhase, unknown>;
  isReleaseBuildCacheJsonCandidate(name: string): boolean;
  isReleaseBuildCachePhaseReceiptName(name: string): boolean;
  assertOutsideProjectNodeModules(target: string, projectRoot: string): void;
  collectWebEnvironmentFiles(root: string): Array<{ path: string; sha256: string }>;
  normalizeArchivePath(value: string): string | null;
  pathAllowed(candidate: string, targets: string[], excludes: string[]): boolean;
  phaseConfig(phase: ReleaseBuildCachePhase, buildOptions?: Record<string, unknown>): {
    targets: string[];
    excludes: string[];
  };
  pruneCacheToBudget(
    cacheRoot: string,
    budgetBytes: number,
    projectRoot: string,
  ): { removedBytes: number; remainingBytes: number; removedEntries: number };
  sha256File(path: string): Promise<string>;
  stableJson(value: unknown): string;
};
