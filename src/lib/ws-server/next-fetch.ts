/**
 * Next.js HTTP fetch helpers for the ws-server → Next API hop.
 *
 * ws-server reads sync state from the Next.js backend over loopback HTTP. This
 * module owns the origin resolution, retry/backoff, and JSON envelope handling.
 * Extracted faithfully from the ws-server monolith — no behavior change.
 *
 * The ws auth token is sourced from the same `getOrCreateWsToken()` the entry
 * uses and cached on first call (getOrCreateWsToken does a file read each time).
 */

import { getApiBase, getWsBase } from '@/lib/panel/api-port';
import type {
  RuntimeActionRequest,
  RuntimeActionResult,
  RuntimeLaunchRequest,
  RuntimeLaunchResult,
} from '@/lib/runtime/actions';
import { getOrCreateWsToken } from '@/lib/ws-auth';

/** Default per-request timeout (ms). Also used by the entry's fetchSync probe. */
export const FETCH_TIMEOUT_MS = 8_000;
const NEXT_FETCH_MAX_ATTEMPTS = 5;
const NEXT_FETCH_INITIAL_BACKOFF_MS = 100;
const RUNTIME_MUTATION_SETTLE_TIMEOUT_MS = 5 * 60_000;
const RUNTIME_MUTATION_REPLAY_DELAY_MS = 500;

const RETRYABLE_NEXT_FETCH_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
]);

let cachedWsToken: string | null = null;
function wsToken(): string {
  return (cachedWsToken ??= getOrCreateWsToken());
}

function getNextOrigin(): string {
  if (process.env.O8_NEXT_HTTP_OWNER === '1') return getWsBase().replace(/^ws:/, 'http:');
  return process.env.NEXT_ORIGIN ?? getApiBase();
}

export function buildNextUrl(pathname: string, searchParams?: URLSearchParams): string {
  const query = searchParams && searchParams.size > 0 ? `?${searchParams.toString()}` : '';
  return `${getNextOrigin()}${pathname}${query}`;
}

function getNextFetchErrorCode(error: Error): string | null {
  const cause = (error as Error & { cause?: unknown }).cause;
  if (!cause || typeof cause !== 'object') return null;
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function isRetryableNextFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return false;
  const code = getNextFetchErrorCode(error);
  return error.message === 'fetch failed' || (code !== null && RETRYABLE_NEXT_FETCH_CODES.has(code));
}

