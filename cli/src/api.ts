/**
 * HTTP client + exit-code mapping for the o8 CLI.
 *
 * Wraps fetch with bearer-token injection and translates HTTP failures into
 * the documented exit-code surface (#2 connection refused, #3 unauthorized,
 * #4 not found, #5 conflict, #6 ambiguous server timeout). Every other error
 * bubbles as exit 1.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket, { type RawData } from 'ws';
import { resolveCliDataDir, type ResolvedConfig } from './config.js';

export const EXIT = {
  OK: 0,
  INVALID_ARGS: 1,
  CONNECTION_REFUSED: 2,
  UNAUTHORIZED: 3,
  NOT_FOUND: 4,
  CONFLICT: 5,
  SERVER_TIMEOUT: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  constructor(
    public code: string,
    message: string,
    public exit: ExitCode,
    public hint?: string,
    public ambiguous = false,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Bound the complete request, including response-body reads. Defaults to 120s. */
  timeoutMs?: number;
  /** Treat 404 as success and return null instead of throwing. */
  allowNotFound?: boolean;
  /** Return a structured 409/422 response instead of throwing. */
  allowConflict?: boolean;
  /** Return a structured 503 response instead of throwing. */
  allowUnavailable?: boolean;
}

export interface ApiResponse<T> {
  status: number;
  data: T;
}

export interface PacketTailEvent {
  schema: 'o8/lane.event/v1';
  id: string;
  packetId: string;
  laneId: string;
  verb: string;
  actor: string;
  event?: string;
  status?: string;
  timestamp: string;
  timestampMs: number;
  payload: Record<string, unknown>;
}

function buildUrl(base: string, path: string, query?: ApiRequestOptions['query']): string {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, base);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export const DEFAULT_API_TIMEOUT_MS = 120_000;
export const SLOW_MUTATION_TIMEOUT_MS = 300_000;

const TIMEOUT_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ETIMEDOUT',
]);

interface ErrorRecord {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  cause?: unknown;
}

function asErrorRecord(value: unknown): ErrorRecord | null {
  return value && typeof value === 'object' ? value as ErrorRecord : null;
}

function boundedErrorText(value: unknown, maxLength = 300): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

function transportErrorDetails(error: unknown): {
  name: string;
  message: string;
  code: string | null;
} {
  const record = asErrorRecord(error);
  const cause = asErrorRecord(record?.cause);
  const codeValue = cause?.code ?? record?.code;
  return {
    name: typeof record?.name === 'string' ? record.name : '',
    message: boundedErrorText(error),
    code: typeof codeValue === 'string' ? codeValue : null,
  };
}

function formatTimeoutSeconds(timeoutMs: number): string {
  const seconds = timeoutMs / 1000;
  return Number.isInteger(seconds)
    ? String(seconds)
    : seconds.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function throwNetworkError(
  error: unknown,
  cfg: ResolvedConfig,
  path: string,
  timeoutMs: number,
): never {
  const details = transportErrorDetails(error);
  if (details.code === 'ECONNREFUSED' || /\bECONNREFUSED\b/i.test(details.message)) {
    throw new CliError(
      'connection_refused',
      `o8 app refused the TCP connection to ${cfg.apiBase}.`,
      EXIT.CONNECTION_REFUSED,
      'Launch /Applications/o8.app or run `npm run dev` from the repo. Check ~/.o8/api-port for the picked port.',
    );
  }

  const timedOut = (details.code ? TIMEOUT_CODES.has(details.code) : false)
    || details.name === 'TimeoutError'
    || details.name === 'AbortError';
  if (timedOut) {
    throw new CliError(
      'server_timeout',
      `o8 app accepted the connection but ${path} did not answer within ${formatTimeoutSeconds(timeoutMs)}s.`,
      EXIT.SERVER_TIMEOUT,
      'The server route is stalled, not unreachable. Check the packet lane events and the app Activity view for the blocked operation.',
      true,
    );
  }

  const codeLabel = details.code ? ` (${details.code})` : '';
  throw new CliError(
    'network_error',
    `Network error calling ${path}${codeLabel}: ${details.message}`,
    EXIT.CONNECTION_REFUSED,
  );
}

function parseResponseJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readPortFile(dir: string | null, name: string): number | null {
  if (!dir) return null;
  const path = join(dir, name);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8').trim();
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : null;
  } catch {
    return null;
  }
}

