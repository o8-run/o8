import type { RepoReadiness } from '@/lib/repos/types';

/** A repository the workspace terminal knows about. It lives apart from
 * ./types so server modules (src/lib/desktop/*, reached from native API
 * routes and the CLI chat program) can name it without pulling the desktop
 * canvas and its icon shims into their type program. */
export interface RegisteredRepo {
  name: string;
  localPath: string;
  remoteUrl?: string;
  branch?: string | null;
  readiness?: RepoReadiness | null;
  registryRepoId?: string;
  isWorktree?: boolean;
  worktreeStatus?: string | null;
}
