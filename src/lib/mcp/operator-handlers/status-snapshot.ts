import { runtimeConnectionRows } from '@/lib/runtimes/shared/connection-evidence';
import { apiFetch, getApiBase } from './shared';
import { publishNativeStatus, removeNativeStatus } from '@/lib/mcp/native-read-publication';

const REFRESH_AFTER_MS = 5_000;
const MAX_AGE_MS = 15_000;
const MAX_SNAPSHOTS = 64;

type Connections = ReturnType<typeof runtimeConnectionRows>;
interface Snapshot {
  data: Record<string, unknown>;
  runtimeConnections: Connections;
  capturedAt: number;
}
interface Source {
  snapshot?: Snapshot;
  inflight?: Promise<Snapshot>;
}

// Preserve server-side filtering of its truncated approval/activity lists.
// Include the backend so a port switch cannot reuse another process's data.
const sources = new Map<string, Source>();
const connectionRefreshes = new Map<string, Promise<{ value: Connections; capturedAt: number }>>();
type LeadStatuses = ReturnType<typeof import('@/lib/orchestrator/lead-status').readLeadStatuses>;
const leadReads = new Map<string, Promise<LeadStatuses>>();

function readLeads(base: string, sessionKey: string | undefined) {
  const key = JSON.stringify([base, sessionKey || '']);
  const pending = leadReads.get(key);
  if (pending) return pending;
  const query = new URLSearchParams({ list: 'true', ...(sessionKey ? { sessionKey } : {}) });
  const request = Promise.resolve(apiFetch(`/api/orchestrator/lead?${query}`)).then(value => {
    const result = value as LeadStatuses;
    if (!Array.isArray(result?.leads) || !Number.isSafeInteger(result.cursor)) throw new Error('Lead status unavailable');
    return result;
  });
  leadReads.set(key, request);
  const settled = () => { leadReads.delete(key); };
  void request.then(settled, settled);
  return request;
}

function readConnections(base: string) {
  const pending = connectionRefreshes.get(base);
  if (pending) return pending;
  const capturedAt = Date.now();
  const request = Promise.resolve(apiFetch('/api/panel/operator-defaults')).catch(() => null)
    .then((value) => ({ value: runtimeConnectionRows(value), capturedAt }));
  connectionRefreshes.set(base, request);
  const settled = () => { connectionRefreshes.delete(base); };
  void request.then(settled, settled);
  return request;
}

function pruneSources() {
  for (const [key, source] of sources) {
    if (sources.size <= MAX_SNAPSHOTS) break;
    if (!source.inflight) {
      sources.delete(key);
      removeNativeStatus(key);
    }
  }
}

function refresh(source: Source, base: string, sessionKey: string | undefined): Promise<Snapshot> {
  if (source.inflight) return source.inflight;
  // Include the time spent gathering evidence in its age, not just cache time.
  const startedAt = Date.now();
  const qs = sessionKey ? `?sessionKey=${encodeURIComponent(sessionKey)}` : '';
  const request = Promise.all([
    apiFetch(`/api/operator/status${qs}`) as Promise<Record<string, unknown>>,
    readConnections(base),
  ]).then(([data, connections]) => {
    const capturedAt = Math.min(startedAt, connections.capturedAt);
    if (Date.now() - capturedAt >= MAX_AGE_MS) {
      throw new Error('Status refresh exceeded its freshness bound');
    }
    const snapshot = { data, runtimeConnections: connections.value, capturedAt };
    source.snapshot = snapshot;
    return snapshot;
  });
  source.inflight = request;
  const settled = () => { source.inflight = undefined; pruneSources(); };
  void request.then(settled, settled);
  return request;
}

export async function readStatusSnapshot(sessionKey: string | undefined, fresh: boolean) {
  const base = getApiBase();
  const key = JSON.stringify([base, sessionKey || '']);
  const source = sources.get(key) ?? {};
  sources.delete(key);
  sources.set(key, source);
  const cached = source.snapshot;
  const ageMs = cached ? Date.now() - cached.capturedAt : Infinity;
  let value: Snapshot;
  // Cold, expired, and explicitly fresh reads wait on the same refresh. A
  // failure never renews the old snapshot or serves it past the hard bound.
  if (!cached || fresh || ageMs < 0 || ageMs >= MAX_AGE_MS) {
    value = await refresh(source, base, sessionKey);
  } else {
    if (ageMs >= REFRESH_AFTER_MS) {
      void refresh(source, base, sessionKey).catch(() => {});
    }
    value = cached;
  }
  // Runtime observations can be cached; a durable lead handback cannot survive a new turn.
  let live: LeadStatuses | undefined;
  try {
    live = await readLeads(base, sessionKey);
  } catch {
    // A failed lead read must neither erase runtime evidence nor reuse a handback.
    removeNativeStatus(key);
  }
  if (Date.now() - value.capturedAt >= MAX_AGE_MS) throw new Error('Status refresh exceeded its freshness bound');
  const data: Record<string, unknown> = { ...value.data };
  delete data.leads;
  delete data.leadsUnavailable;
  delete data.leadsTruncated;
  if (live) {
    if (live.leads.length) data.leads = live.leads;
    if (live.truncated) data.leadsTruncated = true;
    publishNativeStatus(base, sessionKey, { ...value, data, leadCursor: live.cursor });
  } else {
    data.leadsUnavailable = true;
  }
  return {
    data,
    runtimeConnections: value.runtimeConnections,
    snapshot: {
      capturedAt: new Date(value.capturedAt).toISOString(),
      ageMs: Math.max(0, Date.now() - value.capturedAt),
      refreshAfterMs: REFRESH_AFTER_MS,
      maxAgeMs: MAX_AGE_MS,
    },
  };
}
