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
  const { response } = await githubInstallationFetch(repo, `/repos/${repo}/pulls/${number}`, { cache: 'reload', signal: AbortSignal.timeout(HOST_TIMEOUT_MS) }, { authorization, share: false });
  if (!response.ok) throw new Error('Pull request state could not be read.');
  const pr = await response.json() as HostPull;
  if (!pr.head?.sha || !pr.node_id || !['open', 'closed'].includes(pr.state)) throw new Error('Pull request state was incomplete.');
  return pr;
}
// One host request timeout plus a margin before a confirmed absence can settle it.
const HOST_TIMEOUT_MS = 18_000;
const SETTLEMENT_WINDOW_MS = HOST_TIMEOUT_MS + 12_000;
function publicationResult(receipt: PublicationReceipt): PublicationReceipt {
  if (receipt.status === 'unknown') throw new PublicationUnknown(receipt);
  if (receipt.status === 'refused' || receipt.status === 'disabled') throw new PublicationRefused(receipt);
  return receipt;
}
async function reconcile(host: string, receipt: PublicationReceipt, authorization: GitHubInstallationAuthorization): Promise<PublicationReceipt> {
  let next: PublicationReceipt;
  try {
    const pr = await readPull(receipt.repo, receipt.number, authorization);
    next = { ...receipt, updatedAt: new Date().toISOString() };
    const elapsed = Date.now() - Date.parse(receipt.createdAt);
    if (pr.head.sha.toLowerCase() !== receipt.approvedSha.toLowerCase()) {
      next.status = 'refused'; next.reason = 'The pull request head changed. Return to review before publishing.';
    } else if (pr.merged === true || pr.merged_at) {
      if (!pr.merge_commit_sha) throw new Error('The merged commit could not be read.');
      next.status = 'merged'; next.mergedSha = pr.merge_commit_sha; next.reason = null;
    } else if (pr.state === 'closed') {
      next.status = 'refused'; next.reason = 'The pull request was closed without merging. Return to review.';
    } else if (receipt.method === 'queue' || receipt.action === 'enable-auto-merge' || receipt.status === 'queued') {
      const { response } = await githubInstallationFetch(receipt.repo, '/graphql', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
        body: JSON.stringify({ query: 'query PublicationState($id: ID!) { node(id: $id) { ... on PullRequest { headRefOid isInMergeQueue autoMergeRequest { enabledAt } } } }', variables: { id: pr.node_id } }),
      }, { authorization });
      const payload = await response.json() as { errors?: unknown[]; data?: { node?: { headRefOid?: string; isInMergeQueue?: boolean; autoMergeRequest?: unknown } } };
      const node = payload.data?.node;
      // An absent or partial GraphQL result is a failed read, not confirmed absence.
      if (!response.ok || payload.errors?.length || !node?.headRefOid || typeof node.isInMergeQueue !== 'boolean'
        || !Object.hasOwn(node, 'autoMergeRequest')) throw new Error('Publication state could not be read.');
      if (node.headRefOid.toLowerCase() !== receipt.approvedSha.toLowerCase()) {
        next.status = 'refused'; next.reason = 'The pull request head changed. Return to review before publishing.';
      } else if (node.isInMergeQueue) { next.status = 'queued'; next.reason = null; }
      else if (node.autoMergeRequest) { next.status = 'auto_merge_enabled'; next.reason = null; }
      else if (receipt.status !== 'unknown' || elapsed >= SETTLEMENT_WINDOW_MS) {
        next.status = receipt.status === 'auto_merge_enabled' ? 'disabled' : 'refused';
        next.reason = 'GitHub confirmed no queued or enabled auto-merge publication. Review before a new request.';
      }
    } else if (receipt.status === 'unknown' && elapsed >= SETTLEMENT_WINDOW_MS) {
      next.status = 'refused'; next.reason = 'The request window elapsed and GitHub confirmed this head is still open and unmerged. Review before a new request.';
    }
  } catch {
    // Failed reads preserve both the outcome and its evidence. They do not revoke a
    // known queue/auto-merge state, extend the reservation, or authorize a mutation.
    return publicationResult(receipt);
  }
  savePublication(host, next);
  return publicationResult(readPublication(host, receipt.repo, receipt.number)!);
}
function assertSameHead(receipt: PublicationReceipt, approvedSha: string): void {
  if (receipt.approvedSha.toLowerCase() !== approvedSha) throw new PublicationRefused({ ...receipt,
    reason: 'The publication intent belongs to a different head. Return to review before publishing.' });
}
function existingPublication(receipt: PublicationReceipt, action: PublicationReceipt['action']): PublicationReceipt {
  if (action === 'merge' && receipt.status === 'auto_merge_enabled') throw new PublicationRefused({ ...receipt,
    reason: 'Auto-merge is already enabled; an explicit merge was not sent. Disable auto-merge and review before requesting an explicit merge.' });
  return receipt;
}

