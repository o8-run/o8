import { execFileSync } from '@/lib/providers/child-process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

interface RemoteCacheEntry { paths: string[]; stamp: string; slug: string | null }
const remotes = new Map<string, RemoteCacheEntry>();
const systemPaths = new Map<string, string[] | null>();

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoPath, encoding: 'utf8', timeout: 3000, maxBuffer: 512 * 1024,
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readSlug(repoPath: string): string | null | undefined {
  try {
    const remote = git(repoPath, ['remote', 'get-url', 'origin']).trim();
    return remote.match(/[:/]([^/]+\/[^/.]+?)(?:\.git)?$/)?.[1]?.toLowerCase() ?? null;
  } catch (error) {
    // Exit 2 is Git's "no such remote": a definite answer the configuration
    // stamp covers, so it is cached like any slug. Other failures are not.
    return (error as { status?: unknown }).status === 2 ? null : undefined;
  }
}

function configPaths(repoPath: string, system = false): string[] | null {
  try {
    const fields = git(repoPath, ['config', ...(system ? ['--system'] : []), '--null', '--show-origin', '--list']).split('\0');
    if (fields.pop() !== '' || fields.length % 2 !== 0) return null;
    const paths = new Set<string>();
    for (let index = 0; index < fields.length; index += 2) {
      // Includes may reference absent files or depend on the current branch.
      // Keep those configurations on the uncached Git path.
      if (!fields[index].startsWith('file:') || /^include(?:if)?\./i.test(fields[index + 1])) return null;
      paths.add(resolve(repoPath, fields[index].slice(5)));
    }
    return [...paths];
  } catch {
    return null;
  }
}

function stamp(paths: string[]): string | null {
  try {
    return JSON.stringify(paths.map((path) => {
      try {
        const s = statSync(path, { bigint: true });
        return [path, s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [path, 'absent'];
        throw error;
      }
    }));
  } catch {
    return null;
  }
}

/** Reuse a lookup only while all supported Git configuration inputs are unchanged. */
export function getRemoteSlug(repoPath: string): string | null {
  const dotGit = join(repoPath, '.git');
  // Linked worktrees, external metadata, and config overrides retain Git's
  // original behavior. This fast path is only for ordinary registered roots.
  if (Object.keys(process.env).some((key) => /^GIT_(?:CONFIG|DIR$|COMMON_DIR$|WORK_TREE$|CEILING_DIRECTORIES$)/.test(key))) return readSlug(repoPath) ?? null;
  try { if (!statSync(dotGit).isDirectory()) return readSlug(repoPath) ?? null; }
  catch { return readSlug(repoPath) ?? null; }
  const environment = JSON.stringify([homedir(), process.env.XDG_CONFIG_HOME, process.env.PATH]);
  const key = `${environment}\n${repoPath}`;
  const cached = remotes.get(key);
  if (cached && stamp(cached.paths) === cached.stamp) return cached.slug;

  if (!systemPaths.has(environment)) {
    const paths = configPaths(repoPath, true);
    // An empty or missing system config has no observable origin path. Do not
    // cache when we cannot detect its later creation or replacement.
    if (systemPaths.size >= 8) systemPaths.clear();
    systemPaths.set(environment, paths?.length ? paths : null);
  }
  const system = systemPaths.get(environment);
  const configured = system ? configPaths(repoPath) : null;
  if (!system || !configured) return readSlug(repoPath) ?? null;
  const paths = [...new Set([
    ...system, ...configured, dotGit, join(dotGit, 'config'), join(dotGit, 'config.worktree'),
    join(homedir(), '.gitconfig'), join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'git', 'config'),
  ])];
  const before = stamp(paths);
  const slug = readSlug(repoPath);
  const afterConfig = configPaths(repoPath);
  if (slug !== undefined && before !== null && before === stamp(paths)
    && JSON.stringify(afterConfig) === JSON.stringify(configured)) {
    if (remotes.size >= 256) remotes.delete(remotes.keys().next().value!);
    remotes.set(key, { paths, stamp: before, slug });
  } else {
    remotes.delete(key);
  }
  return slug ?? null;
}
