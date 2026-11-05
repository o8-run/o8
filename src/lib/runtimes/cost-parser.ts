import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { requestRate, resolveRate, type ResolvedRate } from '@/lib/cost/rate-table';
import { registerCostParser } from './shared/cost-parser-registry';

export type { SessionCostData } from './shared/cost-parser-registry';
import type { SessionCostData } from './shared/cost-parser-registry';

const TOKENS_PER_MILLION = 1_000_000;

interface ClaudeUsagePayload {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  service_tier?: string | null;
  speed?: string | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

interface ClaudeJsonlEntry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  requestId?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: ClaudeUsagePayload;
  };
}

interface ParsedUsageEntry {
  cacheReadTokens: number;
  cacheWrite1hTokens: number;
  cacheWrite5mTokens: number;
  cacheWriteTokens: number;
  inputTokens: number;
  model: string | null;
  outputTokens: number;
  totalCostUsd: number;
}

function toTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function detectPricingModel(rawModel: string | null | undefined, usage: ClaudeUsagePayload): ResolvedRate | null {
  const normalizedModel = rawModel?.trim().toLowerCase();
  if (!normalizedModel || normalizedModel === '<synthetic>') {
    return null;
  }

  const normalizedTier = usage.service_tier?.trim().toLowerCase();
  const normalizedSpeed = usage.speed?.trim().toLowerCase();
  const isFastTier = normalizedTier === 'fast'
    || normalizedTier === 'priority'
    || normalizedSpeed === 'fast'
    || normalizedModel.includes('fast');
  const lookupModel = isFastTier && !normalizedModel.includes('fast')
    ? `${normalizedModel}-fast`
    : normalizedModel;
  return resolveRate('anthropic', lookupModel);
}

function buildParsedUsageEntry(
  usage: ClaudeUsagePayload,
  rawModel: string | null | undefined,
  fallbackModel: string | null,
): ParsedUsageEntry {
  const inputTokens = toTokenCount(usage.input_tokens);
  const outputTokens = toTokenCount(usage.output_tokens);
  const cacheReadTokens = toTokenCount(usage.cache_read_input_tokens);
  const cacheWrite5mTokens = toTokenCount(usage.cache_creation?.ephemeral_5m_input_tokens);
  const cacheWrite1hTokens = toTokenCount(usage.cache_creation?.ephemeral_1h_input_tokens);
  const cacheWriteTokens = Math.max(
    toTokenCount(usage.cache_creation_input_tokens),
    cacheWrite5mTokens + cacheWrite1hTokens,
  );
  const cacheWriteRemainder = Math.max(0, cacheWriteTokens - cacheWrite5mTokens - cacheWrite1hTokens);
  const normalizedCacheWrite5mTokens = cacheWrite5mTokens + cacheWriteRemainder;
  const resolved = detectPricingModel(rawModel, usage);
  // Haiku 5.5 prices a request whose prompt (input, cache reads and cache
  // writes) passes 100K tokens at its long-prompt rates.
  const pricing = resolved && requestRate(resolved, inputTokens + cacheReadTokens + cacheWriteTokens);
  const model = pricing?.modelKey ?? fallbackModel ?? rawModel?.trim() ?? null;

  const totalCostUsd = (
    (inputTokens * (pricing?.inputUsdPerMillion ?? 0))
    + (outputTokens * (pricing?.outputUsdPerMillion ?? 0))
    + (cacheReadTokens * (pricing?.cacheReadUsdPerMillion ?? 0))
    + (normalizedCacheWrite5mTokens * (pricing?.cacheWriteUsdPerMillion ?? 0))
    + (cacheWrite1hTokens * (pricing?.cacheWrite1hUsdPerMillion ?? 0))
  ) / TOKENS_PER_MILLION;

  return {
    cacheReadTokens,
    cacheWrite1hTokens,
    cacheWrite5mTokens: normalizedCacheWrite5mTokens,
    cacheWriteTokens,
    inputTokens,
    model,
    outputTokens,
    totalCostUsd,
  };
}

async function jsonlFilesInDirectory(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(directory, entry.name));
}

/**
 * Claude stores native child-agent transcripts beside the parent JSONL at
 * `<session-id>/subagents/*.jsonl`. They are separate billable sessions, but
 * carry the same parent session id. Include them in cost parsing and rely on
 * request-id dedupe below so a provider replay cannot charge the same request
 * twice.
 */
