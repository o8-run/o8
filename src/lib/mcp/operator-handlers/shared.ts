import { apiError, McpInputError, O8ApiError, safeErrorText, unreachableApiError } from '@/lib/mcp/api-error';
export { McpInputError } from '@/lib/mcp/api-error';
export { parseDirectivesApplied, parseDirectivesViolated } from '@/lib/orchestrator/review-finding-input';
import { parseReviewFindings as readReviewFindings } from '@/lib/orchestrator/review-finding-input';
import { DEFAULT_API_PORT } from '@/lib/panel/api-port';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import {
  formatDispatchableRuntimeChoices,
  isDispatchableRuntime,
} from '@/lib/orchestrator/runtime-capabilities';
import { getDataDir } from '@/lib/data-dir-migration';
import {
  pollCorrelatedMcpMutation,
  type McpMutationCorrelationField,
} from '@/lib/mcp/correlated-mutation';
import type { CorrelatedActionPayload } from '@/lib/orchestrator/action-receipt';

// ── Types ──

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
}

// ── API Client State ──

let _apiBase = `http://localhost:${DEFAULT_API_PORT}`;
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [500, 1500, 4000];
const FETCH_TIMEOUT_MS = 15_000;

let _apiHealthy = true;
let _lastHealthCheck = 0;
const HEALTH_CHECK_INTERVAL_MS = 10_000;

// ── Panel auth token ──
//
// The Next-side middleware gates /api/orchestrator/*, /api/panel/* (and a
// dozen other prefixes) on EITHER a loopback origin OR `Authorization: Bearer
// <ws-token>` matching ${dataDir}/ws-token. The middleware's loopback bypass
// has been observed to NOT trigger from this MCP server's plain Node fetch
// (no Origin or sec-fetch-site headers; nextUrl.hostname/Host inspection has
// edge cases — see epic-937 t6-mcp REPORT, 2026-04-30). Including the Bearer
// token explicitly is belt-and-suspenders: works whether or not the loopback
// path triggers.
let _cachedPanelToken: { value: string; readAt: number } | null = null;
const PANEL_TOKEN_TTL_MS = 30_000;

function readPanelToken(): string | null {
  const now = Date.now();
  if (_cachedPanelToken && now - _cachedPanelToken.readAt < PANEL_TOKEN_TTL_MS) {
    return _cachedPanelToken.value || null;
  }
  try {
    const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    // Match middleware's lookup order: CORTEX_IDE_DATA_DIR override, else ~/.o8.
    const dataDir = getDataDir();
    const tokenPath = join(dataDir, 'ws-token');
    if (!existsSync(tokenPath)) {
      _cachedPanelToken = { value: '', readAt: now };
      return null;
    }
    const value = readFileSync(tokenPath, 'utf-8').trim();
    _cachedPanelToken = { value, readAt: now };
    return value || null;
  } catch {
    return null;
  }
}

export function setApiBase(base: string): void {
  _apiBase = base;
}

/** Native reads must retain this API client's credential-rotation behavior. */
export function nativeReadCredentialMatches(token: string): boolean {
  return readPanelToken() === token;
}

let _apiBaseCache: { value: string; ts: number } | null = null;
/**
 * Re-reads the api-port file each call because dev-bridge swaps and prod-app
 * boots can move the backend port. Caches the result for 1s to avoid file-stat
 * thrash; fallback order is api-port file, _apiBase from setApiBase(), then
 * the default _apiBase.
 */
function resolveApiBaseLive(): string {
  const now = Date.now();
  if (_apiBaseCache && now - _apiBaseCache.ts < 1000) return _apiBaseCache.value;
  try {
    const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const dataDir = getDataDir();
    const portFile = join(dataDir, 'api-port');
    if (existsSync(portFile)) {
      const n = parseInt(readFileSync(portFile, 'utf-8').trim(), 10);
      if (Number.isInteger(n) && n > 0 && n < 65536) {
        const value = `http://127.0.0.1:${n}`;
        _apiBaseCache = { value, ts: now };
        return value;
      }
    }
  } catch { /* fall through */ }
  _apiBaseCache = { value: _apiBase, ts: now };
  return _apiBase;
}

export function getApiBase(): string {
  return resolveApiBaseLive();
}

