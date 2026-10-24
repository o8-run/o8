/**
 * Mobile diff fetch helper. Picks the right endpoint and returns a unified
 * diff body that `parseDiff()` (from `@/lib/llm/diff-parse`) can consume.
 *
 *  - Worktree (live agent / approval packet): GET /api/worktrees/diff
 *  - PR card: GET /api/panel/prs/:n?repo=:repo, then synthesize a unified
 *    diff from `pr.files[].patch`.
 *
 * All gated fetches include the meta[name="ws-token"] Bearer header so iOS
 * Safari PWA same-origin handling on LAN doesn't strip auth.
 */

export type MobileDiffSource =
  | { kind: 'worktree'; sessionKey?: string | null; worktreePath?: string | null; baseBranch?: string | null }
  | { kind: 'pr'; repo: string; number: number };

export interface MobileDiffPayload {
  rawDiff: string;
  additions: number;
  deletions: number;
  fileCount: number;
  error?: string;
}

import { getMobileGithubContext } from './github-cache';
import { githubItemQuery } from '@/lib/github-client/item-query';
import { getMobileWsToken } from '@/lib/mobile/ws-token-client';

function getWsToken(): string {
  return getMobileWsToken();
}

function authHeaders(): Record<string, string> {
  const token = getWsToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

interface PrFile {
  path: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string | null;
}

function synthesizePrDiff(files: PrFile[]): string {
  const out: string[] = [];
  for (const file of files) {
    if (!file.path) continue;
    const status = (file.status ?? 'modified').toLowerCase();
    const oldGitPath = status === 'added' ? '/dev/null' : `a/${file.path}`;
    const newGitPath = status === 'removed' || status === 'deleted' ? '/dev/null' : `b/${file.path}`;
    out.push(`diff --git ${oldGitPath} ${newGitPath}`);
    if (status === 'added') out.push('new file mode 100644');
    if (status === 'removed' || status === 'deleted') out.push('deleted file mode 100644');
    out.push(`--- ${oldGitPath}`);
    out.push(`+++ ${newGitPath}`);
    if (file.patch && file.patch.trim()) {
      out.push(file.patch.replace(/\r\n/g, '\n').replace(/\n+$/, ''));
    }
  }
  return out.join('\n');
}

async function fetchWorktreeDiff(
  source: Extract<MobileDiffSource, { kind: 'worktree' }>,
): Promise<MobileDiffPayload> {
  const params = new URLSearchParams();
  if (source.sessionKey) params.set('sessionKey', source.sessionKey);
  if (source.worktreePath) params.set('worktreePath', source.worktreePath);
  if (source.baseBranch) params.set('baseBranch', source.baseBranch);

  const response = await fetch(`/api/worktrees/diff?${params.toString()}`, {
    cache: 'no-store',
    headers: authHeaders(),
  });
  if (!response.ok) {
    return { rawDiff: '', additions: 0, deletions: 0, fileCount: 0, error: `HTTP ${response.status}` };
  }
  const data = await response.json() as {
    diff?: string;
    additions?: number;
    deletions?: number;
    fileCount?: number;
    error?: string;
  };
  return {
    rawDiff: typeof data.diff === 'string' ? data.diff : '',
    additions: data.additions ?? 0,
    deletions: data.deletions ?? 0,
    fileCount: data.fileCount ?? 0,
    error: data.error,
  };
}

async function fetchPrDiff(
  source: Extract<MobileDiffSource, { kind: 'pr' }>,
): Promise<MobileDiffPayload> {
  const context = getMobileGithubContext();
  const data = await context.client.fetchQuery(githubItemQuery<{
    pr?: { additions?: number; deletions?: number; changedFiles?: number; files?: PrFile[] }; error?: string;
  }>(source.repo, 'pr-files', source.number,
    `/api/panel/prs/${source.number}?repo=${encodeURIComponent(source.repo)}`, context));
  if (data.error) {
    return { rawDiff: '', additions: 0, deletions: 0, fileCount: 0, error: data.error };
  }
  const pr = data.pr;
  if (!pr?.files) {
    return { rawDiff: '', additions: 0, deletions: 0, fileCount: 0, error: 'No diff available' };
  }
  return {
    rawDiff: synthesizePrDiff(pr.files),
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    fileCount: pr.changedFiles ?? pr.files.length,
  };
}

export async function fetchMobileDiff(source: MobileDiffSource): Promise<MobileDiffPayload> {
  try {
    if (source.kind === 'worktree') return await fetchWorktreeDiff(source);
    return await fetchPrDiff(source);
  } catch (error) {
    return {
      rawDiff: '',
      additions: 0,
      deletions: 0,
      fileCount: 0,
      error: error instanceof Error ? error.message : 'Failed to load diff',
    };
  }
}
