import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  RuntimeCapacityBucket,
  RuntimeCapacitySnapshot,
  RuntimeCapacitySource,
  RuntimeCapacityStatus,
} from '@/lib/runtimes/types';

// Capacity observation is deliberately narrower than runtime discovery.
// Codex exposes structured limits; Claude Code exposes local token activity,
// not an account quota. Unknown values stay null instead of becoming a
// percentage or remaining-credit estimate.

export type {
  RuntimeCapacityBucket,
  RuntimeCapacityConfidence,
  RuntimeCapacitySnapshot,
  RuntimeCapacitySource,
  RuntimeCapacityStatus,
} from '@/lib/runtimes/types';

export interface CliWindow {
  windowMinutes: number;
  usedPercent: number | null;
  resetsAt: number | null;
  tokens: number | null;
}

/** Legacy drawer projection retained while clients migrate to capacities[]. */
export interface CliUsage {
  runtime: 'codex' | 'claude';
  primary: CliWindow | null;
  secondary: CliWindow | null;
  source: RuntimeCapacitySource | null;
  available: boolean;
  error?: string;
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
export const CAPACITY_STALE_AFTER_MS = 15 * 60 * 1000;
const MAX_OBSERVATION_FILES = 128;
const MAX_DIRECTORY_ENTRIES = 4_096;
const MAX_JSONL_BYTES = 512 * 1024;

type JsonlParseResult = {
  rows: Record<string, unknown>[];
  malformedLines: number;
};

type CapacityRead = {
  capacity: RuntimeCapacitySnapshot;
  legacy: CliUsage;
};

function parseJsonl(content: string): JsonlParseResult {
  const rows: Record<string, unknown>[] = [];
  let malformedLines = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        rows.push(parsed as Record<string, unknown>);
      } else {
        malformedLines += 1;
      }
    } catch {
      malformedLines += 1;
    }
  }
  return { rows, malformedLines };
}

function listFilesRecursive(root: string, suffix: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  let visitedEntries = 0;
  while (stack.length > 0 && out.length < MAX_OBSERVATION_FILES && visitedEntries < MAX_DIRECTORY_ENTRIES) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }
    entries.sort((left, right) => left.localeCompare(right));
    for (const name of entries) {
      visitedEntries += 1;
      if (visitedEntries > MAX_DIRECTORY_ENTRIES || out.length >= MAX_OBSERVATION_FILES) break;
      const full = join(dir, name);
      let stats;
      try { stats = statSync(full); } catch { continue; }
      if (stats.isDirectory()) {
        stack.push(full);
      } else if (stats.isFile() && full.endsWith(suffix)) {
        out.push(full);
      }
    }
  }
  return out;
}

function readJsonlTail(filePath: string): string {
  const stats = statSync(filePath);
  if (stats.size <= MAX_JSONL_BYTES) return readFileSync(filePath, 'utf8');
  const length = Math.min(stats.size, MAX_JSONL_BYTES);
  const buffer = Buffer.alloc(length);
  const descriptor = openSync(filePath, 'r');
  try {
    readSync(descriptor, buffer, 0, length, stats.size - length);
  } finally {
    closeSync(descriptor);
  }
  const text = buffer.toString('utf8');
  const firstLineEnd = text.indexOf('\n');
  return firstLineEnd >= 0 ? text.slice(firstLineEnd + 1) : '';
}

function isoFromMs(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}

function isoFromEpochSeconds(value: number | null): string | null {
  return value === null ? null : isoFromMs(value * 1000);
}

function observationStatus(observedAtMs: number, nowMs: number): RuntimeCapacityStatus {
  return Math.max(0, nowMs - observedAtMs) > CAPACITY_STALE_AFTER_MS ? 'stale' : 'available';
}

function unavailableCapacity(
  runtime: string,
  reason: string,
  source: RuntimeCapacitySource | null = null,
  identityId: string | null = null,
): RuntimeCapacitySnapshot {
  return {
    runtime,
    identityId,
    status: 'unavailable',
    reason,
    observedAt: null,
    source,
    confidence: null,
    buckets: [],
  };
}

function malformedCapacity(
  runtime: string,
  source: RuntimeCapacitySource,
  identityId: string | null = null,
): RuntimeCapacitySnapshot {
  return {
    runtime,
    identityId,
    status: 'malformed',
    reason: 'malformed_observation',
    observedAt: null,
    source,
    confidence: null,
    buckets: [],
  };
}

function unavailableLegacy(runtime: CliUsage['runtime'], error: string): CliUsage {
  return {
    runtime,
    primary: null,
    secondary: null,
    source: null,
    available: false,
    error,
  };
}