async function resolveSessionFiles(
  sessionDir: string,
  includeChildSessions: boolean,
): Promise<string[]> {
  const sessionPath = path.resolve(sessionDir);
  const stats = await stat(sessionPath).catch(() => null);
  if (!stats) {
    return [];
  }

  if (stats.isFile()) {
    if (path.extname(sessionPath) !== '.jsonl') {
      return [];
    }
    if (!includeChildSessions) {
      return [sessionPath];
    }
    const childDirectory = path.join(
      path.dirname(sessionPath),
      path.basename(sessionPath, '.jsonl'),
      'subagents',
    );
    return [sessionPath, ...await jsonlFilesInDirectory(childDirectory)].sort();
  }

  if (!stats.isDirectory()) {
    return [];
  }

  const directFiles = await jsonlFilesInDirectory(sessionPath);
  const childFiles = includeChildSessions
    ? await jsonlFilesInDirectory(path.join(sessionPath, 'subagents'))
    : [];
  return [...directFiles, ...childFiles].sort();
}

export async function parseSessionCost(
  sessionDir: string,
  options?: { includeChildSessions?: boolean },
): Promise<SessionCostData> {
  const sessionFiles = await resolveSessionFiles(sessionDir, options?.includeChildSessions !== false);
  const dedupedUsage = new Map<string, ParsedUsageEntry>();
  let fallbackModel: string | null = null;

  for (const sessionFile of sessionFiles) {
    const lineReader = createInterface({
      input: createReadStream(sessionFile, { encoding: 'utf8' }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    let lineNumber = 0;
    for await (const line of lineReader) {
      lineNumber += 1;
      if (!line.trim()) continue;

      let entry: ClaudeJsonlEntry;
      try {
        entry = JSON.parse(line) as ClaudeJsonlEntry;
      } catch {
        continue;
      }

      if (entry.type !== 'assistant' || !entry.message?.usage) {
        continue;
      }

      const parsedUsage = buildParsedUsageEntry(entry.message.usage, entry.message.model, fallbackModel);
      const totalTokens = parsedUsage.inputTokens
        + parsedUsage.outputTokens
        + parsedUsage.cacheReadTokens
        + parsedUsage.cacheWriteTokens;
      if (parsedUsage.model && parsedUsage.model !== '<synthetic>') {
        fallbackModel = parsedUsage.model;
      }
      if (totalTokens === 0) {
        continue;
      }

      const dedupeKey = entry.requestId
        ?? entry.message.id
        ?? entry.uuid
        ?? `${sessionFile}:${entry.timestamp ?? lineNumber}`;
      const existing = dedupedUsage.get(dedupeKey);
      if (!existing) {
        dedupedUsage.set(dedupeKey, parsedUsage);
        continue;
      }

      dedupedUsage.set(dedupeKey, {
        cacheReadTokens: Math.max(existing.cacheReadTokens, parsedUsage.cacheReadTokens),
        cacheWrite1hTokens: Math.max(existing.cacheWrite1hTokens, parsedUsage.cacheWrite1hTokens),
        cacheWrite5mTokens: Math.max(existing.cacheWrite5mTokens, parsedUsage.cacheWrite5mTokens),
        cacheWriteTokens: Math.max(existing.cacheWriteTokens, parsedUsage.cacheWriteTokens),
        inputTokens: Math.max(existing.inputTokens, parsedUsage.inputTokens),
        model: parsedUsage.model ?? existing.model,
        outputTokens: Math.max(existing.outputTokens, parsedUsage.outputTokens),
        totalCostUsd: Math.max(existing.totalCostUsd, parsedUsage.totalCostUsd),
      });
    }
  }

  const totals: SessionCostData = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalCostUsd: 0,
    model: null,
  };
  const models = new Set<string>();

  for (const usage of dedupedUsage.values()) {
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.cacheReadTokens += usage.cacheReadTokens;
    totals.cacheWriteTokens += usage.cacheWriteTokens;
    totals.totalCostUsd += usage.totalCostUsd;
    if (usage.model) {
      models.add(usage.model);
    }
  }

  totals.totalCostUsd = Number(totals.totalCostUsd.toFixed(6));
  totals.model = models.size === 1 ? [...models][0] : models.size > 1 ? 'mixed' : fallbackModel;
  if (totals.totalCostUsd > 0) totals.costSource = 'estimate';

  return totals;
}

// ── Zero-cost sentinel returned when the Claude parser finds no data ──────────
const EMPTY_COST: SessionCostData = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalCostUsd: 0,
  model: null,
};

// ── Self-registration ─────────────────────────────────────────────────────────
// Runs on import so the registry is populated before any caller invokes parseCost.
registerCostParser({
  runtimeId: 'claude-code',
  async parseFiles(paths) {
    // parseSessionCost accepts a single path (file or directory).
    // The Claude parser derives the model from the JSONL itself — no fallback needed.
    // Use the first path; multi-path support can be added per-adapter later.
    const firstPath = paths[0];
    if (!firstPath) {
      return EMPTY_COST;
    }
    return parseSessionCost(firstPath);
  },
});
