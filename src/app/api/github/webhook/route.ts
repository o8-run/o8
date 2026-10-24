import { after, NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { verifyGitHubWebhookSignature } from '@/lib/github-broker';
import { recordAutomationSourceEvent } from '@/lib/automations/source-events';
import { resolveRepoPath } from '@/lib/intake/resolve-repo';
import {
  markGitHubSyncSuccess,
  upsertGitHubInstallation,
  upsertGitHubIssue,
  upsertGitHubPullRequest,
  upsertGitHubRepository,
} from '@/lib/github-broker/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256');
  const event = request.headers.get('x-github-event');
  const deliveryId = request.headers.get('x-github-delivery');

  try {
    if (!verifyGitHubWebhookSignature(rawBody, signature)) {
      return NextResponse.json({ error: 'Invalid GitHub webhook signature.' }, { status: 401 });
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Webhook verification failed.' }, { status: 500 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // Signature-verified but malformed body — acknowledge instead of throwing
    // (an unhandled 500 makes GitHub retry the same malformed delivery).
    return NextResponse.json({ ok: true, ignored: 'malformed JSON body' });
  }
  const payload = parsed as {
    action?: string;
    installation?: {
      id?: number;
      account?: { login?: string; type?: string };
      target_type?: string;
      permissions?: Record<string, string>;
    };
    repository?: {
      id?: number;
      full_name?: string;
      name?: string;
      private?: boolean;
      default_branch?: string | null;
      owner?: { login?: string | null };
    };
    issue?: {
      id: number;
      number: number;
      title: string;
      state: string;
      body?: string | null;
      html_url: string;
      created_at: string;
      updated_at: string;
      closed_at?: string | null;
      comments?: number;
      user?: { login?: string | null } | null;
      assignees?: Array<{ login?: string | null }>;
      labels?: Array<{ name?: string | null; color?: string | null }>;
    };
    pull_request?: {
      id: number;
      number: number;
      title: string;
      state: string;
      body?: string | null;
      html_url: string;
      created_at: string;
      updated_at: string;
      closed_at?: string | null;
      merged_at?: string | null;
      additions?: number;
      deletions?: number;
      changed_files?: number;
      user?: { login?: string | null } | null;
      head?: { ref?: string | null };
      base?: { ref?: string | null };
    };
    check_run?: {
      id?: number;
      name?: string;
      status?: string;
      conclusion?: string | null;
      started_at?: string | null;
      completed_at?: string | null;
      pull_requests?: Array<{ number?: number }>;
    };
    check_suite?: {
      id?: number;
      status?: string;
      conclusion?: string | null;
      before_sha?: string;
      after_sha?: string;
      pull_requests?: Array<{ number?: number }>;
    };
  };
  const repoFullName = payload.repository?.full_name;

  if (!event || !repoFullName) {
    return NextResponse.json({ ok: true, ignored: true });
  }

  try {
    const repoParts = repoFullName.split('/');
    const installation = payload.installation;
    if (installation?.id) {
      upsertGitHubInstallation({
        installationId: installation.id,
        accountLogin: installation.account?.login ?? repoParts[0],
        accountType: installation.account?.type ?? null,
        targetType: installation.target_type ?? null,
        permissions: installation.permissions ?? null,
      });
    }

    if (payload.repository?.id) {
      upsertGitHubRepository({
        repoId: payload.repository.id,
        fullName: repoFullName,
        owner: payload.repository.owner?.login ?? repoParts[0] ?? '',
        name: payload.repository.name ?? repoParts[1] ?? repoFullName,
        private: Boolean(payload.repository.private),
        defaultBranch: payload.repository.default_branch ?? null,
        installationId: installation?.id ?? null,
        lastWebhookAt: new Date().toISOString(),
      });
    }

    if (['check_run', 'check_suite', 'status', 'workflow_run'].includes(event)) {
      const check = payload.check_run ?? payload.check_suite ?? {};
      const checkId = typeof check.id === 'number' ? check.id : null;
      recordAutomationSourceEvent({
        sourceKind: 'repository',
        sourceId: repoFullName,
        repoPath: resolveRepoPath(repoFullName),
        eventType: `${event}:${payload.action ?? 'updated'}`,
        fingerprint: `repository:${deliveryId ?? createHash('sha256').update(rawBody).digest('hex')}`,
        payload: {
          repository: repoFullName,
          deliveryId,
          event,
          action: payload.action ?? null,
          checkId,
          check,
        },
      });
    }

    if (event === 'issues') {
      const issue = payload.issue;
      if (issue) {
        upsertGitHubIssue({
          issueId: issue.id,
          repoFullName,
          number: issue.number,
          title: issue.title,
          state: issue.state,
          author: issue.user?.login ? { login: issue.user.login } : null,
          assignees: (issue.assignees ?? [])
            .map((assignee) => assignee.login ? { login: assignee.login } : null)
            .filter((assignee): assignee is { login: string } => Boolean(assignee)),
          labels: (issue.labels ?? [])
            .map((label) => label.name ? { name: label.name, color: label.color ?? '000000' } : null)
            .filter((label): label is { name: string; color: string } => Boolean(label)),
          comments: issue.comments ?? 0,
          body: issue.body ?? '',
          url: issue.html_url,
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          closedAt: issue.closed_at ?? null,
        });
        markGitHubSyncSuccess(repoFullName, 'issues', null);

        // Trigger intake pipeline when an issue is assigned
        if (payload.action === 'assigned' && issue.assignees && issue.assignees.length > 0) {
          void (async () => {
            try {
              const { resolveRepoPath } = await import('@/lib/intake/resolve-repo');
              const repoPath = resolveRepoPath(repoFullName);
              if (!repoPath) {
                console.log(`[github-intake] No local repo path for ${repoFullName}, skipping intake`);
                return;
              }
              const { processAssignedIssue } = await import('@/lib/intake/github-intake');
              await processAssignedIssue({
                issueId: issue.id,
                repoFullName,
                number: issue.number,
                title: issue.title,
                state: issue.state,
                author: issue.user?.login ? { login: issue.user.login } : null,
                assignees: (issue.assignees ?? [])
                  .map((a) => a.login ? { login: a.login } : null)
                  .filter((a): a is { login: string } => Boolean(a)),
                labels: (issue.labels ?? [])
                  .map((l) => l.name ? { name: l.name, color: l.color ?? '000000' } : null)
                  .filter((l): l is { name: string; color: string } => Boolean(l)),
                comments: issue.comments ?? 0,
                body: issue.body ?? '',
                url: issue.html_url,
                createdAt: issue.created_at,
                updatedAt: issue.updated_at,
                closedAt: issue.closed_at ?? null,
              }, repoFullName, repoPath);
            } catch (error) {
              console.error(`[github-intake] Failed for issue #${issue.number}: ${error instanceof Error ? error.message : String(error)}`);
            }
          })();
        }
      }
    } else if (event === 'pull_request') {
      const pr = payload.pull_request;
      if (pr) {
        upsertGitHubPullRequest({
          pullRequestId: pr.id,
          repositoryId: payload.repository?.id ?? null,
          repoFullName,
          number: pr.number,
          title: pr.title,
          state: pr.state,
          author: pr.user?.login ? { login: pr.user.login } : null,
          body: pr.body ?? '',
          headRefName: pr.head?.ref ?? '',
          baseRefName: pr.base?.ref ?? '',
          additions: pr.additions ?? 0,
          deletions: pr.deletions ?? 0,
          changedFiles: pr.changed_files ?? 0,
          reviewDecision: null,
          statusCheckRollup: [],
          url: pr.html_url,
          createdAt: pr.created_at,
          updatedAt: pr.updated_at,
          closedAt: pr.closed_at ?? null,
          mergedAt: pr.merged_at ?? null,
        });
        markGitHubSyncSuccess(repoFullName, 'pull_requests', null);
        const { enqueuePullRequestStackRefresh, drainPullRequestStackRefresh } = await import('@/lib/github-broker/pull-request-stack-refresh');
        enqueuePullRequestStackRefresh(repoFullName, pr.number);
        try { after(() => drainPullRequestStackRefresh()); }
        catch { /* Outside a live request context, the supervisor consumes the persisted intent. */ }
        recordAutomationSourceEvent({
          sourceKind: 'repository',
          sourceId: repoFullName,
          repoPath: resolveRepoPath(repoFullName),
          eventType: `pull_request:${payload.action ?? 'updated'}`,
          fingerprint: `repository:${deliveryId ?? createHash('sha256').update(rawBody).digest('hex')}`,
          occurredAt: Date.parse(pr.updated_at) || Date.now(),
          payload: {
            repository: repoFullName,
            deliveryId,
            action: payload.action ?? null,
            pullRequest: {
              number: pr.number,
              state: pr.state,
              head: pr.head?.ref ?? null,
              base: pr.base?.ref ?? null,
            },
          },
        });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Webhook sync failed.' }, { status: 500 });
  }
}
