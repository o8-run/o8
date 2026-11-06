import { NextRequest, NextResponse } from 'next/server';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { hydrateUsageLogAnalytics } from './usage-log-analytics';
import { getDb } from '@/lib/db';
import { sessionOutcomes, approvals } from '@/lib/db/schema';
import { CLOSE_UNMERGED_DISPOSITIONS } from '@/lib/orchestrator/close-unmerged';
import { gte, sql } from 'drizzle-orm';
import { getDataDir } from '@/lib/data-dir-migration';
import { claudeRequestCostUsd, claudeRequestRate, readClaudeRequestTokens } from '@/lib/cost/rate-table';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/panel/analytics?hours=24
 *
 * Returns comprehensive cost/usage analytics aggregated across:
 * - Codex CLI owned sessions
 * - Claude Code sessions
 * - OpenCode 2 owned sessions
 * - IDE LLM chat usage logs
 */

type SurfaceKey = 'Codex CLI' | 'Claude Code' | 'OpenCode 2' | 'IDE LLM Chat' | 'Symon Voice';

interface HourBucket {
  hour: string;
  cost: number;
  messages: number;
  tokens: number;
}

interface ModelBreakdown {
  model: string;
  cost: number;
  messages: number;
  /** Messages whose model has no rate; their cost is not in `cost`. */
  unpricedMessages: number;
  sessions: number;
}

interface Breakdown {
  cost: number;
  messages: number;
  tokens: number;
  sessions: number;
}

interface TopSession {
  id: string;
  agent: string;
  cost: number;
  messages: number;
  model: string;
  active: boolean;
}

interface SessionAccumulator {
  id: string;
  agent: string;
  surface: SurfaceKey;
  cost: number;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  cacheWriteTokens: number;
  model: string;
  models: Set<string>;
  active: boolean;
}

