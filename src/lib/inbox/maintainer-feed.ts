import { readIdleDrafts } from '@/lib/github-broker/idle-drafts';
import 'server-only';
import { listRepos } from '@/lib/repos/registry';
import { normalizeRepoSlug } from '@/lib/github-broker/repo';
import { listGitHubAttentionThreads, listGitHubIssues, listGitHubPullRequests, readGitHubSyncState } from '@/lib/github-broker/store';
import { findWaitingOutsiders } from '@/lib/supervisor/outsider-attention';
import type { MaintainerContribution, MaintainerFeed } from './maintainer-types';

/** Read connected mirrors and the existing paged PR summaries for idle-draft decisions. Missing or stale sync is visible, never a clean bill of health. */
export async function readMaintainerFeed(repoPaths?: string[]): Promise<MaintainerFeed> {
  const bySlug = new Map<string, string[]>();
  for (const entry of await listRepos()) {
    const slug = normalizeRepoSlug(entry.remoteUrl)?.toLowerCase();
    if (slug) bySlug.set(slug, [...(bySlug.get(slug) ?? []), entry.localPath]);
  }
  if (repoPaths) for (const [slug, paths] of bySlug) if (!paths.some((path) => repoPaths.includes(path))) bySlug.delete(slug);
  const contributions: MaintainerContribution[] = [];
  const sources: MaintainerFeed['sources'] = [];
  for (const [repo, repoPaths] of bySlug) {
    const syncs = ['issues', 'pull_requests'].map((resource) => readGitHubSyncState(repo, resource as 'issues' | 'pull_requests'));
    const successful = syncs.flatMap((sync) => sync?.lastSuccessfulAt ? [sync.lastSuccessfulAt.replace(' ', 'T') + (/Z$|[+-]\d{2}:?\d{2}$/.test(sync.lastSuccessfulAt) ? '' : 'Z')] : []);
    const lastSuccessfulAt = successful.length === 2 ? successful.sort()[0] : null;
    sources.push({ repo, repoPaths, lastSuccessfulAt, stale: !lastSuccessfulAt || Date.now() - Date.parse(lastSuccessfulAt) > 120_000 || syncs.some((sync) => Boolean(sync?.lastError) || Boolean(sync?.staleAt)) });
    for (const pull of listGitHubPullRequests(repo).filter((pull) => pull.state.toLowerCase() === 'open')) {
      contributions.push({ id: `github:${repo}:pr:${pull.number}`, kind: 'pull_request', repo, repoPaths, number: pull.number, title: pull.title, author: pull.author?.login ?? null, assignees: [], url: pull.url, createdAt: pull.createdAt, updatedAt: pull.updatedAt, headRefName: pull.headRefName, baseRefName: pull.baseRefName });
    }
    for (const issue of listGitHubIssues(repo).filter((issue) => issue.state.toLowerCase() === 'open' && issue.labels.some((label) => /^(?:claimed|status:claimed)$/i.test(label.name)))) {
      contributions.push({ id: `github:${repo}:issue:${issue.number}`, kind: 'claim', repo, repoPaths, number: issue.number, title: issue.title, author: issue.author?.login ?? null, assignees: issue.assignees.map((person) => person.login), url: issue.url, createdAt: issue.createdAt, updatedAt: issue.updatedAt });
    }
  }
  const idleDraftsUnavailable: string[] = [];
  let draftsTruncated = false;
  await Promise.all([...bySlug].map(async ([repo, repoPaths]) => {
    try {
      const page = await readIdleDrafts(repo);
      if (page.error) { idleDraftsUnavailable.push(repo); return; }
      draftsTruncated ||= page.nextPage !== null;
      for (const pr of page.drafts) {
        const id = `github:${repo}:pr:${pr.number}`;
        const item: MaintainerContribution = {
          id, kind: 'pull_request', repo, repoPaths, number: pr.number,
          title: `Idle draft · ${pr.ageDays}d · checks ${pr.checks ?? 'unknown'} · conflicts with main ${pr.conflictsWithMain === null ? 'unknown' : pr.conflictsWithMain ? 'yes' : 'no'} · Continue / Handoff / Close: ${pr.title}`,
          author: pr.author, assignees: [], url: pr.url, createdAt: pr.createdAt, updatedAt: pr.updatedAt,
          baseRefName: pr.baseRefName, headRefName: pr.headRefName, idleDraft: pr,
        };
        const index = contributions.findIndex(existing => existing.id === id);
        if (index === -1) contributions.push(item); else contributions[index] = item;
      }
    } catch { idleDraftsUnavailable.push(repo); }
  }));
  contributions.sort((a, b) => Number(Boolean(b.idleDraft)) - Number(Boolean(a.idleDraft)) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const attention = listGitHubAttentionThreads().filter((thread) => bySlug.has(thread.repo.toLowerCase()));
  const associationByThread = new Map(attention.map((thread) => [`${thread.repo.toLowerCase()}:${thread.kind}:${thread.number}`, thread.lastHumanCommentAuthorAssociation]));
  const replies = findWaitingOutsiders(attention, new Date(), 0).map((thread): MaintainerContribution => ({
    id: `github:${thread.repo.toLowerCase()}:${thread.kind}:${thread.number}:reply:${thread.waitingSince}`,
    kind: 'reply', repo: thread.repo.toLowerCase(), repoPaths: bySlug.get(thread.repo.toLowerCase())!, number: thread.number,
    title: thread.title, author: thread.waitingLogin, authorAssociation: associationByThread.get(`${thread.repo.toLowerCase()}:${thread.kind}:${thread.number}`), assignees: [], url: thread.url,
    createdAt: thread.waitingSince, updatedAt: thread.waitingSince, waitingSince: thread.waitingSince, threadKind: thread.kind,
  })).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { contributions: contributions.slice(0, 200), replies: replies.slice(0, 200), sources, truncated: draftsTruncated || contributions.length > 200, ...(idleDraftsUnavailable.length ? { idleDraftsUnavailable: idleDraftsUnavailable.sort() } : {}), repliesTruncated: replies.length > 200 };
}
