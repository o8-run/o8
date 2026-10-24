import type { MobileTranscriptEntry } from '@/lib/mobile/types';

export const CACHE_OBSERVATIONS_KEY = 'o8:prompt-cache-observations:v1';
const MAX_ROWS = 5000;
const RETAIN_MS = 14 * 86400_000;
export const LARGE_CONTEXT_TOKENS = 10_000;
export interface CacheObservation {
  id: string; session: string; runtime: string; model: string;
  startedAt: number; endedAt: number; input: number | null; read: number | null; write: number | null;
  requestedLifetimeMs: number | null; idleGapMs: number | null;
}
export interface CacheResume extends CacheObservation { idleGapMs: number | null }
const EMPTY: readonly CacheObservation[] = [];
let snapshot: readonly CacheObservation[] = EMPTY;
let storedValue: string | null | undefined;
const listeners = new Set<() => void>();
const count = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const lifetime = (n: unknown): n is number => count(n) && n > 0 && n <= 24 * 3600_000;
const supported = (runtime: string) => runtime === 'codex' || runtime === 'claude-code';
function valid(row: unknown): row is CacheObservation {
  if (!row || typeof row !== 'object') return false;
  const r = row as CacheObservation;
  return typeof r.id === 'string' && typeof r.session === 'string' && supported(r.runtime) && typeof r.model === 'string'
    && count(r.startedAt) && count(r.endedAt) && r.endedAt >= r.startedAt
    && [r.input, r.read, r.write].every(n => n === null || count(n))
    && (r.idleGapMs === null || count(r.idleGapMs))
    && (r.requestedLifetimeMs === null || lifetime(r.requestedLifetimeMs));
}
function read(): CacheObservation[] {
  try {
    const raw = window.localStorage.getItem(CACHE_OBSERVATIONS_KEY);
    if (raw && raw.length > 2_000_000) return [];
    const rows: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(rows) ? rows.filter(valid).slice(-MAX_ROWS) : [];
  } catch { return []; }
}
export function cacheObservations(): readonly CacheObservation[] {
  if (typeof window !== 'undefined') {
    try { const value = window.localStorage.getItem(CACHE_OBSERVATIONS_KEY);
      if (value !== storedValue) { snapshot = read(); storedValue = value; }
    } catch { /* Preserve in-memory observations when storage is disabled. */ }
  }
  return snapshot;
}
export const emptyCacheObservations = () => EMPTY;
export function subscribeCacheObservations(listener: () => void) {
  listeners.add(listener);
  const changed = (event: StorageEvent) => {
    if (event.key !== CACHE_OBSERVATIONS_KEY && event.key !== null) return;
    snapshot = read();
    try { storedValue = window.localStorage.getItem(CACHE_OBSERVATIONS_KEY); } catch { storedValue = undefined; } listeners.forEach(notify => notify());
  };
  window.addEventListener('storage', changed);
  return () => { listeners.delete(listener); window.removeEventListener('storage', changed); };
}