function delayNextFetchRetry(delayMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export async function fetchWithRetry(input: string, init: RequestInit): Promise<Response> {
  let backoffMs = NEXT_FETCH_INITIAL_BACKOFF_MS;

  for (let attempt = 1; attempt <= NEXT_FETCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (error) {
      if (attempt === NEXT_FETCH_MAX_ATTEMPTS || !isRetryableNextFetchError(error)) {
        throw error;
      }

      await delayNextFetchRetry(backoffMs);
      backoffMs *= 2;
    }
  }

  throw new Error('[ws-server] internal fetch retry loop exited unexpectedly');
}

export async function fetchNextJson<T>(
  pathname: string,
  options: {
    method?: 'GET' | 'POST' | 'DELETE';
    searchParams?: URLSearchParams;
    body?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${wsToken()}`,
  };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const url = buildNextUrl(pathname, options.searchParams);
  const init = {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS),
  };
  const response = process.env.O8_NEXT_HTTP_OWNER === '1'
    ? await fetchOwnedJsonResponse(url, init)
    : await fetchWithRetry(url, init);

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const record = payload && typeof payload === 'object'
      ? payload as { error?: unknown; note?: unknown }
      : null;
    const structuredError = record?.error && typeof record.error === 'object'
      ? (record.error as { message?: unknown }).message
      : record?.error;
    const error = typeof structuredError === 'string'
      ? structuredError
      : typeof record?.note === 'string'
        ? record.note
        : '';
    throw new Error(error || `${pathname} failed (${response.status})`);
  }

  return payload as T;
}

async function fetchOwnedJsonResponse(url: string, init: RequestInit): Promise<Response> {
  const [{ NextRequest }, { dispatchNativeHttp }] = await Promise.all([
    import('./native-http-request'), import('./native-http-routes'),
  ]);
  const signal = init.signal;
  signal?.throwIfAborted();
  return new Promise<Response>((resolve, reject) => {
    const abort = () => reject(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    dispatchNativeHttp(new NextRequest(url, { ...init, signal: signal ?? undefined })).then(resolve, reject)
      .finally(() => signal?.removeEventListener('abort', abort));
  });
}

function requireMutationReceipt<T>(pathname: string, payload: T): T {
  if (!payload || typeof payload !== 'object' || typeof (payload as { ok?: unknown }).ok !== 'boolean') {
    const error = new Error(`${pathname} returned an incomplete success receipt`);
    error.name = 'AmbiguousReceiptError';
    throw error;
  }
  return payload;
}

export async function fetchRuntimeAction(
  body: RuntimeActionRequest & { clientMutationId: string },
): Promise<RuntimeActionResult> {
  const startedAt = Date.now();
  while (true) {
    let result: RuntimeActionResult;
    try {
      result = requireMutationReceipt('/api/runtime/action', await fetchNextJson<RuntimeActionResult>('/api/runtime/action', {
        method: 'POST',
        body,
        timeoutMs: 8_000,
      }));
    } catch (error) {
      const ambiguousTransportFailure = error instanceof Error
        && (error.name === 'TimeoutError'
          || error.name === 'AmbiguousReceiptError'
          || isRetryableNextFetchError(error));
      if (!ambiguousTransportFailure || Date.now() - startedAt >= RUNTIME_MUTATION_SETTLE_TIMEOUT_MS) {
        throw error;
      }
      await delayNextFetchRetry(RUNTIME_MUTATION_REPLAY_DELAY_MS);
      continue;
    }
    if (!result.ok) {
      throw new Error(result.note || `Runtime ${body.action} failed`);
    }
    if (!result.inProgress) return result;
    if (Date.now() - startedAt >= RUNTIME_MUTATION_SETTLE_TIMEOUT_MS) {
      throw new Error(
        result.note || `Runtime ${body.action} is still in progress after five minutes`,
      );
    }
    await delayNextFetchRetry(RUNTIME_MUTATION_REPLAY_DELAY_MS);
  }
}

export async function fetchRuntimeLaunch(
  body: RuntimeLaunchRequest & { clientMutationId: string },
): Promise<RuntimeLaunchResult & { replayed?: boolean }> {
  const startedAt = Date.now();
  while (true) {
    let result: RuntimeLaunchResult & { inProgress?: boolean; replayed?: boolean };
    try {
      result = requireMutationReceipt('/api/runtime/launch', await fetchNextJson<RuntimeLaunchResult & { inProgress?: boolean; replayed?: boolean }>('/api/runtime/launch', {
        method: 'POST',
        body,
        timeoutMs: 15_000,
      }));
    } catch (error) {
      const ambiguousTransportFailure = error instanceof Error
        && (error.name === 'TimeoutError'
          || error.name === 'AmbiguousReceiptError'
          || isRetryableNextFetchError(error));
      if (!ambiguousTransportFailure || Date.now() - startedAt >= RUNTIME_MUTATION_SETTLE_TIMEOUT_MS) {
        throw error;
      }
      // The server may still be completing a launch after our owning request
      // times out. Replay the exact same mutation instead of returning control
      // to the supervisor, which would mint a fresh id for its next retry.
      await delayNextFetchRetry(RUNTIME_MUTATION_REPLAY_DELAY_MS);
      continue;
    }
    if (!result.ok) {
      throw new Error(result.note || `Runtime ${body.runtime} launch failed`);
    }
    if (!result.inProgress) {
      if (!result.surfaceId) {
        throw new Error(result.note || `Runtime ${body.runtime} launch returned no surface`);
      }
      return result;
    }
    if (Date.now() - startedAt >= RUNTIME_MUTATION_SETTLE_TIMEOUT_MS) {
      throw new Error(
        result.note || `Runtime ${body.runtime} launch is still in progress after five minutes`,
      );
    }
    await delayNextFetchRetry(RUNTIME_MUTATION_REPLAY_DELAY_MS);
  }
}