export function resolveWsBase(cfg: ResolvedConfig): string {
  const envPort = (process.env.O8_WS_PORT && Number.parseInt(process.env.O8_WS_PORT, 10))
    || (process.env.WS_PORT && Number.parseInt(process.env.WS_PORT, 10))
    || null;
  const wsPort = envPort && Number.isInteger(envPort) && envPort > 0 && envPort < 65536
    ? envPort
    : readPortFile(cfg.dataDir ?? resolveCliDataDir(), 'ws-port') ?? 3002;
  return `ws://127.0.0.1:${wsPort}`;
}

function isPacketTailEvent(value: unknown): value is PacketTailEvent {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.schema === 'o8/lane.event/v1'
    && typeof record.id === 'string'
    && typeof record.packetId === 'string'
    && typeof record.laneId === 'string'
    && typeof record.verb === 'string'
    && typeof record.timestamp === 'string'
    && typeof record.timestampMs === 'number';
}

export function openPacketTailSocket(
  cfg: ResolvedConfig,
  packetId: string,
  options: {
    since?: number;
    connectTimeoutMs?: number;
    onEvent: (event: PacketTailEvent) => void;
  },
): Promise<WebSocket> {
  const url = new URL('/ws', resolveWsBase(cfg));
  if (cfg.token) url.searchParams.set('token', cfg.token);
  const connectTimeoutMs = options.connectTimeoutMs ?? 3_000;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new Error(`WebSocket connection timed out at ${url.toString()}`));
    }, connectTimeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      ws.off('open', handleOpen);
      ws.off('error', handleError);
    };
    const handleError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const handleOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      ws.on('message', (raw: RawData) => {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (isPacketTailEvent(parsed) && parsed.packetId === packetId) {
          options.onEvent(parsed);
        }
      });
      ws.send(JSON.stringify({
        type: 'packet-tail-subscribe',
        packetId,
        since: options.since,
      }));
      resolve(ws);
    };

    ws.once('open', handleOpen);
    ws.once('error', handleError);
  });
}

