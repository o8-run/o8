import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { modelRateTable } from '@/lib/cost/rate-table';
import { getDb, getSqlite, usageLogs } from '@/lib/db';
import type { UsageRole } from '@/lib/db/usage';
import { getRuntime } from '@/lib/runtimes';
import { ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';
import { derivePacketAttemptIndex } from '@/lib/orchestrator/cost-attribution';

const LOG_PREFIX = '[cost-persistence]';

type UsageProvider = 'anthropic' | 'openai' | 'google' | 'openrouter' | 'opencode' | 'runtime';

export interface PersistSessionCostInput {
  sessionKey: string;
  runtime: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd: number;
  repoPath: string;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costSource?: 'gateway' | 'estimate' | 'unknown';
  laneId?: string | null;
  packetId?: string | null;
  missionId?: string | null;
  role?: UsageRole | null;
  runId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface PersistedSessionCost {
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  model: string | null;
  costSource: 'gateway' | 'estimate';
  laneId: string | null;
  packetId: string | null;
  missionId: string | null;
  role: UsageRole | null;
  attempt: number;
  runId: string | null;
  metadataJson: string | null;
}

function billingPeriodFor(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeTokenCount(value: unknown) {
  return Math.max(0, Math.round(finiteNumber(value)));
}

function normalizeUsd(value: number) {
  return Number(finiteNumber(value).toFixed(6));
}

function metadataJsonForCostSource(
  metadata: Record<string, unknown> | null | undefined,
  costSource: PersistSessionCostInput['costSource'],
): string | null {
  const normalized = { ...(metadata ?? {}) };
  if (costSource === 'gateway') {
    normalized.costSource = 'gateway';
    delete normalized.rateTableVersion;
  } else if (costSource === 'estimate') {
    normalized.costSource = 'estimate';
    normalized.rateTableVersion = modelRateTable.rateTableVersion;
  } else if (costSource === 'unknown') {
    normalized.costSource = 'unknown';
    delete normalized.rateTableVersion;
  }
  return Object.keys(normalized).length > 0 ? JSON.stringify(normalized) : null;
}

export function readPersistedSessionCosts(sessionKey: string): PersistedSessionCost[] {
  const normalized = sessionKey.trim();
  const db = getDb();
  if (!normalized || !db) return [];

  const rows = db
    .select({
      inputTokens: usageLogs.inputTokens,
      outputTokens: usageLogs.outputTokens,
      costUsd: usageLogs.costUsd,
      model: usageLogs.model,
      provider: usageLogs.provider,
      laneId: usageLogs.laneId,
      packetId: usageLogs.packetId,
      missionId: usageLogs.missionId,
      role: usageLogs.role,
      attempt: usageLogs.attempt,
      runId: usageLogs.runId,
      metadataJson: usageLogs.metadataJson,
    })
    .from(usageLogs)
    .where(eq(usageLogs.sessionKey, normalized))
    .orderBy(asc(usageLogs.attempt), asc(usageLogs.createdAt))
    .all();

  return rows.map((row) => ({
    inputTokens: normalizeTokenCount(row.inputTokens),
    outputTokens: normalizeTokenCount(row.outputTokens),
    totalCostUsd: normalizeUsd(row.costUsd),
    model: row.model?.trim() || null,
    costSource: row.provider === 'openrouter' ? 'gateway' : 'estimate',
    laneId: row.laneId?.trim() || null,
    packetId: row.packetId?.trim() || null,
    missionId: row.missionId?.trim() || null,
    role: row.role,
    attempt: Math.max(1, normalizeTokenCount(row.attempt)),
    runId: row.runId?.trim() || null,
    metadataJson: row.metadataJson,
  }));
}

/** Back-compatible aggregate for callers that only need the session total. */
export function readPersistedSessionCost(sessionKey: string): PersistedSessionCost | null {
  const rows = readPersistedSessionCosts(sessionKey);
  if (rows.length === 0) return null;
  const models = new Set(rows.map((row) => row.model).filter((model): model is string => Boolean(model)));
  const packetIds = new Set(rows.map((row) => row.packetId));
  const laneIds = new Set(rows.map((row) => row.laneId));
  const missionIds = new Set(rows.map((row) => row.missionId));
  const roles = new Set(rows.map((row) => row.role));
  const runIds = new Set(rows.map((row) => row.runId));
  return {
    inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
    outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
    totalCostUsd: normalizeUsd(rows.reduce((sum, row) => sum + row.totalCostUsd, 0)),
    model: models.size === 1 ? [...models][0] : models.size > 1 ? 'mixed' : null,
    costSource: rows.some((row) => row.costSource === 'gateway') ? 'gateway' : 'estimate',
    laneId: laneIds.size === 1 ? [...laneIds][0] : null,
    packetId: packetIds.size === 1 ? [...packetIds][0] : null,
    missionId: missionIds.size === 1 ? [...missionIds][0] : null,
    role: roles.size === 1 ? [...roles][0] : null,
    attempt: Math.max(...rows.map((row) => row.attempt)),
    runId: runIds.size === 1 ? [...runIds][0] : null,
    metadataJson: null,
  };
}

// Problem C — exhaustive dispatch switch: maps runtime → billing provider.
// Each runtime routes to a different payment provider (anthropic/openai/google).
// Add a new runtime case here when adding a new adapter. Never collapse to a label lookup.
function providerForRuntime(runtime: string, costSource?: PersistSessionCostInput['costSource']): UsageProvider {
  if (costSource === 'gateway') return 'openrouter';
  if (runtime === 'claude-code') {
    return 'anthropic';
  }
  if (runtime === 'codex') {
    return 'openai';
  }
  if (runtime === 'gemini') {
    return 'google';
  }
  if (runtime === 'opencode') {
    return 'opencode';
  }
  return 'runtime';
}

function agentNameForRuntime(runtime: string) {
  // Capability-map lookup for display label; optional chaining guards against unknown runtimes.
  const label = ORCHESTRATOR_RUNTIMES[runtime as keyof typeof ORCHESTRATOR_RUNTIMES]?.label;
  return label ?? runtime;
}

async function resolvePersistenceContext(input: PersistSessionCostInput): Promise<{
  laneId: string | null;
  packetId: string | null;
  missionId: string | null;
  role: UsageRole;
  runId: string | null;
  attempt: number;
}> {
  const { getLane, findLaneBySession } = await import('@/lib/lane/registry');
  const explicitLaneId = input.laneId?.trim() || null;
  const lane = explicitLaneId
    ? getLane(explicitLaneId)
    : findLaneBySession(input.sessionKey.trim());
  const laneId = explicitLaneId ?? lane?.id ?? null;
  const packetId = input.packetId?.trim() || lane?.packetId?.trim() || null;
  let missionId = input.missionId?.trim() || null;
  if (!missionId && packetId) {
    const { findMissionRegistryEntryByPacketId } = await import('@/lib/orchestrator/mission-registry');
    missionId = findMissionRegistryEntryByPacketId(packetId, { includeArchived: true })?.id ?? null;
  }
  let runId = input.runId?.trim() || null;
  if (!runId && laneId) {
    const row = getSqlite().prepare(`
      SELECT id FROM worker_runs WHERE lane_id = ? ORDER BY started_at DESC LIMIT 1
    `).get(laneId) as { id: string } | undefined;
    runId = row?.id ?? null;
  }
  return {
    laneId,
    packetId,
    missionId,
    role: input.role ?? (packetId || laneId ? 'worker' : 'other'),
    runId,
    attempt: derivePacketAttemptIndex({ packetId, laneId }),
  };
}

export async function persistSessionCost(input: PersistSessionCostInput): Promise<boolean> {
  const db = getDb();
  if (!db) {
    console.warn(`${LOG_PREFIX} Database unavailable, skipping ${input.sessionKey}.`);
    return false;
  }

  const sessionKey = input.sessionKey.trim();
  if (!sessionKey) {
    return false;
  }

  const context = await resolvePersistenceContext(input);
  const provider = providerForRuntime(input.runtime, input.costSource);
  const sessionRows = db
    .select({
      id: usageLogs.id,
      attempt: usageLogs.attempt,
      inputTokens: usageLogs.inputTokens,
      outputTokens: usageLogs.outputTokens,
      cacheReadTokens: usageLogs.cacheReadTokens,
      cacheWriteTokens: usageLogs.cacheWriteTokens,
      costUsd: usageLogs.costUsd,
      provider: usageLogs.provider,
    })
    .from(usageLogs)
    .where(eq(usageLogs.sessionKey, sessionKey))
    .all();
  const existing = sessionRows.find((row) => row.attempt === context.attempt);
  const priorRows = sessionRows.filter((row) => row.attempt < context.attempt);
  const priorInputTokens = priorRows.reduce((sum, row) => sum + normalizeTokenCount(row.inputTokens), 0);
  const priorOutputTokens = priorRows.reduce((sum, row) => sum + normalizeTokenCount(row.outputTokens), 0);
  const priorCacheReadTokens = priorRows.reduce((sum, row) => sum + normalizeTokenCount(row.cacheReadTokens), 0);
  const priorCacheWriteTokens = priorRows.reduce((sum, row) => sum + normalizeTokenCount(row.cacheWriteTokens), 0);
  const priorCostUsd = normalizeUsd(priorRows.reduce((sum, row) => sum + normalizeUsd(row.costUsd), 0));
  const attemptInputTokens = Math.max(0, normalizeTokenCount(input.inputTokens) - priorInputTokens);
  const attemptOutputTokens = Math.max(0, normalizeTokenCount(input.outputTokens) - priorOutputTokens);
  const attemptCacheReadTokens = Math.max(0, normalizeTokenCount(input.cacheReadTokens) - priorCacheReadTokens);
  const attemptCacheWriteTokens = Math.max(0, normalizeTokenCount(input.cacheWriteTokens) - priorCacheWriteTokens);
  const attemptCostUsd = normalizeUsd(Math.max(0, normalizeUsd(input.costUsd) - priorCostUsd));
  const attribution = {
    laneId: context.laneId,
    packetId: context.packetId,
    missionId: context.missionId,
    role: context.role,
    runId: context.runId,
  };

  if (existing) {
    const effectiveCostSource = existing.provider === 'openrouter' && input.costSource !== 'gateway'
      ? 'gateway'
      : input.costSource;
    db.update(usageLogs).set({
      model: input.model?.trim() || input.runtime,
      provider: existing.provider === 'openrouter' && input.costSource !== 'gateway' ? 'openrouter' : provider,
      inputTokens: Math.max(normalizeTokenCount(existing.inputTokens), attemptInputTokens),
      outputTokens: Math.max(normalizeTokenCount(existing.outputTokens), attemptOutputTokens),
      cacheReadTokens: Math.max(normalizeTokenCount(existing.cacheReadTokens), attemptCacheReadTokens),
      cacheWriteTokens: Math.max(normalizeTokenCount(existing.cacheWriteTokens), attemptCacheWriteTokens),
      costUsd: input.costSource === 'gateway'
        ? attemptCostUsd
        : existing.provider === 'openrouter'
          ? normalizeUsd(existing.costUsd)
          : Math.max(normalizeUsd(existing.costUsd), attemptCostUsd),
      repoPath: resolve(input.repoPath),
      agentName: agentNameForRuntime(input.runtime),
      billingPeriod: billingPeriodFor(),
      ...attribution,
      metadataJson: metadataJsonForCostSource(input.metadata, effectiveCostSource),
    }).where(and(eq(usageLogs.sessionKey, sessionKey), eq(usageLogs.attempt, context.attempt))).run();
    return true;
  }

  db.insert(usageLogs).values({
    id: randomUUID(),
    userId: null,
    model: input.model?.trim() || input.runtime,
    provider,
    inputTokens: attemptInputTokens,
    outputTokens: attemptOutputTokens,
    cacheReadTokens: attemptCacheReadTokens,
    cacheWriteTokens: attemptCacheWriteTokens,
    costUsd: attemptCostUsd,
    sessionKey,
    attempt: context.attempt,
    repoPath: resolve(input.repoPath),
    agentName: agentNameForRuntime(input.runtime),
    requestType: 'completion',
    billingPeriod: billingPeriodFor(),
    ...attribution,
    metadataJson: metadataJsonForCostSource(input.metadata, input.costSource),
  }).run();

  console.log(`${LOG_PREFIX} Persisted ${sessionKey} attempt ${context.attempt}.`);
  return true;
}

export async function persistRuntimeSessionCost(input: {
  sessionKey: string;
  runtime: string;
  repoPath: string;
  laneId?: string | null;
  packetId?: string | null;
  missionId?: string | null;
  role?: UsageRole;
  runId?: string | null;
}): Promise<boolean> {
  try {
    const adapter = getRuntime(input.runtime);
    if (!adapter?.capabilities.costTelemetry || !adapter.getTelemetry) {
      console.warn(`${LOG_PREFIX} Runtime ${input.runtime} has no telemetry for ${input.sessionKey}.`);
      return false;
    }

    const telemetry = await adapter.getTelemetry(input.sessionKey);
    if (!telemetry) {
      console.warn(`${LOG_PREFIX} No telemetry found for ${input.sessionKey}.`);
      return false;
    }

    const { persistPacketSessionSpend } = await import('./packet-spend-persistence');
    const packetSpend = await persistPacketSessionSpend({ ...input, telemetry });
    // Numeric usage receipts cannot represent an unknown total. Preserve its
    // packet/token evidence without inventing a zero-dollar billing record.
    if (packetSpend.telemetry.costUsd === null) return packetSpend.persisted;
    return await persistSessionCost({
      sessionKey: input.sessionKey,
      runtime: input.runtime,
      model: telemetry.model,
      inputTokens: packetSpend.telemetry.inputTokens,
      outputTokens: packetSpend.telemetry.outputTokens,
      costUsd: packetSpend.telemetry.costUsd,
      repoPath: input.repoPath,
      cacheReadTokens: telemetry.cacheReadTokens,
      cacheWriteTokens: telemetry.cacheWriteTokens,
      costSource: packetSpend.telemetry.costSource,
      laneId: input.laneId,
      packetId: input.packetId,
      missionId: input.missionId,
      role: input.role ?? 'worker',
      runId: input.runId,
      metadata: packetSpend.telemetry.costSource === 'gateway'
        ? { costSource: 'gateway' }
        : packetSpend.telemetry.costSource === 'estimate'
          ? { costSource: 'estimate', rateTableVersion: modelRateTable.rateTableVersion }
          : packetSpend.telemetry.costSource === 'unknown'
            ? { costSource: 'unknown' }
            : undefined,
    });
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to persist runtime session cost for ${input.sessionKey}.`, error);
    return false;
  }
}
