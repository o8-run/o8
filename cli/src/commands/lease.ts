import { ambientChildEnvironment } from '../../../src/lib/providers/ambient-environment.js';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveCliDataDir, resolveConfig } from '../config.js';
import { printHumanHeading, printHumanKv, printJson, type OutputMode } from '../output.js';

const DEFAULT_TTL_MS = 2 * 60 * 60_000;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 24 * 60 * 60_000;
const WAIT_POLL_MS = 100;
const CLAIM_FILE_SCHEMA = 'o8/cli/lease-claim/v1';

interface LeaseOwner {
  id: string;
  label: string;
  pid: number;
}

interface StoredLeaseClaim {
  schema: typeof CLAIM_FILE_SCHEMA;
  resource: string;
  ownerId: string;
  ownerPid: number;
  claimToken: string;
}

interface LeaseHolder {
  resource: string;
  leaseId: string;
  owner: LeaseOwner;
  acquiredAt: string;
  ttlMs: number;
  heartbeatAt: string;
  expiresAt: string;
  overdue: boolean;
}

interface LeaseWaiter {
  waiterId: string;
  owner: LeaseOwner;
  position: number;
  enqueuedAt: string;
}

interface LeaseSnapshot {
  resource: string;
  holder: LeaseHolder | null;
  waiters: LeaseWaiter[];
  blocked: { code: string; message: string } | null;
}

interface AcquirePayload {
  schema: string;
  ok: boolean;
  result: {
    state: 'acquired' | 'queued' | 'refused';
    lease?: LeaseHolder;
    waiter?: LeaseWaiter;
    holder?: LeaseHolder | null;
    nextWaiter?: LeaseWaiter | null;
    blocked?: LeaseSnapshot['blocked'];
    reason?: string;
  };
}

interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

interface LeaseOwnerPidOptions {
  ppid?: number;
  env?: NodeJS.ProcessEnv;
  readProcess?: (pid: number) => ProcessRow | null;
}

const TRANSIENT_PARENT_NAMES = new Set([
  'bash',
  'cmd',
  'cmd.exe',
  'dash',
  'env',
  'fish',
  'ksh',
  'npm',
  'npm-cli.js',
  'npx',
  'npx-cli.js',
  'powershell',
  'powershell.exe',
  'pwsh',
  'sh',
  'zsh',
]);

function readProcessRow(pid: number): ProcessRow | null {
  if (process.platform === 'win32') {
    const script = [
      `$row = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop`,
      'if ($null -eq $row) { exit 3 }',
      '$command = if ($null -ne $row.CommandLine) { $row.CommandLine } else { $row.Name }',
      '[Console]::Out.Write("$($row.ParentProcessId)`n$command")',
    ].join('; ');
    const receipt = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], { encoding: 'utf8', timeout: 2_000, windowsHide: true });
    if (receipt.status !== 0) return null;
    const [rawPpid, command = ''] = receipt.stdout.trim().split(/\r?\n/, 2);
    const ppid = Number(rawPpid);
    return Number.isSafeInteger(ppid) && ppid >= 0 ? { pid, ppid, command } : null;
  }
  const receipt = spawnSync('/bin/ps', [
    '-o',
    'ppid=',
    '-o',
    'command=',
    '-p',
    String(pid),
  ], {
    encoding: 'utf8',
    env: { ...ambientChildEnvironment(), LANG: 'C', LC_ALL: 'C' },
    timeout: 2_000,
    windowsHide: true,
  });
  if (receipt.status !== 0) return null;
  const match = receipt.stdout.match(/^\s*(\d+)\s+(.+?)\s*$/);
  if (!match) return null;
  return { pid, ppid: Number(match[1]), command: match[2] };
}

function hasAgentSession(env: NodeJS.ProcessEnv): boolean {
  return [
    env.O8_WORKER_PACKET_ID,
    env.O8_OWNED_RUN_MARKER,
    env.CODEX_SESSION_ID,
    env.CODEX_THREAD_ID,
    env.CLAUDE_CODE_SESSION_ID,
    env.CLAUDECODE,
    env.AI_AGENT,
  ].some((value) => Boolean(value?.trim()));
}

function commandName(command: string): string {
  const match = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return path.basename(match?.[1] ?? match?.[2] ?? match?.[3] ?? '').toLowerCase();
}

function isTransientParent(command: string): boolean {
  const name = commandName(command);
  if (TRANSIENT_PARENT_NAMES.has(name)) return true;
  return (name === 'node' || name === 'node.exe')
    && /(?:^|[/\\])(?:npm|npx)(?:-cli)?\.js(?:\s|$)/i.test(command);
}

