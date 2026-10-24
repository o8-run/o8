import type { PullRequestStackObservation } from '@/lib/github-broker/pull-request-stack';

export type { PullRequestStackObservation };

const statuses = new Set(['ready', 'none', 'unauthorized', 'unsupported_or_not_found',
  'unsupported_cross_fork', 'deferred', 'offline', 'unavailable']);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const iso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const commit = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);

/** Admit only the requested PR's provider-native observation to the client cache. */
export function validPrStackObservation(value: unknown, target: number): value is PullRequestStackObservation {
  if (!record(value) || typeof value.status !== 'string' || !statuses.has(value.status)
    || value.source !== 'github-native' || typeof value.stale !== 'boolean' || !iso(value.attemptedAt)
    || (value.fetchedAt !== null && !iso(value.fetchedAt))
    || (value.revision !== null && !text(value.revision))) return false;
  if (value.history !== undefined && (!Array.isArray(value.history) || value.history.length > 20 || !value.history.every(entry =>
    record(entry) && text(entry.revision) && iso(entry.fetchedAt) && entry.source === 'github-native'
    && ['target', 'webhook'].includes(String(entry.trigger))
    && validPrStackObservation({ ...value, history: undefined, status: entry.snapshot === null ? 'none' : 'ready',
      snapshot: entry.snapshot, fetchedAt: entry.fetchedAt, revision: entry.revision }, entry.snapshot === null ? target
        : record(entry.snapshot) && Array.isArray(entry.snapshot.layers) && record(entry.snapshot.layers[0]) ? Number(entry.snapshot.layers[0].number) : 0)))) return false;
  const snapshot = value.snapshot;
  if (snapshot === null) return value.status !== 'ready';
  if (['none', 'unauthorized', 'unsupported_cross_fork'].includes(value.status)
    || !record(snapshot) || !positive(snapshot.id) || !positive(snapshot.number) || !text(snapshot.trunk)
    || !iso(value.fetchedAt) || !text(value.revision)
    || !Array.isArray(snapshot.layers) || !snapshot.layers.length || snapshot.layers.length > 100) return false;
  const seen = new Set<number>();
  for (const layer of snapshot.layers) {
    if (!record(layer) || !positive(layer.number) || seen.has(layer.number)
      || !text(layer.title) || !text(layer.state) || !text(layer.headRef) || !text(layer.baseRef)
      || !commit(layer.headSha) || !commit(layer.baseSha)) return false;
    seen.add(layer.number);
  }
  return seen.has(target);
}