export async function apiFetch<T = unknown>(
  cfg: ResolvedConfig,
  path: string,
  opts: ApiRequestOptions = {},
): Promise<ApiResponse<T | null>> {
  const url = buildUrl(cfg.apiBase, path, opts.query);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new CliError(
      'invalid_args',
      'apiFetch timeoutMs must be a positive integer.',
      EXIT.INVALID_ARGS,
    );
  }
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  if (cfg.source.token === 'worker' && cfg.workerPacketId) headers['x-o8-worker-packet-id'] = cfg.workerPacketId;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  let responseText: string;
  try {
    res = await fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    responseText = res.status === 204 ? '' : await res.text();
  } catch (err) {
    throwNetworkError(err, cfg, path, timeoutMs);
  }

  if (res.status === 401 || res.status === 403) {
    const json = parseResponseJson(responseText);
    const error = asErrorRecord(json?.error);
    const serverDetail = typeof json?.error === 'string' ? json.error
      : typeof error?.message === 'string' ? error.message : '';
    const detail = boundedErrorText(serverDetail).replace(/\p{Cc}/gu, ' ');
    const typedCode = typeof error?.code === 'string' ? error.code : '';
    const spectatorDenied = typedCode.startsWith('spectator_') || cfg.source.token === 'spectator';
    if (res.status === 403) {
      throw new CliError(
        'forbidden',
        `Server refused this operation (403)${detail ? `: ${detail}` : '.'}`,
        EXIT.UNAUTHORIZED,
        cfg.source.token === 'worker' && cfg.token?.startsWith('o8br_')
          ? 'Use Brain reads for the assigned project. Ask the operator to link the repository before starting a new turn.'
          : cfg.source.token === 'worker'
          ? 'Use scoped operations for your assigned packet; ask the lead to reconcile global mission or contract state.'
          : spectatorDenied
          ? 'Check O8_SPECTATOR_TOKEN and the repository grants attached to that bearer.'
          : 'This principal lacks permission for the operation. Check the required capability with the operator.',
      );
    }
    throw new CliError(
      'unauthorized',
      `Server rejected the bearer token (401)${detail ? `: ${detail}` : '.'}`,
      EXIT.UNAUTHORIZED,
      spectatorDenied
        ? 'Check O8_SPECTATOR_TOKEN and the repository grants attached to that bearer.'
        : cfg.source.token === 'worker'
        ? 'The worker credential was refused or expired. Start a new authorized turn; do not substitute an operator credential.'
        : cfg.token
        ? 'Token did not match ~/.o8/ws-token on the server. Refresh O8_API_TOKEN or rerun from a loopback host.'
        : 'Set O8_API_TOKEN or ensure ~/.o8/ws-token is readable; cross-origin callers require the bearer token.',
    );
  }
  if (res.status === 404) {
    if (opts.allowNotFound) return { status: 404, data: null };
    // A route's typed not-found reason (for example an unknown packet) beats a bare status.
    const json = parseResponseJson(responseText);
    const error = asErrorRecord(json?.error);
    const serverDetail = typeof json?.error === 'string' ? json.error
      : typeof error?.message === 'string' ? error.message : '';
    const detail = boundedErrorText(serverDetail).replace(/\p{Cc}/gu, ' ');
    throw new CliError('not_found', `404 from ${path}${detail ? `: ${detail}` : ''}`, EXIT.NOT_FOUND);
  }
  if (res.status === 409 || res.status === 422) {
    const json = parseResponseJson(responseText);
    if (opts.allowConflict && json) {
      return { status: res.status, data: json as T };
    }
    let detail = '';
    const error = json?.error;
    const errorText = typeof error === 'string'
      ? error
      : asErrorRecord(error)?.message;
    detail = typeof json?.note === 'string'
      ? json.note
      : typeof json?.message === 'string'
        ? json.message
        : typeof errorText === 'string' ? errorText : '';
    throw new CliError(
      'conflict',
      `State machine rejected the operation (${res.status})${detail ? `: ${detail}` : '.'}`,
      EXIT.CONFLICT,
    );
  }
  if (res.status === 503 && opts.allowUnavailable) {
    const json = parseResponseJson(responseText);
    if (json) return { status: res.status, data: json as T };
  }
  if (!res.ok) {
    // Surface the server's error body — a bare "HTTP 500" hides the typed
    // reason the route already returned (#1464 was diagnosed blind because
    // of this branch).
    let detail = '';
    let typedCode = '';
    const json = parseResponseJson(responseText);
    const error = json?.error;
    const errorRecord = asErrorRecord(error);
    const errorText = typeof error === 'string' ? error : errorRecord?.message;
    typedCode = typeof errorRecord?.code === 'string' ? errorRecord.code : '';
    detail = typeof json?.note === 'string'
      ? json.note
      : typeof json?.message === 'string'
        ? json.message
        : typeof errorText === 'string' ? errorText : '';
    if (typedCode === 'mission_store_busy') {
      throw new CliError(
        typedCode,
        detail || 'Mission store is busy dispatching — retry in a moment.',
        EXIT.CONFLICT,
      );
    }
    throw new CliError(
      'http_error',
      `HTTP ${res.status} from ${path}${detail ? `: ${detail}` : ''}`,
      EXIT.INVALID_ARGS,
    );
  }

  // Allow empty 204 / non-JSON 200 to coexist; default to null.
  if (!responseText) return { status: res.status, data: null };
  try {
    return { status: res.status, data: JSON.parse(responseText) as T };
  } catch {
    throw new CliError(
      'invalid_response',
      `Non-JSON response from ${path}`,
      EXIT.INVALID_ARGS,
    );
  }
}