function isExplicitCommandWrapper(command: string): boolean {
  const name = commandName(command);
  if (name === 'env' || name === 'npm' || name === 'npx'
    || name === 'npm-cli.js' || name === 'npx-cli.js') return true;
  if ((name === 'node' || name === 'node.exe')
    && /(?:^|[/\\])(?:npm|npx)(?:-cli)?\.js(?:\s|$)/i.test(command)) return true;
  if (name === 'cmd' || name === 'cmd.exe') return /(?:^|\s)\/c(?:\s|$)/i.test(command);
  if (name === 'powershell' || name === 'powershell.exe' || name === 'pwsh') {
    return /(?:^|\s)-(?:command|encodedcommand)(?:\s|$)/i.test(command);
  }
  return TRANSIENT_PARENT_NAMES.has(name)
    && /(?:^|\s)-[a-z]*c[a-z]*(?:\s|$)/i.test(command);
}

/** Resolve the stable session process above short-lived command-shell parents. */
export function resolveLeaseOwnerPid(options: LeaseOwnerPidOptions = {}): number | null {
  const immediateParent = options.ppid ?? process.ppid;
  if (!Number.isSafeInteger(immediateParent) || immediateParent <= 1) return null;
  const env = options.env ?? process.env;
  const readProcess = options.readProcess ?? readProcessRow;
  const initialRow = readProcess(immediateParent);
  if (!initialRow || initialRow.pid !== immediateParent || !Number.isSafeInteger(initialRow.ppid)) {
    return hasAgentSession(env) ? null : immediateParent;
  }
  if (!hasAgentSession(env) && !isExplicitCommandWrapper(initialRow.command)) {
    return immediateParent;
  }
  let candidate = immediateParent;
  let row: ProcessRow | null = initialRow;
  const seen = new Set<number>();
  for (let depth = 0; depth < 8 && candidate > 1 && !seen.has(candidate); depth += 1) {
    seen.add(candidate);
    if (row?.pid !== candidate) row = readProcess(candidate);
    if (!row || row.pid !== candidate || !Number.isSafeInteger(row.ppid)) return null;
    if (!isTransientParent(row.command)) return candidate;
    candidate = row.ppid;
    row = null;
  }
  return null;
}

function flag(rest: string[], name: string): string | null {
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === `--${name}`) return rest[index + 1] ?? '';
    if (token.startsWith(`--${name}=`)) return token.slice(name.length + 3);
  }
  return null;
}

function firstPositional(rest: string[]): string | null {
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token.startsWith('--')) {
      if (!token.includes('=') && token === '--ttl') index += 1;
      continue;
    }
    return token.trim() || null;
  }
  return null;
}

export function parseLeaseTtlMs(raw: string | null): number {
  if (!raw) return DEFAULT_TTL_MS;
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!match) {
    throw new CliError('invalid_ttl', 'Lease TTL must use ms, s, m, or h.', EXIT.INVALID_ARGS);
  }
  const value = Number(match[1]);
  const unit = (match[2] ?? 'ms').toLowerCase();
  const ttlMs = unit === 'h'
    ? value * 3_600_000
    : unit === 'm' ? value * 60_000 : unit === 's' ? value * 1_000 : value;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
    throw new CliError(
      'invalid_ttl',
      'Lease TTL must resolve to an integer from 1 second through 24 hours.',
      EXIT.INVALID_ARGS,
    );
  }
  return ttlMs;
}

function safeAscii(value: string, fallback: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ').replace(/[^\x20-\x7e]/g, '');
  return (normalized || fallback).slice(0, maxLength);
}

function leaseOwner(): LeaseOwner {
  const pid = resolveLeaseOwnerPid();
  if (!pid) {
    throw new CliError(
      'owner_process_unresolved',
      'Lease ownership could not be bound to a stable local process.',
      EXIT.CONFLICT,
      'Use the MCP lease tools from a persistent agent session, or retry from a readable interactive shell.',
    );
  }
  const workerPacket = process.env.O8_WORKER_PACKET_ID?.trim();
  const session = process.env.CLAUDE_CODE_SESSION_ID?.trim()
    || process.env.CODEX_SESSION_ID?.trim()
    || process.env.CODEX_THREAD_ID?.trim()
    || process.env.TERM_SESSION_ID?.trim();
  const id = workerPacket
    ? `packet:${workerPacket}`
    : session ? `session:${session}` : `process:${pid}`;
  const runtime = process.env.AI_AGENT?.split('_')[0]
    || (process.env.CLAUDECODE ? 'claude-code' : 'agent');
  return {
    id: safeAscii(id, `process:${pid}`, 256),
    label: safeAscii(`${runtime}:${workerPacket || session || pid}`, `agent:${pid}`, 128),
    pid,
  };
}

