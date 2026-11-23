/**
 * Resolve a GitHub repo full name (e.g., "o8-run/o8") to a local
 * filesystem path using the canonical o8 data-dir repo registry.
 */

import 'server-only';

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { isPathReachable } from '@/lib/fs/protected-folders';
import { parseOriginUrl } from '@/lib/repos/remote';

interface RegisteredRepo { path: string; slug: string | null }
const origins = new Map<string, { stamp: string; url: string | null | undefined }>();

function slugOf(url: string | null | undefined): string | null {
  return url?.match(/[:/]([^/]+\/[^/.]+?)(?:\.git)?$/)?.[1]?.toLowerCase() ?? null;
}

/** The repository's origin read from its config file. Git is never started: a
 * server timer runs this, and a Git child of the packaged app can take seconds.
 * `undefined` means the file needs Git's own parser, so the saved remote stands. */
function readOrigin(root: string): string | null | undefined {
  try {
    let gitDir = join(root, '.git');
    if (statSync(gitDir).isFile()) {
      const pointer = readFileSync(gitDir, 'utf8').trim().match(/^gitdir: (.+)$/)?.[1];
      if (!pointer) return undefined;
      gitDir = resolve(root, pointer);
    }
    let configDir = gitDir;
    try { configDir = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim()); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined; }
    const config = join(configDir, 'config');
    const info = statSync(config, { bigint: true });
    const stamp = `${config}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    const cached = origins.get(root);
    if (cached?.stamp === stamp) return cached.url;
    const url = parseOriginUrl(readFileSync(config, 'utf8'));
    if (origins.size >= 256) origins.delete(origins.keys().next().value!);
    origins.set(root, { stamp, url });
    return url;
  } catch {
    return undefined;
  }
}

function registeredRepos(): RegisteredRepo[] {
  const registryPath = join(getDataDir(), 'repos.json');
  if (!existsSync(registryPath)) return [];
  const parsed = JSON.parse(readFileSync(registryPath, 'utf-8'));
  const repos: Array<{ localPath?: string; path?: string; remoteUrl?: string | null }> = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.repos) ? parsed.repos : [];
  const out: RegisteredRepo[] = [];
  for (const repo of repos) {
    const repoPath = repo.localPath ?? repo.path;
    if (!repoPath) continue;
    const path = resolve(repoPath.replace(/^~(?=\/|$)/, homedir()));
    // Behind a pending privacy prompt this check would stop the event loop.
    if (!isPathReachable(path) || !existsSync(path)) continue;
    const origin = readOrigin(path);
    out.push({ path, slug: slugOf(origin === undefined ? repo.remoteUrl : origin) });
  }
  return out;
}

/** One registry read for many lookups: each registered repository is resolved
 * once, not once per name looked up. */
export function createRepoPathResolver(): (repoFullName: string) => string | null {
  let repos: RegisteredRepo[] | null = null;
  return (repoFullName) => {
    try { repos ??= registeredRepos(); } catch { return null; }
    const target = repoFullName.toLowerCase();
    const name = target.split('/')[1];
    for (const repo of repos) {
      // Match by git remote, then fall back to the directory name.
      if (repo.slug === target || basename(repo.path).toLowerCase() === name) return repo.path;
    }
    return null;
  };
}

export function resolveRepoPath(repoFullName: string): string | null {
  return createRepoPathResolver()(repoFullName);
}
