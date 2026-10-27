'use client';

const INSTALL_FLAG = '__o8LongLivedFetchBudgetInstalled';
const ORIGINAL_FETCH = '__o8OriginalFetchForLongLivedBudget';
const MAX_LONG_LIVED_REQUESTS = 4;
const TRACKED_INIT = Symbol.for('o8.longLivedFetchBudgetTracked');

type BudgetWindow = Window & {
  [INSTALL_FLAG]?: boolean;
  [ORIGINAL_FETCH]?: typeof fetch;
};

type BudgetedRequestInit = RequestInit & {
  [TRACKED_INIT]?: boolean;
};

interface ActiveHolder {
  id: number;
  label: string;
  startedAt: number;
}

const activeHolders = new Map<number, ActiveHolder>();
let nextHolderId = 1;

function sameAppOrigin(input: RequestInfo | URL): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const url = typeof Request !== 'undefined' && input instanceof Request
      ? new URL(input.url)
      : new URL(String(input), window.location.href);
    return url.origin === window.location.origin;
  } catch {
    return false;
  }
}

function requestLabel(input: RequestInfo | URL, init?: RequestInit): string {
  const method = init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET');
  try {
    const url = typeof Request !== 'undefined' && input instanceof Request
      ? new URL(input.url)
      : new URL(String(input), window.location.href);
    return `${method.toUpperCase()} ${url.pathname}`;
  } catch {
    return `${method.toUpperCase()} ${String(input)}`;
  }
}

function acquireHolder(label: string): () => void {
  const id = nextHolderId;
  nextHolderId += 1;
  activeHolders.set(id, { id, label, startedAt: Date.now() });

  if (activeHolders.size > MAX_LONG_LIVED_REQUESTS) {
    console.error('[conn-budget] long-lived app-origin request budget exceeded', {
      count: activeHolders.size,
      limit: MAX_LONG_LIVED_REQUESTS,
      holders: Array.from(activeHolders.values()).map((holder) => holder.label),
    });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeHolders.delete(id);
  };
}

function noopRelease(): void {}

function wrapsLongLivedBody(response: Response): boolean {
  return response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') === true;
}

function wrapResponseBody(response: Response, release: () => void): Response {
  if (!response.body) {
    release();
    return response;
  }

  const reader = response.body.getReader();
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          releaseOnce();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        releaseOnce();
        controller.error(error);
      }
    },
    async cancel(reason) {
      releaseOnce();
      await reader.cancel(reason).catch(() => undefined);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function beginLongLivedFetchBudget(
  input: RequestInfo | URL,
  init?: RequestInit,
  label?: string,
): () => void {
  if (typeof window === 'undefined' || !sameAppOrigin(input)) return noopRelease;
  return acquireHolder(label ?? requestLabel(input, init));
}

// Headers watchdog (#1359 recurrence, 2026-07-04): a request whose response
// HEADERS never arrive holds one of the webview's ~6 per-origin connections
// forever — six stuck server handlers bricked every subsequent fetch/XHR/lazy
// chunk on the page. Explicit long operations may allow a longer finite wait.
// This only bounds the wait BEFORE headers; callers bound the stream itself.
const HEADERS_WATCHDOG_MS = 45_000;

function withHeadersWatchdog(init: RequestInit | undefined, timeoutMs = HEADERS_WATCHDOG_MS): { init: RequestInit; cancel: () => void } {
  const controller = new AbortController();
  const upstream = init?.signal;
  if (upstream) {
    if (upstream.aborted) controller.abort(upstream.reason);
    else upstream.addEventListener('abort', () => controller.abort(upstream.reason), { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error(`o8 headers watchdog: no response headers in ${timeoutMs / 1000}s`)), timeoutMs);
  return {
    init: { ...(init ?? {}), signal: controller.signal },
    cancel: () => clearTimeout(timer),
  };
}

/** A bounded operation may explicitly allow more time for its headers. */
export async function fetchWithLongLivedBudget(
  input: RequestInfo | URL,
  init?: RequestInit,
  headersTimeoutMs = HEADERS_WATCHDOG_MS,
): Promise<Response> {
  if (typeof window === 'undefined' || !sameAppOrigin(input)) {
    return fetch(input, init);
  }

  const release = beginLongLivedFetchBudget(input, init);
  const watchdog = withHeadersWatchdog(init, headersTimeoutMs);
  try {
    const budgetedInit = {
      ...watchdog.init,
      [TRACKED_INIT]: true,
    } as BudgetedRequestInit;
    const response = await fetch(input, budgetedInit);
    watchdog.cancel();
    return wrapResponseBody(response, release);
  } catch (error) {
    watchdog.cancel();
    release();
    throw error;
  }
}

export function installLongLivedFetchBudgetGuard(): void {
  if (typeof window === 'undefined') return;
  const budgetWindow = window as BudgetWindow;
  if (budgetWindow[INSTALL_FLAG]) return;

  const nativeFetch = budgetWindow.fetch.bind(window);
  budgetWindow[ORIGINAL_FETCH] = budgetWindow.fetch;
  budgetWindow.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const budgetedInit = init as BudgetedRequestInit | undefined;
    if (budgetedInit?.[TRACKED_INIT] || !sameAppOrigin(input)) {
      return nativeFetch(input, init);
    }
    // Same headers watchdog for ALL app-origin traffic — one stuck handler
    // must cost at most 45s of a pool slot, never a permanent connection.
    const watchdog = withHeadersWatchdog(init);
    let response: Response;
    try {
      response = await nativeFetch(input, watchdog.init);
    } finally {
      watchdog.cancel();
    }
    if (!wrapsLongLivedBody(response)) {
      return response;
    }
    const release = acquireHolder(requestLabel(input, init));
    return wrapResponseBody(response, release);
  };
  budgetWindow[INSTALL_FLAG] = true;
}

export function snapshotLongLivedFetchBudgetForTests(): string[] {
  return Array.from(activeHolders.values()).map((holder) => holder.label);
}

export function resetLongLivedFetchBudgetForTests(): void {
  activeHolders.clear();
  nextHolderId = 1;
  if (typeof window === 'undefined') return;
  const budgetWindow = window as BudgetWindow;
  if (budgetWindow[ORIGINAL_FETCH]) {
    budgetWindow.fetch = budgetWindow[ORIGINAL_FETCH]!;
    delete budgetWindow[ORIGINAL_FETCH];
  }
  delete budgetWindow[INSTALL_FLAG];
}
