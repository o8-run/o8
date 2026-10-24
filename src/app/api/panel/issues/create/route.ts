export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createGitHubIssue, resolveRepoSlug } from '@/lib/github-broker';
import { captureGitHubAccount, captureGitHubInstallationAuthorization, GitHubAccountChangedError, requireGitHubAccount } from '@/lib/github-broker/auth';
import { GitHubIssueCreationRefusedError } from '@/lib/github-broker/actions';
import { bindIdempotencyClientMutation, deriveIdempotencyKey, withIdempotency } from '@/lib/orchestrator/idempotency-store';

const DEFAULT_REPO = process.env.GITHUB_REPO || process.env.CORTEX_IDE_REVIEW_REPO || '';
// Creation receipts are not refresh-cache entries: expiry must not authorize a
// second GitHub side effect. Keep them for the practical lifetime of this store.
const CREATION_RECEIPT_TTL_MS = Math.floor(Number.MAX_SAFE_INTEGER / 2);

export async function POST(request: Request) {
  const account = captureGitHubAccount();
  const body = await request.json();
  const { title, description, labels, repo, clientMutationId } = body as {
    title: string;
    description?: string;
    labels?: string[];
    repo?: string;
    clientMutationId?: string;
  };

  if (clientMutationId !== undefined && (typeof clientMutationId !== 'string'
    || !/^[a-zA-Z0-9_-]{1,200}$/.test(clientMutationId))) {
    return NextResponse.json({ ok: false, error: 'Invalid clientMutationId' }, { status: 400 });
  }

  if (!title?.trim()) {
    return NextResponse.json({ error: 'Title is required' }, { status: 400 });
  }

  const repoSlug = await resolveRepoSlug(repo || null, DEFAULT_REPO);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repoSlug)) {
    return NextResponse.json({ error: 'Invalid repo format' }, { status: 400 });
  }

  try {
    const authorization = await captureGitHubInstallationAuthorization(repoSlug, account);
    const input = {
      title: title.trim(),
      body: description?.trim() || '',
      labels: labels?.filter(Boolean) ?? [],
    };
    const create = async () => {
      const issue = await createGitHubIssue(repoSlug, input, authorization);
      return { ok: true, url: issue.url, number: issue.number, repo: repoSlug };
    };
    // Existing desktop callers remain compatible. Native retries supply the
    // same frozen key/body, including after a transport timeout or repo switch.
    if (!clientMutationId) {
      const result = await create();
      requireGitHubAccount(account);
      return NextResponse.json(result);
    }

    const scopeId = JSON.stringify([account.apiBaseUrl, repoSlug.toLowerCase()]);
    const binding = bindIdempotencyClientMutation({
      namespace: `github_issue_create:${scopeId}`, clientKey: clientMutationId,
      body: JSON.stringify({ accountId: account.owner, installationId: authorization.installation.id, input }), ttlMs: CREATION_RECEIPT_TTL_MS,
    });
    if (binding.status === 'conflict') {
      return NextResponse.json({ ok: false, error: 'clientMutationId belongs to another account or issue draft' }, { status: 409 });
    }
    if (binding.status === 'unavailable') {
      return NextResponse.json({ ok: false, error: 'Issue creation receipt store is unavailable' }, { status: 503 });
    }
    const outcome = await withIdempotency({
      key: deriveIdempotencyKey({ verb: 'github_issue_create', scopeId, clientKey: clientMutationId }),
      verb: 'github_issue_create', scopeId, ttlMs: CREATION_RECEIPT_TTL_MS, attachToInFlight: true,
    }, async () => {
      try { return await create(); } catch (error) {
        if (error instanceof GitHubIssueCreationRefusedError || error instanceof GitHubAccountChangedError) throw error;
        // A transport/5xx/storage error after attempting the POST cannot prove
        // GitHub did not commit. Persist this uncertainty instead of releasing
        // the key and authorizing a second side effect on retry.
        return { ok: false, repo: repoSlug, creationOutcomeUnknown: true,
          error: 'Creation outcome is unknown. Inspect GitHub before creating another issue.' };
      }
    });
    requireGitHubAccount(account);
    if (outcome.inProgress) {
      return NextResponse.json({ ok: false, inProgress: true,
        error: outcome.unresolved ? 'Prior creation outcome is unknown. Inspect GitHub before creating another issue.'
          : 'Issue creation is still in progress. Retry the same draft to recover its receipt.' },
      { status: outcome.unresolved ? 409 : 202 });
    }
    return NextResponse.json(outcome.result, { status: outcome.result.ok ? 200 : 409 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (err instanceof GitHubAccountChangedError) return NextResponse.json({ ok: false, error: message }, { status: 409 });
    const retryAfter = err instanceof GitHubIssueCreationRefusedError && err.retryAt
      ? Math.max(1, Math.ceil((err.retryAt - Date.now()) / 1000)) : null;
    return NextResponse.json({ error: message, ok: false,
      ...(clientMutationId && err instanceof GitHubIssueCreationRefusedError ? { creationRefused: true } : {}) },
    { status: retryAfter ? 429 : 500, ...(retryAfter ? { headers: { 'Retry-After': String(retryAfter) } } : {}) });
  }
}
