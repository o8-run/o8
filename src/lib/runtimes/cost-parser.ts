import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { claudeRequestCostUsd, claudeRequestRate, readClaudeRequestTokens } from '@/lib/cost/rate-table';
import { registerCostParser } from './shared/cost-parser-registry';

export type { SessionCostData } from './shared/cost-parser-registry';
import type { SessionCostData } from './shared/cost-parser-registry';

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

function buildParsedUsageEntry(
  usage: ClaudeUsagePayload,
  rawModel: string | null | undefined,
  fallbackModel: string | null,
): ParsedUsageEntry {
  const tokens = readClaudeRequestTokens(usage);
  const pricing = claudeRequestRate(rawModel, usage);
  const model = pricing?.modelKey ?? fallbackModel ?? rawModel?.trim() ?? null;

  return {
    cacheReadTokens: tokens.cacheReadTokens,
    cacheWrite1hTokens: tokens.cacheWrite1hTokens,
    cacheWrite5mTokens: tokens.cacheWriteTokens - tokens.cacheWrite1hTokens,
    cacheWriteTokens: tokens.cacheWriteTokens,
    inputTokens: tokens.inputTokens,
    model,
    outputTokens: tokens.outputTokens,
    totalCostUsd: pricing ? claudeRequestCostUsd(pricing, tokens) : 0,
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
