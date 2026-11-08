import 'server-only';

import { createHash } from 'node:crypto';
import { listLanes } from '@/lib/lane/registry';
import { deriveWorkflowStage, describeWorkflowStage } from '@/lib/workflows/status';
import { PrMergeRefused, type PrMergeGate } from '@/lib/github-broker/pr-merge-gate';
import type { PullRequestListItem, PullRequestListPage } from '@/lib/github-broker/pull-request-list.types';
import { gitLabToken, resolveGitLabProject, type GitLabProject } from './detect';
import type { GitProvider, GitProviderDiscussion, GitProviderMergeMethod, GitProviderMergeOptions } from './types';

interface GitLabUser { username?: string | null; avatar_url?: string | null }
interface GitLabMergeRequest {
  iid: number; title: string; description?: string | null; state: 'opened' | 'closed' | 'merged' | 'locked';
  draft?: boolean; work_in_progress?: boolean; author?: GitLabUser | null; reviewers?: GitLabUser[] | null;
  source_branch: string; target_branch: string; source_project_id?: number; target_project_id?: number;
  created_at: string; updated_at: string; closed_at?: string | null; merged_at?: string | null; web_url: string;
  labels?: string[]; sha?: string | null; diff_refs?: { base_sha?: string | null; head_sha?: string | null } | null;
  has_conflicts?: boolean; detailed_merge_status?: string | null; merge_status?: string | null;
  merge_when_pipeline_succeeds?: boolean;
}
interface GitLabChange { old_path: string; new_path: string; new_file?: boolean; renamed_file?: boolean; deleted_file?: boolean; diff?: string | null }
interface GitLabPipeline { id: number; sha: string; status: string; web_url?: string | null }
interface GitLabNote {
  id: number; body?: string | null; author?: GitLabUser | null; created_at: string; system?: boolean; type?: string | null;
  position?: { new_path?: string | null; old_path?: string | null; new_line?: number | null; old_line?: number | null } | null;
}

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_NOTE_PAGES = 10;
const MERGE_METHODS: GitProviderMergeMethod[] = ['merge', 'squash'];

export class GitLabRequestError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403 || status === 404
      ? 'GitLab denied access to this project. Check the GitLab token for this host, then retry.'
      : `GitLab request failed (${status}).`);
    this.name = 'GitLabRequestError';
  }
}

function requireProject(repo: string): GitLabProject {
  const project = resolveGitLabProject(repo);
  if (!project) throw new Error('This repository is not on a configured GitLab host.');
  return project;
}

