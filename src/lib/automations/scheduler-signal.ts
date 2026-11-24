/**
 * What the automation scheduler needs to know without importing it: which
 * sources an enabled watch reads, and a signal that automations, fires or
 * watched source events changed so the scheduler re-plans its next wake.
 */
import { getSqlite } from '@/lib/db';
import type { AutomationSourceKind } from './source-events';

type Listener = (reason: 'changed' | 'source_event') => void;
let listener: Listener | null = null;

/** The scheduler registers here at boot; tests and other processes leave it unset. */
export function onAutomationSchedulerSignal(next: Listener | null): void {
  listener = next;
}

export function signalAutomationsChanged(): void {
  listener?.('changed');
}

export function signalAutomationSourceEvent(): void {
  listener?.('source_event');
}

/**
 * Source kinds an enabled, event-driven watch reads, with the earliest such
 * watch's creation time per kind. A fuzzy watch fires from its condition, not
 * from events, so it does not count. The automations table is small; this is
 * read per call rather than cached so a change by any writer is seen at once.
 */
export function watchedSourceKinds(): Map<AutomationSourceKind, number> {
  const rows = getSqlite().prepare(`
    SELECT watch_source_kind AS kind, MIN(created_at) AS created
    FROM automations
    WHERE enabled = 1 AND trigger_kind = 'watch' AND watch_source_kind IS NOT NULL
      AND symon_fuzzy_condition IS NULL
    GROUP BY watch_source_kind
  `).all() as Array<{ kind: AutomationSourceKind; created: string | number | null }>;
  const kinds = new Map<AutomationSourceKind, number>();
  for (const row of rows) kinds.set(row.kind, createdAtMs(row.created));
  return kinds;
}

/** SQLite `datetime('now')` text is UTC without a zone; numbers are epoch milliseconds. */
export function createdAtMs(value: string | number | null): number {
  if (typeof value === 'number') return value;
  if (!value) return 0;
  const parsed = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : 0;
}
