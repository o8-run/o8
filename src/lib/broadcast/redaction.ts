import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

import { readActiveTokenHashes } from '@/lib/mobile/device-token-file';
import { getOrCreateWsToken } from '@/lib/ws-auth';

const SENSITIVE_KEY = /authorization|bearer|credential|password|(?:^|[_.-])pw(?:$|[_.-])|auth|cookie|secret|token|api.?key|session.?key|ws.?token|device.?token|^env(?:ironment)?(?:_?variables?)?$/i;
const GENERIC_HOME_PATHS = [
  /\/Users\/[^/\s]+(?=\/|\b)/g,
  /\/home\/[^/\s]+(?=\/|\b)/g,
  /[A-Za-z]:\\Users\\[^\\\s]+(?=\\|\b)/g,
];

export interface BroadcastRedactionContext {
  activeDeviceTokenHashes: Set<string>;
  environmentValues: string[];
  operatorToken: string | null;
}

// Only values under secret-looking keys are treated as secrets. A blanket
// "any value over N chars" rule scrubbed ordinary words out of the feed
// (NODE_ENV=production turned every "production" into [redacted-env]).
// Values shorter than this are never secrets whatever their key: flags like
// FOO_TOKEN=1 would otherwise scrub every "1".
const MIN_ENV_SECRET_LENGTH = 6;

function environmentValues(): string[] {
  return [...new Set(Object.entries(process.env)
    .flatMap(([key, value]) => (
      typeof value === 'string'
        && value.length >= MIN_ENV_SECRET_LENGTH
        && SENSITIVE_KEY.test(key)
        ? [value]
        : []
    )))]
    .sort((left, right) => right.length - left.length);
}

export function createBroadcastRedactionContext(): BroadcastRedactionContext {
  const operatorToken = getOrCreateWsToken().trim();
  return {
    activeDeviceTokenHashes: readActiveTokenHashes(),
    environmentValues: environmentValues(),
    operatorToken: operatorToken || null,
  };
}

function isExactCredential(value: string, context: BroadcastRedactionContext): boolean {
  if (context.operatorToken === value) return true;
  if (!value) return false;
  const hash = createHash('sha256').update(value).digest('hex');
  return context.activeDeviceTokenHashes.has(hash);
}

export function redactBroadcastText(
  value: string,
  context: BroadcastRedactionContext = createBroadcastRedactionContext(),
): string {
  if (isExactCredential(value, context)) return '[redacted-token]';
  let redacted = value;
  // The live operator token usually comes from the data directory, not the environment, so the
  // environment pass below cannot find it inside a sentence or a quoted value.
  const operator = context.operatorToken;
  if (operator && operator.length >= MIN_ENV_SECRET_LENGTH && redacted.includes(operator)) {
    redacted = redacted.split(operator).join('[redacted-token]');
  }
  // Worker bearers are base64url, and a brain-read grant carries a dot-separated signature.
  redacted = redacted
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:o8sp|o8pw|o8ro|o8br|cwk)_[A-Za-z0-9_-]{12,}(?:\.[A-Za-z0-9_-]+)*/g, '[redacted-token]');
  const home = homedir();
  if (home && home !== '/') redacted = redacted.split(home).join('~');
  for (const pattern of GENERIC_HOME_PATHS) redacted = redacted.replace(pattern, '~');
  for (const environmentValue of context.environmentValues) {
    if (redacted.includes(environmentValue)) {
      redacted = redacted.split(environmentValue).join('[redacted-env]');
    }
  }
  return redacted;
}

export function redactBroadcastValue(
  value: unknown,
  key = '',
  context: BroadcastRedactionContext = createBroadcastRedactionContext(),
): unknown {
  if (SENSITIVE_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string') return redactBroadcastText(value, context);
  if (Array.isArray(value)) return value.map((entry) => redactBroadcastValue(entry, '', context));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      output[entryKey] = redactBroadcastValue(entryValue, entryKey, context);
    }
    return output;
  }
  return value;
}

export function redactBroadcastRecord(
  value: Record<string, unknown>,
  context: BroadcastRedactionContext = createBroadcastRedactionContext(),
): Record<string, unknown> {
  return redactBroadcastValue(value, '', context) as Record<string, unknown>;
}
