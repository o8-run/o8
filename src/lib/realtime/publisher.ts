import type {
  RealtimeInternalRequest,
  RealtimeMutationPublishRequest,
  RealtimeRefreshRequest,
} from '@/lib/realtime/types';
import { SELF_REQUEST_HEADERS } from '@/lib/background-work/idle-gate';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { getWsBase } from '@/lib/panel/api-port';

export function normalizeRealtimeInternalOrigin(origin: string): string {
  return origin.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
}

const REALTIME_INTERNAL_ORIGIN = normalizeRealtimeInternalOrigin(
  process.env.CORTEX_REALTIME_INTERNAL_ORIGIN ?? getWsBase(),
);
const REALTIME_INTERNAL_TIMEOUT_MS = 2_500;
// o8d answers 503 with Retry-After while its producer is being replaced. The
// request was not forwarded, so one bounded retry cannot duplicate a notice.
const REALTIME_UNAVAILABLE_RETRY_MAX_MS = 1_000;

async function postInternalRealtimeRequest(payload: RealtimeInternalRequest) {
  try {
    const deadline = AbortSignal.timeout(REALTIME_INTERNAL_TIMEOUT_MS);
    const post = () => fetch(`${REALTIME_INTERNAL_ORIGIN}/internal/realtime`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getOrCreateWsToken()}`,
        'Content-Type': 'application/json',
        'x-o8-background': '1',
      },
      body: JSON.stringify(payload),
      signal: deadline,
    });
    let response = await post();
    if (response.status === 503 && response.headers.has('retry-after')) {
      await response.body?.cancel();
      const seconds = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(seconds) ? Math.min(Math.max(seconds * 1_000, 0), REALTIME_UNAVAILABLE_RETRY_MAX_MS) : REALTIME_UNAVAILABLE_RETRY_MAX_MS;
      await new Promise(resolve => setTimeout(resolve, delay));
      response = await post();
    }
    return response.ok;
  } catch {
    // Best-effort: the app must remain correct even if the local WS bridge
    // is not running yet. Poll fallback still reconciles eventually.
    return false;
  }
}

export async function requestRealtimeRefresh(request: Omit<RealtimeRefreshRequest, 'kind'>) {
  return postInternalRealtimeRequest({
    kind: 'refresh',
    ...request,
  });
}

export async function publishRealtimeMutation(request: Omit<RealtimeMutationPublishRequest, 'kind'>) {
  return postInternalRealtimeRequest({
    kind: 'mutation',
    ...request,
  });
}

/** Resources whose clients read once on a `changed` notice instead of polling. */
export type ChangedResource = 'update';
const CHANGED_COALESCE_MS = 250;
const changedPending = new Set<ChangedResource>();

/**
 * One generic "this changed" notice per resource: the ws-server broadcasts
 * `{ channel: 'changed', event: <resource> }` with no data, and a window that
 * shows the resource reads it once. Changes within 250 ms coalesce into one.
 *
 * Best-effort — never throws; a missed notice is read on the next one.
 */
export function publishChanged(resource: ChangedResource): void {
  if (changedPending.has(resource)) return;
  changedPending.add(resource);
  setTimeout(() => {
    changedPending.delete(resource);
    void fetch(`${REALTIME_INTERNAL_ORIGIN}/internal/changed`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getOrCreateWsToken()}`,
        'Content-Type': 'application/json',
        // The server's own notice: never client activity for the idle gate.
        ...SELF_REQUEST_HEADERS,
      },
      body: JSON.stringify({ resource }),
      signal: AbortSignal.timeout(REALTIME_INTERNAL_TIMEOUT_MS),
    }).then(response => response.body?.cancel()).catch(() => {});
  }, CHANGED_COALESCE_MS).unref?.();
}

/**
 * #840 — Lightweight broadcast for Cortex memory mutations the UI cares
 * about (directives, outcomes, codebase-memory). The ws-server fans this
 * out as a `cortex-changes` channel event, which the desktop WS context
 * bridges to an `o8:cortex-changes` window event. The Recall Card and
 * Packet Review Card listen for this and re-fetch their data without a
 * full page reload.
 *
 * Best-effort — never throws, never blocks the merge path.
 */
export async function publishCortexChange(payload: {
  scope: 'directive' | 'outcome' | 'codebase-memory';
  /** Repo path the change applies to, when known. */
  repoPath?: string;
  /** Free-form reason for logs (e.g. `merge:packet-123`). */
  reason?: string;
}) {
  try {
    await fetch(`${REALTIME_INTERNAL_ORIGIN}/internal/cortex-changes`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getOrCreateWsToken()}`,
        'Content-Type': 'application/json',
        // The server's own notice: never client activity for the idle gate.
        ...SELF_REQUEST_HEADERS,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REALTIME_INTERNAL_TIMEOUT_MS),
    });
  } catch {
    // Best-effort — UI still has poll fallback.
  }
}

/**
 * #1147 Phase 2 — live visual-proof. After an agent records a before/after
 * still (POST /api/panel/artifacts), fan out an `artifacts` channel event so
 * the mounted proof strips (PacketCard, PrPanel, mission-complete) refetch
 * live instead of waiting for the next mount/poll. Carries only identifiers —
 * clients refetch the authoritative list via GET /api/panel/artifacts.
 *
 * Best-effort — never throws, never blocks the ingest path.
 */
export async function publishArtifactRecorded(payload: {
  artifactId: string;
  packetId?: string | null;
  prNumber?: number | null;
  laneId?: string | null;
}) {
  try {
    await fetch(`${REALTIME_INTERNAL_ORIGIN}/internal/artifacts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getOrCreateWsToken()}`,
        'Content-Type': 'application/json',
        // The server's own notice: never client activity for the idle gate.
        ...SELF_REQUEST_HEADERS,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REALTIME_INTERNAL_TIMEOUT_MS),
    });
  } catch {
    // Best-effort — UI still has its mount/poll fetch.
  }
}
