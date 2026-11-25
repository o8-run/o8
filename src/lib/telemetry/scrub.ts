import { SECRET_PATTERNS, VIEWER_SECRET_PATTERNS } from '@/lib/acp/output-redaction-matchers';

/**
 * Local redaction for logs and diagnostics that stay on this machine or that the
 * user chooses to share: home paths, query strings and credential-shaped values.
 * Pure and never throws.
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
