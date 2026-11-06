import { mkdtemp, mkdir, writeFile, appendFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { historyRange } from './history-range';
import { createHistoryReader } from './history-service';
import { createOverrideRateTable } from './history-readers/usagePricing';
import type { HistoryRoot } from './history-roots';

const temporary: string[] = [];
afterEach(async () => { for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true }); });
const line = (value: unknown) => JSON.stringify(value) + '\n';
const at = Date.parse('2026-10-08T21:00:00Z');
const claude = (id: string, time = at, model = 'test-model') => ({ type: 'assistant', timestamp: new Date(time).toISOString(), sessionId: 'external-claude', requestId: id,
  message: { id, model, content: 'private conversation never returned', usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 20 } } });
const token = (time: number, input = 100) => ({ type: 'event_msg', timestamp: new Date(time).toISOString(),
  payload: { type: 'token_count', info: { last_token_usage: { input_tokens: input, cached_input_tokens: 80, output_tokens: 30, reasoning_output_tokens: 10 },
    total_token_usage: { input_tokens: 99999 } } } });
const pricing = async () => ({ table: createOverrideRateTable({ 'test-model': { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8, cacheReadCostPerMillionTokens: 0.2 } }),
  at, meta: { source: 'Fixture prices', observedAt: new Date(at).toISOString(), status: 'cached' as const } });

it('reads external CLI stores, deduplicates blocks, archives and forks, and re-reads only completed appended bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'o8-global-usage-')); temporary.push(root);
  const claudeDir = join(root, 'projects'); const codexDir = join(root, 'sessions'); const archiveDir = join(root, 'archive');
  await Promise.all([claudeDir, codexDir, archiveDir].map(path => mkdir(path)));
  const claudePath = join(claudeDir, 'outside.jsonl'); const codexPath = join(codexDir, 'parent.jsonl');
  await writeFile(claudePath, line(claude('one')) + line(claude('one')) + line(claude('old', at - 95 * 86_400_000)));
  await writeFile(codexPath, line({ type: 'session_meta', payload: { id: 'external-codex' } }) + line({ type: 'turn_context', payload: { model: 'test-model' } }) + line(token(at)) + line(token(at + 1)));
  await copyFile(codexPath, join(archiveDir, 'copy.jsonl'));
  await writeFile(join(codexDir, 'fork.jsonl'), line({ type: 'session_meta', timestamp: new Date(at).toISOString(), payload: { id: 'child', forked_from_id: 'external-codex' } })
    + line({ type: 'turn_context', payload: { model: 'test-model' } }) + line(token(at + 10)) + line(token(at + 5000, 200)));
  const roots: HistoryRoot[] = [ { provider: 'claude', path: claudeDir, format: 'jsonl' },
    { provider: 'codex', path: codexDir, format: 'jsonl' }, { provider: 'codex', path: archiveDir, format: 'jsonl' } ];
  let now = at + 10_000;
  const options = { roots: async () => roots, cacheDirectory: join(root, 'cache'), pricing, now: () => now };
  const read = createHistoryReader(options); const first = await read({ days: 30, timeZone: 'America/New_York' });
  expect(first.providerSessions).toEqual({ claude: 1, codex: 2 });
  expect(first.buckets.reduce((sum, bucket) => sum + bucket.records, 0)).toBe(3);
  expect(first.buckets.filter(bucket => bucket.provider === 'codex').reduce((sum, bucket) => sum + bucket.totals.uncachedInputTokens, 0)).toBe(140);
  expect(JSON.stringify(first)).not.toContain('private conversation'); expect(JSON.stringify(first)).not.toContain(root);
  const tail = JSON.stringify(claude('two')); await appendFile(claudePath, tail.slice(0, 40)); now += 2000;
  const partial = await read({ days: 30, timeZone: 'UTC', fresh: true }); expect(partial.buckets.reduce((sum, bucket) => sum + bucket.records, 0)).toBe(3);
  await appendFile(claudePath, tail.slice(40) + '\n'); now += 2000;
  const appended = await read({ days: 30, timeZone: 'UTC', fresh: true }); expect(appended.buckets.reduce((sum, bucket) => sum + bucket.records, 0)).toBe(4);
  expect(appended.scan.bytesRead).toBeLessThan(first.scan.bytesRead);
  const reopened = await createHistoryReader(options)({ days: 30, timeZone: 'UTC' }); expect(reopened.scan.bytesRead).toBe(0);
  await writeFile(claudePath, line(claude('unknown', at, 'unknown-paid-model'))); now += 2000;
  const truncated = await read({ days: 30, timeZone: 'UTC', fresh: true });
  expect(truncated.buckets.find(bucket => bucket.model === 'unknown-paid-model')).toMatchObject({ unpricedRecords: 1, costUsd: 0 });
  expect(truncated.buckets.some(bucket => bucket.model === 'test-model' && bucket.provider === 'claude')).toBe(false);
});

