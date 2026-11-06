import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { modelRateTable } from '@/lib/cost/rate-table';
import { parseRateTable, type RateTable } from './history-readers/usagePricing';
import { createBundledRateTable } from './bundled-rates';
import type { UsageHistorySummary } from './history-types';

const URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const TTL = 24 * 60 * 60 * 1000;
export interface HistoryPricing { table: RateTable; meta: UsageHistorySummary['pricing']; at: number }
let current: HistoryPricing | null = null;
let inflight: Promise<HistoryPricing> | null = null;
const bundled = () => createBundledRateTable(modelRateTable.rates);

export async function readHistoryPricing(fresh = false) {
  if (inflight) return inflight;
  if (current && Date.now() - current.at < (fresh ? 60_000 : TTL)) return current;
  inflight = (async () => {
    const directory = join(getDataDir(), 'usage-history');
    const file = join(directory, 'rates.json');
    if (!current) {
      try {
        const saved = JSON.parse(await readFile(file, 'utf8'));
        const table = parseRateTable(saved.document);
        if (table.size && typeof saved.at === 'number') current = { table, at: saved.at,
          meta: { source: URL, observedAt: new Date(saved.at).toISOString(), status: 'cached' } };
      } catch { /* A public rate snapshot is optional. */ }
      if (!fresh && current && Date.now() - current.at < TTL) return current;
    }
    try {
      const response = await fetch(URL, { signal: AbortSignal.timeout(5_000), cache: 'no-store' });
      if (!response.ok) throw new Error('Price snapshot unavailable');
      const text = await response.text();
      if (text.length > 12 * 1024 * 1024) throw new Error('Price snapshot too large');
      const document = JSON.parse(text); const table = parseRateTable(document);
      if (!table.size) throw new Error('No valid prices');
      const at = Date.now(); current = { table, at, meta: { source: URL, observedAt: new Date(at).toISOString(), status: 'live' } };
      await mkdir(directory, { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify({ at, document }), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    } catch {
      if (current) current = { ...current, meta: { ...current.meta, status: 'cached' } };
      else current = { table: bundled(), at: Date.now(), meta: { source: 'Bundled model rates',
        observedAt: modelRateTable.observedOn, status: 'bundled' } };
    }
    return current!;
  })().finally(() => { inflight = null; });
  return inflight;
}
