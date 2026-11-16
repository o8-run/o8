import { getSqlite } from '@/lib/db';

export interface LinkedWork {
  pullRequests: { total: number; open?: number; merged?: number; closed?: number };
  branches: number;
}
type Thread = { id: string; repoBranch?: string | null; repoPath?: string | null; githubOwner?: string | null; githubRepo?: string | null };
type Link = { threadId: string; repositoryId: number; pullRequestId: number; state: string | null; mergedAt: string | null; branch: string | null; repositoryName: string };

/** Same durable associations as conversation PR context, joined to the local mirror. */
export function lookupLinkedWork(threads: Thread[]): Map<string, LinkedWork | null> {
  const result = new Map<string, LinkedWork | null>(threads.map(thread => [thread.id, null]));
  if (!threads.length) return result;
  try {
    const rows = getSqlite().prepare(`
      SELECT DISTINCT c.thread_id AS threadId, c.repository_id AS repositoryId,
        c.pull_request_id AS pullRequestId, p.state, p.merged_at AS mergedAt,
        p.head_ref_name AS branch, c.repository_name AS repositoryName
      FROM conversation_pr_context c
      LEFT JOIN github_pull_requests p ON p.repository_id = c.repository_id
        AND p.pull_request_id = c.pull_request_id AND p.number = c.number
      WHERE c.thread_id IN (${threads.map(() => '?').join(',')})
    `).all(...threads.map(thread => thread.id)) as Link[];
    for (const thread of threads) {
      const links = rows.filter(row => row.threadId === thread.id);
      if (!links.length && !thread.repoBranch) continue;
      const pulls = new Map(links.map(link => [`${link.repositoryId}:${link.pullRequestId}`, link]));
      const branches = new Set(links.filter(link => link.branch).map(link => `${link.repositoryName.toLowerCase()}:${link.branch}`));
      if (thread.repoBranch) {
        const repository = thread.githubOwner && thread.githubRepo ? `${thread.githubOwner}/${thread.githubRepo}`.toLowerCase() : thread.repoPath ?? '';
        branches.add(`${repository}:${thread.repoBranch}`);
      }
      const known = [...pulls.values()].every(link => link.mergedAt || ['open', 'closed', 'merged'].includes(link.state?.toLowerCase() ?? ''));
      result.set(thread.id, {
        pullRequests: {
          total: pulls.size,
          ...(known ? {
            open: [...pulls.values()].filter(link => !link.mergedAt && link.state?.toLowerCase() === 'open').length,
            merged: [...pulls.values()].filter(link => link.mergedAt || link.state?.toLowerCase() === 'merged').length,
            closed: [...pulls.values()].filter(link => !link.mergedAt && link.state?.toLowerCase() === 'closed').length,
          } : {}),
        }, branches: branches.size,
      });
    }
  } catch {
    // Missing linkage storage must not hide otherwise available threads.
  }
  return result;
}
