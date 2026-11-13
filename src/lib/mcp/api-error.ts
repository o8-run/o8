import { MANAGED_BRAIN_UNAVAILABLE_MESSAGE } from '@/lib/cortex/qa/managed-brain-unavailable';
import type { Citation } from '@/lib/cortex/qa/types';
import { WebviewBridgeError } from '@/lib/mcp/o8-webview-error';

const MAX_ERROR_LENGTH = 200;
// A 4xx `error` is text a route wrote for its caller, such as a storage hold
// with the space to free. It gets more room; a 5xx never passes through (#3657).
const MAX_ROUTE_ERROR_LENGTH = 500;

function singleLineMessage(value: unknown, maxLength = MAX_ERROR_LENGTH): string | null {
  if (typeof value !== 'string' || value.length > maxLength || /[\r\n\u2028\u2029]/u.test(value)) return null;
  const message = value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  return message || null;
}

export interface ManagedBrainUnavailableResult {
  ok: false;
  code: 'managed_brain_unavailable';
  message: string;
  citations: Citation[];
  sourcesConsidered: number;
}

export class O8ApiError extends Error {
  managedBrainUnavailable?: ManagedBrainUnavailableResult;
  readonly noRetry: boolean;

  constructor(readonly status: number | null, readonly summary: string,
    readonly routeError: { code: string; message: string } | null = null) {
    super(summary);
    this.name = 'O8ApiError';
    this.noRetry = status !== null && status < 500;
  }
}

/** Fixed text when every retry failed to reach the backend, which usually means it is not running. */
export function unreachableApiError(): O8ApiError {
  return new O8ApiError(null, 'o8 API unreachable. Open the o8 desktop app, which starts the backend, or run `npm run desktop:dev` from the o8 repo.');
}

export class McpInputError extends Error {
  constructor(message: string) {
    super(singleLineMessage(message) ?? 'Invalid tool input');
    this.name = 'McpInputError';
  }
}

export function apiError(path: string, status: number | null, body: string, detail?: unknown): O8ApiError {
  console.error('[mcp] API error:', { status, path, body }, detail ?? '');
  let summary = `o8 API error (${status ?? 'network'})`;
  // Only this documented outage envelope can carry retrieved sources across a 5xx.
  if (path === '/api/cortex/ask/answer' && status === 503) {
    try {
      const payload = JSON.parse(body);
      if (payload?.ok === false && payload.code === 'managed_brain_unavailable'
        && Array.isArray(payload.citations) && payload.citations.every((citation: Citation) =>
          citation && typeof citation.kind === 'string' && typeof citation.title === 'string'
          && typeof citation.rowId === 'string' && typeof citation.table === 'string')
        && Number.isInteger(payload.sourcesConsidered) && payload.sourcesConsidered >= 0) {
        const error = new O8ApiError(status, MANAGED_BRAIN_UNAVAILABLE_MESSAGE);
        error.managedBrainUnavailable = { ok: false, code: payload.code,
          message: MANAGED_BRAIN_UNAVAILABLE_MESSAGE, citations: payload.citations,
          sourcesConsidered: payload.sourcesConsidered };
        return error;
      }
    } catch { /* Unknown 5xx payloads keep fixed error text. */ }
  }
  if (status !== null && status >= 400 && status < 500) {
    try {
      const payload = JSON.parse(body) as { error?: unknown } | null;
      summary = singleLineMessage(payload?.error, MAX_ROUTE_ERROR_LENGTH) ?? summary;
      // Only this operator route's documented envelope is exposed as structured close data.
      if (path === '/api/orchestrator/discard-packet' && payload?.error && typeof payload.error === 'object') {
        const route = payload.error as { code?: unknown; message?: unknown };
        const message = singleLineMessage(route.message, MAX_ROUTE_ERROR_LENGTH);
        if (typeof route.code === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(route.code) && message) {
          return new O8ApiError(status, message, { code: route.code, message });
        }
      }
    } catch { /* use the fixed summary */ }
  }
  if (status !== null && status >= 400
    && ['/api/orchestrator/steer-packet', '/api/orchestrator/reset-packet'].includes(path)) {
    try {
      const route = JSON.parse(body)?.error as { code?: unknown; message?: unknown } | undefined;
      // Lifecycle routes deliberately write 4xx messages for their caller.
      // Server exceptions keep fixed text; only their bounded cause code survives.
      const message = status < 500 ? singleLineMessage(route?.message, MAX_ROUTE_ERROR_LENGTH) : summary;
      if (typeof route?.code === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(route.code) && message) {
        return new O8ApiError(status, message, { code: route.code, message });
      }
    } catch { /* use the fixed summary */ }
  }
  return new O8ApiError(status, summary);
}

/**
 * Bounded text for a failed tool call. Exceptions give fixed text unless they
 * are typed API or input errors. A successful response that reports `ok: false`
 * keeps its own short, single-line `error` (or `error.message`, or `note`),
 * since routes write those for the caller.
 */
export function safeErrorText(error: unknown): string {
  console.error('[mcp] Tool failure:', error);
  if (error instanceof O8ApiError) return error.summary;
  if (error instanceof McpInputError) return error.message;
  if (error instanceof WebviewBridgeError) return error.message;
  if (error instanceof Error || typeof error !== 'object' || error === null) return 'o8 operation failed';
  const result = error as { error?: unknown; note?: unknown };
  const nested = typeof result.error === 'object' && result.error !== null ? (result.error as { message?: unknown }).message : undefined;
  return singleLineMessage(result.error) ?? singleLineMessage(nested) ?? singleLineMessage(result.note) ?? 'o8 operation failed';
}
