import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

import { readLocalWorkerToken } from '@/lib/auth/worker-token';
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
  /** The shared local-worker token from the data directory. */
  workerToken?: string | null;
}

// Prefixed bearers match wherever they start: a preceding word character, escape or
// percent-encoding must not shield one. A brain-read grant carries a dot-separated signature.
const PREFIXED_BEARER = /(?:o8sp|o8pw|o8ro|o8br|o8wt|o8p|o8d|cwk)_[A-Za-z0-9_-]{12,}(?:\.[A-Za-z0-9_-]+)*/g;
// Device bearers are 64 lowercase hex; only a run whose hash is an active device token is redacted.
const DEVICE_TOKEN_RUN = /(?<![0-9a-fA-F])[0-9a-f]{64}(?![0-9a-fA-F])/g;

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
    workerToken: readLocalWorkerToken(),
  };
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function isExactCredential(value: string, context: BroadcastRedactionContext): boolean {
  if (context.operatorToken === value) return true;
  if (!value) return false;
  if (context.workerToken === value) return true;
  return context.activeDeviceTokenHashes.has(sha256(value));
}

export function redactBroadcastText(
  value: string,
  context: BroadcastRedactionContext = createBroadcastRedactionContext(),
): string {
  if (isExactCredential(value, context)) return '[redacted-token]';
  let redacted = value;
  // The live operator and local-worker tokens usually come from the data directory, not the
  // environment, so the environment pass below cannot find them inside a sentence or a quoted value.
  for (const token of [context.operatorToken, context.workerToken]) {
    if (token && token.length >= MIN_ENV_SECRET_LENGTH && redacted.includes(token)) {
      redacted = redacted.split(token).join('[redacted-token]');
    }
  }
  if (context.activeDeviceTokenHashes.size > 0) {
    redacted = redacted.replace(DEVICE_TOKEN_RUN, (run) => (
      context.activeDeviceTokenHashes.has(sha256(run)) ? '[redacted-token]' : run
    ));
  }
  redacted = redacted
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(PREFIXED_BEARER, '[redacted-token]');
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