function waiterId(owner: LeaseOwner): string {
  return `waiter:${owner.id}:${process.pid}:${Date.now()}`.slice(0, 512);
}

function claimFileName(resource: string, owner: LeaseOwner): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([resource, owner.id, owner.pid]), 'utf8')
    .digest('hex');
  return `${digest}.json`;
}

function claimDirectories(): string[] {
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'current-user';
  return [
    path.join(resolveCliDataDir(), 'lease-claims'),
    path.join(os.tmpdir(), `o8-lease-claims-${uid}`),
  ];
}

function readLeaseClaim(resource: string, owner: LeaseOwner): { claim: StoredLeaseClaim; path: string } | null {
  const fileName = claimFileName(resource, owner);
  for (const directory of claimDirectories()) {
    const file = path.join(directory, fileName);
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoredLeaseClaim;
      if (parsed.schema === CLAIM_FILE_SCHEMA
        && parsed.resource === resource
        && parsed.ownerId === owner.id
        && parsed.ownerPid === owner.pid
        && /^[A-Za-z0-9_-]{32,256}$/.test(parsed.claimToken)) {
        return { claim: parsed, path: file };
      }
      throw new Error('claim contents do not match this process and resource');
    } catch (error) {
      throw new CliError(
        'lease_claim_invalid',
        `The private lease claim at ${file} is invalid: ${error instanceof Error ? error.message : String(error)}`,
        EXIT.CONFLICT,
      );
    }
  }
  return null;
}

function loadOrCreateLeaseClaim(resource: string, owner: LeaseOwner): { claim: StoredLeaseClaim; path: string } {
  const existing = readLeaseClaim(resource, owner);
  if (existing) return existing;
  const claim: StoredLeaseClaim = {
    schema: CLAIM_FILE_SCHEMA,
    resource,
    ownerId: owner.id,
    ownerPid: owner.pid,
    claimToken: randomBytes(32).toString('base64url'),
  };
  const fileName = claimFileName(resource, owner);
  let lastError: unknown;
  for (const directory of claimDirectories()) {
    const file = path.join(directory, fileName);
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(file, `${JSON.stringify(claim)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      return { claim, path: file };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const concurrent = readLeaseClaim(resource, owner);
        if (concurrent) return concurrent;
      }
      lastError = error;
    }
  }
  throw new CliError(
    'lease_claim_unavailable',
    `The private lease claim could not be persisted: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    EXIT.CONFLICT,
  );
}

function removeLeaseClaim(file: string): void {
  try {
    unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write('warning: released lease, but could not remove its private claim file\n');
    }
  }
}

function holderSummary(holder: LeaseHolder | null | undefined): string {
  if (!holder) return '(none)';
  return `${holder.owner.label} (${holder.owner.id}, pid ${holder.owner.pid})`;
}

function printAcquire(mode: OutputMode, resource: string, result: AcquirePayload['result']): void {
  const payload = { schema: 'o8/cli/lease.acquire/v1', ok: result.state === 'acquired', resource, result };
  if (!mode.human) return printJson(payload);
  printHumanHeading('lease acquire');
  printHumanKv([
    ['resource', resource],
    ['state', result.state],
    ['holder', result.state === 'acquired' ? holderSummary(result.lease) : holderSummary(result.holder)],
    ['lease', result.lease?.leaseId ?? '(none)'],
    ['reason', result.reason ?? result.blocked?.message ?? ''],
  ]);
}