it('reads live SQLite and legacy copies once, observes WAL appends, and leaves provider storage unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'o8-opencode-usage-')); temporary.push(root);
  const path = join(root, 'opencode.db'); const db = new DatabaseSync(path); db.exec('PRAGMA journal_mode=WAL; CREATE TABLE message(id TEXT, session_id TEXT, data TEXT, time_created INTEGER)');
  const message = { role: 'assistant', modelID: 'test-model', sessionID: 'external-opencode', time: { created: at }, cost: 0,
    tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 30, write: 40 } } };
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('one', 'external-opencode', JSON.stringify(message), at);
  await mkdir(join(root, 'storage', 'message'), { recursive: true }); await writeFile(join(root, 'storage', 'message', 'one.json'), JSON.stringify({ ...message, id: 'one' }));
  let now = at + 10000;
  const read = createHistoryReader({ roots: async () => [{ provider: 'opencode', path: root, format: 'opencode' }], cacheDirectory: join(root, 'cache'), pricing, now: () => now });
  try {
    const before = await readFile(path); const first = await read({ days: 1, timeZone: 'UTC' });
    expect(first.buckets).toHaveLength(1); expect(first.buckets[0]).toMatchObject({ records: 1, totals: { outputTokens: 25, reasoningTokens: 5 }, unpricedRecords: 0 });
    expect(await readFile(path)).toEqual(before);
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('two', 'external-opencode', JSON.stringify(message), at); now += 2000;
    const second = await read({ days: 1, timeZone: 'UTC', fresh: true }); expect(second.buckets[0].records).toBe(2);
  } finally { db.close(); }
});

it('keeps calendar ranges and exact hourly ranges correct over daylight saving changes', () => {
  const until = Date.parse('2026-11-03T18:00:00Z');
  expect(new Date(historyRange(7, until, 'America/New_York').since).toISOString()).toBe('2026-10-28T04:00:00.000Z');
  expect(historyRange(1, until, 'America/New_York').since).toBe(until - 86_400_000);
});

it('skips oversized tool output without dropping later usage in the same rollout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'o8-large-usage-')); temporary.push(root);
  await writeFile(join(root, 'large.jsonl'), line({ type: 'session_meta', payload: { id: 'large-session' } })
    + line({ type: 'turn_context', payload: { model: 'test-model' } })
    + line({ type: 'response_item', payload: { output: 'x'.repeat(17 * 1024 * 1024) } }) + line(token(at)));
  const result = await createHistoryReader({ roots: async () => [{ provider: 'codex', path: root, format: 'jsonl' }],
    cacheDirectory: join(root, 'cache'), pricing, now: () => at + 10000 })({ days: 30, timeZone: 'UTC' });
  expect(result.sources.find(source => source.provider === 'codex')?.status).toBe('ready');
  expect(result.buckets[0].records).toBe(1);
});

it('scans saved before the 1-hour cache split are read again and price 1-hour writes', async () => {
  const { gzipSync, gunzipSync } = await import('node:zlib');
  const root = await mkdtemp(join(tmpdir(), 'o8-usage-memo-')); temporary.push(root);
  const claudeDir = join(root, 'projects'); await mkdir(claudeDir);
  const record = claude('one');
  Object.assign(record.message.usage, { cache_creation_input_tokens: 1_000_000,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 } });
  await writeFile(join(claudeDir, 'session.jsonl'), line(record));
  const table = createOverrideRateTable({ 'test-model': { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 } });
  // A 1-hour write at $5 per million, against $2.50 for a 5-minute write.
  const tiered = new Map([...table].map(([model, rate]) => [model, { ...rate, cacheCreationCostPerToken: 2.5e-6, cacheCreation1hCostPerToken: 5e-6 }]));
  const options = { roots: async () => [{ provider: 'claude' as const, path: claudeDir, format: 'jsonl' as const }], cacheDirectory: join(root, 'cache'),
    pricing: async () => ({ ...(await pricing()), table: tiered }), now: () => at + 10_000 };
  const writeCost = (result: Awaited<ReturnType<ReturnType<typeof createHistoryReader>>>) => result.buckets[0].categoryCostUsd.cacheWrite;
  expect(writeCost(await createHistoryReader(options)({ days: 30, timeZone: 'UTC' }))).toBeCloseTo(5, 9);
  // The same scan as an older build saved it: schema 1, no 1-hour split.
  const file = join(root, 'cache', 'scans-v1.json.gz');
  const saved = JSON.parse(gunzipSync(await readFile(file)).toString());
  for (const [, memo] of saved.files) for (const scanned of memo.records) delete scanned.cacheCreation1hTokens;
  await writeFile(file, gzipSync(JSON.stringify({ ...saved, schema: 1 })));
  const reopened = await createHistoryReader(options)({ days: 30, timeZone: 'UTC' });
  expect(reopened.scan.bytesRead).toBeGreaterThan(0);
  expect(writeCost(reopened)).toBeCloseTo(5, 9);
});
