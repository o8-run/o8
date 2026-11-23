import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSqlite } from '@/lib/db';
import { updateGitHubThreadAttention, upsertGitHubIssue, upsertGitHubPullRequest } from '@/lib/github-broker/store';
import { GET } from './route';
import { listInboxItems } from '@/lib/supervisor/inbox';

const { listRepos } = vi.hoisted(() => ({ listRepos: vi.fn(async () => [
  { name: 'repo', localPath: '/workspace/repo', remoteUrl: 'https://github.com/example/repo.git' },
  { name: 'worktree', localPath: '/workspace/worktree', remoteUrl: 'git@github.com:example/repo.git' },
]) }));
vi.mock('@/lib/repos/registry', () => ({ listRepos }));
vi.mock('@/lib/intake/resolve-repo', () => {
  const resolveRepoPath = (repo: string) => repo === 'example/repo' ? '/workspace/repo' : null;
  return { resolveRepoPath, createRepoPathResolver: () => resolveRepoPath };
});

const recent = () => new Date(Date.now() - 30 * 60_000).toISOString();
function persistIssue(number: number, { repo = 'example/repo', state = 'open', labels = [] as string[], association = 'FIRST_TIME_CONTRIBUTOR', author = 'contributor' } = {}) {
  const at = recent();
  upsertGitHubIssue({ issueId: number, repoFullName: repo, number, title: `Discussion ${number}`, state, author: { login: author }, assignees: [{ login: author }], labels: labels.map((name) => ({ name, color: '000000' })), comments: 1, body: '', url: `https://github.com/${repo}/issues/${number}`, createdAt: at, updatedAt: at, closedAt: state === 'closed' ? at : null });
  updateGitHubThreadAttention({ repoFullName: repo, kind: 'issue', number, lastHumanCommentAuthorLogin: author, lastHumanCommentAuthorAssociation: association, lastHumanCommentAt: at, lastInsiderCommentAt: null });
}
const read = async (query = '?includeMaintainer=1&includeDismissed=1&scope=all') => (await GET(new Request(`http://localhost/api/panel/supervisor-inbox${query}`))).json();
beforeEach(() => {
  listRepos.mockClear();
  listInboxItems({ includeAllProjects: true, includeDismissed: true });
  const db = getSqlite();
  for (const table of ['supervisor_inbox', 'github_issues', 'github_pull_requests', 'github_sync_state']) db.prepare(`DELETE FROM ${table}`).run();
});
describe('maintainer inbox persisted route', () => {
  it('reads connected contributions and recent unanswered conversations through the existing API', async () => {
    persistIssue(1, { labels: ['status:claimed'] }); persistIssue(2, { association: 'MEMBER' }); persistIssue(3, { author: 'helper[bot]' }); persistIssue(4, { state: 'closed' }); persistIssue(5, { repo: 'unconnected/repo' });
    const at = recent();
    upsertGitHubPullRequest({ pullRequestId: 8, repoFullName: 'example/repo', number: 8, title: 'Add a plugin', state: 'open', author: { login: 'contributor' }, body: '', headRefName: 'plugin', baseRefName: 'main', additions: 12, deletions: 2, changedFiles: 1, reviewDecision: null, statusCheckRollup: [], url: 'https://github.com/example/repo/pull/8', createdAt: at, updatedAt: at, closedAt: null, mergedAt: null });
    const body = await read();
    expect(body.maintainer.contributions.map((item: { kind: string }) => item.kind).sort()).toEqual(['claim', 'pull_request']);
    expect(body.maintainer.replies.map((item: { number: number }) => item.number)).toEqual([1]);
    expect(body.maintainer.replies[0].repoPaths).toEqual(['/workspace/repo', '/workspace/worktree']);
    expect(body.maintainer.sources).toHaveLength(1);
    expect(body.maintainer.sources[0].stale).toBe(true);
    expect(getSqlite().prepare("SELECT COUNT(*) as n FROM supervisor_inbox WHERE kind = 'outside_human_waiting'").get()).toEqual({ n: 0 });
  });
  it('uses the persisted maintainer response to remove an unanswered conversation', async () => {
    persistIssue(1);
    expect((await read()).maintainer.replies).toHaveLength(1);
    updateGitHubThreadAttention({ repoFullName: 'example/repo', kind: 'issue', number: 1, lastHumanCommentAuthorLogin: 'contributor', lastHumanCommentAuthorAssociation: 'CONTRIBUTOR', lastHumanCommentAt: recent(), lastInsiderCommentAt: new Date().toISOString() });
    expect((await read()).maintainer.replies).toHaveLength(0);
  });
  it('returns UTC freshness and keeps a failed optional read from taking down agent incidents', async () => {
    const at = new Date().toISOString();
    const db = getSqlite();
    for (const resource of ['issues', 'pull_requests']) db.prepare('INSERT INTO github_sync_state (key, repo_full_name, resource, last_successful_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(`example/repo:${resource}`, 'example/repo', resource, at.replace('T', ' ').replace('Z', ''), at);
    expect((await read()).maintainer.sources[0]).toMatchObject({ lastSuccessfulAt: at, stale: false });
    listRepos.mockRejectedValueOnce(new Error('Registry unavailable'));
    const body = await read();
    expect(body.maintainer).toBeNull(); expect(body.maintainerError).toContain('unavailable'); expect(Array.isArray(body.items)).toBe(true);
    expect((await read('')).maintainer).toBeUndefined();
  });
  it('returns only the summary the activity dock reads, matching the full list', async () => {
    const db = getSqlite(); const at = new Date().toISOString();
    for (const [id, status] of [['a', 'human_required'], ['b', 'human_required'], ['c', 'pending'], ['d', 'dismissed']]) {
      db.prepare(`INSERT INTO supervisor_inbox (id, project_id, incident_key, repo_path, packet_id, kind, payload, created_at, last_seen_at, repeat_count, status)
        VALUES (?, 'default', ?, ?, NULL, 'session_lost', '{}', ?, ?, 1, ?)`).run(id, `incident-${id}`, `/workspace/repo-${id}`, at, at, status);
    }
    const summary = await read('?scope=all&summaryOnly=1');
    expect(Object.keys(summary)).toEqual(['summary']);
    expect(summary.summary).toEqual((await read('?scope=all')).summary);
    expect(summary.summary).toMatchObject({ humanRequired: 2, pending: 1, dismissed: 0, total: 3 });
  });
});
