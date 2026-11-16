import { childEnvironment } from '@/lib/providers/spawn-environment';
import { providerSpawnEnvironment } from '@/lib/providers/spawn-environment';
import 'server-only';

import { spawn } from '@/lib/providers/child-process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { forceKillTreeWindows } from '@/lib/runtimes/shared/owned-session/helpers';
import { resolveClaudeBinary } from '@/lib/runtimes/shared/cli-locate';
import type {
  RuntimeCapacityAccount, RuntimeCapacityAmount, RuntimeCapacityBucket, RuntimeCapacitySnapshot,
} from '@/lib/runtimes/types';
import { readClaudeRuntimeCapacity } from '@/lib/usage/cli-scrape';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
}

/** `{ amount_minor, currency, exponent }`, the CLI's money shape in `rate_limits.spend`. */
function money(value: unknown): RuntimeCapacityAmount | null {
  const raw = record(value);
  const minor = raw?.amount_minor;
  const exponent = raw?.exponent;
  const currency = typeof raw?.currency === 'string' ? raw.currency.trim().toUpperCase() : '';
  if (!Number.isSafeInteger(minor) || (minor as number) < 0 || !/^[A-Z]{3}$/.test(currency)) return null;
  if (!Number.isInteger(exponent) || (exponent as number) < 0 || (exponent as number) > 6) return null;
  return { amount: (minor as number) / 10 ** (exponent as number), currency };
}

/**
 * Resets left in `rate_limits.cedar_ember`: usable, unpaused, unexpired grants only.
 * Adapted from T3 Code (https://github.com/pingdotgg/t3code),
 * apps/server/src/provider/claudeResetCredits.ts, commit
 * 05ccd6bfb5c49fe73cd979c03ec8eb3e6f45fa6a. Copyright (c) 2026 T3 Tools Inc.
 * MIT; see licenses/t3code-MIT.txt. Adaptation: a single count read from the CLI's
 * own usage answer instead of a separate request.
 */
function resetsLeft(value: unknown, now: number): number | undefined {
  const block = record(value);
  if (block?.eligible !== true || !Array.isArray(block.grants)) return undefined;
  let left = 0;
  for (const raw of block.grants) {
    const grant = record(raw);
    if (!grant || grant.usable_now !== true || grant.paused === true) continue;
    if (!Number.isSafeInteger(grant.resets_left) || (grant.resets_left as number) < 0) continue;
    const ends = typeof grant.ends_at === 'string' ? Date.parse(grant.ends_at) : null;
    if (grant.ends_at != null && !(ends !== null && ends > now)) continue;
    left += grant.resets_left as number;
  }
  return left;
}

/** The Organization row of the CLI's `get_status` sections. */
function organization(status: unknown): string | undefined {
  const sections = record(status)?.sections;
  if (!Array.isArray(sections)) return undefined;
  for (const section of sections) {
    const rows = record(section)?.rows;
    if (!Array.isArray(rows)) continue;
    for (const raw of rows) {
      const row = record(raw);
      if (row?.label !== 'Organization' || typeof row.value !== 'string') continue;
      const value = row.value.replace(/\s+/g, ' ').trim().slice(0, 120);
      if (value) return value;
    }
  }
  return undefined;
}

function claudeAccount(limits: RecordValue | null, status: unknown, now: number): RuntimeCapacityAccount | undefined {
  const account: RuntimeCapacityAccount = {};
  const org = organization(status);
  if (org) account.organization = org;
  const resets = limits ? resetsLeft(limits.cedar_ember, now) : undefined;
  if (resets !== undefined) account.resetsLeft = resets;
  const spend = record(limits?.spend);
  const credits = money(spend?.balance);
  if (credits) account.credits = credits;
  const used = spend?.enabled === true ? money(spend.used) : null;
  if (used) {
    const limit = money(spend?.limit);
    account.extraUsage = limit?.currency === used.currency ? { used, limit } : { used };
  }
  return Object.keys(account).length ? account : undefined;
}

export function parseClaudeUsageCapacity(value: unknown, observedAt = Date.now(), status?: unknown): RuntimeCapacitySnapshot {
  const response = record(value);
  const limits = record(response?.rate_limits);
  const buckets: RuntimeCapacityBucket[] = [];
  const add = (id: string, label: string, raw: unknown) => {
    const window = record(raw);
    if (window?.utilization == null) return;
    if (typeof window.utilization !== 'number' || !Number.isFinite(window.utilization) || window.utilization < 0 || window.utilization > 100) {
      throw new Error('Malformed Claude usage window');
    }
    const reset = typeof window.resets_at === 'string' ? Date.parse(window.resets_at) : NaN;
    buckets.push({ id, label, usedRatio: window.utilization / 100, used: null, unit: null, remaining: null,
      resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null, expiresAt: null });
  };
  if (response?.rate_limits_available === true && limits) {
    add('five_hour', '5-hour', limits.five_hour);
    add('seven_day', 'Weekly', limits.seven_day);
    add('seven_day_oauth_apps', 'Weekly · apps', limits.seven_day_oauth_apps);
    add('seven_day_opus', 'Weekly · Opus', limits.seven_day_opus);
    add('seven_day_sonnet', 'Weekly · Sonnet', limits.seven_day_sonnet);
    if (Array.isArray(limits.model_scoped)) {
      for (const raw of limits.model_scoped.slice(0, 24)) {
        const scoped = record(raw);
        if (typeof scoped?.display_name !== 'string' || !scoped.display_name.trim()) continue;
        const label = scoped.display_name.trim().slice(0, 80);
        add(`model:${label}`, `Weekly · ${label}`, scoped);
      }
    }
  }
  const account = claudeAccount(limits, status, observedAt);
  return { runtime: 'claude-code', identityId: null, status: buckets.length ? 'available' : 'unavailable',
    reason: buckets.length ? null : response?.rate_limits_available === false ? 'subscription_limits_unsupported' : 'quota_not_reported',
    observedAt: new Date(observedAt).toISOString(), source: 'structured-cli', confidence: buckets.length ? 'exact' : null,
    buckets: [...new Map(buckets.map(bucket => [bucket.id, bucket])).values()],
    ...(account ? { account } : {}) };
}