const SURFACES: SurfaceKey[] = ['Codex CLI', 'Claude Code', 'OpenCode 2', 'IDE LLM Chat', 'Symon Voice'];
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function numberOrZero(value: unknown): number {
  return finiteNumber(value) ?? 0;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = finiteNumber(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function parseTimestamp(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value === 'string' && value.trim()) {
    const direct = Number(value);
    if (Number.isFinite(direct)) {
      return direct > 1_000_000_000_000 ? direct : direct * 1000;
    }
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function parseTimestampFromName(fileName: string): number | undefined {
  const match = basename(fileName).match(/^(\d{10,13})/);
  if (!match) return undefined;
  return parseTimestamp(Number(match[1]));
}

function normalizeModel(model: string | null | undefined): string {
  const value = String(model ?? 'unknown').trim() || 'unknown';
  return value.replace(/-\d{8}$/, '');
}

function tokenTotal(input: number, output: number, cacheRead: number, cacheWrite: number): number {
  return input + output + cacheRead + cacheWrite;
}

function hourKey(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:00`;
}

/** A Claude Code line's cost from the shared rate table, or null when its model has no rate. */
function claudeLineCost(model: string, usage: Record<string, unknown>): number | null {
  const rate = claudeRequestRate(model, usage);
  return rate ? claudeRequestCostUsd(rate, readClaudeRequestTokens(usage)) : null;
}

function createBreakdown(): Breakdown {
  return { cost: 0, messages: 0, tokens: 0, sessions: 0 };
}

function ensureBreakdown(map: Map<string, Breakdown>, key: string): Breakdown {
  let value = map.get(key);
  if (!value) {
    value = createBreakdown();
    map.set(key, value);
  }
  return value;
}

function ensureModelBreakdown(map: Map<string, ModelBreakdown>, key: string): ModelBreakdown {
  let value = map.get(key);
  if (!value) {
    value = { model: key, cost: 0, messages: 0, unpricedMessages: 0, sessions: 0 };
    map.set(key, value);
  }
  return value;
}

function createSession(id: string, agent: string, surface: SurfaceKey, active: boolean): SessionAccumulator {
  return {
    id,
    agent,
    surface,
    cost: 0,
    messages: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    cacheWriteTokens: 0,
    model: 'unknown',
    models: new Set<string>(),
    active,
  };
}

function discoverIdeChatSessions(sinceTs: number): Array<{ id: string; model: string }> {
  const historyDir = join(getDataDir(), 'chat-history');
  const sessions: Array<{ id: string; model: string }> = [];

  for (const file of safeReadDir(historyDir)) {
    if (!file.endsWith('.json')) continue;
    const filePath = join(historyDir, file);

    try {
      const stat = statSync(filePath);
      if (stat.mtimeMs < sinceTs) continue;

      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as { messages?: unknown[]; model?: string };
      if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) continue;

      sessions.push({
        id: basename(file, '.json'),
        model: normalizeModel(parsed.model),
      });
    } catch {
      // skip unreadable history files
    }
  }

  return sessions;
}

interface AutonomyMetrics {
  total: number;
  succeeded: number;
  partial: number;
  failed: number;
  mergedClean: number;
  successRate: number;
  mergedCleanRate: number;
}

interface GovernanceMetrics {
  total: number;
  approved: number;
  rejected: number;
  pending: number;
  approvalRate: number;
  avgLatencyMs: number;
}

/**
 * Autonomy (from session_outcomes) + Governance (from approvals), windowed to
 * `sinceTs`. Both null on DB-unavailable / query failure so the page degrades
 * to an honest empty state — never mocks.
 */
function computeMoatMetrics(sinceTs: number): {
  autonomy: AutonomyMetrics | null;
  governance: GovernanceMetrics | null;
} {
  let autonomy: AutonomyMetrics | null = null;
  let governance: GovernanceMetrics | null = null;
  try {
    const db = getDb();
    if (!db) return { autonomy, governance };

    // session_outcomes.completedAt is ISO text → convert to unix ms for the window.
    const outcomes = db
      .select({ outcome: sessionOutcomes.outcome, mergedClean: sessionOutcomes.mergedClean })
      .from(sessionOutcomes)
      .where(gte(sql`strftime('%s', ${sessionOutcomes.completedAt}) * 1000`, sinceTs))
      .all();
    // An operator-closed packet has no merge/retry verdict, so it must not
    // depress the autonomous work success rate as though it had failed.
    const scoredOutcomes = outcomes.filter(
      (outcome) => !(CLOSE_UNMERGED_DISPOSITIONS as readonly string[]).includes(outcome.outcome),
    );
    const total = scoredOutcomes.length;
    const succeeded = scoredOutcomes.filter((o) => o.outcome === 'succeeded').length;
    const partial = scoredOutcomes.filter((o) => o.outcome === 'partial').length;
    const failed = scoredOutcomes.filter((o) => o.outcome === 'failed' || o.outcome === 'interrupted').length;
    const mergedClean = scoredOutcomes.filter((o) => o.mergedClean === true).length;
    autonomy = {
      total, succeeded, partial, failed, mergedClean,
      successRate: total > 0 ? (succeeded / total) * 100 : 0,
      mergedCleanRate: total > 0 ? (mergedClean / total) * 100 : 0,
    };

    // approvals.createdAt / resolvedAt are unix ms already.
    const apprs = db
      .select({ status: approvals.status, createdAt: approvals.createdAt, resolvedAt: approvals.resolvedAt })
      .from(approvals)
      .where(gte(approvals.createdAt, sinceTs))
      .all();
    const approved = apprs.filter((a) => a.status === 'approved');
    const rejected = apprs.filter((a) => a.status === 'rejected').length;
    const pending = apprs.filter((a) => a.status === 'pending').length;
    const latencies = approved
      .map((a) => (typeof a.resolvedAt === 'number' ? a.resolvedAt - a.createdAt : 0))
      .filter((d) => d > 0);
    const avgLatencyMs = latencies.length > 0
      ? latencies.reduce((s, d) => s + d, 0) / latencies.length
      : 0;
    governance = {
      total: apprs.length,
      approved: approved.length,
      rejected,
      pending,
      approvalRate: apprs.length > 0 ? (approved.length / apprs.length) * 100 : 0,
      avgLatencyMs,
    };
  } catch {
    // graceful — omit on any DB/query error
  }
  return { autonomy, governance };
}

export async function GET(request: NextRequest) {
  try {
    const hours = parseInt(request.nextUrl.searchParams.get('hours') || '24', 10);
    const sinceTs = Date.now() - hours * 60 * 60 * 1000;
    const visibleSurfaces = SURFACES;

    const hourlyMap = new Map<string, HourBucket>();
    const modelMap = new Map<string, ModelBreakdown>();
    const agentMap = new Map<string, Breakdown>();
    const surfaceMap = new Map<string, Breakdown>(visibleSurfaces.map((surface) => [surface, createBreakdown()]));
    const topSessions: TopSession[] = [];

    let totalCost = 0;
    let totalMessages = 0;
    let totalUnpriced = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCache = 0;
    let totalCacheWrite = 0;
    let totalSessions = 0;

    const recordUsage = (args: {
      ts: number;
      /** Null when the model has no rate: counted as unpriced, not as $0. */
      cost: number | null;
      inputTokens: number;
      outputTokens: number;
      cacheTokens: number;
      cacheWriteTokens: number;
      model: string;
      agent: string;
      surface: SurfaceKey;
    }) => {
      const normalizedModel = normalizeModel(args.model);
      const tokens = tokenTotal(args.inputTokens, args.outputTokens, args.cacheTokens, args.cacheWriteTokens);
      const cost = args.cost ?? 0;

      totalCost += cost;
      totalMessages += 1;
      if (args.cost === null) totalUnpriced += 1;
      totalInput += args.inputTokens;
      totalOutput += args.outputTokens;
      totalCache += args.cacheTokens;
      totalCacheWrite += args.cacheWriteTokens;

      const bucketKey = hourKey(args.ts);
      if (!hourlyMap.has(bucketKey)) {
        hourlyMap.set(bucketKey, { hour: bucketKey, cost: 0, messages: 0, tokens: 0 });
      }
      const hourly = hourlyMap.get(bucketKey)!;
      hourly.cost += cost;
      hourly.messages += 1;
      hourly.tokens += tokens;

      const model = ensureModelBreakdown(modelMap, normalizedModel);
      model.cost += cost;
      model.messages += 1;
      if (args.cost === null) model.unpricedMessages += 1;

      const agent = ensureBreakdown(agentMap, args.agent);
      agent.cost += cost;
      agent.messages += 1;
      agent.tokens += tokens;

      const surface = ensureBreakdown(surfaceMap, args.surface);
      surface.cost += cost;
      surface.messages += 1;
      surface.tokens += tokens;

      return normalizedModel;
    };

    const finalizeSession = (session: SessionAccumulator) => {
      if (session.messages === 0) return;

      totalSessions += 1;
      ensureBreakdown(agentMap, session.agent).sessions += 1;
      ensureBreakdown(surfaceMap, session.surface).sessions += 1;

      const models = session.models.size > 0 ? session.models : new Set([normalizeModel(session.model)]);
      for (const model of models) {
        ensureModelBreakdown(modelMap, model).sessions += 1;
      }

      topSessions.push({
        id: session.id,
        agent: session.agent,
        cost: session.cost,
        messages: session.messages,
        model: normalizeModel(session.model),
        active: session.active,
      });
    };

    const {
      persistedRuntimeSessionKeys,
      llmMessages,
      llmModelsUsed,
      llmSessionCount,
    } = hydrateUsageLogAnalytics({
      sinceTs,
      normalizeModel,
      recordUsage,
      finalizeSession,
    });

    // ── Codex CLI sessions ────────────────────────────────────────────────────
    const codexRoots = [
      join(getDataDir(), 'owned-codex'),
      join(getDataDir(), 'owned-codex-archive'),
    ];

    for (const root of codexRoots) {
      for (const sessionDirName of safeReadDir(root)) {
        if (persistedRuntimeSessionKeys.has(`codex-owned:${sessionDirName}`)) {
          continue;
        }
        const runsDir = join(root, sessionDirName, 'runs');
        const runFiles = safeReadDir(runsDir).filter((file) => file.endsWith('.jsonl'));
        if (runFiles.length === 0) continue;

        const session = createSession(sessionDirName, 'Codex CLI', 'Codex CLI', false);

        for (const runFile of runFiles) {
          const runPath = join(runsDir, runFile);

          try {
            const stat = statSync(runPath);
            if ((Date.now() - stat.mtimeMs) < ACTIVE_WINDOW_MS) session.active = true;
            if (stat.mtimeMs < sinceTs) continue;

            const fallbackTs = parseTimestampFromName(runFile) ?? stat.mtimeMs;
            const lines = readFileSync(runPath, 'utf-8').split('\n').filter(Boolean);
            for (const line of lines) {
              try {
                const parsed = JSON.parse(line) as Record<string, unknown>;
                if (parsed.type !== 'turn.completed') continue;

                const usage = (parsed.usage ?? {}) as Record<string, unknown>;
                const ts = parseTimestamp(parsed.timestamp ?? parsed.completed_at, fallbackTs);
                if (ts < sinceTs) continue;

                const inputTokens = numberOrZero(usage.input_tokens);
                const outputTokens = numberOrZero(usage.output_tokens);
                const cacheTokens = numberOrZero(usage.cached_input_tokens);
                const cacheWriteTokens = 0;
                const cost = 0;

                if (inputTokens === 0 && outputTokens === 0 && cacheTokens === 0) continue;

                const normalizedModel = recordUsage({
                  ts,
                  cost,
                  inputTokens,
                  outputTokens,
                  cacheTokens,
                  cacheWriteTokens,
                  model: 'codex',
                  agent: 'Codex CLI',
                  surface: 'Codex CLI',
                });

                session.cost += cost;
                session.messages += 1;
                session.inputTokens += inputTokens;
                session.outputTokens += outputTokens;
                session.cacheTokens += cacheTokens;
                session.models.add(normalizedModel);
                session.model = 'codex';
              } catch {
                // skip malformed run lines
              }
            }
          } catch {
            // skip unreadable run file
          }
        }

        finalizeSession(session);
      }
    }

    // ── Claude Code sessions ─────────────────────────────────────────────────
    const claudeProjectsRoot = join(homedir(), '.claude', 'projects');
    for (const projectDir of safeReadDir(claudeProjectsRoot)) {
      const projectPath = join(claudeProjectsRoot, projectDir);
      const files = safeReadDir(projectPath).filter((file) => file.endsWith('.jsonl'));

      for (const file of files) {
        if (persistedRuntimeSessionKeys.has(`claude-code:${basename(file, '.jsonl')}`)) {
          continue;
        }
        const filePath = join(projectPath, file);

        try {
          const stat = statSync(filePath);
          if (stat.mtimeMs < sinceTs) continue;

          const session = createSession(
            basename(file, '.jsonl'),
            'Claude Code',
            'Claude Code',
            (Date.now() - stat.mtimeMs) < ACTIVE_WINDOW_MS,
          );

          const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line) as Record<string, unknown>;
              if (parsed.type !== 'assistant') continue;

              const message = (parsed.message ?? {}) as Record<string, unknown>;
              const usage = (message.usage ?? {}) as Record<string, unknown>;
              if (Object.keys(usage).length === 0) continue;

              const ts = parseTimestamp(parsed.timestamp ?? message.timestamp, stat.mtimeMs);
              if (ts < sinceTs) continue;

              const inputTokens = numberOrZero(usage.input_tokens);
              const outputTokens = numberOrZero(usage.output_tokens);
              const cacheTokens = numberOrZero(usage.cache_read_input_tokens);
              const cacheWriteTokens = numberOrZero(usage.cache_creation_input_tokens);

              if (inputTokens === 0 && outputTokens === 0 && cacheTokens === 0 && cacheWriteTokens === 0) {
                continue;
              }

              const explicitCost = firstFiniteNumber(
                parsed.cost_usd,
                parsed.costUsd,
                message.cost_usd,
                message.costUsd,
                usage.cost_usd,
                usage.costUsd,
              );
              const model = String(message.model ?? parsed.model ?? 'claude');
              const cost = explicitCost ?? claudeLineCost(model, usage);
              const normalizedModel = recordUsage({
                ts,
                cost,
                inputTokens,
                outputTokens,
                cacheTokens,
                cacheWriteTokens,
                model,
                agent: 'Claude Code',
                surface: 'Claude Code',
              });

              session.cost += cost ?? 0;
              session.messages += 1;
              session.inputTokens += inputTokens;
              session.outputTokens += outputTokens;
              session.cacheTokens += cacheTokens;
              session.cacheWriteTokens += cacheWriteTokens;
              session.models.add(normalizedModel);
              if (session.model === 'unknown' || session.model === '') session.model = model;
            } catch {
              // skip malformed lines
            }
          }

          finalizeSession(session);
        } catch {
          // skip unreadable files
        }
      }
    }

    // ── IDE LLM chat usage logs ──────────────────────────────────────────────
    if (llmMessages > 0) {
      if (llmSessionCount === 0) {
        const ideChatSessions = discoverIdeChatSessions(sinceTs);
        const sessionCount = ideChatSessions.length > 0 ? ideChatSessions.length : 1;

        totalSessions += sessionCount;
        ensureBreakdown(agentMap, 'IDE LLM Chat').sessions += sessionCount;
        ensureBreakdown(surfaceMap, 'IDE LLM Chat').sessions += sessionCount;

        if (ideChatSessions.length > 0) {
          const sessionsByModel = new Map<string, number>();
          for (const session of ideChatSessions) {
            const model = normalizeModel(session.model);
            sessionsByModel.set(model, (sessionsByModel.get(model) ?? 0) + 1);
          }
          for (const [model, count] of sessionsByModel) {
            ensureModelBreakdown(modelMap, model).sessions += count;
          }
        } else {
          for (const model of llmModelsUsed) {
            ensureModelBreakdown(modelMap, model).sessions += 1;
          }
        }
      }
    }

    topSessions.sort((a, b) => {
      if (b.cost !== a.cost) return b.cost - a.cost;
      if (b.messages !== a.messages) return b.messages - a.messages;
      return a.id.localeCompare(b.id);
    });

    const hourly = Array.from(hourlyMap.values()).sort((a, b) => a.hour.localeCompare(b.hour));
    const byModel = Array.from(modelMap.values()).sort((a, b) => {
      if (b.cost !== a.cost) return b.cost - a.cost;
      if (b.messages !== a.messages) return b.messages - a.messages;
      return a.model.localeCompare(b.model);
    });

    const totalTokens = tokenTotal(totalInput, totalOutput, totalCache, totalCacheWrite);
    const cacheHitRate = (totalInput + totalCache) > 0
      ? (totalCache / (totalInput + totalCache)) * 100
      : 0;

    // ── Autonomy (session_outcomes) + Governance (approvals) ──
    // DB-backed, windowed to the same `hours`. Graceful: if the DB is
    // unavailable or empty these come back null and the page shows an honest
    // empty state. Cost stays the primary surface; these ride on top.
    const moat = computeMoatMetrics(sinceTs);

    return NextResponse.json({
      totals: {
        cost: totalCost,
        messages: totalMessages,
        unpricedMessages: totalUnpriced,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cacheTokens: totalCache,
        cacheWriteTokens: totalCacheWrite,
        sessions: totalSessions,
        cacheHitRate,
        avgCostPerMessage: totalMessages > 0 ? totalCost / totalMessages : 0,
        totalTokens,
      },
      byAgent: Object.fromEntries(agentMap.entries()),
      bySurface: Object.fromEntries(visibleSurfaces.map((surface) => [surface, surfaceMap.get(surface) ?? createBreakdown()])),
      byModel,
      hourly,
      topSessions: topSessions.slice(0, 10),
      autonomy: moat.autonomy,
      governance: moat.governance,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown' },
      { status: 500 },
    );
  }
}
