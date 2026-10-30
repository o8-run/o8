export type RepoSetupEnvMode = 'copy' | 'symlink' | 'skip';

export const REPO_WORKSPACE_ISOLATION_PREFERENCES = [
  'auto',
  'git-worktree',
  'apfs-cow-clone',
] as const;

export type RepoWorkspaceIsolationPreference = typeof REPO_WORKSPACE_ISOLATION_PREFERENCES[number];

export function isRepoWorkspaceIsolationPreference(value: unknown): value is RepoWorkspaceIsolationPreference {
  return typeof value === 'string'
    && (REPO_WORKSPACE_ISOLATION_PREFERENCES as readonly string[]).includes(value);
}

// 'missing' (#1565) — the registered localPath no longer exists on disk
// (moved/deleted). First-class state so the rail can flag it at DETECTION
// time instead of the operator discovering it via a failed spawn.
export type RepoReadinessState = 'ready' | 'needs_setup' | 'blocked' | 'missing' | 'unknown';

export interface RepoReadiness {
  state: RepoReadinessState;
  label: string;
  summary: string;
  dispatchable?: boolean;
  nextAction?: string;
  failedCheck?: string;
  correctiveAction?: string;
  currentBranch: string | null;
  onDefaultBranch: boolean | null;
  originConfigured: boolean;
  dirty: boolean;
  missingEnvFiles: string[];
}

export interface RepoSetupConfig {
  envMode: RepoSetupEnvMode;
  envFiles: string[];
  installCommand: string | null;
  installOnCreateWorkspace: boolean;
  buildCommand: string | null;
  runBuildOnCreateWorkspace: boolean;
  devCommand: string | null;
  defaultPort: number | null;
  workspaceIsolationPreference: RepoWorkspaceIsolationPreference;
}

export type RepoWorkspaceManifestCache =
  | { version: 1; path: string; serviceNames: string[] }
  | { error: string };

export interface RepoRegistryEntry {
  id: string;
  name: string;
  localPath: string;
  remoteUrl: string | null;
  defaultBranch: string;
  isGitRepo?: boolean;
  addedAt: string;
  lastOpenedAt: string | null;
  /** Durable opt-out from global storage-pressure parking. Missing legacy values normalize to false. */
  storagePressureParkingDisabled: boolean;
  setup: RepoSetupConfig;
  manifest?: RepoWorkspaceManifestCache;
  readiness?: RepoReadiness;
}

export interface RepoRegistryStore {
  version: 1;
  repos: RepoRegistryEntry[];
}

export interface ValidatedRepoCandidate {
  name: string;
  localPath: string;
  remoteUrl: string | null;
  defaultBranch: string;
  isGitRepo?: boolean;
  setup: RepoSetupConfig;
}

export interface RepoRegistryDeleteBody {
  id: string;
}

export interface RepoRegistryValidateBody {
  action: 'validate';
  localPath: string;
}

export interface RepoRegistryAddBody {
  action?: 'add';
  localPath: string;
}

export interface RepoRegistryCloneBody {
  action: 'clone';
  cloneUrl: string;
  name?: string;
}

export interface RepoRegistryUpdateBody {
  action: 'update';
  id: string;
  localPath?: string;
  setup?: RepoSetupConfig;
  lastOpenedAt?: string | null;
  storagePressureParkingDisabled?: boolean;
}

export interface RepoRegistryTouchBody {
  action: 'touch';
  id: string;
  lastOpenedAt?: string | null;
}

export type RepoRegistryPostBody =
  | RepoRegistryValidateBody
  | RepoRegistryAddBody
  | RepoRegistryCloneBody
  | RepoRegistryUpdateBody
  | RepoRegistryTouchBody;
