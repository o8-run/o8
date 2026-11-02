import 'server-only';

/**
 * The in-app receipt: "your report was fixed in this version."
 *
 * This reaches everyone who ever filed a report — which is the whole point of
 * a receipt.
 *
 * How it costs nothing and leaks nothing:
 *   - We DOWNLOAD a public manifest (fixed.json) that release.mjs ships next to
 *     latest.json on the public o8-releases mirror. Same anonymous GitHub asset
 *     the updater already fetches: no server, no auth, no bill.
 *   - We UPLOAD nothing. The join happens locally, against this machine's own
 *     ledger (~/.o8/feedback/reports.jsonl). No report ids leave the box, no
 *     telemetry, no identity. The manifest carries no reporter handles either.
 *
 * So the receipt works even for an operator with crash reporting turned off.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { feedbackDir, readReports } from './report-ledger';

const MANIFEST_URL = 'https://github.com/hurttlocker/o8-releases/releases/latest/download/fixed.json';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // the manifest only changes on release
const FETCH_TIMEOUT_MS = 8000;

/**
 * `fixed` is a win; `needs-info` is an ask ("we looked, can you tell us X?").
 * Wounds — wont-fix, cant-reproduce, attempted — are never published: a public
 * list of what we won't fix is the rot board we refused to build.
 */
export type ReceiptStatus = 'fixed' | 'needs-info';

export interface FixedEntry {
  id: string;
  title: string;
  version: string;
  status: ReceiptStatus;
  /** For needs-info, the ask itself. Without it the card has nothing to say. */
  note?: string;
}

/** A fix for a report THIS machine filed, that the operator hasn't seen yet. */
export interface FixReceipt extends FixedEntry {
  /** When they filed it — lets the UI say "you reported this 3 weeks ago". */
  reportedAt: number;
}

interface CachedManifest {
  entries: FixedEntry[];
  fetchedAt: number;
}

let cache: CachedManifest | null = null;

function seenPath(): string {
  return path.join(feedbackDir(), 'seen-fixed.json');
}

/** Ids the operator has already been shown. Never throws. */
export function readSeen(): Set<string> {
  try {
    const file = seenPath();
    if (!existsSync(file)) return new Set();
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { ids?: unknown };
    return new Set(Array.isArray(parsed.ids) ? parsed.ids.map(String) : []);
  } catch {
    return new Set();
  }
}

/** Mark receipts as shown so they don't nag. Never throws. */
export function markSeen(ids: string[]): void {
  try {
    const dir = feedbackDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const merged = readSeen();
    for (const id of ids) merged.add(id.trim().toUpperCase());
    writeFileSync(seenPath(), `${JSON.stringify({ ids: [...merged] }, null, 2)}\n`, 'utf8');
  } catch {
    /* a failed ack just means we ask again next launch — harmless */
  }
}

function parseManifest(payload: unknown): FixedEntry[] {
  if (!payload || typeof payload !== 'object') return [];
  const raw = (payload as { fixed?: unknown }).fixed;
  if (!Array.isArray(raw)) return [];

  const out: FixedEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { id, title, version, status, note } = item as Record<string, unknown>;
    if (typeof id !== 'string' || typeof title !== 'string' || typeof version !== 'string' || !id || !title) continue;
    // The first shipped manifest predates `status` — those entries are all fixes.
    const resolved: ReceiptStatus = status === 'needs-info' ? 'needs-info' : 'fixed';
    // An ask with nothing to ask for is worse than silence — drop it.
    if (resolved === 'needs-info' && typeof note !== 'string') continue;
    out.push({
      id: id.toUpperCase(),
      title,
      version,
      status: resolved,
      ...(typeof note === 'string' && note ? { note } : {}),
    });
  }
  return out;
}

/**
 * Fetch the public manifest. Cached for 6h — it only changes on release, and an
 * update check must never become a hot loop against GitHub. Never throws: a
 * missing receipt is invisible, a crashing dashboard is not.
 */
export async function fetchFixedManifest(now: number = Date.now()): Promise<FixedEntry[]> {
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.entries;

  try {
    const response = await fetch(MANIFEST_URL, {
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // 404 is expected until the first release that ships a manifest.
    if (!response.ok) {
      cache = { entries: cache?.entries ?? [], fetchedAt: now };
      return cache.entries;
    }
    const entries = parseManifest(await response.json());
    cache = { entries, fetchedAt: now };
    return entries;
  } catch {
    // Offline, timeout, malformed — serve whatever we had, or nothing.
    cache = { entries: cache?.entries ?? [], fetchedAt: now };
    return cache.entries;
  }
}

/**
 * Pure: which of MY reports are fixed and unseen. Newest fix first.
 * Split out from the fetch so the join is testable without a network.
 */
export function matchReceipts(
  manifest: FixedEntry[],
  reports: { id: string; ts: number; title?: string; origin?: string }[],
  seen: Set<string>,
): FixReceipt[] {
  const mine = new Map(reports.map((r) => [r.id.toUpperCase(), r]));

  const receipts: FixReceipt[] = [];
  for (const entry of manifest) {
    if (seen.has(entry.id)) continue;
    const own = mine.get(entry.id);
    if (!own) continue; // somebody else's report
    // Only reports filed from THIS install earn a receipt. Rows mirrored from
    // the intake channel by the maintainer's sync carry origin 'intake-sync' —
    // without this check the ops box showed "you reported this" for every
    // fixed report in existence (Q hit it on the D3YPBP fix, 2026-07-14).
    // The Map is last-write-wins, so a re-appended marked row (ledger is
    // append-only) overrides an older unmarked copy of the same id.
    if (own.origin === 'intake-sync') continue; // mirrored by ops sync, not filed here

    // Show them THEIR OWN WORDS. The manifest title is the sanitized line we
    // publish to the world; this machine's ledger still has the raw text they
    // typed, and "you reported this — <what you actually said>" is the whole
    // point of a receipt. Fall back to the public title if the local one is gone.
    receipts.push({
      ...entry,
      title: own.title?.trim() || entry.title,
      reportedAt: own.ts,
    });
  }
  // Most recently filed first — the freshest one is the one they remember.
  return receipts.sort((a, b) => b.reportedAt - a.reportedAt);
}

/** The receipts to show right now. Never throws. */
export async function collectReceipts(): Promise<FixReceipt[]> {
  try {
    const [manifest, reports] = [await fetchFixedManifest(), readReports()];
    return matchReceipts(manifest, reports, readSeen());
  } catch {
    return [];
  }
}

/** Test seam — the module caches the manifest fetch. */
export function __resetFixedFeedCache(): void {
  cache = null;
}
