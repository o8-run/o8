import { performance } from 'node:perf_hooks';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, getSqlite } from '@/lib/db';
import { searchConversations, syncChatHistorySearchRecord } from './conversations';
import { searchTranscripts, syncTranscriptSearchDocument } from './transcripts';
import { boundedTypoSelect, toTypoFts5Query } from './fts';
import type { SearchResponse } from './types';
import { GET } from '@/app/api/panel/search/route';

// Keep the route and both history providers real; other providers need no services.
vi.mock('@/lib/search/agents', () => ({ searchAgents: async () => [] }));
vi.mock('@/lib/search/approvals', () => ({ searchApprovals: async () => [] }));
vi.mock('@/lib/search/directives', () => ({ searchDirectives: () => [] }));
vi.mock('@/lib/search/files', () => ({ searchFiles: async () => [] }));
vi.mock('@/lib/search/inbox', () => ({ searchInbox: async () => [] }));
vi.mock('@/lib/search/issues', () => ({ searchIssues: async () => [], browseIssues: async () => [] }));

const completedAt = '2026-10-01T00:00:00.000Z';

function seed(id: string, title: string, text = title) {
  syncChatHistorySearchRecord(id, {
    title,
    repoName: 'search-fixture',
    repoPath: '/tmp/search-fixture',
    messages: [{ role: 'user', content: text }],
  }, completedAt);
  syncTranscriptSearchDocument({
    packetId: id,
    laneId: `lane-${id}`,
    sessionKey: `session-${id}`,
    title,
    repoPath: '/tmp/search-fixture',
    entries: [{ id: `entry-${id}`, role: 'user', text, timestamp: new Date(completedAt) }],
    completedAt,
  });
}

async function search(query: string): Promise<SearchResponse> {
  const response = await GET(new Request(`http://localhost/api/panel/search?q=${encodeURIComponent(query)}`));
  expect(response.status).toBe(200);
  const payload = await response.json() as SearchResponse;
  expect(payload.providerErrors).toBeUndefined();
  return payload;
}

beforeEach(() => {
  expect(getDb()).not.toBeNull();
  getSqlite().exec('DELETE FROM chat_history; DELETE FROM transcript_search_documents; DELETE FROM session_outcomes; DELETE FROM lanes;');
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => closeDb());

describe('persisted history typo recovery through the search route', () => {
  it.each(['compactoin', 'compacion', 'compactionn', 'reciept'])('recovers %s with stable targets and an approximate indication', async query => {
    seed('recovered', 'Compaction receipt', 'Keep the original matched excerpt.');
    const payload = await search(query);
    for (const kind of ['chat', 'transcript'] as const) {
      expect(payload.groups[kind]).toHaveLength(1);
      expect(payload.groups[kind][0]).toMatchObject({
        title: 'Compaction receipt',
        detail: expect.stringContaining('Approximate match'),
        target: kind === 'chat' ? { chatTabId: 'recovered' } : { packetId: 'recovered' },
      });
    }
  });

  it('keeps strict results and their scores ahead of recovered results, including after route sorting', async () => {
    seed('strict', 'compactoin');
    const baseline = await search('compactoin');
    seed('recovered', 'Compaction');
    const payload = await search('compactoin');
    for (const kind of ['chat', 'transcript'] as const) {
      const [strict, recovered] = payload.groups[kind];
      expect(strict).toEqual(baseline.groups[kind][0]);
      expect(recovered?.id).toBe(`${kind}:recovered`);
      expect(strict.score).toBeGreaterThan(recovered.score);
      expect(strict.detail).not.toContain('Approximate match');
    }
    expect(payload.results.slice(0, 2).every(result => result.id.endsWith(':strict'))).toBe(true);
  });

  it.each(['compaction', 'compac', 'ＣＯＭＰＡＣＴＩＯＮ', 'compaction!!!', 'café'])('preserves exact, prefix, Unicode and punctuation search: %s', async query => {
    seed('strict', 'Compaction café receipt');
    const payload = await search(query);
    for (const kind of ['chat', 'transcript'] as const) {
      expect(payload.groups[kind].map(result => result.id)).toEqual([`${kind}:strict`]);
      expect(payload.groups[kind][0].detail).not.toContain('Approximate match');
    }
  });

  it('retains the other query tokens when repairing one spelling', async () => {
    seed('wanted', 'Compaction cedar');
    seed('unrelated', 'Compaction maple');
    const payload = await search('cedar compactoin');
    expect(payload.groups.chat.map(result => result.id)).toEqual(['chat:wanted']);
    expect(payload.groups.transcript.map(result => result.id)).toEqual(['transcript:wanted']);
  });

  it.each(['zzzzzz', 'xy', 'cedar zzzzzz', 'compactoin reciept', '" OR NEAR(*)'])('returns nothing without a plausible single repair: %s', async query => {
    seed('unrelated', 'Compaction receipt cedar');
    const payload = await search(query);
    expect(payload.groups.chat).toEqual([]);
    expect(payload.groups.transcript).toEqual([]);
  });

  it('skips fallback once three strict hits exist and retains the eight-result cap', async () => {
    for (let index = 0; index < 10; index++) seed(`strict-${index}`, 'compactoin');
    seed('recovered', 'Compaction');
    const prepare = vi.spyOn(getSqlite(), 'prepare');
    expect(await searchConversations('compactoin')).toHaveLength(8);
    expect(await searchTranscripts('compactoin')).toHaveLength(8);
    expect(prepare).toHaveBeenCalledTimes(4); // One chat query and the three transcript sources.
  });

  it('bounds extra queries and skips recovery for pathological input', async () => {
    seed('wanted', 'Compaction receipt cedar');
    const prepare = vi.spyOn(getSqlite(), 'prepare');
    expect(await searchConversations('compactoin')).toHaveLength(1);
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(8);
    prepare.mockClear();
    const longQuery = 'compactoin '.repeat(10_000);
    expect(await searchConversations(longQuery)).toEqual([]);
    expect(await searchTranscripts(longQuery)).toEqual([]);
    expect(prepare).toHaveBeenCalledTimes(4);
  });

  it('caps spelling alternatives and candidate documents before ranking', () => {
    for (let index = 0; index < 50; index++) seed(`candidate-${index}`, 'Compaction');
    const query = toTypoFts5Query(getSqlite(), 'chat_history_fts', 'compactoin', 0);
    expect(query).not.toBeNull();
    const candidates = getSqlite().prepare(boundedTypoSelect('SELECT rowid FROM chat_history_fts WHERE chat_history_fts MATCH ?')).all(query);
    expect(candidates).toHaveLength(32);
    expect(query?.match(/"[^" ]+"\*/g)?.length).toBeLessThanOrEqual(512);
  });

  it('records strict and fallback latency on the same 2,000-document corpus', async () => {
    getSqlite().transaction(() => {
      for (let index = 0; index < 2_000; index++) seed(`corpus-${index}`, `Compaction receipt document ${index}`);
    })();
    const run = async (query: string) => {
      const start = performance.now();
      const results = await searchConversations(query);
      return { results, elapsed: performance.now() - start };
    };
    const strict = await run('compaction');
    const recovered = await run('compactoin');
    expect(strict.results).toHaveLength(8);
    expect(recovered.results).toHaveLength(8);
    console.info(`[typo-search] 2000 documents: strict=${strict.elapsed.toFixed(1)}ms fallback=${recovered.elapsed.toFixed(1)}ms`);
  });
});