// ── Codex ───────────────────────────────────────────────────────────────────

type ParsedCodexWindow = {
  legacy: CliWindow;
  bucket: RuntimeCapacityBucket;
};

function parseCodexWindow(
  id: string,
  fallbackLabel: string,
  raw: unknown,
): ParsedCodexWindow | null | 'malformed' {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'malformed';
  const record = raw as Record<string, unknown>;
  const recognized = ['window_minutes', 'used_percent', 'resets_at'].some((key) => key in record);
  if (!recognized) return 'malformed';

  const rawMinutes = record.window_minutes;
  const rawUsed = record.used_percent;
  const rawReset = record.resets_at;
  if (rawMinutes !== undefined && (typeof rawMinutes !== 'number' || !Number.isFinite(rawMinutes) || rawMinutes <= 0)) {
    return 'malformed';
  }
  if (rawUsed !== undefined && (typeof rawUsed !== 'number' || !Number.isFinite(rawUsed) || rawUsed < 0 || rawUsed > 100)) {
    return 'malformed';
  }
  if (rawReset !== undefined && (typeof rawReset !== 'number' || !Number.isFinite(rawReset) || rawReset <= 0)) {
    return 'malformed';
  }

  const windowMinutes = typeof rawMinutes === 'number' ? rawMinutes : 0;
  const usedPercent = typeof rawUsed === 'number' ? rawUsed : null;
  const resetsAt = typeof rawReset === 'number' ? rawReset : null;
  const label = windowMinutes === 300
    ? '5h'
    : windowMinutes === 10080
      ? 'Weekly'
      : windowMinutes > 0
        ? `${windowMinutes}m`
        : fallbackLabel;
  return {
    legacy: {
      windowMinutes,
      usedPercent,
      resetsAt,
      tokens: null,
    },
    bucket: {
      id,
      label,
      usedRatio: usedPercent === null ? null : usedPercent / 100,
      used: null,
      unit: null,
      remaining: null,
      resetsAt: isoFromEpochSeconds(resetsAt),
      expiresAt: null,
    },
  };
}

export function readCodexRuntimeCapacity(options: {
  nowMs?: number;
  configHome?: string;
  identityId?: string | null;
} = {}): RuntimeCapacitySnapshot {
  return readCodexCapacity(options).capacity;
}

function readCodexCapacity(options: {
  nowMs?: number;
  configHome?: string;
  identityId?: string | null;
} = {}): CapacityRead {
  const nowMs = options.nowMs ?? Date.now();
  const identityId = options.identityId ?? null;
  const configHome = options.configHome?.trim()
    || process.env.CODEX_HOME?.trim()
    || join(homedir(), '.codex');
  const sessionsRoot = join(configHome, 'sessions');
  if (!existsSync(sessionsRoot)) {
    return {
      capacity: unavailableCapacity('codex', 'local_state_missing', null, identityId),
      legacy: unavailableLegacy('codex', 'no codex sessions dir'),
    };
  }
  const files = listFilesRecursive(sessionsRoot, '.jsonl');
  if (files.length === 0) {
    return {
      capacity: unavailableCapacity('codex', 'no_observations', 'structured-cli', identityId),
      legacy: unavailableLegacy('codex', 'no jsonl files'),
    };
  }
  files.sort((left, right) => {
    try { return statSync(right).mtimeMs - statSync(left).mtimeMs; } catch { return 0; }
  });

  let sawMalformedJsonl = false;
  for (const file of files.slice(0, 3)) {
    try {
      const parsed = parseJsonl(readJsonlTail(file));
      sawMalformedJsonl ||= parsed.malformedLines > 0;
      for (let index = parsed.rows.length - 1; index >= 0; index -= 1) {
        const row = parsed.rows[index];
        if (row.type !== 'event_msg') continue;
        const payload = row.payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
        const payloadRecord = payload as Record<string, unknown>;
        if (payloadRecord.type !== 'token_count' || !('rate_limits' in payloadRecord)) continue;
        const rateLimits = payloadRecord.rate_limits;
        if (!rateLimits || typeof rateLimits !== 'object' || Array.isArray(rateLimits)) {
          return {
            capacity: malformedCapacity('codex', 'structured-cli', identityId),
            legacy: unavailableLegacy('codex', 'malformed rate_limits event'),
          };
        }
        const rateLimitRecord = rateLimits as Record<string, unknown>;
        const primary = parseCodexWindow('primary', 'Primary', rateLimitRecord.primary);
        const secondary = parseCodexWindow('secondary', 'Secondary', rateLimitRecord.secondary);
        if (primary === 'malformed' || secondary === 'malformed' || (!primary && !secondary)) {
          return {
            capacity: malformedCapacity('codex', 'structured-cli', identityId),
            legacy: unavailableLegacy('codex', 'malformed rate_limits event'),
          };
        }
        const rowTimestamp = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
        const observedAtMs = Number.isFinite(rowTimestamp) ? rowTimestamp : statSync(file).mtimeMs;
        const status = observationStatus(observedAtMs, nowMs);
        const buckets = [primary, secondary]
          .filter((window): window is ParsedCodexWindow => Boolean(window))
          .map((window) => window.bucket);
        return {
          capacity: {
            runtime: 'codex',
            identityId,
            status,
            reason: status === 'stale' ? 'observation_stale' : null,
            observedAt: isoFromMs(observedAtMs),
            source: 'structured-cli',
            confidence: 'exact',
            buckets,
          },
          legacy: {
            runtime: 'codex',
            primary: primary?.legacy ?? null,
            secondary: secondary?.legacy ?? null,
            source: 'structured-cli',
            available: true,
          },
        };
      }
    } catch {
      sawMalformedJsonl = true;
    }
  }

  return sawMalformedJsonl
    ? {
      capacity: malformedCapacity('codex', 'structured-cli', identityId),
      legacy: unavailableLegacy('codex', 'malformed codex observation'),
    }
    : {
      capacity: unavailableCapacity('codex', 'no_capacity_observation', 'structured-cli', identityId),
      legacy: unavailableLegacy('codex', 'no token_count event'),
    };
}

