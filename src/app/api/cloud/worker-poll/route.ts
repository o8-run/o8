/**
 * Cloud worker long-poll endpoint
 *
 * Workers hit this endpoint with a cursor:
 *   GET /api/cloud/worker-poll?cursor=0&workerId=<opaque>
 *   Authorization: Bearer <cwk_...>
 *
 * The server holds the request open up to `LONG_POLL_TIMEOUT_MS`. If a job is
 * available at or after the presented cursor, it atomically leases the job
 * to this worker and returns the lease token. If the timeout fires first, it
 * returns 204 so the worker can re-poll cheaply.
 *
 * Why a separate auth path from `/api/panel/*`?
 *   The panel middleware (src/middleware.ts) gates on loopback origin + the
 *   ~/.cortex-ide/ws-token bearer — that token is per-user, loopback-only,
 *   and must never leave the operator's machine. Cloud workers run OFF-host
 *   (Kubernetes, VMs, customer bare metal) so they need a different tier of
 *   credential with team scoping. `/api/cloud/*` is therefore added to
 *   middleware.WORKER_PREFIXES which bypasses panel-auth; this handler then
 *   runs its own verifyCloudWorkerKey() check against config-file records.
 */
import { NextResponse } from 'next/server';
import { buildErrorPayload } from '@/lib/api/error-format';
import { verifyCloudWorkerKey } from '@/lib/cloud/worker-auth';
import { ForgottenCloudContextError, workerLaunchPayload } from '@/lib/cloud/worker-payload';
import { recordCloudWorkerPresence } from '@/lib/cloud/worker-presence';
import {
  cancelJob,
  claimNextJob,
  cloudJobLeaseMs,
  getJobDrainStatus,
  type CloudJob,
  waitForJob,
} from '@/lib/cloud/job-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };
const LONG_POLL_TIMEOUT_MS = 25_000;

function jobPayload(job: CloudJob) {
  let launch: ReturnType<typeof workerLaunchPayload>;
  try { launch = workerLaunchPayload(job.launch); } catch (error) {
    if (error instanceof ForgottenCloudContextError) cancelJob(job.teamId, job.id);
    throw error;
  }
  return {
    id: job.id,
    cursor: job.cursor,
    // The durable record keeps coordinator paths for operator views. Only the
    // remote checkout contract and task fields cross the worker boundary.
    launch,
    enqueuedAt: job.enqueuedAt,
    claimedAt: job.claimedAt,
    claimedBy: job.claimedBy,
    leaseToken: job.leaseToken,
    leaseExpiresAt: job.leaseExpiresAt,
    claimCount: job.claimCount,
    leaseRecoveryCount: job.leaseRecoveryCount,
    executionAttempts: job.executionAttempts,
    maxAttempts: job.maxAttempts,
  };
}

function authErrorResponse(status: 401 | 403, reason: string) {
  return NextResponse.json(
    { error: status === 401 ? 'Unauthorized' : 'Forbidden', reason },
    { status, headers: NO_STORE_HEADERS },
  );
}

export async function GET(request: Request) {
  const auth = verifyCloudWorkerKey(request.headers.get('authorization'));
  if (!auth.ok) {
    return authErrorResponse(auth.status, auth.reason);
  }

  const url = new URL(request.url);
  const cursorParam = url.searchParams.get('cursor');
  const workerIdParam = url.searchParams.get('workerId');
  const waitMsParam = url.searchParams.get('waitMs');
  const cursor = cursorParam ? Number.parseInt(cursorParam, 10) : 0;
  const workerId = workerIdParam?.trim() || auth.keyId;
  const waitMs = waitMsParam == null
    ? LONG_POLL_TIMEOUT_MS
    : Number.parseInt(waitMsParam, 10);

  if (!Number.isFinite(cursor) || cursor < 0) {
    return NextResponse.json(
      { error: 'Invalid cursor', reason: 'cursor_out_of_range' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > LONG_POLL_TIMEOUT_MS) {
    return NextResponse.json(
      { error: 'Invalid waitMs', reason: 'wait_out_of_range' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  if (workerId.length > 128 || /[\0-\x1f\x7f]/.test(workerId)) {
    return NextResponse.json(
      { error: 'Invalid workerId', reason: 'worker_id_out_of_range' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    recordCloudWorkerPresence({ teamId: auth.teamId, keyId: auth.keyId, workerId });
    const leaseMs = cloudJobLeaseMs();
    // Fast path — job already waiting for this cursor.
    const immediate = claimNextJob(auth.teamId, cursor, workerId, leaseMs, auth.keyId);
    if (immediate) {
      return NextResponse.json(
        { job: jobPayload(immediate) },
        { headers: NO_STORE_HEADERS },
      );
    }
    const drain = getJobDrainStatus(auth.teamId);
    if (drain.draining) {
      return NextResponse.json(
        { draining: true, reason: 'app_restart', activeLeases: drain.activeLeases },
        { status: 409, headers: { ...NO_STORE_HEADERS, 'Retry-After': '1' } },
      );
    }

    // Slow path — long-poll until a job arrives or timeout.
    // The AbortSignal on the incoming request fires when the worker hangs
    // up early; in that case we cancel the waiter so we don't leak memory.
    const canClaim = () => {
      const current = verifyCloudWorkerKey(request.headers.get('authorization'));
      return current.ok && current.keyId === auth.keyId && current.teamId === auth.teamId;
    };
    const waiter = waitForJob(auth.teamId, cursor, workerId, waitMs, leaseMs, canClaim, auth.keyId);
    const abort = request.signal;
    if (abort.aborted) {
      waiter.cancel();
      return new NextResponse(null, { status: 499, headers: NO_STORE_HEADERS });
    }
    const onAbort = () => waiter.cancel();
    abort.addEventListener('abort', onAbort);

    try {
      const job = await waiter.promise;
      const current = verifyCloudWorkerKey(request.headers.get('authorization'));
      if (!current.ok) return authErrorResponse(current.status, current.reason);
      if (current.keyId !== auth.keyId || current.teamId !== auth.teamId) {
        return authErrorResponse(403, 'credential_identity_changed');
      }
      if (!job) {
        return new NextResponse(null, { status: 204, headers: NO_STORE_HEADERS });
      }
      return NextResponse.json(
        { job: jobPayload(job) },
        { headers: NO_STORE_HEADERS },
      );
    } finally {
      abort.removeEventListener('abort', onAbort);
    }
  } catch (error) {
    if (error instanceof ForgottenCloudContextError) return NextResponse.json({ error: error.message, reason: 'memory_changed' }, { status: 409, headers: NO_STORE_HEADERS });
    console.error('[cloud-worker-poll] failed:', error);
    return NextResponse.json(
      buildErrorPayload('cloud_worker_poll_failed'),
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
