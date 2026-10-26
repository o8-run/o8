import type { RepoRegistryEntry } from '@/lib/repos/types';

const KEY = 'o8:recent-repo-folders';
export interface RecentRepoFolder { name: string; localPath: string }

export function recentRepoFolders(repos: RepoRegistryEntry[]): RecentRepoFolder[] {
  let saved: RecentRepoFolder[] = [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (Array.isArray(value)) saved = value.filter((row): row is RecentRepoFolder => (
      typeof row?.name === 'string' && typeof row?.localPath === 'string'
    ));
  } catch { /* Storage can be unavailable in a private window. */ }
  const registered = [...repos].sort((a, b) => (
    (b.lastOpenedAt ?? b.addedAt ?? '').localeCompare(a.lastOpenedAt ?? a.addedAt ?? '')
  ));
  return [...new Map([...saved, ...registered].map(row => [row.localPath, {
    name: row.name, localPath: row.localPath,
  }])).values()].slice(0, 8);
}

export function rememberRepoFolder(repo: RepoRegistryEntry) {
  try {
    localStorage.setItem(KEY, JSON.stringify([
      { name: repo.name, localPath: repo.localPath },
      ...recentRepoFolders([]).filter(row => row.localPath !== repo.localPath),
    ].slice(0, 8)));
  } catch { /* Opening a project must work without browser storage. */ }
}

export function isRepoUrl(value: string): boolean {
  return /^(?:https?:\/\/|ssh:\/\/|git:\/\/|[^\s/@]+@[^\s:]+:)/i.test(value.trim());
}

export function repoOpenError(error: unknown, cloning: boolean): string {
  const reason = error instanceof Error ? error.message : '';
  if (/fetch|network|load failed/i.test(reason)) return 'Could not reach o8. Check that it is running, then try again.';
  if (cloning && /destination.*(?:exists|different)/i.test(reason)) {
    return 'A folder with this name already exists. Choose its local folder or use another repository URL.';
  }
  if (cloning) {
    return 'Could not clone this repository. Check the URL, your network connection, and repository access, then try again.';
  }
  if (/Unable to update repository registry/i.test(reason)) return 'Could not save this folder. Check folder permissions, then try again.';
  if (/Home mode/i.test(reason)) return 'Choose a project folder inside your home folder.';
  return reason || 'Could not open this folder. Check that it exists and you can read it, then try again.';
}
