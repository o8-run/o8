import 'server-only';
import { randomUUID } from 'node:crypto';
import { captureGitHubAccount, captureGitHubInstallationAuthorization, githubInstallationFetch, type GitHubInstallationAuthorization } from './auth';
import { githubCredentialScope } from './request-budget';
import { assertPrMergeAllowed, PrMergeRefused } from './pr-merge-gate';
import { claimPublication, readPublication, savePublication, recordPublicationRefusal, type PublicationReceipt } from './publication-store';

export class PublicationUnknown extends Error {
  constructor(readonly receipt: PublicationReceipt) { super('Publication outcome is unknown. Refresh to reconcile the actual pull request state; no second merge was sent.'); }
}
export class PublicationRefused extends Error {
  constructor(readonly receipt: PublicationReceipt) { super(receipt.reason ?? 'Publication refused. Return to review.'); }
}
export interface PublicationOptions {
  expectedHeadSha?: string;
  expectedMergeGate?: string;
  mergeMethod?: 'merge' | 'squash' | 'rebase';
  principal?: string;
  beforePublish?: () => Promise<void>;
}
type HostPull = { id: number; node_id: string; state: string; title?: string; merged?: boolean; merged_at?: string | null; merge_commit_sha?: string | null;
  head: { sha: string }; base: { ref: string; sha: string } };
async function readPull(repo: string, number: number, authorization: GitHubInstallationAuthorization) {
  const { response } = await githubInstallationFetch(repo, `/repos/${repo}/pulls/${number}`, { cache: 'reload', signal: AbortSignal.timeout(18_000) }, { authorization, share: false });
  if (!response.ok) throw new Error('Pull request state could not be read.');
  return await response.json() as HostPull;
}
async function reconcile(host: string, receipt: PublicationReceipt, authorization: GitHubInstallationAuthorization): Promise<PublicationReceipt> {
  // An open PR is not proof that an earlier request cannot still complete. Unknown
  // stays quarantined; reconciliation never issues another publication mutation.
  try {
    const pr = await readPull(receipt.repo, receipt.number, authorization);
    let status: PublicationReceipt['status'] = receipt.status === 'merged' ? 'merged' : 'unknown';
    let mergedSha = receipt.mergedSha;
    if (pr.head.sha !== receipt.approvedSha) {
      if (receipt.status !== 'unknown') status = 'refused';
    } else if ((pr.merged === true || pr.merged_at) && pr.merge_commit_sha) {
      status = 'merged'; mergedSha = pr.merge_commit_sha;
    } else if (receipt.action === 'enable-auto-merge' || receipt.status === 'unknown' || receipt.status === 'queued') {
      const { response } = await githubInstallationFetch(receipt.repo, '/graphql', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(18_000),
        body: JSON.stringify({ query: 'query PublicationState($id: ID!) { node(id: $id) { ... on PullRequest { headRefOid isInMergeQueue autoMergeRequest { enabledAt } } } }', variables: { id: pr.node_id } }),
      }, { authorization });
      const payload = await response.json() as { errors?: unknown[]; data?: { node?: { headRefOid?: string; isInMergeQueue?: boolean; autoMergeRequest?: unknown } } };
      const node = payload.data?.node;
      if (response.ok && !payload.errors?.length && node?.headRefOid === receipt.approvedSha) {
        if (node.isInMergeQueue) status = 'queued';
        else if (node.autoMergeRequest) status = 'auto_merge_enabled';
      }
    }
    const next = { ...receipt, status, mergedSha, reason: pr.head.sha !== receipt.approvedSha ? 'The pull request head changed. Return to review; the original publication remains unresolved.' : receipt.reason, updatedAt: new Date().toISOString() };
    savePublication(host, next);
    const saved = readPublication(host, receipt.repo, receipt.number)!;
    if (saved.status === 'merged') return saved;
    if (status === 'unknown') throw new PublicationUnknown(next);
    if (status === 'refused') throw new PublicationRefused(next);
    return next;
  } catch (error) {
    if (error instanceof PublicationUnknown) throw error;
    if (receipt.status !== 'unknown') throw error;
    throw new PublicationUnknown(receipt);
  }
}