/** All hosting publication entry points share gates, durable intent and host-enforced head matching. */
export async function publishGitHubPullRequest(repo: string, number: number, action: PublicationReceipt['action'], options: PublicationOptions): Promise<PublicationReceipt> {
  const approvedSha = options.expectedHeadSha?.toLowerCase();
  if (!approvedSha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(approvedSha)) throw new Error('An approved head SHA is required before publication.');
  const account = captureGitHubAccount();
  const authorization = await captureGitHubInstallationAuthorization(repo, account);
  const host = account.apiBaseUrl;
  const authorizationScope = githubCredentialScope(host, authorization.installation.id, authorization.token);
  const scope = JSON.stringify([host, authorization.installation.id, repo.toLowerCase()]);
  const previous = readPublication(host, repo, number);
  if (previous && !['refused', 'disabled'].includes(previous.status)) {
    const reconciled = await reconcile(host, previous, authorization);
    assertSameHead(reconciled, approvedSha);
    return existingPublication(reconciled, action);
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
    if (decision.pr.githubScope !== authorizationScope) throw new Error('GitHub authorization changed before publication.');
    if (decision.pr.mergeQueue === true) receipt.method = 'queue';
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
  receipt.createdAt = receipt.updatedAt = new Date().toISOString();
  receipt.status = 'unknown'; receipt.reason = 'Request reserved; host outcome not yet confirmed.';
  const claimed = claimPublication(host, receipt);
  if (claimed.id !== receipt.id) {
    assertSameHead(claimed, approvedSha);
    const reconciled = await reconcile(host, claimed, authorization);
    assertSameHead(reconciled, approvedSha);
    return existingPublication(reconciled, action);
  }
  try {
    const queue = decision.pr.mergeQueue === true;
    let response: Response;
    if (queue || action === 'enable-auto-merge') {
      const mutation = queue ? 'enqueuePullRequest' : 'enablePullRequestAutoMerge';
      const inputType = queue ? 'EnqueuePullRequestInput' : 'EnablePullRequestAutoMergeInput';
      const selection = queue ? 'mergeQueueEntry { id }' : 'pullRequest { id }';
      ({ response } = await githubInstallationFetch(repo, '/graphql', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
        body: JSON.stringify({ query: `mutation Publication($input: ${inputType}!) { ${mutation}(input: $input) { ${selection} } }`,
          variables: { input: { pullRequestId: pr.node_id, expectedHeadOid: approvedSha, ...(!queue ? { mergeMethod: method.toUpperCase() } : {}) } } }),
      }, { authorization }));
      const payload = await response.json() as { errors?: Array<{ type?: string }>; data?: Record<string, { mergeQueueEntry?: { id?: string }; pullRequest?: { id?: string } }> };
      if (response.ok && !payload.errors?.length && (queue ? payload.data?.[mutation]?.mergeQueueEntry?.id : payload.data?.[mutation]?.pullRequest?.id === pr.node_id)) {
        receipt.status = queue ? 'queued' : 'auto_merge_enabled';
      } else if (response.status >= 400 && response.status < 500
        || !payload.data?.[mutation] && payload.errors?.length && payload.errors.every(error => error.type === 'UNPROCESSABLE')) receipt.status = 'refused';
    } else {
      ({ response } = await githubInstallationFetch(repo, `/repos/${repo}/pulls/${number}/merge`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
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
