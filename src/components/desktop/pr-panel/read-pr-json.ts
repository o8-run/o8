import type { QueryClient } from '@tanstack/react-query';
import { assertGithubScope, GithubReadDeferredError, recordGithubQuota } from '@/lib/github-client/refresh-policy';
import { githubQuotaDeadline } from '@/lib/github-client/quota-deadline';
/** A shared read can survive a tab switch, but must never pin Retry forever. */
export class PrReadDeferredError extends Error {
  constructor(message: string, readonly retryAfterMs: number) { super(message); }
}
export async function readPrJson<T>(url: string, signal?: AbortSignal, scope?: { client: QueryClient; repo: string; manual?: boolean }): Promise<T> {
  const controller = new AbortController();
  // Hot reload can compile this route on its first read; the installed app
  // has precompiled routes and keeps the shorter deadline.
  let timedOut = false;
  const interrupt = () => controller.abort();
  if (signal?.aborted) interrupt();
  else signal?.addEventListener('abort', interrupt, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, process.env.NODE_ENV === 'development' ? 60_000 : 25_000);
  try {
    if (scope) assertGithubScope(scope.client, scope.repo, scope.manual);
    const response = await fetch(url, { signal: controller.signal });
    const data = await response.json() as T & { error?: string };
    const deadline = githubQuotaDeadline(response);
    if (deadline !== null) {
      if (scope) recordGithubQuota(scope.client, scope.repo, deadline);
      throw new PrReadDeferredError(data.error || 'GitHub refresh is paused.', deadline - Date.now());
    }
    if (!response.ok) throw new Error(data.error || 'Pull request could not be read. Retry.');
    return data;
  } catch (error) {
    if (error instanceof GithubReadDeferredError) throw new PrReadDeferredError(error.message, error.retryAt - Date.now());
    if (timedOut) throw new Error('Pull request read timed out. Retry.');
    if (controller.signal.aborted || (error as { name?: string } | null)?.name === 'AbortError') throw new Error('Pull request read was interrupted. Retry.');
    throw error;
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', interrupt); }
}
