import { createHash } from 'node:crypto';

export type GitHubReadPriority = 'interactive' | 'background';
export class GitHubRequestDeferredError extends Error {
  constructor(readonly retryAt: number, readonly reason: 'rate-limit' | 'interactive-reserve') {
    super(reason === 'rate-limit' ? 'GitHub asked o8 to wait before refreshing.' : 'Background refresh paused to leave GitHub capacity for your actions.');
  }
}
interface Budget { remaining?: number; limit?: number; resetAt: number; blockedUntil: number; failures: number }
const budgets = new Map<string, Budget>();
function saveBudget(key: string, value: Budget) {
  budgets.delete(key); if (budgets.size >= 128) budgets.delete(budgets.keys().next().value!); budgets.set(key, value);
}
export function githubCredentialScope(host: string, installation: number, token: string): string {
  return createHash('sha256').update(JSON.stringify([host, installation, token])).digest('hex');
}
const keyFor = (scope: string, resource: string) => `${scope}:${resource}`;
export function assertGitHubRequestBudget(scope: string, resource: string, priority: GitHubReadPriority, now = Date.now()): void {
  const state = budgets.get(keyFor(scope, resource));
  const blockedUntil = Math.max(state?.blockedUntil ?? 0, budgets.get(keyFor(scope, 'secondary'))?.blockedUntil ?? 0);
  if (blockedUntil > now) throw new GitHubRequestDeferredError(blockedUntil, 'rate-limit');
  if (!state || state.resetAt <= now) return;
  if (state.remaining === 0) throw new GitHubRequestDeferredError(state.resetAt, 'rate-limit');
  const reserve = Math.min(100, Math.max(5, Math.floor((state.limit ?? 5000) * 0.02)));
  if (priority === 'background' && state.remaining !== undefined && state.remaining <= reserve) throw new GitHubRequestDeferredError(state.resetAt, 'interactive-reserve');
}
export function observeGitHubRequestBudget(scope: string, resource: string, response: Response, now = Date.now(), secondaryLimited = false): void {
  const key = keyFor(scope, resource);
  const state: Budget = budgets.get(key) ?? { resetAt: 0, blockedUntil: 0, failures: 0 };
  const number = (name: string) => { const raw = response.headers.get(name); const value = raw !== null && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN; return Number.isFinite(value) ? value : undefined; };
  const remaining = number('x-ratelimit-remaining'); const reset = number('x-ratelimit-reset');
  state.limit = number('x-ratelimit-limit') ?? state.limit;
  if (remaining !== undefined) state.remaining = state.resetAt === (reset ?? 0) * 1000 ? Math.min(state.remaining ?? remaining, remaining) : remaining;
  if (reset !== undefined) state.resetAt = reset * 1000;
  if (remaining === 0 && state.resetAt <= now) state.resetAt = now + 60_000;
  const retry = response.headers.get('retry-after');
  const retryAt = retry ? /^\d+(?:\.\d+)?$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry) : 0;
  if (response.status === 429 || (response.status === 403 && (remaining === 0 || retry || secondaryLimited))) {
    state.failures += 1;
    state.blockedUntil = Math.max(Number.isFinite(retryAt) ? retryAt : 0, remaining === 0 ? state.resetAt : now + Math.min(15 * 60_000, 60_000 * 2 ** (state.failures - 1)));
    if (remaining !== 0) saveBudget(keyFor(scope, 'secondary'), { ...state });
  } else if (response.ok || response.status === 304) state.failures = 0;
  saveBudget(key, state);
}
