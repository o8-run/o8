import 'server-only';

import { CodexAppServerClient } from '@/lib/codex/app-server-client';
import { resolveCli } from '@/lib/runtimes/shared/cli-resolver';
import type { RuntimeCapacityAccount, RuntimeCapacityBucket, RuntimeCapacitySnapshot } from '@/lib/runtimes/types';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function capacityLabel(id: string, windowMinutes: number | null): string {
  if (windowMinutes === 300) return '5-hour';
  if (windowMinutes === 10_080) return 'Weekly';
  if (windowMinutes && windowMinutes > 0) {
    if (windowMinutes % 1_440 === 0) return `${windowMinutes / 1_440}-day`;
    if (windowMinutes % 60 === 0) return `${windowMinutes / 60}-hour`;
  }
  return id === 'primary' ? 'Primary' : 'Secondary';
}

function parseWindow(id: string, value: unknown): RuntimeCapacityBucket | null {
  if (value == null) return null;
  const window = record(value);
  if (!window) throw new Error(`Codex ${id} rate limit is malformed.`);
  const usedPercent = finiteNumber(window.usedPercent ?? window.used_percent);
  const windowMinutes = finiteNumber(window.windowDurationMins ?? window.window_minutes);
  const resetsAt = finiteNumber(window.resetsAt ?? window.resets_at);
  if (usedPercent === null || usedPercent < 0 || usedPercent > 100) {
    throw new Error(`Codex ${id} rate limit has no valid usage percentage.`);
  }
  return {
    id,
    label: capacityLabel(id, windowMinutes),
    usedRatio: usedPercent / 100,
    used: null,
    unit: null,
    remaining: null,
    resetsAt: resetsAt === null ? null : new Date(resetsAt * 1_000).toISOString(),
    expiresAt: null,
  };
}

/**
 * Credits from `credits.balance` (a decimal string), resets from
 * `rateLimitResetCredits.availableCount`, and the workspace from `account/read`.
 */
function codexAccount(response: JsonRecord | null, rateLimits: JsonRecord, accountRead: unknown): RuntimeCapacityAccount | undefined {
  const account: RuntimeCapacityAccount = {};
  const workspace = record(record(accountRead)?.account)?.workspaceName;
  if (typeof workspace === 'string' && workspace.trim()) {
    account.organization = workspace.replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  const resets = record(response?.rateLimitResetCredits)?.availableCount;
  if (Number.isSafeInteger(resets) && (resets as number) >= 0) account.resetsLeft = resets as number;
  const credits = record(record(record(response?.rateLimitsByLimitId)?.codex)?.credits ?? rateLimits.credits);
  const balance = typeof credits?.balance === 'string' && credits.balance.trim() ? Number(credits.balance) : NaN;
  if (credits?.hasCredits === true && credits.unlimited !== true && Number.isFinite(balance) && balance >= 0) {
    account.credits = { amount: balance, currency: null };
  }
  return Object.keys(account).length ? account : undefined;
}

export function parseCodexAppServerCapacity(
  value: unknown,
  options: { identityId?: string | null; observedAtMs?: number; accountRead?: unknown } = {},
): RuntimeCapacitySnapshot {
  const response = record(value);
  const rateLimits = record(response?.rateLimits ?? response?.rate_limits);
  if (!rateLimits) throw new Error('Codex app-server returned no rate-limit snapshot.');
  const buckets = [
    parseWindow('primary', rateLimits.primary),
    parseWindow('secondary', rateLimits.secondary),
  ].filter((bucket): bucket is RuntimeCapacityBucket => bucket !== null);
  if (buckets.length === 0) throw new Error('Codex app-server returned no rate-limit windows.');
  const account = codexAccount(response, rateLimits, options.accountRead);
  return {
    runtime: 'codex',
    identityId: options.identityId ?? null,
    status: 'available',
    reason: null,
    observedAt: new Date(options.observedAtMs ?? Date.now()).toISOString(),
    source: 'app-server',
    confidence: 'exact',
    buckets,
    ...(account ? { account } : {}),
  };
}

export async function readLiveCodexRuntimeCapacity(options: {
  configHome: string;
  identityId?: string | null;
  binaryPath?: string;
  requestTimeoutMs?: number;
}): Promise<RuntimeCapacitySnapshot> {
  const binaryPath = options.binaryPath ?? (await resolveCli({
    runtimeId: 'codex',
    binaryName: 'codex',
    envOverride: 'O8_CODEX_BIN',
    extraEnvOverrides: ['CODEX_HOME'],
  })).path;
  const requestTimeoutMs = options.requestTimeoutMs ?? 3_500;
  const client = new CodexAppServerClient({
    binaryPath,
    codexHome: options.configHome,
    requestTimeoutMs,
  });
  try {
    await client.initialize('o8-capacity', '1');
    const [response, accountRead] = await Promise.all([
      client.request('account/rateLimits/read', {}, requestTimeoutMs),
      // The workspace name is optional; an app-server without account/read still reports limits.
      client.request('account/read', {}, requestTimeoutMs).catch(() => null),
    ]);
    return parseCodexAppServerCapacity(response, { identityId: options.identityId, accountRead });
  } finally {
    await client.close();
  }
}
