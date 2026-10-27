import 'server-only';

import { githubInstallationFetch } from './auth';

async function parseGithubJson<T>(response: Response) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `GitHub request failed (${response.status})`);
  }
  return JSON.parse(text) as T;
}

export async function fetchGitHubCommits(repoFullName: string, limit = 15) {
  const { response } = await githubInstallationFetch(
    repoFullName,
    `/repos/${repoFullName}/commits?per_page=${Math.min(limit, 30)}`,
  );
  const commits = await parseGithubJson<Array<{
    sha?: string;
    commit?: { message?: string; committer?: { date?: string | null } | null };
  }>>(response);

  return commits.map((commit) => ({
    hash: (commit.sha ?? '').slice(0, 7),
    message: (commit.commit?.message ?? '').split('\n')[0],
    date: commit.commit?.committer?.date ?? '',
  }));
}

export async function fetchGitHubWorkflowRuns(repoFullName: string, limit = 15, fresh = false) {
  const { response } = await githubInstallationFetch(
    repoFullName,
    `/repos/${repoFullName}/actions/runs?per_page=${Math.min(limit, 30)}`,
    fresh ? { cache: 'reload' } : undefined,
  );
  const payload = await parseGithubJson<{
    workflow_runs?: Array<{
      id: number;
      display_title?: string | null;
      event?: string | null;
      head_branch?: string | null;
      head_sha?: string | null;
      status?: string | null;
      conclusion?: string | null;
      created_at?: string | null;
      updated_at?: string | null;
      name?: string | null;
      html_url?: string | null;
    }>;
  }>(response);

  return (payload.workflow_runs ?? []).map((run) => ({
    databaseId: run.id,
    displayTitle: run.display_title ?? '',
    event: run.event ?? '',
    headBranch: run.head_branch ?? '',
    headSha: run.head_sha ?? '',
    status: run.status ?? '',
    conclusion: run.conclusion ?? '',
    createdAt: run.created_at ?? '',
    updatedAt: run.updated_at ?? '',
    workflowName: run.name ?? '',
    url: run.html_url ?? '',
  }));
}

export async function fetchGitHubWorkflowRunDetail(repoFullName: string, runId: number) {
  const [runResponse, jobsResponse] = await Promise.all([
    githubInstallationFetch(repoFullName, `/repos/${repoFullName}/actions/runs/${runId}`),
    githubInstallationFetch(repoFullName, `/repos/${repoFullName}/actions/runs/${runId}/jobs?per_page=100`),
  ]);

  const run = await parseGithubJson<{
    id: number;
    display_title?: string | null;
    event?: string | null;
    head_branch?: string | null;
    head_sha?: string | null;
    status?: string | null;
    conclusion?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
    name?: string | null;
    html_url?: string | null;
    run_attempt?: number | null;
    pull_requests?: Array<{
      number?: number | null;
      html_url?: string | null;
      url?: string | null;
    }>;
  }>(runResponse.response);

  const jobsPayload = await parseGithubJson<{
    jobs?: Array<{
      id: number;
      name?: string | null;
      status?: string | null;
      conclusion?: string | null;
      started_at?: string | null;
      completed_at?: string | null;
      html_url?: string | null;
      check_run_url?: string | null;
      steps?: Array<{
        name?: string | null;
        status?: string | null;
        conclusion?: string | null;
        number?: number | null;
      }>;
    }>;
  }>(jobsResponse.response);

  const pullRequests = await resolveRelatedPullRequests(
    repoFullName,
    run.pull_requests ?? [],
    run.head_sha ?? null,
  );

  const annotationJobs = await Promise.all(
    (jobsPayload.jobs ?? []).map(async (job) => {
      const checkRunId = extractCheckRunId(job.check_run_url ?? null);
      const annotations = checkRunId
        ? await fetchCheckRunAnnotations(repoFullName, checkRunId).catch(() => [])
        : [];

      return {
        databaseId: job.id,
        name: job.name ?? '',
        status: job.status ?? '',
        conclusion: job.conclusion ?? '',
        startedAt: job.started_at ?? '',
        completedAt: job.completed_at ?? '',
        url: job.html_url ?? '',
        steps: (job.steps ?? []).map((step) => ({
          name: step.name ?? '',
          status: step.status ?? '',
          conclusion: step.conclusion ?? '',
          number: step.number ?? 0,
        })),
        checkRunId,
        annotations,
      };
    }),
  );

  const botComments = pullRequests.length > 0
    ? await fetchRelatedBotComments(
      repoFullName,
      pullRequests.map((pr) => pr.number),
    ).catch(() => [])
    : [];

  return {
    run: {
      databaseId: run.id,
      displayTitle: run.display_title ?? '',
      event: run.event ?? '',
      headBranch: run.head_branch ?? '',
      headSha: run.head_sha ?? '',
      status: run.status ?? '',
      conclusion: run.conclusion ?? '',
      createdAt: run.created_at ?? '',
      updatedAt: run.updated_at ?? '',
      workflowName: run.name ?? '',
      url: run.html_url ?? '',
      pullRequests,
      jobs: annotationJobs,
      annotations: annotationJobs.flatMap((job) => job.annotations.map((annotation) => ({
        ...annotation,
        jobName: job.name,
        jobUrl: job.url,
      }))),
      botComments,
    },
    logs: '',
  };
}

