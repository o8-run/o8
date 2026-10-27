import { SECRET_PATTERNS, VIEWER_SECRET_PATTERNS } from '@/lib/acp/output-redaction-matchers';

/**
 * Sentry payload scrubbing — the single, tested transform every JS Sentry layer
 * runs in `beforeSend` (@sentry/node in the Next server + ws-server, and
 * @sentry/browser in the desktop webview).
 *
 * Privacy is brand (ruling: o8-desktop-error-telemetry-direction). Engineers'
 * stack traces can carry home paths (→ the operator's username), repo names, and
 * query strings with tokens/ids. We strip identity + secrets BEFORE anything
 * leaves the machine. Pure, dependency-free, and NEVER throws — a scrub failure
 * must never take down the process it observes, so every entry point is wrapped.
 */

/**
 * Collapse the identity-bearing home segment of a POSIX path to an ellipsis,
 * keeping the rest so a stack trace stays debuggable:
 *   /Users/example/o8/src/x.ts → /Users/…/o8/src/x.ts
 *   /home/deploy/app/server.js       → /home/…/app/server.js
 * The username is the PII; the trailing path is safe + useful.
 */
const HOME_PREFIX = /\/(Users|home)\/[^/\\\s"':)>\]]+/g;

export function scrubPaths(input: string): string {
  if (typeof input !== 'string' || !input) return input;
  try {
    return input.replace(HOME_PREFIX, '/$1/…');
  } catch {
    return input;
  }
}

/** Strip the query string from any http(s) URL (may carry tokens / ids). */
const URL_QUERY = /(https?:\/\/[^\s"'?]+)\?[^\s"']*/g;

export function stripQueryStrings(input: string): string {
  if (typeof input !== 'string' || !input) return input;
  try {
    return input.replace(URL_QUERY, '$1');
  } catch {
    return input;
  }
}

/**
 * Credential-shaped values: session JWTs, bearer/basic headers, device tokens,
 * secret keys, OAuth codes, and the value of any key that names a token,
 * ticket, session, secret, password, credential, cookie or authorization,
 * including escaped and nested JSON. Percent-encoding is decoded first so
 * encoded parameters and dots cannot slip past. The native console-error hook
 * in src-tauri/src/webview_latch.rs mirrors these rules; keep them identical.
 */

function percentDecode(input: string): string {
  return input.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** Redact credential-shaped values. Never throws; fails closed to `[redacted]`. */
export function redactSecrets(input: string): string {
  if (typeof input !== 'string' || !input) return input;
  try {
    let text = input;
    for (let pass = 0; pass < 3 && /%[0-9A-Fa-f]{2}/.test(text); pass++) text = percentDecode(text);
    for (const [pattern, replacement] of [...VIEWER_SECRET_PATTERNS, ...SECRET_PATTERNS]) text = text.replace(pattern, replacement);
    return text;
  } catch {
    return '[redacted]';
  }
}

/**
 * Keys whose VALUES must never leave the machine — auth material, identity,
 * env dumps. Case-insensitive; deliberately precise so ordinary keys
 * (`packetId`, `count`, `author`) are NOT dropped.
 */
const PII_KEY_RE = /(pass(word|wd)?|secret|token|api[-_ ]?key|apikey|access[-_ ]?key|private[-_ ]?key|authorization|bearer|credential|cookie|session[-_ ]?id|\bdsn\b|e[-_ ]?mail|\benv\b|home[-_ ]?dir|hostname)/i;

export function isPiiKey(key: string): boolean {
  return typeof key === 'string' && PII_KEY_RE.test(key);
}

/** Return a shallow copy with PII-keyed entries removed. Never throws. */
export function dropPiiKeys<T extends Record<string, unknown>>(record: T): Partial<T> {
  const out: Partial<T> = {};
  try {
    for (const [key, value] of Object.entries(record)) {
      if (isPiiKey(key)) continue;
      out[key as keyof T] = value as T[keyof T];
    }
  } catch {
    return record;
  }
  return out;
}

/** True when a string carries a home path (used to drop path-bearing crumbs). */
export function containsHomePath(input: unknown): boolean {
  if (typeof input !== 'string') return false;
  HOME_PREFIX.lastIndex = 0;
  return HOME_PREFIX.test(input);
}

// Minimal structural shape of a Sentry event — loose on purpose so this module
// stays pure (no @sentry type coupling) and unit-testable in isolation.
interface FrameLike {
  filename?: unknown;
  abs_path?: unknown;
  module?: unknown;
  function?: unknown;
}
interface ExceptionValueLike {
  value?: unknown;
  stacktrace?: { frames?: FrameLike[] };
}
interface BreadcrumbLike {
  message?: unknown;
  data?: Record<string, unknown>;
}
export interface SentryEventLike {
  message?: unknown;
  exception?: { values?: ExceptionValueLike[] };
  request?: { url?: unknown; query_string?: unknown; headers?: unknown; cookies?: unknown; data?: unknown };
  breadcrumbs?: BreadcrumbLike[];
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  user?: unknown;
  server_name?: unknown;
}

export interface ScrubOptions {
  /** Webview: drop breadcrumbs whose message/data carries a file path outright. */
  dropBreadcrumbsWithPaths?: boolean;
}

function scrubString(value: unknown): string | undefined {
  return typeof value === 'string' ? stripQueryStrings(scrubPaths(redactSecrets(value))) : undefined;
}

/**
 * The shared `beforeSend` transform. Scrubs message, exception values + stack
 * frame paths, request URLs (query stripped, identity headers/cookies/body
 * dropped), and breadcrumbs; removes identity fields (`user`, `server_name`) and
 * PII-keyed extra/contexts. Mutates + returns the event. Never throws.
 */
export function scrubSentryEvent<T extends SentryEventLike>(event: T, opts: ScrubOptions = {}): T | null {
  try {
    if (typeof event.message === 'string') event.message = scrubString(event.message);

    for (const value of event.exception?.values ?? []) {
      const scrubbedValue = scrubString(value.value);
      if (scrubbedValue !== undefined) value.value = scrubbedValue;
      for (const frame of value.stacktrace?.frames ?? []) {
        const fn = scrubString(frame.filename);
        if (fn !== undefined) frame.filename = fn;
        const ap = scrubString(frame.abs_path);
        if (ap !== undefined) frame.abs_path = ap;
        const mod = scrubString(frame.module);
        if (mod !== undefined) frame.module = mod;
        const fun = scrubString(frame.function);
        if (fun !== undefined) frame.function = fun;
      }
    }

    if (event.request) {
      // Never send identity-bearing request metadata.
      delete event.request.query_string;
      delete event.request.headers;
      delete event.request.cookies;
      delete event.request.data;
      const url = scrubString(event.request.url);
      if (url !== undefined) event.request.url = url;
    }

    if (Array.isArray(event.breadcrumbs)) {
      const kept: BreadcrumbLike[] = [];
      for (const crumb of event.breadcrumbs) {
        if (opts.dropBreadcrumbsWithPaths) {
          const dataStr = crumb.data ? safeJson(crumb.data) : '';
          if (containsHomePath(crumb.message) || containsHomePath(dataStr)) continue;
        }
        const msg = scrubString(crumb.message);
        if (msg !== undefined) crumb.message = msg;
        if (crumb.data && typeof crumb.data === 'object') {
          // Console breadcrumbs keep the raw logged values; the scrubbed
          // message already carries their formatted text.
          delete crumb.data.arguments;
          const u = scrubString(crumb.data.url);
          if (u !== undefined) crumb.data.url = u;
          crumb.data = dropPiiKeys(crumb.data) as Record<string, unknown>;
        }
        kept.push(crumb);
      }
      event.breadcrumbs = kept;
    }

    // Identity fields — never leave the machine.
    delete event.user;
    delete event.server_name;
    if (event.extra) event.extra = dropPiiKeys(event.extra) as Record<string, unknown>;
    if (event.contexts) event.contexts = dropPiiKeys(event.contexts) as Record<string, unknown>;
  } catch {
    // Privacy is fail-closed: an event we could not fully inspect never leaves.
    return null;
  }
  return event;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