/** All hosting publication entry points share gates, durable intent and host-enforced head matching. */
export async function publishGitHubPullRequest(repo: string, number: number, action: PublicationReceipt['action'], options: PublicationOptions): Promise<PublicationReceipt> {
  const approvedSha = options.expectedHeadSha;
  if (!approvedSha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(approvedSha)) throw new Error('An approved head SHA is required before publication.');
  const account = captureGitHubAccount();
  const authorization = await captureGitHubInstallationAuthorization(repo, account);
  const host = account.apiBaseUrl;
  const scope = githubCredentialScope(host, authorization.installation.id, authorization.token);
  const previous = readPublication(host, repo, number);
  if (previous && !['refused', 'disabled'].includes(previous.status)) {
    const reconciled = await reconcile(host, previous, authorization);
    if (previous.approvedSha !== approvedSha) throw new Error('The approved head changed. Return to review before publishing.');
    return reconciled;
  }
  const method = options.mergeMethod ?? 'squash';
  if (!['merge', 'squash', 'rebase'].includes(method)) throw new Error('A supported merge method is required.');
  const now = new Date().toISOString();
  const receipt: PublicationReceipt = { id: randomUUID(), repo, number, approvedSha, mergedSha: null, baseSha: null, baseRef: null,
    method, action, authorizingPrincipal: options.principal ?? 'unknown', scope, status: 'refused', checks: null, reason: null, createdAt: now, updatedAt: now };
  let decision: Awaited<ReturnType<typeof assertPrMergeAllowed>>;
  try {
    await options.beforePublish?.();
    decision = await assertPrMergeAllowed(repo, number, approvedSha, method, options.expectedMergeGate, action);
    if (decision.pr.githubScope !== scope) throw new Error('GitHub authorization changed before publication.');
    receipt.baseSha = decision.pr.baseSha; receipt.baseRef = decision.pr.baseRefName;
    receipt.checks = { gates: decision.gate.checks, runs: decision.pr.statusCheckRollup, required: decision.pr.requiredChecks, statuses: decision.pr.requiredStatuses };
  } catch (error) {
    if (error instanceof PrMergeRefused) receipt.checks = error.gate?.checks ?? null;
    receipt.reason = error instanceof Error ? error.message : 'Publication gates unavailable.';
    // Refusals are audit events; never overwrite another request's active intent.
    recordPublicationRefusal(receipt);
    throw error;
  }
  const pr = await readPull(repo, number, authorization);
  if (pr.head.sha !== approvedSha || pr.base.sha !== receipt.baseSha || pr.base.ref !== receipt.baseRef) {
    receipt.reason = 'The approved head or base changed. Return to review before publication.';
    recordPublicationRefusal(receipt);
    throw new PrMergeRefused(decision.gate, true);
  }
  receipt.status = 'unknown'; receipt.reason = 'Request reserved; host outcome not yet confirmed.';
  const claimed = claimPublication(host, receipt);
  if (claimed.id !== receipt.id) return reconcile(host, claimed, authorization);
  try {
    const queue = decision.pr.mergeQueue === true;
    let response: Response;
    if (queue || action === 'enable-auto-merge') {
      const mutation = queue ? 'enqueuePullRequest' : 'enablePullRequestAutoMerge';
      const inputType = queue ? 'EnqueuePullRequestInput' : 'EnablePullRequestAutoMergeInput';
      const selection = queue ? 'mergeQueueEntry { id }' : 'pullRequest { id }';
      ({ response } = await githubInstallationFetch(repo, '/graphql', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(18_000),
        body: JSON.stringify({ query: `mutation Publication($input: ${inputType}!) { ${mutation}(input: $input) { ${selection} } }`,
          variables: { input: { pullRequestId: pr.node_id, expectedHeadOid: approvedSha, ...(!queue ? { mergeMethod: method.toUpperCase() } : {}) } } }),
      }, { authorization }));
      const payload = await response.json() as { errors?: unknown[]; data?: Record<string, { mergeQueueEntry?: { id?: string }; pullRequest?: { id?: string } }> };
      if (response.ok && !payload.errors?.length && (queue ? payload.data?.[mutation]?.mergeQueueEntry?.id : payload.data?.[mutation]?.pullRequest?.id === pr.node_id)) {
        receipt.status = queue ? 'queued' : 'auto_merge_enabled';
      } else if (response.status >= 400 && response.status < 500) receipt.status = 'refused';
    } else {
      ({ response } = await githubInstallationFetch(repo, `/repos/${repo}/pulls/${number}/merge`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(18_000),
        body: JSON.stringify({ sha: approvedSha, merge_method: method,
          ...(method === 'squash' && pr.title && !pr.title.includes('[via-o8]') ? { commit_title: `${pr.title} (#${number}) [via-o8]` } : {}) }),
      }, { authorization }));
      const payload = await response.json() as { merged?: boolean; sha?: string };
      if (response.ok && payload.merged === true && payload.sha) { receipt.status = 'merged'; receipt.mergedSha = payload.sha; }
      else if (response.status >= 400 && response.status < 500 || response.ok && payload.merged === false) receipt.status = 'refused';
    }
  } catch { /* The durable reservation remains unknown across transport and parse failures. */ }
  receipt.updatedAt = new Date().toISOString();
  receipt.reason = receipt.status === 'unknown' ? 'Host response was not confirmed; reconcile before any retry.' : receipt.status === 'refused' ? 'The host refused publication. The head may have changed; refresh and return to review.' : null;
  savePublication(host, receipt);
  const saved = readPublication(host, repo, number)!;
  if (saved.status === 'unknown') throw new PublicationUnknown(saved);
  if (saved.status === 'refused') throw new PublicationRefused(saved);
  if (saved.status === 'queued' || saved.status === 'auto_merge_enabled') return reconcile(host, saved, authorization).catch(error => { if (error instanceof PublicationRefused || error instanceof PublicationUnknown) throw error; return saved; });
  return saved;
}

/** A confirmed disable settles a known enable; it cannot clear an unknown request. */
export function recordGitHubAutoMergeDisabled(host: string, repo: string, number: number): void {
  const receipt = readPublication(host, repo, number);
  if (receipt?.status !== 'auto_merge_enabled') return;
  savePublication(host, { ...receipt, status: 'disabled', reason: 'GitHub confirmed auto-merge was disabled.', updatedAt: new Date().toISOString() });
}
