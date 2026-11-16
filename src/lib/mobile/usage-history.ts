import { getDb } from '@/lib/db';
import { usageLogs } from '@/lib/db/schema';
import { resolveRate } from '@/lib/cost/rate-table';
import { parseDbTimestamp, runtimeSurfaceFromRow } from '@/app/api/panel/analytics/usage-log-analytics';

export type UsageRange = '24h' | '7d' | '30d' | '90d';
type UsageRow = typeof usageLogs.$inferSelect;
type Amount = { cost: number; tokens: number };
const AGENTS = {
  'Claude Code': { id: 'claude', label: 'Claude Code', provider: 'anthropic' },
  'Codex CLI': { id: 'codex', label: 'Codex CLI', provider: 'codex' },
  'OpenCode 2': { id: 'opencode', label: 'OpenCode 2', provider: 'opencode' },
} as const;

export function parseUsageRange(value: string | null): UsageRange | null {
  if (value === null) return '30d';
  return value === '24h' || value === '7d' || value === '30d' || value === '90d' ? value : null;
}

// Calendar ranges include today. Hourly ranges include the current partial hour.
// Millisecond stepping preserves both occurrences of an hour when clocks go back.
export function usageWindow(range: UsageRange, now: number) {
  const start = new Date(now);
  start.setMinutes(0, 0, 0);
  if (range === '24h') start.setTime(start.getTime() - 23 * 3_600_000);
  else {
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (Number.parseInt(range, 10) - 1));
  }
  const starts: number[] = [];
  const cursor = new Date(start);
  while (cursor.getTime() <= now) {
    starts.push(cursor.getTime());
    if (range === '24h') cursor.setTime(cursor.getTime() + 3_600_000);
    else cursor.setDate(cursor.getDate() + 1);
  }
  return starts;
}

export function buildUsageHistory(range: UsageRange, rows: UsageRow[], now: number) {
  const starts = usageWindow(range, now);
  const buckets = starts.map(start => ({ start: new Date(start).toISOString(), agents: {} as Record<string, Amount> }));
  const agents = new Map<string, { id: string; label: string; cost: number; tokens: number; sessions: Set<string> }>();
  let unpricedMessages = 0;
  for (const row of rows) {
    const ts = parseDbTimestamp(row.createdAt);
    if (ts < starts[0] || ts > now || row.requestType !== 'completion') continue;
    const surface = runtimeSurfaceFromRow(row);
    if (!surface || !(surface in AGENTS)) continue;
    const agent = AGENTS[surface as keyof typeof AGENTS];
    const tokens = (row.inputTokens ?? 0) + (row.outputTokens ?? 0) + (row.cacheReadTokens ?? 0) + (row.cacheWriteTokens ?? 0);
    // Stored cost is the analytics source of truth, priced by the shared rate table.
    const cost = row.costUsd ?? 0;
    if (!tokens && !cost) continue;
    if (cost === 0 && !resolveRate(agent.provider, row.model)) unpricedMessages++;
    let summary = agents.get(agent.id);
    if (!summary) {
      summary = { id: agent.id, label: agent.label, cost: 0, tokens: 0, sessions: new Set<string>() };
      agents.set(agent.id, summary);
    }
    summary.cost += cost;
    summary.tokens += tokens;
    if (row.sessionKey?.trim()) summary.sessions.add(row.sessionKey.trim());
    const index = starts.findLastIndex(start => start <= ts);
    const amount = buckets[index].agents[agent.id] ??= { cost: 0, tokens: 0 };
    amount.cost += cost;
    amount.tokens += tokens;
  }
  const summaries = [...agents.values()].map(agent => ({
    id: agent.id, label: agent.label, cost: agent.cost, tokens: agent.tokens, sessions: agent.sessions.size,
  })).sort((a, b) => b.cost - a.cost || a.id.localeCompare(b.id));
  for (const bucket of buckets) for (const agent of summaries) bucket.agents[agent.id] ??= { cost: 0, tokens: 0 };
  return {
    range, generatedAt: new Date(now).toISOString(), bucket: range === '24h' ? 'hour' as const : 'day' as const,
    buckets, agents: summaries,
    totals: {
      cost: summaries.reduce((sum, agent) => sum + agent.cost, 0),
      tokens: summaries.reduce((sum, agent) => sum + agent.tokens, 0),
      sessions: summaries.reduce((sum, agent) => sum + agent.sessions, 0), unpricedMessages,
    },
  };
}

const cache = new Map<UsageRange, { expires: number; value: ReturnType<typeof buildUsageHistory> }>();
export function getUsageHistory(range: UsageRange) {
  const now = Date.now();
  const cached = cache.get(range);
  // Also expire on a local bucket boundary, even inside the 60-second lifetime.
  if (cached && cached.expires > now && cached.value.buckets.at(-1)?.start === new Date(usageWindow(range, now).at(-1)!).toISOString()) return cached.value;
  const db = getDb();
  if (!db) throw new Error('Usage history unavailable.');
  const value = buildUsageHistory(range, db.select().from(usageLogs).all(), now);
  cache.set(range, { expires: now + 60_000, value });
  return value;
}
