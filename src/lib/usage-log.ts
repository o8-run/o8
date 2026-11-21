import { createReadStream } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { findLaneBySession, getLane } from '@/lib/lane/registry';
import { parseSessionCost } from '@/lib/runtimes/cost-parser';
import type { RuntimeTelemetry } from '@/lib/runtimes/types';
import { getDataDir } from '@/lib/data-dir-migration';

const USAGE_LOG_DIR = getDataDir();
const USAGE_LOG_PATH = path.join(USAGE_LOG_DIR, 'usage.jsonl');
const inFlightUsageDispatches = new Set<string>();

export type DispatchUsageRuntime = 'claude-code' | 'codex' | 'opencode';

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model?: string | null;
}

interface UsageDispatchCompletion {
  finishedAtMs?: number;
  snapshot?: UsageSnapshot | null;
}

interface MonitorUsageDispatchOptions {
  dispatchKey: string;
  runtime: DispatchUsageRuntime;
  laneId?: string;
  sessionKey?: string;
  model?: string | null;
  startedAtMs: number;
  baseline?: UsageSnapshot | null;
  awaitCompletion: () => Promise<UsageDispatchCompletion>;
}

interface UsageLogRow {
  ts: string;
  packetId: string;
  model: string;
  runtime: DispatchUsageRuntime;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

function toFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeModel(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed || 'unknown';
}

function resolvePacketId(laneId?: string, sessionKey?: string) {
  const normalizedLaneId = laneId?.trim();
  if (!normalizedLaneId) {
    try {
      return findLaneBySession(sessionKey?.trim() ?? '')?.packetId?.trim() ?? '';
    } catch {
      return '';
    }
  }

  try {
    return getLane(normalizedLaneId)?.packetId?.trim() ?? '';
  } catch {
    return '';
  }
}

function diffUsageSnapshot(
  baseline: UsageSnapshot | null | undefined,
  finalSnapshot: UsageSnapshot | null | undefined,
) {
  const before = baseline ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const after = finalSnapshot ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };

  return {
    inputTokens: Math.max(0, Math.round(after.inputTokens - before.inputTokens)),
    outputTokens: Math.max(0, Math.round(after.outputTokens - before.outputTokens)),
    costUsd: Math.max(0, Number((after.costUsd - before.costUsd).toFixed(6))),
    model: after.model ?? before.model ?? null,
  };
}

async function appendUsageLogRow(row: UsageLogRow) {
  try {
    await mkdir(USAGE_LOG_DIR, { recursive: true });
    await appendFile(USAGE_LOG_PATH, `${JSON.stringify(row)}\n`, 'utf8');
  } catch {
    // Silent skip by contract.
  }
}

export function usageSnapshotFromTelemetry(telemetry?: RuntimeTelemetry | null): UsageSnapshot {
  return {
    inputTokens: Math.max(0, Math.round(toFiniteNumber(telemetry?.inputTokens))),
    outputTokens: Math.max(0, Math.round(toFiniteNumber(telemetry?.outputTokens))),
    costUsd: Math.max(0, Number(toFiniteNumber(telemetry?.estimatedCostUsd).toFixed(6))),
    model: telemetry?.model ?? null,
  };
}

export async function readClaudeUsageSnapshot(jsonlPath: string): Promise<UsageSnapshot> {
  const sessionCost = await parseSessionCost(jsonlPath);
  let latestReportedCost: number | null = null;

  const lineReader = createInterface({
    input: createReadStream(jsonlPath, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of lineReader) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed) as { type?: unknown; total_cost_usd?: unknown; cost_usd?: unknown };
      if (parsed.type !== 'result') continue;

      if (typeof parsed.total_cost_usd === 'number' && Number.isFinite(parsed.total_cost_usd)) {
        latestReportedCost = parsed.total_cost_usd;
        continue;
      }

      if (typeof parsed.cost_usd === 'number' && Number.isFinite(parsed.cost_usd)) {
        latestReportedCost = parsed.cost_usd;
      }
    } catch {
      continue;
    }
  }

  return {
    inputTokens: sessionCost.inputTokens,
    outputTokens: sessionCost.outputTokens,
    costUsd: Number((latestReportedCost ?? sessionCost.totalCostUsd).toFixed(6)),
    model: sessionCost.model,
  };
}

export function monitorUsageDispatch(options: MonitorUsageDispatchOptions) {
  if (inFlightUsageDispatches.has(options.dispatchKey)) {
    return;
  }

  inFlightUsageDispatches.add(options.dispatchKey);
  const packetId = resolvePacketId(options.laneId, options.sessionKey);
  void (async () => {
    let completion: UsageDispatchCompletion = {};

    try {
      completion = await options.awaitCompletion();
    } catch {
      completion = {};
    } finally {
      inFlightUsageDispatches.delete(options.dispatchKey);
    }

    const finishedAtMs = Number.isFinite(completion.finishedAtMs)
      ? Math.max(options.startedAtMs, completion.finishedAtMs ?? options.startedAtMs)
      : Date.now();
    const delta = diffUsageSnapshot(options.baseline, completion.snapshot);

    await appendUsageLogRow({
      ts: new Date(finishedAtMs).toISOString(),
      packetId,
      model: normalizeModel(delta.model ?? options.model),
      runtime: options.runtime,
      inputTokens: delta.inputTokens,
      outputTokens: delta.outputTokens,
      costUsd: delta.costUsd,
      durationMs: Math.max(0, Math.round(finishedAtMs - options.startedAtMs)),
    });
  })();
}