/** Initialize the CLI and request usage and status only. Never send a user message or open a worker session. */
export async function readLiveClaudeRuntimeCapacity(options: {
  binaryPath?: string; cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv;
} = {}): Promise<RuntimeCapacitySnapshot> {
  const invocation = cliInvocation(options.binaryPath ?? resolveClaudeBinary(), [
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--setting-sources', 'user', '--settings', '{"disableAllHooks":true}',
    '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  ]);
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = childEnvironment({ runtimeId: 'claude-code', env: { ...options.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_AUTO_CONNECT_IDE: '0', CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1' } });
    delete env.FORCE_CODE_TERMINAL;
    const proc = spawn(invocation.command, invocation.args, {
      cwd: options.cwd ?? homedir(), env: providerSpawnEnvironment(env, { runtimeId: 'claude-code' }), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const initId = randomUUID();
    const usageId = randomUUID();
    const statusId = randomUUID();
    // The usage answer, held until the status answer (organization) arrives or the read times out.
    let usage: { response: unknown } | null = null;
    let status: { response: unknown } | null = null;
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    let bytes = 0;
    let settled = false;
    let requestedUsage = false;
    const finish = (value?: RuntimeCapacitySnapshot) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      proc.stdin.end();
      if (process.platform === 'win32' && proc.pid) void forceKillTreeWindows(proc.pid);
      else proc.kill('SIGTERM');
      const killTimer = setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); }, 500);
      killTimer.unref();
      proc.once('close', () => clearTimeout(killTimer));
      if (value) resolve(value); else reject(new Error('Claude usage observation unavailable'));
    };
    const send = (requestId: string, request: RecordValue) => {
      proc.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request })}\n`);
    };
    const parsed = () => {
      try { return usage ? parseClaudeUsageCapacity(usage.response, Date.now(), status?.response) : undefined; } catch { return undefined; }
    };
    const timeout = setTimeout(() => finish(parsed()), options.timeoutMs ?? 6_500);
    proc.on('error', () => finish());
    proc.stdin.on('error', () => finish());
    proc.on('close', () => finish(parsed()));
    proc.stderr.resume(); // Never expose CLI banners, account fields, or raw errors to the client.
    proc.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1_048_576) { finish(); return; }
      buffer += decoder.write(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        let row: RecordValue | null;
        try { row = record(JSON.parse(line)); } catch { continue; }
        if (row?.type !== 'control_response') continue;
        const response = record(row.response);
        if (response?.request_id !== initId && response?.request_id !== usageId && response?.request_id !== statusId) continue;
        if (response.request_id === statusId && requestedUsage) {
          // An older CLI without get_status still reports usage; only the organization is lost.
          status = { response: response.subtype === 'success' ? response.response : null };
        } else if (response.subtype !== 'success') { finish(); return; }
        else if (response.request_id === initId && !requestedUsage) {
          requestedUsage = true;
          send(usageId, { subtype: 'get_usage', skip_behaviors: true });
          send(statusId, { subtype: 'get_status' });
        } else if (response.request_id === usageId && requestedUsage) {
          usage = { response: response.response };
          if (!parsed()) { finish(); return; }
        }
        if (usage && status) { finish(parsed()); return; }
      }
    });
    send(initId, { subtype: 'initialize', hooks: {} });
  });
}

const CACHE_MS = 60_000;
let lastAttempt = 0;
let lastGood: RuntimeCapacitySnapshot | null = null;
let latest: RuntimeCapacitySnapshot | null = null;
let inflight: Promise<RuntimeCapacitySnapshot> | null = null;

export async function readClaudeAccountCapacity(options: { fresh?: boolean } = {}): Promise<RuntimeCapacitySnapshot> {
  if (inflight) return inflight;
  if (!options.fresh && latest && Date.now() - lastAttempt < CACHE_MS) return latest;
  inflight = (async () => {
    let observed: RuntimeCapacitySnapshot | null = null;
    try { observed = await readLiveClaudeRuntimeCapacity(); } catch { /* Retain a prior observation or local activity. */ }
    if (observed?.status === 'available') lastGood = observed;
    if (observed?.reason === 'subscription_limits_unsupported') lastGood = null;
    const fallback = observed?.reason === 'subscription_limits_unsupported' ? observed : readClaudeRuntimeCapacity();
    latest = observed?.status === 'available' ? observed : lastGood
      ? { ...lastGood, status: 'stale', reason: 'quota_refresh_failed' }
      : fallback.buckets.length ? { ...fallback, reason: 'quota_not_reported' }
        : observed ?? { ...fallback, reason: 'quota_not_reported' };
    lastAttempt = Date.now();
    return latest;
  })().finally(() => { inflight = null; });
  return inflight;
}

export function resetClaudeCapacityForTests(): void {
  lastAttempt = 0; lastGood = null; latest = null; inflight = null;
}