/** Facts only: timestamps/counters/opaque identities, never prompts or credentials. No network reads. */
export function recordCacheTranscript(input: {
  session: string; runtime: string; model?: string | null; entries: MobileTranscriptEntry[]; running: boolean;
  completedAt?: number;
}): void {
  if (!supported(input.runtime) || !input.session || input.running) return;
  const groups: MobileTranscriptEntry[][] = [];
  for (const entry of input.entries) {
    if (entry.role === 'user') groups.push([entry]);
    else if (groups.length) groups[groups.length - 1].push(entry);
  }
  const additions: CacheObservation[] = [];
  groups.forEach((group, index) => {
    const user = group[0];
    const assistant = group.filter(e => e.role === 'assistant' && e.type !== 'compaction');
    if (!assistant.length || !count(user.timestamp)) return;
    // Do not transfer cache evidence from a previous backend or model to the next selected one.
    const runtimes = new Set(assistant.map(e => e.backend ?? input.runtime));
    const models = new Set(assistant.filter(e => e.tokens).map(e => e.model ?? ''));
    if (models.size === 0) models.add('');
    if (runtimes.size !== 1 || !runtimes.has(input.runtime) || models.size !== 1) return;
    const times = assistant.map(e => e.timestamp).filter(count);
    if (times.length !== assistant.length) return;
    const usage = assistant.filter(e => e.tokens);
    const total = (field: 'input' | 'cacheRead' | 'cacheWrite') => {
      if (!usage.length || !usage.every(({ tokens: t }) => t?.cacheObserved !== false && count(t?.[field]))) return null;
      const sum = usage.reduce((n, e) => n + e.tokens![field]!, 0);
      return count(sum) ? sum : null;
    };
    const ttl = usage.map(e => e.tokens?.cacheRetentionMs).filter(lifetime);
    const endedAt = index === groups.length - 1 && count(input.completedAt) ? input.completedAt : Math.max(...times);
    const row: CacheObservation = { id: JSON.stringify([input.session, input.runtime, user.id]), session: input.session,
      runtime: input.runtime, model: [...models][0], startedAt: user.timestamp, endedAt,
      input: total('input'), read: total('cacheRead'), write: total('cacheWrite'),
      requestedLifetimeMs: ttl.length ? Math.min(...ttl) : null, idleGapMs: null };
    if (valid(row)) additions.push(row);
  });
  if (!additions.length) return;
  const previous = cacheObservations();
  const rows = new Map([...read(), ...previous].map(row => [row.id, row]));
  // Reopening the same historical messages must not downgrade a later observed completion time.
  for (const row of additions) {
    const old = rows.get(row.id);
    rows.set(row.id, old ? { ...row, endedAt: Math.max(old.endedAt, row.endedAt) } : row);
  }
  const now = Date.now();
  const next = cacheResumes([...rows.values()]).filter(row => row.endedAt >= now - RETAIN_MS && row.endedAt <= now)
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id)).slice(-MAX_ROWS);
  if (JSON.stringify(next) === JSON.stringify(previous)) return;
  snapshot = next;
  try { const value = JSON.stringify(next); window.localStorage.setItem(CACHE_OBSERVATIONS_KEY, value); storedValue = value; } catch { /* Local storage may be unavailable. */ }
  listeners.forEach(notify => notify());
}

export function cacheResumes(rows: readonly CacheObservation[]): CacheResume[] {
  const previous = new Map<string, CacheObservation>();
  return [...rows].sort((a, b) => a.startedAt - b.startedAt).map(row => {
    const key = JSON.stringify([row.session, row.runtime, row.model]);
    const prior = previous.get(key); previous.set(key, row);
    return { ...row, idleGapMs: prior ? Math.max(0, row.startedAt - prior.endedAt) : row.idleGapMs };
  });
}
export function sessionCacheEstimate(rows: readonly CacheObservation[], session: string, runtime: string, model: string | null | undefined, now: number) {
  const resumes = cacheResumes(rows);
  const last = resumes.filter(row => row.session === session && row.runtime === runtime).at(-1);
  if (!supported(runtime) || !model || !last || last.model !== (model ?? '') || last.read === null) return null;
  if (last.read === 0 && !(last.write! > 0)) return last.idleGapMs! > 0 && last.input! >= LARGE_CONTEXT_TOKENS
    ? { remainingMs: 0, source: 'observed' } : null;
  const evidence = resumes.filter(row => row.runtime === runtime && row.model === last.model && row.idleGapMs !== null && row.idleGapMs > 0).slice(-40);
  const coldBound = Math.min(Infinity, ...evidence.filter(row => row.read === 0 && (row.input ?? 0) >= LARGE_CONTEXT_TOKENS).map(row => row.idleGapMs!));
  const observed = Math.max(0, ...evidence.filter(row => (row.read ?? 0) > 0 && row.idleGapMs! < coldBound).map(row => row.idleGapMs!));
  const ttl = last.requestedLifetimeMs ?? (observed || null);
  return ttl ? { remainingMs: Math.max(0, last.endedAt + ttl - now), source: last.requestedLifetimeMs ? 'requested' : 'observed' } : null;
}
export function dailyCacheStats(rows: readonly CacheObservation[], runtime: string, now: number) {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const today = cacheResumes(rows).filter(row => row.runtime === runtime && row.endedAt >= start.getTime() && row.endedAt <= now);
  const known = today.filter(row => row.input !== null && row.read !== null && row.write !== null);
  const read = known.reduce((n, row) => n + row.read!, 0);
  const total = known.reduce((n, row) => n + row.input! + row.read! + row.write!, 0);
  return { share: total > 0 ? read / total : null, measured: known.length, observed: today.length,
    coldResumes: known.filter(row => row.idleGapMs !== null && row.idleGapMs > 0 && row.read === 0 && row.input! >= LARGE_CONTEXT_TOKENS).length };
}