async function gitlab<T>(project: GitLabProject, path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}) {
  const token = await gitLabToken(project.baseUrl);
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetch(`${project.baseUrl}/api/v4/projects/${encodeURIComponent(project.path)}${path}`, {
    method: init.method ?? 'GET',
    headers: { Accept: 'application/json', ...(token ? { 'PRIVATE-TOKEN': token } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    // Never forward the token to a host the operator did not configure.
    redirect: 'error',
  });
  if (!response.ok) throw new GitLabRequestError(response.status);
  const nextPage = Number(response.headers.get('x-next-page') || 0);
  return { data: await response.json() as T, nextPage: Number.isSafeInteger(nextPage) && nextPage > 0 ? nextPage : null };
}

const prState = (state: GitLabMergeRequest['state']) => state === 'merged' ? 'merged' as const : state === 'opened' ? 'open' as const : 'closed' as const;
const isDraft = (mr: GitLabMergeRequest) => Boolean(mr.draft ?? mr.work_in_progress);
const sameProject = (mr: GitLabMergeRequest, project: GitLabProject) => mr.source_project_id !== undefined && mr.source_project_id === mr.target_project_id ? project.slug : null;
const mergeable = (mr: GitLabMergeRequest) => !mr.has_conflicts && (mr.detailed_merge_status ? mr.detailed_merge_status === 'mergeable' : mr.merge_status === 'can_be_merged');

/** GitLab pipeline status in the GitHub check-run vocabulary the panel buckets on. */
function pipelineCheck(pipeline: GitLabPipeline) {
  const finished: Record<string, string> = { success: 'success', failed: 'failure', canceled: 'cancelled', skipped: 'skipped' };
  const conclusion = finished[pipeline.status] ?? null;
  return { name: `pipeline #${pipeline.id}`, status: conclusion ? 'completed' : pipeline.status === 'running' ? 'in_progress' : 'queued', conclusion, url: pipeline.web_url ?? null };
}

function fileStats(diff: string) {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

async function listMergeRequests(repo: string, query: Parameters<GitProvider['listPullRequests']>[1]): Promise<PullRequestListPage> {
  const project = requireProject(repo);
  // GitLab's `closed` excludes merged requests; GitHub's includes them.
  const params = new URLSearchParams({
    state: query.state === 'open' ? 'opened' : 'all', page: String(query.page), per_page: '100',
    order_by: query.sort === 'newest' ? 'created_at' : 'updated_at', sort: query.sort === 'oldest' ? 'asc' : 'desc',
  });
  const { data, nextPage } = await gitlab<GitLabMergeRequest[]>(project, `/merge_requests?${params}`, { signal: query.signal });
  const rows = query.state === 'closed' ? data.filter((mr) => mr.state !== 'opened') : data;
  return {
    repo: project.slug,
    statsUnavailable: true,
    nextPage,
    prs: rows.map((mr): PullRequestListItem => ({
      number: mr.iid, title: mr.title, author: mr.author?.username ?? 'Unknown author', avatarUrl: mr.author?.avatar_url ?? null,
      additions: null, deletions: null, checks: null,
      requestedReviewers: mr.reviewers ? mr.reviewers.flatMap((reviewer) => reviewer.username ? [reviewer.username] : []) : null,
      state: prState(mr.state), draft: isDraft(mr), headRefName: mr.source_branch, baseRefName: mr.target_branch,
      updatedAt: mr.updated_at, headRepoFullName: sameProject(mr, project), url: mr.web_url, labels: mr.labels ?? [],
      createdAt: mr.created_at, reviewDecision: null,
      mergeable: mr.has_conflicts ? 'CONFLICTING' : mergeable(mr) ? 'MERGEABLE' : null,
    })),
  };
}

async function readMergeRequest(project: GitLabProject, iid: number) {
  const [{ data: mr }, pipelines] = await Promise.all([
    gitlab<GitLabMergeRequest & { changes?: GitLabChange[] }>(project, `/merge_requests/${iid}/changes`),
    gitlab<GitLabPipeline[]>(project, `/merge_requests/${iid}/pipelines`).then(({ data }) => data, () => null),
  ]);
  const files = (mr.changes ?? []).map((change) => ({
    path: change.new_path,
    previousPath: change.renamed_file ? change.old_path : null,
    status: change.new_file ? 'added' : change.deleted_file ? 'removed' : change.renamed_file ? 'renamed' : 'modified',
    ...fileStats(change.diff ?? ''),
    patch: change.diff || null,
  }));
  const headSha = mr.sha ?? mr.diff_refs?.head_sha ?? '';
  // The newest pipeline for the reviewed head is the merge-relevant one.
  const latest = pipelines?.find((pipeline) => pipeline.sha === headSha);
  return {
    number: mr.iid, title: mr.title, body: mr.description ?? '', state: prState(mr.state),
    author: mr.author?.username ?? 'Unknown author', avatarUrl: mr.author?.avatar_url ?? null, labels: mr.labels ?? [],
    requestedReviewers: (mr.reviewers ?? []).flatMap((reviewer) => reviewer.username ? [reviewer.username] : []),
    headRefName: mr.source_branch, baseRefName: mr.target_branch, headRepoFullName: sameProject(mr, project),
    headSha, baseSha: mr.diff_refs?.base_sha ?? '',
    additions: files.reduce((sum, file) => sum + file.additions, 0), deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    changedFiles: files.length, draft: isDraft(mr), autoMergeEnabled: Boolean(mr.merge_when_pipeline_succeeds),
    allowedMergeMethods: MERGE_METHODS, createdAt: mr.created_at, updatedAt: mr.updated_at,
    closedAt: mr.closed_at ?? null, mergedAt: mr.merged_at ?? null, mergeable: mergeable(mr), reviewDecision: null,
    statusCheckRollup: latest ? [pipelineCheck(latest)] : [], checksUnavailable: pipelines === null,
    url: mr.web_url, files,
  };
}
type GitLabDetail = Awaited<ReturnType<typeof readMergeRequest>>;

async function readNotes(project: GitLabProject, iid: number): Promise<GitProviderDiscussion> {
  const notes: GitLabNote[] = [];
  let page: number | null = 1;
  for (let read = 0; page && read < MAX_NOTE_PAGES; read += 1) {
    const result: { data: GitLabNote[]; nextPage: number | null } = await gitlab<GitLabNote[]>(project, `/merge_requests/${iid}/notes?${new URLSearchParams({ sort: 'asc', order_by: 'created_at', per_page: '100', page: String(page) })}`);
    notes.push(...result.data);
    page = result.nextPage;
  }
  const discussion: GitProviderDiscussion = { comments: [], issueComments: [], reviews: [], discussionIncomplete: page !== null };
  for (const note of notes) {
    if (note.system) continue;
    const author = note.author?.username ?? 'Unknown author';
    const position = note.type === 'DiffNote' ? note.position : null;
    const path = position?.new_path ?? position?.old_path;
    if (position && path) {
      const line = position.new_line ?? position.old_line ?? null;
      discussion.comments.push({ id: note.id, author, body: note.body ?? '', path, line, side: position.new_line != null ? 'RIGHT' : 'LEFT',
        createdAt: note.created_at, state: 'COMMENTED', diffHunk: '', inReplyTo: null });
    } else {
      discussion.issueComments.push({ id: note.id, body: note.body ?? '', user: author, created_at: note.created_at });
    }
  }
  return discussion;
}

/** o8's merge gate for GitLab: the same fresh, snapshot-bound decision the GitHub panel enforces. */
function assessGitLabMergeGate(project: GitLabProject, mr: GitLabDetail): PrMergeGate {
  const checks: PrMergeGate['checks'] = [];
  const add = (name: string, pass: boolean, detail: string) => { checks.push({ name, verdict: pass ? 'pass' : 'fail', detail }); };
  add('pr-identity', Boolean(mr.headSha && mr.baseSha && mr.baseRefName), 'Review an exact head and base before merging.');
  add('pr-state', mr.state === 'open' && !mr.mergedAt && !mr.draft, 'The merge request must be open and not a draft.');
  add('pr-mergeable', mr.mergeable, 'GitLab must confirm this merge request is mergeable.');
  const failedChecks = mr.statusCheckRollup.filter((check) => check.conclusion && check.conclusion !== 'success').length;
  const pendingChecks = mr.statusCheckRollup.filter((check) => !check.conclusion || check.status !== 'completed').length;
  add('pr-checks', !mr.checksUnavailable && failedChecks === 0 && pendingChecks === 0, 'Pipelines must be available, finished and successful.');
  const workflow = describeWorkflowStage({ prState: mr.state, failedChecks, pendingChecks, requestedChanges: 0 });
  add('pr-workflow', workflow.mergeAllowed, workflow.mergeDetail);
  // Packet membership is only resolvable for GitHub remotes, so fail closed for any lane on this branch.
  let lanesOnBranch: string[] | null = null;
  try { lanesOnBranch = listLanes().filter((lane) => lane.branch === mr.headRefName).map((lane) => lane.id).sort(); } catch { /* unavailable */ }
  add('packet-membership', lanesOnBranch !== null && lanesOnBranch.length === 0, lanesOnBranch === null
    ? 'Packet membership or runtime state is unavailable. Refresh before merging.'
    : 'A lane works on this branch. Use the governed packet merge path.');
  const snapshot = createHash('sha256').update(JSON.stringify({ repo: project.slug.toLowerCase(), number: mr.number, head: mr.headSha,
    base: mr.baseSha, baseRef: mr.baseRefName, headRef: mr.headRefName, state: mr.state, draft: mr.draft, mergedAt: mr.mergedAt,
    mergeable: mr.mergeable, checks: mr.statusCheckRollup, checksUnavailable: mr.checksUnavailable, lanes: lanesOnBranch, gates: checks })).digest('hex');
  return { repo: project.slug, number: mr.number, headSha: mr.headSha, baseSha: mr.baseSha, baseRefName: mr.baseRefName,
    allowed: checks.every((check) => check.verdict === 'pass'), autoMergeAllowed: checks.every((check) => check.verdict === 'pass'), snapshot, checks, packets: [] };
}

/** The `/api/panel/prs/[number]` body for a GitLab merge request, in the panel's PR shape. */
export async function readGitLabPanelDetail(repo: string, iid: number) {
  const project = requireProject(repo);
  const [mr, discussion] = await Promise.all([readMergeRequest(project, iid), readNotes(project, iid)]);
  const failedChecks = mr.statusCheckRollup.filter((check) => check.conclusion && check.conclusion !== 'success').length;
  const pendingChecks = mr.statusCheckRollup.filter((check) => !check.conclusion || check.status !== 'completed').length;
  return {
    ...mr,
    mergeGate: assessGitLabMergeGate(project, mr),
    discussionIncomplete: discussion.discussionIncomplete,
    resolvedRepo: project.slug,
    readiness: null,
    workflowStage: deriveWorkflowStage({ prState: mr.state, failedChecks, pendingChecks, requestedChanges: 0, readinessState: null }),
    reviewComments: discussion.comments,
    issueComments: discussion.issueComments,
    diffStat: mr.files.map((file) => `${file.path} | +${file.additions} -${file.deletions}`).join('\n'),
  };
}

async function mergeMergeRequest(repo: string, iid: number, { mergeMethod, expectedHeadSha, expectedMergeGate }: GitProviderMergeOptions) {
  const project = requireProject(repo);
  let mr: GitLabDetail;
  let gate: PrMergeGate;
  try {
    mr = await readMergeRequest(project, iid);
    gate = assessGitLabMergeGate(project, mr);
  } catch { throw new PrMergeRefused(null, false); }
  const changed = Boolean(expectedMergeGate && expectedMergeGate !== gate.snapshot) || expectedHeadSha !== mr.headSha;
  if (changed || !gate.allowed || !mr.allowedMergeMethods.includes(mergeMethod)) throw new PrMergeRefused(gate, changed);
  const squash = mergeMethod === 'squash';
  const { data } = await gitlab<{ state?: string }>(project, `/merge_requests/${iid}/merge`, { method: 'PUT', body: {
    sha: expectedHeadSha, squash, should_remove_source_branch: false,
    ...(squash && !mr.title.includes('[via-o8]') ? { squash_commit_message: `${mr.title} (!${iid}) [via-o8]` } : {}),
  } });
  if (data.state !== 'merged') throw new Error('GitLab did not confirm a merge.');
}

export const gitlabProvider: GitProvider = {
  kind: 'gitlab',
  listPullRequests: listMergeRequests,
  readDiscussion: (repo, iid) => readNotes(requireProject(repo), iid),
  comment: async (repo, iid, body) => { await gitlab(requireProject(repo), `/merge_requests/${iid}/notes`, { method: 'POST', body: { body } }); },
  merge: mergeMergeRequest,
};
