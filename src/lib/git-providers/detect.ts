import { normalizeRepoSlug } from '@/lib/github-broker/repo';

/** A GitLab instance the operator has configured. Only configured hosts are ever contacted. */
export interface GitLabHostConfig { baseUrl: string }

/** Supplies the access token for a configured GitLab instance, or null for anonymous public reads. */
export type GitLabTokenGetter = (baseUrl: string) => string | null | Promise<string | null>;

export interface GitLabProject {
  /** API origin, without a trailing slash, e.g. `https://gitlab.com`. */
  baseUrl: string;
  /** Full project path including nested groups, e.g. `group/sub/project`. */
  path: string;
  /** Host-qualified repository key used by the panel routes, e.g. `gitlab.com/group/project`. */
  slug: string;
}

export type DetectedGitProvider = { kind: 'github'; repo: string } | { kind: 'gitlab'; project: GitLabProject };

const DEFAULT_GITLAB_HOSTS: GitLabHostConfig[] = [{ baseUrl: 'https://gitlab.com' }];
let gitlabHosts: GitLabHostConfig[] = DEFAULT_GITLAB_HOSTS;
let gitlabToken: GitLabTokenGetter = () => null;

/**
 * Configures the GitLab instances and token source. The token is injected rather
 * than stored here; without one, GitLab is read anonymously (public projects only).
 */
export function configureGitLabProvider(options: { hosts?: GitLabHostConfig[]; token?: GitLabTokenGetter } = {}) {
  gitlabHosts = options.hosts ?? DEFAULT_GITLAB_HOSTS;
  gitlabToken = options.token ?? (() => null);
}

export function gitLabToken(baseUrl: string) {
  return gitlabToken(baseUrl);
}

const PATH_SEGMENT = /^[\w.-]+$/;

function projectPath(pathname: string): string | null {
  const path = pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  const segments = path.split('/');
  return segments.length >= 2 && segments.every((segment) => PATH_SEGMENT.test(segment) && segment !== '.' && segment !== '..') ? path : null;
}

function configuredHosts() {
  return gitlabHosts.flatMap((config) => {
    try {
      const url = new URL(config.baseUrl);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return [];
      return [{ baseUrl: url.origin, host: url.host.toLowerCase(), hostname: url.hostname.toLowerCase() }];
    } catch { return []; }
  });
}

/** Parses an `origin` URL (HTTPS, ssh:// or scp-style) against the configured GitLab hosts. */
export function gitLabProjectFromRemote(remoteUrl: string | null | undefined): GitLabProject | null {
  const remote = remoteUrl?.trim();
  if (!remote) return null;
  let host: string | null = null;
  let hostname: string;
  let pathname: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(remote);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    hostname = scp[1].toLowerCase();
    pathname = scp[2];
  } else {
    let url: URL;
    try { url = new URL(remote); } catch { return null; }
    if (!['https:', 'http:', 'ssh:', 'git+ssh:'].includes(url.protocol)) return null;
    hostname = url.hostname.toLowerCase();
    // An HTTP remote names the API origin exactly; an SSH port is never the web port.
    if (url.protocol === 'https:' || url.protocol === 'http:') host = url.host.toLowerCase();
    try { pathname = decodeURIComponent(url.pathname); } catch { return null; }
  }
  const match = configuredHosts().find((config) => host ? config.host === host : config.hostname === hostname);
  const path = match ? projectPath(pathname) : null;
  return match && path ? { baseUrl: match.baseUrl, path, slug: `${match.host}/${path}` } : null;
}

/** Resolves a host-qualified GitLab repository key from a panel request. GitHub `owner/name` keys never match. */
export function resolveGitLabProject(repo: string | null | undefined): GitLabProject | null {
  const value = repo?.trim();
  if (!value) return null;
  for (const config of configuredHosts()) {
    if (!value.toLowerCase().startsWith(`${config.host}/`)) continue;
    const path = projectPath(value.slice(config.host.length + 1));
    if (path) return { baseUrl: config.baseUrl, path, slug: `${config.host}/${path}` };
  }
  return null;
}

/** Chooses the provider for a project from its `origin` remote. */
export function detectGitProvider(remoteUrl: string | null | undefined): DetectedGitProvider | null {
  const github = normalizeRepoSlug(remoteUrl);
  if (github) return { kind: 'github', repo: github };
  const project = gitLabProjectFromRemote(remoteUrl);
  return project ? { kind: 'gitlab', project } : null;
}
