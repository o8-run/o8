import { fetchGitHubPullRequestDetail } from '@/lib/github-broker';
import { listPullRequestContext } from '@/lib/orchestrator/pull-request-context';

/** Only durable thread associations select repositories; caller parameters cannot widen this set. */
export async function mobileThreadPullRequests(threadIds: string[]) {
  const reads = new Map<string, ReturnType<typeof fetchGitHubPullRequestDetail>>();
  const rows = [];
  for (const threadId of [...new Set(threadIds)].sort()) {
    const seen = new Set<string>();
    let after = 0;
    do {
      const page = listPullRequestContext({ threadId }, { after, limit: 200 });
      for (const link of page.links) {
        const repository = link.repositoryFullName;
        const key = `${repository}#${link.number}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let read = reads.get(key);
        if (!read) {
          read = fetchGitHubPullRequestDetail(repository, link.number);
          reads.set(key, read);
        }
        const pr = await read;
        const checks = { passing: 0, failing: 0, pending: 0, failingNames: [] as string[] };
        for (const check of pr.statusCheckRollup) {
          const conclusion = check.conclusion?.toLowerCase();
          if (!conclusion || (check.status && check.status.toLowerCase() !== 'completed')) checks.pending++;
          else if (['success', 'neutral', 'skipped'].includes(conclusion)) checks.passing++;
          else { checks.failing++; checks.failingNames.push(check.name); }
        }
        checks.failingNames.sort();
        rows.push({ repository, number: pr.number, title: pr.title, state: pr.mergedAt ? 'merged' : pr.state.toLowerCase(),
          draft: pr.draft, ...(pr.inMergeQueue == null ? {} : { mergeQueueState: pr.inMergeQueue }),
          checks, threadId, updatedAt: pr.updatedAt ?? link.createdAt, changedFiles: pr.changedFiles });
      }
      if (page.nextCursor === null) break;
      after = page.nextCursor;
    } while (true);
  }
  return rows.sort((a, b) => a.repository.localeCompare(b.repository) || a.number - b.number || a.threadId.localeCompare(b.threadId));
}