function extractCheckRunId(checkRunUrl: string | null) {
  if (!checkRunUrl) return null;
  const match = checkRunUrl.match(/\/check-runs\/(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

async function fetchCheckRunAnnotations(repoFullName: string, checkRunId: number) {
  const annotations: Array<{
    path: string;
    startLine: number;
    endLine: number;
    level: string;
    message: string;
    title: string;
    rawDetails: string;
    blobUrl: string;
  }> = [];

  for (let page = 1; page <= 3; page += 1) {
    const { response } = await githubInstallationFetch(
      repoFullName,
      `/repos/${repoFullName}/check-runs/${checkRunId}/annotations?per_page=100&page=${page}`,
    );
    const pageAnnotations = await parseGithubJson<Array<{
      path?: string | null;
      start_line?: number | null;
      end_line?: number | null;
      annotation_level?: string | null;
      message?: string | null;
      title?: string | null;
      raw_details?: string | null;
      blob_href?: string | null;
    }>>(response);

    annotations.push(
      ...pageAnnotations.map((annotation) => ({
        path: annotation.path ?? '',
        startLine: annotation.start_line ?? 0,
        endLine: annotation.end_line ?? annotation.start_line ?? 0,
        level: annotation.annotation_level ?? 'notice',
        message: annotation.message ?? '',
        title: annotation.title ?? '',
        rawDetails: annotation.raw_details ?? '',
        blobUrl: annotation.blob_href ?? '',
      })),
    );

    if (pageAnnotations.length < 100) break;
  }

  return annotations;
}

async function resolveRelatedPullRequests(
  repoFullName: string,
  embeddedPullRequests: Array<{ number?: number | null; html_url?: string | null; url?: string | null }>,
  headSha: string | null,
) {
  const embedded = embeddedPullRequests
    .map((pullRequest) => ({
      number: pullRequest.number ?? null,
      url: pullRequest.html_url ?? pullRequest.url ?? '',
    }))
    .filter((pullRequest): pullRequest is { number: number; url: string } => Number.isFinite(pullRequest.number));

  if (embedded.length > 0) {
    return embedded;
  }

  if (!headSha) {
    return [];
  }

  try {
    const { response } = await githubInstallationFetch(
      repoFullName,
      `/repos/${repoFullName}/commits/${headSha}/pulls?per_page=20`,
    );
    const prs = await parseGithubJson<Array<{
      number?: number | null;
      html_url?: string | null;
    }>>(response);

    return prs
      .map((pullRequest) => ({
        number: pullRequest.number ?? null,
        url: pullRequest.html_url ?? '',
      }))
      .filter((pullRequest): pullRequest is { number: number; url: string } => Number.isFinite(pullRequest.number));
  } catch {
    return [];
  }
}

function isBotActor(user?: { login?: string | null; type?: string | null } | null) {
  const login = (user?.login ?? '').toLowerCase();
  const type = (user?.type ?? '').toLowerCase();
  return type === 'bot' || login.endsWith('[bot]');
}

async function fetchRelatedBotComments(repoFullName: string, prNumbers: number[]) {
  const dedupe = new Map<string, {
    id: number;
    prNumber: number;
    kind: 'issue' | 'review';
    author: string;
    body: string;
    createdAt: string;
    path?: string;
    line?: number | null;
    url: string;
  }>();

  await Promise.all(
    prNumbers.slice(0, 3).map(async (prNumber) => {
      const [issueCommentsResponse, reviewCommentsResponse] = await Promise.all([
        githubInstallationFetch(repoFullName, `/repos/${repoFullName}/issues/${prNumber}/comments?per_page=100`),
        githubInstallationFetch(repoFullName, `/repos/${repoFullName}/pulls/${prNumber}/comments?per_page=100`),
      ]);

      const [issueComments, reviewComments] = await Promise.all([
        parseGithubJson<Array<{
          id: number;
          body?: string | null;
          created_at?: string | null;
          html_url?: string | null;
          user?: { login?: string | null; type?: string | null } | null;
        }>>(issueCommentsResponse.response),
        parseGithubJson<Array<{
          id: number;
          body?: string | null;
          created_at?: string | null;
          html_url?: string | null;
          path?: string | null;
          line?: number | null;
          user?: { login?: string | null; type?: string | null } | null;
        }>>(reviewCommentsResponse.response),
      ]);

      for (const comment of issueComments) {
        if (!isBotActor(comment.user) || !(comment.body ?? '').trim()) continue;
        dedupe.set(`issue:${comment.id}`, {
          id: comment.id,
          prNumber,
          kind: 'issue',
          author: comment.user?.login ?? 'unknown',
          body: comment.body ?? '',
          createdAt: comment.created_at ?? '',
          url: comment.html_url ?? '',
        });
      }

      for (const comment of reviewComments) {
        if (!isBotActor(comment.user) || !(comment.body ?? '').trim()) continue;
        dedupe.set(`review:${comment.id}`, {
          id: comment.id,
          prNumber,
          kind: 'review',
          author: comment.user?.login ?? 'unknown',
          body: comment.body ?? '',
          createdAt: comment.created_at ?? '',
          path: comment.path ?? undefined,
          line: comment.line ?? null,
          url: comment.html_url ?? '',
        });
      }
    }),
  );

  return [...dedupe.values()]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 12);
}
