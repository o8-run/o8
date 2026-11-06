import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { historyRange } from './history-range';
import type { HistoryPricing } from './history-pricing';
import type { HistoryRoot } from './history-roots';
import { discoverHistoryFiles, scanHistoryFile, type FileMemo } from './history-files';
import { readOpenCodeUsage } from './history-readers/opencodeUsageReader';
import { readAntigravityUsage } from './history-readers/antigravityUsageReader';
import { EMPTY_TOTALS, type UsageRecord } from './history-readers/usageTranscripts';
import { priceUsage, cacheSavingsUsd, type RateTable } from './history-readers/usagePricing';
import type { HistoryBucket, HistorySource, UsageHistorySummary, UsageProviderKind } from './history-types';

const zip = promisify(gzip); const unzip = promisify(gunzip);
const RETENTION = 92 * 86_400_000;
/** Saved scans from an older schema are read again; 2 added Claude's 1-hour cache writes. */
const MEMO_SCHEMA = 2;
const PROVIDERS: UsageProviderKind[] = ['codex', 'claude', 'grok', 'opencode', 'antigravity'];

export function aggregateHistory(records: readonly UsageRecord[], options: {
  since: number; until: number; timeZone: string; table: RateTable; hourly?: boolean;
}) {
  const buckets = new Map<string, HistoryBucket>(); const bucketSessions = new Map<string, Set<string>>();
  const providerSessions = new Map<UsageProviderKind, Set<string>>(); const seen = new Set<string>();
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: options.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  for (const record of records) {
    if (record.timestampMs < options.since || record.timestampMs > options.until) continue;
    // Occurrence suffixes are attached while scanning Codex files, preserving legitimate repeated requests.
    const identity = record.dedupeKey === null ? null : `${record.provider}:${record.dedupeKey}`;
    if (identity && seen.has(identity)) continue;
    if (identity) seen.add(identity);
    const day = options.hourly ? new Date(Math.floor(record.timestampMs / 3_600_000) * 3_600_000).toISOString() : date.format(record.timestampMs);
    const key = `${day}\0${record.provider}\0${record.model}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { day, provider: record.provider, model: record.model, totals: { ...EMPTY_TOTALS }, costUsd: 0,
        cacheSavingsUsd: 0, categoryCostUsd: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, sessions: 0,
        records: 0, unpricedRecords: 0, reportedRecords: 0, fastCostUsd: 0, speedPremiumUsd: 0 };
      buckets.set(key, bucket); bucketSessions.set(key, new Set());
    }
    const price = priceUsage(options.table, record);
    bucket.records++; bucket.unpricedRecords += Number(price.costSource === 'unpriced');
    bucket.reportedRecords += Number(price.costSource === 'providerReported');
    bucket.costUsd += price.costUsd; bucket.cacheSavingsUsd += cacheSavingsUsd(options.table, record);
    bucket.fastCostUsd += record.speed === 'standard' ? 0 : price.costUsd;
    bucket.speedPremiumUsd += price.speedPremiumUsd;
    for (const category of Object.keys(bucket.totals) as (keyof typeof bucket.totals)[]) bucket.totals[category] += record.totals[category];
    if (price.categoryCostUsd) for (const category of Object.keys(bucket.categoryCostUsd) as (keyof typeof bucket.categoryCostUsd)[]) {
      bucket.categoryCostUsd[category] += price.categoryCostUsd[category];
    }
    bucketSessions.get(key)!.add(record.sessionId); bucket.sessions = bucketSessions.get(key)!.size;
    if (!providerSessions.has(record.provider)) providerSessions.set(record.provider, new Set());
    providerSessions.get(record.provider)!.add(record.sessionId);
  }
  return { buckets: [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day)),
    providerSessions: Object.fromEntries([...providerSessions].map(([provider, sessions]) => [provider, sessions.size])) };
}

/** Reads local CLI stores, never credentials or transcript contents over the API. */
export function createHistoryReader(options: { roots: () => Promise<HistoryRoot[]>; cacheDirectory?: string;
  pricing: (fresh?: boolean) => Promise<HistoryPricing>; now?: () => number }) {
  const memos = new Map<string, FileMemo>(); let loaded = false;
  type ScanResult = { since: number; at: number; records: UsageRecord[]; sources: HistorySource[]; scan: UsageHistorySummary['scan'] };
  let last: ScanResult | null = null;
  let pending: Promise<ScanResult> | null = null;
  const now = options.now ?? Date.now;
  const cacheFile = options.cacheDirectory ? join(options.cacheDirectory, 'scans-v1.json.gz') : null;
  async function scan(fresh: boolean, windowSince: number) {
    if (pending) { const finished = await pending; if (finished.since <= windowSince) return finished; }
    if (last && last.since <= windowSince && now() - last.at < (fresh ? 1_000 : 30_000)) return last;
    pending = (async () => {
      const started = Date.now(); const since = now() - RETENTION;
      if (!loaded && cacheFile) {
        loaded = true;
        try {
          const saved = JSON.parse((await unzip(await readFile(cacheFile), { maxOutputLength: 256 * 1024 * 1024 })).toString());
          if (saved.schema === MEMO_SCHEMA && Array.isArray(saved.files)) for (const [path, memo] of saved.files) {
            if (typeof path === 'string' && Array.isArray(memo.records) && typeof memo.offset === 'number' && memo.state) memos.set(path, memo);
          }
        } catch { /* An absent or invalid metadata cache is rebuilt from the native stores. */ }
      }
      const roots = await options.roots(); const records: UsageRecord[] = [];
      const sources = new Map(PROVIDERS.map(provider => [provider, { provider, status: 'missing', files: 0, records: 0 } as HistorySource]));
      let filesRead = 0; let bytesRead = 0; const active = new Set<string>();
      const append = (provider: UsageProviderKind, rows: readonly UsageRecord[]) => {
        records.push(...rows); sources.get(provider)!.records += rows.length;
      };
      const jsonFiles: { path: string; provider: UsageProviderKind }[] = [];
      for (const root of roots.filter(root => root.format === 'jsonl')) {
        const source = sources.get(root.provider)!;
        const found = await discoverHistoryFiles(root, windowSince);
        if (found.partial) source.status = 'partial';
        else if (!found.missing && source.status !== 'partial') source.status = 'ready';
        for (const path of found.files) if (!active.has(path)) { active.add(path); source.files++; jsonFiles.push({ path, provider: root.provider }); }
      }
      let index = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (index < jsonFiles.length) {
          const file = jsonFiles[index++];
          try {
            const result = await scanHistoryFile(file.path, file.provider, memos.get(file.path), since);
            memos.set(file.path, result.memo); if (result.memo.partial) sources.get(file.provider)!.status = 'partial'; bytesRead += result.bytesRead; filesRead += Number(result.bytesRead > 0);
          } catch { sources.get(file.provider)!.status = 'partial'; }
        }
      }));
      // Stable order makes copied archived/live rollouts count once, independent of I/O completion order.
      for (const file of jsonFiles.sort((a, b) => a.path.localeCompare(b.path))) {
        const memo = memos.get(file.path); if (!memo) continue;
        const occurrences = new Map<string, number>();
        append(file.provider, memo.records.filter(record => record.timestampMs >= since).map(record => {
          if (record.provider !== 'codex') return record;
          const key = `${record.sessionId}:${record.timestampMs}:${record.model}:${record.speed}:${JSON.stringify(record.totals)}`;
          const occurrence = (occurrences.get(key) ?? 0) + 1; occurrences.set(key, occurrence);
          return { ...record, dedupeKey: `${key}:${occurrence}` };
        }));
      }
      for (const root of roots.filter(root => root.format === 'opencode')) {
        const result = await readOpenCodeUsage(root.path, since); const source = sources.get('opencode')!;
        source.files += result.files.length; source.status = result.error ? 'partial' : result.missing ? source.status : 'ready';
        for (const file of result.files) append('opencode', file.records);
      }
      const antigravity = await readAntigravityUsage(roots.filter(root => root.format === 'antigravity').map(root => root.path), since);
      const source = sources.get('antigravity')!; source.files = antigravity.files.length;
      source.status = antigravity.errors.length ? 'partial' : source.files ? 'ready' : 'missing';
      for (const file of antigravity.files) append('antigravity', file.records);
      for (const [path, memo] of memos) if (memo.mtimeMs < since) memos.delete(path);
      if (cacheFile && options.cacheDirectory) try {
        await mkdir(options.cacheDirectory, { recursive: true, mode: 0o700 });
        const bytes = await zip(JSON.stringify({ schema: MEMO_SCHEMA, files: [...memos] }));
        await writeFile(`${cacheFile}.tmp`, bytes, { mode: 0o600 }); await rename(`${cacheFile}.tmp`, cacheFile);
      } catch { /* Scan results remain usable when the disposable cache cannot be written. */ }
      last = { since: windowSince, at: now(), records, sources: [...sources.values()], scan: { filesRead, bytesRead, durationMs: Date.now() - started } };
      return last;
    })().finally(() => { pending = null; });
    return pending;
  }
  return async (input: { days: 1 | 7 | 30 | 90; timeZone: string; fresh?: boolean }): Promise<UsageHistorySummary> => {
    const { since, until } = historyRange(input.days, now(), input.timeZone);
    const [data, pricing] = await Promise.all([scan(input.fresh === true, since), options.pricing(input.fresh)]);
    return { schema: 'o8/usage-history/v1', observedAt: new Date(data.at).toISOString(), since, until, timeZone: input.timeZone,
      ...aggregateHistory(data.records, { since, until, timeZone: input.timeZone, table: pricing.table, hourly: input.days === 1 }),
      sources: data.sources, pricing: pricing.meta, scan: data.scan };
  };
}