export function readCodexUsage(): CliUsage {
  return readCodexCapacity().legacy;
}

// ── Claude Code ─────────────────────────────────────────────────────────────

interface ClaudeTurn {
  ts: number;
  inputTokens: number;
  outputTokens: number;
}

type ClaudeTurnRead = {
  turns: ClaudeTurn[];
  malformedObservations: number;
};

function finiteToken(value: unknown): number | null {
  if (value === undefined) return 0;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

// A Claude transcript only changes by being written, which moves its ctime. Keep each file's parsed
// tail until that happens: the capacity read runs about once a minute over up to 128 transcripts,
// and re-reading and re-parsing them all (up to 64 MiB) every time was the bulk of its cost.
const claudeTurnCache = new Map<string, { version: string; read: ClaudeTurnRead }>();

function fileVersion(file: string): string | null {
  try {
    const stats = statSync(file);
    return `${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
  } catch {
    return null;
  }
}

function cachedClaudeTurns(file: string): ClaudeTurnRead {
  const version = fileVersion(file);
  const cached = claudeTurnCache.get(file);
  if (version !== null && cached?.version === version) return cached.read;
  const read = extractClaudeTurns(file);
  if (version !== null) claudeTurnCache.set(file, { version, read });
  return read;
}

function extractClaudeTurns(file: string): ClaudeTurnRead {
  const turns: ClaudeTurn[] = [];
  let malformedObservations = 0;
  try {
    const parsed = parseJsonl(readJsonlTail(file));
    malformedObservations += parsed.malformedLines;
    for (const row of parsed.rows) {
      const message = row.message;
      if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
      const usage = (message as Record<string, unknown>).usage;
      if (usage === undefined) continue;
      if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
        malformedObservations += 1;
        continue;
      }
      const usageRecord = usage as Record<string, unknown>;
      const input = finiteToken(usageRecord.input_tokens);
      const output = finiteToken(usageRecord.output_tokens);
      const cacheCreation = finiteToken(usageRecord.cache_creation_input_tokens);
      if (input === null || output === null || cacheCreation === null) {
        malformedObservations += 1;
        continue;
      }
      const ts = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
      if (!Number.isFinite(ts)) {
        malformedObservations += 1;
        continue;
      }
      const inputTokens = input + cacheCreation;
      if (inputTokens === 0 && output === 0) continue;
      turns.push({ ts, inputTokens, outputTokens: output });
    }
  } catch {
    malformedObservations += 1;
  }
  return { turns, malformedObservations };
}

export function readClaudeRuntimeCapacity(nowMs = Date.now()): RuntimeCapacitySnapshot {
  return readClaudeCapacity(nowMs).capacity;
}

function readClaudeCapacity(nowMs = Date.now()): CapacityRead {
  const claudeHome = process.env.CLAUDE_HOME?.trim() || join(homedir(), '.claude');
  const projectsRoot = join(claudeHome, 'projects');
  if (!existsSync(projectsRoot)) {
    return {
      capacity: unavailableCapacity('claude-code', 'local_state_missing'),
      legacy: unavailableLegacy('claude', 'no claude projects dir'),
    };
  }
  const sevenDaysAgo = nowMs - SEVEN_DAYS_MS;
  const fiveHoursAgo = nowMs - FIVE_HOURS_MS;
  const files = listFilesRecursive(projectsRoot, '.jsonl').filter((file) => {
    try { return statSync(file).mtimeMs >= sevenDaysAgo; } catch { return false; }
  });
  if (files.length === 0) {
    return {
      capacity: unavailableCapacity('claude-code', 'no_recent_observations', 'local-state'),
      legacy: unavailableLegacy('claude', 'no recent jsonl'),
    };
  }

  const fiveHourUsage = { input: 0, output: 0 };
  const weeklyUsage = { input: 0, output: 0 };
  let oldestFiveHourTs: number | null = null;
  let latestTs: number | null = null;
  let malformedObservations = 0;

  for (const cachedFile of [...claudeTurnCache.keys()]) {
    if (!files.includes(cachedFile)) claudeTurnCache.delete(cachedFile);
  }
  for (const file of files) {
    const read = cachedClaudeTurns(file);
    malformedObservations += read.malformedObservations;
    for (const turn of read.turns) {
      if (turn.ts < sevenDaysAgo) continue;
      weeklyUsage.input += turn.inputTokens;
      weeklyUsage.output += turn.outputTokens;
      if (turn.ts >= fiveHoursAgo) {
        fiveHourUsage.input += turn.inputTokens;
        fiveHourUsage.output += turn.outputTokens;
        oldestFiveHourTs = oldestFiveHourTs === null ? turn.ts : Math.min(oldestFiveHourTs, turn.ts);
      }
      latestTs = latestTs === null ? turn.ts : Math.max(latestTs, turn.ts);
    }
  }

  if (latestTs === null) {
    return malformedObservations > 0
      ? {
        capacity: malformedCapacity('claude-code', 'local-state'),
        legacy: unavailableLegacy('claude', 'malformed claude observation'),
      }
      : {
        capacity: unavailableCapacity('claude-code', 'no_usage_observations', 'local-state'),
        legacy: unavailableLegacy('claude', 'no usage observations'),
      };
  }

  const primaryReset = oldestFiveHourTs === null
    ? null
    : Math.floor((oldestFiveHourTs + FIVE_HOURS_MS) / 1000);
  const status = observationStatus(latestTs, nowMs);
  const primary: CliWindow = {
    windowMinutes: 300,
    usedPercent: null,
    resetsAt: primaryReset,
    tokens: fiveHourUsage.input + fiveHourUsage.output,
  };
  const secondary: CliWindow = {
    windowMinutes: 10080,
    usedPercent: null,
    resetsAt: null,
    tokens: weeklyUsage.input + weeklyUsage.output,
  };
  return {
    capacity: {
      runtime: 'claude-code',
      identityId: null,
      status,
      reason: status === 'stale' ? 'observation_stale' : null,
      observedAt: isoFromMs(latestTs),
      source: 'local-state',
      confidence: 'estimated',
      buckets: [
        {
          id: 'rolling-5h',
          label: '5h activity',
          usedRatio: null,
          used: fiveHourUsage.input + fiveHourUsage.output,
          unit: 'tokens',
          remaining: null,
          resetsAt: isoFromEpochSeconds(primaryReset),
          expiresAt: null,
        },
        {
          id: 'rolling-7d',
          label: '7d activity',
          usedRatio: null,
          used: weeklyUsage.input + weeklyUsage.output,
          unit: 'tokens',
          remaining: null,
          resetsAt: null,
          expiresAt: null,
        },
      ],
    },
    legacy: {
      runtime: 'claude',
      primary,
      secondary,
      source: 'local-state',
      available: true,
    },
  };
}

export function readClaudeUsage(): CliUsage {
  return readClaudeCapacity().legacy;
}

export interface CliUsageSnapshot {
  schema: 'o8/runtime-capacity/v1';
  generatedAt: number;
  capacities: RuntimeCapacitySnapshot[];
  codex: CliUsage;
  claude: CliUsage;
}

export function readAllCliUsage(): CliUsageSnapshot {
  const generatedAt = Date.now();
  const codex = readCodexCapacity({ nowMs: generatedAt });
  const claude = readClaudeCapacity(generatedAt);
  return {
    schema: 'o8/runtime-capacity/v1',
    generatedAt,
    capacities: [codex.capacity, claude.capacity],
    codex: codex.legacy,
    claude: claude.legacy,
  };
}
