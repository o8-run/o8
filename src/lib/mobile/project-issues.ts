import 'server-only';
import { githubInstallationFetch, type GitHubInstallationAuthorization } from '@/lib/github-broker/auth';

type Actor = { login?: string } | null;
interface Issue {
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
  state_reason?: string | null;
  body?: string | null;
  user?: Actor;
  created_at: string;
  updated_at: string;
  labels?: Array<string | { name: string }>;
  assignees?: Array<{ login: string }>;
  comments?: number;
  pull_request?: { merged_at?: string | null };
}
interface Comment {
  id: number;
  user?: Actor;
  body?: string | null;
  created_at: string;
}
interface TimelineEvent {
  id?: number;
  event: string;
  actor?: Actor;
  created_at?: string;
  label?: { name: string };
  assignee?: Actor;
  source?: { issue?: Issue };
}

export class MobileIssueReadError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

interface IssueSource {
  repo: string;
  authorization: GitHubInstallationAuthorization;
  signal: AbortSignal;
}

async function read<T>({ repo, authorization, signal }: IssueSource, suffix: string, expectedScope?: string) {
  const { response, scope } = await githubInstallationFetch(repo, '/repos/' + repo + '/issues' + suffix, { signal }, { authorization });
  if (expectedScope && expectedScope !== scope) throw new MobileIssueReadError(409, 'GitHub access changed. Refresh this issue.');
  if (!response.ok) {
    const status = [403, 404, 429].includes(response.status) ? response.status : 502;
    throw new MobileIssueReadError(status, status === 404 ? 'Issue or repository unavailable.' : 'GitHub could not return these issues.');
  }
  return { value: await response.json() as T, scope, hasNext: /rel="next"/.test(response.headers.get('link') ?? '') };
}

function summary(repo: string, issue: Issue) {
  return {
    repo, number: issue.number, title: issue.title, url: issue.html_url, state: issue.state,
    stateName: issue.state_reason === 'not_planned' ? 'Not planned' : issue.state === 'open' ? 'Open' : 'Closed',
    author: issue.user?.login ?? null, createdAt: issue.created_at, updatedAt: issue.updated_at,
    labels: (issue.labels ?? []).map(label => typeof label === 'string' ? label : label.name),
    assignees: (issue.assignees ?? []).map(person => person.login),
    commentCount: issue.comments ?? 0,
  };
}

export async function projectIssueList(source: IssueSource, state: string, page: number, query: string) {
  const { repo } = source;
  const issues = [];
  const needle = query.trim().toLowerCase();
  let nextPage = page;
  let hasNext = true;
  let scope: string | undefined;
  // GitHub's repository issues endpoint includes pull requests. An empty filtered page
  // may still have successors. Preserve the upstream cursor and bound each phone request.
  for (let count = 0; count < 3 && hasNext; count++) {
    const result = await read<Issue[]>(source, `?state=${state}&sort=updated&direction=desc&per_page=30&page=${nextPage}`, scope);
    scope = result.scope;
    const matches = result.value.filter(issue => !issue.pull_request
      && (!needle || `#${issue.number}\n${issue.title}\n${issue.body ?? ''}`.toLowerCase().includes(needle)));
    issues.push(...matches.map(issue => summary(repo, issue)));
    hasNext = result.hasNext;
    nextPage++;
    if (issues.length) break;
  }
  return { repo, issues, nextPage: hasNext ? nextPage : null, permissions: { create: false } };
}

async function issueComments(source: IssueSource, number: number, page: number, scope: string) {
  const result = await read<Comment[]>(source, `/${number}/comments?per_page=50&page=${page}`, scope);
  return { comments: result.value.map(comment => ({
    id: String(comment.id), anchorId: 'issuecomment-' + comment.id, body: comment.body ?? '',
    author: comment.user?.login ?? null, createdAt: comment.created_at,
  })), nextCursor: result.hasNext ? String(page + 1) : null };
}

export async function projectIssueDetail(source: IssueSource, repoPath: string, number: number, cursor: number | null) {
  const { repo } = source;
  const { value: issue, scope } = await read<Issue>(source, '/' + number);
  if (issue.number !== number) throw new MobileIssueReadError(409, 'Issue changed. Refresh this project.');
  if (issue.pull_request) return { kind: 'pull-request', repo, repoPath, number, url: issue.html_url,
    title: issue.title, body: issue.body ?? '', state: issue.pull_request.merged_at ? 'merged' : issue.state };
  if (cursor) return issueComments(source, number, cursor, scope);
  const [discussion, timeline] = await Promise.all([
    issueComments(source, number, 1, scope),
    read<TimelineEvent[]>(source, `/${number}/timeline?per_page=100`, scope).catch(cause => {
      if (cause instanceof MobileIssueReadError && (cause.status === 403 || cause.status === 404)) return null;
      throw cause;
    }),
  ]);
  const linked = new Map<number, { repo: string; number: number; title: string; url: string; state: string }>();
  const events = [];
  for (const event of timeline?.value ?? []) {
    if (event.event === 'cross-referenced') {
      const source = event.source?.issue;
      if (source?.pull_request && source.html_url?.toLowerCase() === `https://github.com/${repo}/pull/${source.number}`) {
        linked.set(source.number, { repo, number: source.number, title: source.title, url: source.html_url,
          state: source.pull_request.merged_at ? 'merged' : source.state });
      }
    } else if (event.id && event.created_at && event.event !== 'commented') {
      events.push({ id: String(event.id), kind: event.event, actor: event.actor?.login ?? null,
        detail: event.label?.name ?? event.assignee?.login ?? null, createdAt: event.created_at });
    }
  }
  return { kind: 'issue', issue: { ...summary(repo, issue), body: issue.body ?? '', comments: discussion.comments,
    commentsCursor: discussion.nextCursor, events, eventsIncomplete: timeline?.hasNext ?? true, linkedPullRequests: [...linked.values()],
    permissions: { comment: false, edit: false, labels: false, assignees: false }, states: [] } };
}