async function acquire(mode: OutputMode, rest: string[]): Promise<number> {
  const resource = firstPositional(rest);
  if (!resource) {
    throw new CliError(
      'invalid_args',
      'o8 lease acquire requires a resource name.',
      EXIT.INVALID_ARGS,
      'Example: o8 lease acquire test-suite:repo:full-serial --ttl 2h --wait',
    );
  }
  const owner = leaseOwner();
  const leaseClaim = loadOrCreateLeaseClaim(resource, owner);
  const wait = rest.includes('--wait');
  const ttlMs = parseLeaseTtlMs(flag(rest, 'ttl'));
  const requestId = waiterId(owner);
  const cfg = resolveConfig();
  let interrupted = false;
  let queuedReported = false;
  const interrupt = () => { interrupted = true; };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    for (;;) {
      if (interrupted) {
        throw new CliError('interrupted', `Stopped waiting for ${resource}.`, EXIT.INVALID_ARGS);
      }
      const response = await apiFetch<AcquirePayload>(cfg, '/api/leases', {
        method: 'POST',
        allowConflict: true,
        body: {
          action: 'acquire',
          resource,
          owner,
          claimToken: leaseClaim.claim.claimToken,
          waiterPid: wait ? process.pid : undefined,
          ttlMs,
          wait,
          waiterId: requestId,
        },
      });
      const result = response.data?.result;
      if (!result) {
        throw new CliError('invalid_response', 'Lease acquire returned no result.', EXIT.INVALID_ARGS);
      }
      if (result.state === 'acquired') {
        printAcquire(mode, resource, result);
        return EXIT.OK;
      }
      if (result.state === 'refused' || !wait) {
        printAcquire(mode, resource, result);
        return EXIT.CONFLICT;
      }
      if (mode.human && !queuedReported) {
        process.stderr.write(
          `queued for '${resource}' at position ${result.waiter?.position ?? '?'}; current holder ${holderSummary(result.holder)}\n`,
        );
        queuedReported = true;
      }
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
    }
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

async function release(mode: OutputMode, rest: string[]): Promise<number> {
  const resource = firstPositional(rest);
  if (!resource) {
    throw new CliError('invalid_args', 'o8 lease release requires a resource name.', EXIT.INVALID_ARGS);
  }
  const owner = leaseOwner();
  const leaseClaim = readLeaseClaim(resource, owner);
  if (!leaseClaim) {
    throw new CliError(
      'lease_claim_unavailable',
      `This process has no private claim for ${resource}.`,
      EXIT.CONFLICT,
    );
  }
  const response = await apiFetch<{
    ok: boolean;
    result?: { released: boolean; lease: LeaseHolder | null; nextHolder: LeaseHolder | null; refusal?: unknown };
  }>(resolveConfig(), '/api/leases', {
    method: 'POST',
    allowConflict: true,
    allowNotFound: true,
    body: {
      action: 'release',
      resource,
      owner,
      claimToken: leaseClaim.claim.claimToken,
    },
  });
  const result = response.data?.result;
  const payload = { schema: 'o8/cli/lease.release/v1', ok: result?.released === true, resource, result: result ?? null };
  if (mode.human) {
    printHumanHeading('lease release');
    printHumanKv([
      ['resource', resource],
      ['released', result?.released ? 'yes' : 'no'],
      ['next holder', holderSummary(result?.nextHolder)],
    ]);
  } else {
    printJson(payload);
  }
  if (result?.released) removeLeaseClaim(leaseClaim.path);
  return result?.released ? EXIT.OK : response.status === 404 ? EXIT.NOT_FOUND : EXIT.CONFLICT;
}

async function status(mode: OutputMode, rest: string[]): Promise<number> {
  const resource = firstPositional(rest);
  if (!resource) {
    throw new CliError('invalid_args', 'o8 lease status requires a resource name.', EXIT.INVALID_ARGS);
  }
  const response = await apiFetch<{ ok: boolean; lease?: LeaseSnapshot }>(
    resolveConfig(),
    '/api/leases',
    { query: { resource } },
  );
  const lease = response.data?.lease;
  if (!lease) throw new CliError('invalid_response', 'Lease status returned no snapshot.', EXIT.INVALID_ARGS);
  if (mode.human) {
    printHumanHeading('lease status');
    printHumanKv([
      ['resource', lease.resource],
      ['holder', holderSummary(lease.holder)],
      ['overdue', lease.holder?.overdue ? 'yes (still held)' : 'no'],
      ['waiters', String(lease.waiters.length)],
      ['blocked', lease.blocked?.message ?? 'no'],
    ]);
  } else {
    printJson({ schema: 'o8/cli/lease.status/v1', ok: true, lease });
  }
  return EXIT.OK;
}

async function list(mode: OutputMode): Promise<number> {
  const response = await apiFetch<{ ok: boolean; count?: number; leases?: LeaseSnapshot[] }>(
    resolveConfig(),
    '/api/leases',
  );
  const leases = response.data?.leases ?? [];
  if (mode.human) {
    printHumanHeading(`leases (${leases.length})`);
    if (leases.length === 0) printHumanKv([['', '(no active leases)']]);
    else printHumanKv(leases.map((lease) => [
      lease.resource,
      `${holderSummary(lease.holder)} · ${lease.waiters.length} waiter${lease.waiters.length === 1 ? '' : 's'}`,
    ]));
  } else {
    printJson({ schema: 'o8/cli/lease.list/v1', ok: true, count: leases.length, leases });
  }
  return EXIT.OK;
}

export async function runLease(
  mode: OutputMode,
  action: string | undefined,
  rest: string[],
): Promise<number> {
  if (action === 'acquire') return acquire(mode, rest);
  if (action === 'release') return release(mode, rest);
  if (action === 'status') return status(mode, rest);
  if (action === 'list') return list(mode);
  throw new CliError(
    'unknown_lease_subcommand',
    `Unknown lease subcommand: ${action ?? '(none)'}`,
    EXIT.INVALID_ARGS,
    'Subcommands: acquire | release | status | list.',
  );
}
