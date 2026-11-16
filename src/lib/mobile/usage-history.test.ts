import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const all = vi.hoisted(() => vi.fn(() => []));
vi.mock('@/lib/db', () => ({ getDb: () => ({ select: () => ({ from: () => ({ all }) }) }) }));
import { buildUsageHistory, getUsageHistory, parseUsageRange, usageWindow } from './usage-history';
import { GET } from '@/app/api/mobile/usage/history/route';
import type { usageLogs } from '@/lib/db/schema';
function row(overrides: Record<string, unknown> = {}) {
  return { agentName: 'codex', requestType: 'completion', model: 'gpt-6.1-sol', inputTokens: 10,
    outputTokens: 5, costUsd: 2, sessionKey: 'private-session', createdAt: '2026-11-16T12:00:00Z',
    repoPath: 'private-path', userId: 'private-email', metadataJson: 'private-prompt', ...overrides } as typeof usageLogs.$inferSelect;
}
const now = Date.parse('2026-11-16T12:30:00Z');
afterEach(() => vi.useRealTimers());
describe('mobile usage history', () => {
  it.each(['24h', '7d', '30d', '90d'] as const)('zero fills %s and respects both boundaries', range => {
    const starts = usageWindow(range, now);
    expect(starts).toHaveLength(range === '24h' ? 24 : parseInt(range));
    const result = buildUsageHistory(range, [row({ createdAt: new Date(starts[0] - 1).toISOString() }),
      row({ createdAt: new Date(starts[0]).toISOString() }), row({ createdAt: new Date(now).toISOString() }),
      row({ createdAt: new Date(now + 1).toISOString() })], now);
    expect(result.buckets).toHaveLength(starts.length);
    expect(result.buckets[0].agents.codex.cost).toBe(2);
    expect(result.totals.cost).toBe(4);
    expect(result.buckets[1].agents.codex).toEqual({ cost: 0, tokens: 0 });
    expect(result.buckets.map(b => b.start)).toEqual([...result.buckets.map(b => b.start)].sort());
  });
  it('uses local midnight across daylight saving day edges', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const starts = usageWindow('7d', Date.parse('2026-11-03T02:30:00Z'));
      expect(new Date(starts.at(-1)!).toISOString()).toBe('2026-11-02T05:00:00.000Z');
      expect(starts.at(-1)! - starts.at(-2)!).toBe(25 * 3_600_000);
      const result = buildUsageHistory('7d', [row({ createdAt: '2026-11-02T04:59:59Z' }), row({ createdAt: '2026-11-02T05:00:00Z' })], Date.parse('2026-11-03T02:30:00Z'));
      expect(result.buckets.at(-2)?.agents.codex.cost).toBe(2);
      expect(result.buckets.at(-1)?.agents.codex.cost).toBe(2);
      expect(usageWindow('24h', Date.parse('2026-11-01T08:30:00Z'))).toHaveLength(24);
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });
  it('projects only counts, sorts agents, deduplicates sessions and keeps unknown pricing visible', () => {
    const result = buildUsageHistory('30d', [row(), row(), row({ agentName: 'claude-code', costUsd: 6 }), row({ model: 'unknown', costUsd: 0 })], now);
    expect(result.agents.map(a => a.id)).toEqual(['claude', 'codex']);
    expect(result.agents[1]).toEqual({ id: 'codex', label: 'Codex CLI', cost: 4, tokens: 45, sessions: 1 });
    expect(result.totals.unpricedMessages).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/private-|sessionKey|repoPath|userId|metadataJson/);
    expect(Object.keys(result)).toEqual(['range', 'generatedAt', 'bucket', 'buckets', 'agents', 'totals']);
  });
  it('excludes non-coding usage', () => {
    expect(buildUsageHistory('30d', [row({ agentName: 'llm-chat', sessionKey: null, requestType: 'chat' }), row({ agentName: 'other', sessionKey: null })], now).agents).toEqual([]);
  });
  it('rejects bad or empty ranges with 400 and defaults missing range', async () => {
    expect(parseUsageRange(null)).toBe('30d');
    for (const range of ['bad', '', '24H']) {
      expect((await GET(new NextRequest(`http://localhost/api/mobile/usage/history?range=${range}`))).status).toBe(400);
    }
  });
  it('caches by range for 60 seconds and returns the route shape', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now); all.mockClear();
    getUsageHistory('7d'); getUsageHistory('7d'); getUsageHistory('90d');
    expect(all).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_001); getUsageHistory('7d');
    expect(all).toHaveBeenCalledTimes(3);
    const response = await GET(new NextRequest('http://localhost/api/mobile/usage/history'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ range: '30d', bucket: 'day', totals: { cost: 0, tokens: 0, sessions: 0, unpricedMessages: 0 } });
  });
});