export async function checkApiHealth(): Promise<boolean> {
  const now = Date.now();
  if (now - _lastHealthCheck < HEALTH_CHECK_INTERVAL_MS) return _apiHealthy;
  _lastHealthCheck = now;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${resolveApiBaseLive()}/api/panel/repos`, { signal: controller.signal });
    clearTimeout(timer);
    _apiHealthy = res.ok;
  } catch {
    _apiHealthy = false;
  }
  return _apiHealthy;
}

// ── Helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ApiFetchOptions extends RequestInit {
  /** Per-call timeout override in ms. Defaults to FETCH_TIMEOUT_MS (15s).
   *  Use a higher value for endpoints that legitimately take longer
   *  (e.g. /api/cortex/ask/answer can spend 10–40s in the classifier — see #1115). */
  timeoutMs?: number;
  /** Return a JSON error body for explicitly accepted HTTP statuses instead of
   * throwing. Used by read tools that surface structured fail-closed errors. */
  acceptedErrorStatuses?: number[];
}

async function apiFetchResponse(
  path: string,
  init?: ApiFetchOptions,
  returnHttpErrors = false,
): Promise<Response> {
  let lastError: O8ApiError | undefined;
  const timeoutMs = init?.timeoutMs ?? FETCH_TIMEOUT_MS;
  // Strip timeoutMs from the RequestInit so fetch doesn't see it.
  const { timeoutMs: _omit, acceptedErrorStatuses = [], ...fetchInit } = init ?? {};
  void _omit;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
      console.error(`[o8-operator] API retry ${attempt}/${MAX_RETRIES} for ${path} in ${delay}ms`);
      await sleep(delay);
    }

    try {
      const baseUrl = resolveApiBaseLive();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const panelToken = readPanelToken();
      // #3740: marks agent tool calls, which /api/panel/approvals keeps off held merge cards.
      const baseHeaders: Record<string, string> = { 'Content-Type': 'application/json', 'x-o8-agent-tool': '1' };
      if (panelToken) {
        baseHeaders.Authorization = `Bearer ${panelToken}`;
      }
      let res: Response;
      try {
        res = await fetch(`${baseUrl}${path}`, {
          ...fetchInit,
          signal: controller.signal,
          headers: { ...baseHeaders, ...fetchInit.headers },
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const bodyText = await res.clone().text().catch(() => '');
        const httpError = apiError(path, res.status, bodyText);
        const accepted = res.status >= 400 && res.status < 500 && acceptedErrorStatuses.includes(res.status);
        if (!returnHttpErrors && !accepted) throw httpError;
      }
      _apiHealthy = true;
      return res;
    } catch (err) {
      lastError = err instanceof O8ApiError ? err : apiError(path, null, '', err);
      if (lastError.noRetry) {
        _apiHealthy = true; // backend responded; the request itself was rejected
        throw lastError;
      }
      _apiHealthy = false;
    }
  }

  // A network failure after every retry usually means the backend is not running.
  throw !lastError || lastError.status === null ? unreachableApiError() : lastError;
}

export async function apiFetch(path: string, init?: ApiFetchOptions): Promise<unknown> {
  const acceptedErrorStatuses = init?.acceptedErrorStatuses ?? [];
  const res = await apiFetchResponse(path, init);
  const bodyText = await res.text().catch((error) => { throw apiError(path, res.status, '', error); });
  if (!res.ok && !(res.status < 500 && acceptedErrorStatuses.includes(res.status))) {
    throw apiError(path, res.status, bodyText);
  }
  try {
    return JSON.parse(bodyText) as unknown;
  } catch (error) {
    throw apiError(path, res.status, bodyText, error);
  }
}

/** MCP mutation transport with one body-bound correlation id through 202s and retries. */
export function apiFetchCorrelatedMutation<
  TPayload extends CorrelatedActionPayload = CorrelatedActionPayload,
>(
  path: string,
  body: Record<string, unknown>,
  correlationField: McpMutationCorrelationField,
): Promise<TPayload> {
  return pollCorrelatedMcpMutation<TPayload>({
    body,
    correlationField,
    parseError: (response, payload) => apiError(path, response.status, JSON.stringify(payload)),
    send: (requestBody) => apiFetchResponse(path, {
      method: 'POST',
      body: requestBody,
    }, true),
  });
}

export function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], isError };
}

export function jsonResult(data: unknown, isError = false): McpToolResult {
  return { isError, content: [{ type: 'text', text: JSON.stringify(data) }] };
}

export function errorText(error: unknown) {
  return safeErrorText(error);
}

export function requiredString(args: Record<string, unknown>, key: string) {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new McpInputError(`${key} is required. Set ${key} to a non-empty string.`);
  }
  return value.trim();
}

export function optionalString(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function parseMissionRuntime(value: unknown): OrchestratorRuntime {
  if (value === undefined || value === null || value === '') {
    // Preserve the effective operator default as a requested-routing hint.
    try {
      const { resolveDefaultDispatchRuntimeSync } = require('@/lib/operator/defaults') as typeof import('@/lib/operator/defaults');
      return resolveDefaultDispatchRuntimeSync();
    } catch {
      return 'codex';
    }
  }
  if (isDispatchableRuntime(value)) return value;
  throw new McpInputError(`runtime must be one of ${formatDispatchableRuntimeChoices()}`);
}

export function parseIssueList(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new McpInputError('issues must be a non-empty array');
  }

  const issues = value
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      if (typeof entry === 'number' && Number.isFinite(entry)) return String(Math.floor(entry));
      return '';
    })
    .filter(Boolean);

  if (issues.length === 0) {
    throw new McpInputError('issues must contain at least one issue reference');
  }

  return issues;
}

export function parseReviewFindings(value: unknown) {
  try {
    return readReviewFindings(value);
  } catch (error) {
    throw new McpInputError(error instanceof Error ? error.message : 'Invalid review findings');
  }
}
