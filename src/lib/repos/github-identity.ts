import { execFileSync } from '@/lib/providers/child-process';
import { isPathReachable } from '@/lib/fs/protected-folders';

export interface RepoGithubIdentity {
  githubOwner: string | null;
  githubRepo: string | null;
}

const EMPTY_IDENTITY: RepoGithubIdentity = {
  githubOwner: null,
  githubRepo: null,
};

const CACHE_TTL_MS = 5000;
const identityCache = new Map<string, { identity: RepoGithubIdentity; expiresAt: number }>();

function gitValue(repoPath: string, args: string[]): string | null {
  try {
    const value = execFileSync('git', ['-C', repoPath, ...args], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return value || null;
  } catch {
    return null;
  }
}

export function parseGithubRemoteIdentity(remoteUrl: unknown): RepoGithubIdentity {
  if (typeof remoteUrl !== 'string') return EMPTY_IDENTITY;
  const value = remoteUrl.trim();
  if (!value) return EMPTY_IDENTITY;

  const match = value.match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:[#?].*)?$/i);
  if (!match?.[1] || !match[2]) return EMPTY_IDENTITY;
  return {
    githubOwner: match[1],
    githubRepo: match[2],
  };
}

function upstreamRemoteName(repoPath: string): string | null {
  const upstream = gitValue(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const remoteName = upstream?.split('/')[0]?.trim();
  return remoteName || null;
}

function readGitRemoteUrl(repoPath: string): string | null {
  const origin = gitValue(repoPath, ['remote', 'get-url', 'origin']);
  if (origin) return origin;

  const upstream = upstreamRemoteName(repoPath);
  return upstream ? gitValue(repoPath, ['remote', 'get-url', upstream]) : null;
}

export function resolveRepoGithubIdentity(
  repoPath: unknown,
  remoteUrlFallback?: unknown,
): RepoGithubIdentity {
  const pathKey = typeof repoPath === 'string' ? repoPath.trim() : '';
  const fallbackKey = typeof remoteUrlFallback === 'string' ? remoteUrlFallback.trim() : '';
  const cacheKey = `${pathKey}\n${fallbackKey}`;
  const cached = identityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.identity;

  // A synchronous Git child on a folder behind a pending privacy prompt would
  // hold the event loop until its timeout; use the saved remote meanwhile.
  const reachable = !pathKey || isPathReachable(pathKey);
  const remoteUrl = pathKey && reachable ? readGitRemoteUrl(pathKey) : null;
  const remoteIdentity = parseGithubRemoteIdentity(remoteUrl);
  const fallbackIdentity = parseGithubRemoteIdentity(fallbackKey);
  const nextIdentity = remoteIdentity.githubOwner && remoteIdentity.githubRepo
    ? remoteIdentity
    : fallbackIdentity.githubOwner && fallbackIdentity.githubRepo
      ? fallbackIdentity
      : EMPTY_IDENTITY;
  if (reachable) identityCache.set(cacheKey, { identity: nextIdentity, expiresAt: Date.now() + CACHE_TTL_MS });
  return nextIdentity;
}
