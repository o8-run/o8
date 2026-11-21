/**
 * Durable cloud job queue.
 *
 * SQLite owns accepted work, claims, leases, retry accounting, and output.
 * Process memory is used only to wake local long-poll requests early; periodic
 * polling keeps waiters correct when another process enqueues the job.
 */
import { recurring } from '@/lib/background-work/ledger';
import { getSqlite } from '@/lib/db';
import { randomUUID } from 'node:crypto';
import type { LaunchOptions } from '@/lib/runtimes/types';
import type {
  AcknowledgeCloudJobControlResult,
  AppendCloudJobEventInput,
  AppendCloudJobEventResult,
  ClaimCloudJobControlResult,
  CloudJob,
  CloudJobControl,
  CloudJobControlType,
  CloudJobDrainStatus,
  CloudJobEvent,
  CloudJobMetrics,
  QueueCloudJobControlResult,
} from './job-store';
import { SqliteCloudJobStore } from './sqlite-job-store';

export type { CloudJob, CloudJobControl, CloudJobEvent, CloudJobMetrics } from './job-store';
export { CloudPacketActiveError } from './job-store';

const DEFAULT_LEASE_MS = 30_000;
const MIN_LEASE_MS = 100;
const MAX_LEASE_MS = 10 * 60_000;
const DURABLE_POLL_INTERVAL_MS = 100;
const CLOUD_JOB_BOOT_ID = process.env.O8_BOOT_ID?.trim() || `process:${process.pid}:${randomUUID()}`;

const store = new SqliteCloudJobStore();
const teamWaiters = new Map<string, Set<() => void>>();
const activeWaitCancels = new Set<() => void>();

export function cloudJobLeaseMs(): number {
  const configured = Number.parseInt(process.env.O8_CLOUD_JOB_LEASE_MS ?? '', 10);
  if (!Number.isFinite(configured)) return DEFAULT_LEASE_MS;
  return Math.min(Math.max(configured, MIN_LEASE_MS), MAX_LEASE_MS);
}

function notifyTeam(teamId: string): void {
  for (const wake of teamWaiters.get(teamId) ?? []) wake();
}

/** Persist the accepted request before returning its dispatch receipt. */
export function enqueueCloudJob(teamId: string, jobId: string, launch: LaunchOptions): CloudJob {
  const job = store.enqueue({
    id: jobId,
    teamId,
    idempotencyKey: launch.clientMutationId?.trim() || jobId,
    packetId: launch.packetId,
    launch,
  });
  notifyTeam(teamId);
  return job;
}

/** Atomically claim one pending job and issue a worker-bound lease token. */
export function claimNextJob(
  teamId: string,
  cursor: number,
  workerId: string,
  leaseMs: number = cloudJobLeaseMs(),
  workerKeyId?: string,
): CloudJob | null {
  return store.claimNext({ teamId, cursor, workerId, bootId: CLOUD_JOB_BOOT_ID, leaseMs, workerKeyId });
}

/**
 * Wait for a durable claim. The interval is required because enqueue and poll
 * can run in separate app processes, where an in-memory wake signal cannot
 * cross the process boundary.
 */
export function waitForJob(
  teamId: string,
  cursor: number,
  workerId: string,
  timeoutMs: number,
  leaseMs: number = cloudJobLeaseMs(),
  canClaim?: () => boolean,
  workerKeyId?: string,
): { promise: Promise<CloudJob | null>; cancel: () => void } {
  let settled = false;
  let finish: (job: CloudJob | null) => void = () => {};
  let cancelWait: () => void = () => {};
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  const waiters = teamWaiters.get(teamId) ?? new Set<() => void>();
  teamWaiters.set(teamId, waiters);

  const cleanup = () => {
    waiters.delete(check);
    activeWaitCancels.delete(cancelWait);
    if (waiters.size === 0) teamWaiters.delete(teamId);
    if (timeout) clearTimeout(timeout);
    if (interval) clearInterval(interval);
    timeout = null;
    interval = null;
  };
  const settle = (job: CloudJob | null) => {
    if (settled) return;
    settled = true;
    cleanup();
    finish(job);
  };
  const check = () => {
    if (settled) return;
    try {
      if (canClaim && !canClaim()) { settle(null); return; }
      const job = claimNextJob(teamId, cursor, workerId, leaseMs, workerKeyId);
      if (job) settle(job);
    } catch (error) {
      console.error('[cloud-job-queue] durable poll failed:', error);
    }
  };

  const promise = new Promise<CloudJob | null>((resolve) => {
    finish = resolve;
    waiters.add(check);
    interval = recurring('cloud-job-queue-poll', check, DURABLE_POLL_INTERVAL_MS);
    timeout = setTimeout(() => settle(null), Math.max(0, timeoutMs));
    check();
  });

  cancelWait = () => settle(null);
  if (!settled) activeWaitCancels.add(cancelWait);
  return { promise, cancel: cancelWait };
}

export function appendJobEvent(
  input: Omit<AppendCloudJobEventInput, 'leaseMs'> & { leaseMs?: number },
): AppendCloudJobEventResult {
  return store.appendEvent({ ...input, leaseMs: input.leaseMs ?? cloudJobLeaseMs() });
}

export function recoverExpiredJobLeases(teamId: string, nowMs?: number): number {
  const recovered = store.recoverExpiredLeases(teamId, nowMs);
  if (recovered > 0) notifyTeam(teamId);
  return recovered;
}

export function getJob(teamId: string, jobId: string): CloudJob | undefined {
  return store.get(teamId, jobId);
}

export function getLatestSessionJob(teamId: string, sessionId: string): CloudJob | undefined {
  return store.getLatestForSession(teamId, sessionId);
}

export function getLatestPacketJob(teamId: string, packetId: string): CloudJob | undefined {
  return store.getLatestForPacket(teamId, packetId);
}

export function listJobs(teamId: string, limit?: number): CloudJob[] {
  return store.list(teamId, limit);
}

export function readJobEvents(
  teamId: string,
  jobId: string,
  sinceId?: number,
  limit?: number,
): CloudJobEvent[] {
  return store.readEvents(teamId, jobId, sinceId, limit);
}

export function readSessionJobEvents(
  teamId: string,
  sessionId: string,
  sinceId?: number,
  limit?: number,
): CloudJobEvent[] {
  return store.readSessionEvents(teamId, sessionId, sinceId, limit);
}

export function queueJobControl(input: {
  teamId: string;
  sessionId: string;
  controlId: string;
  type: CloudJobControlType;
  payload: unknown;
}): QueueCloudJobControlResult | undefined {
  const result = store.queueControl(input);
  if (result?.followUpJob) notifyTeam(input.teamId);
  return result;
}

export function claimJobControl(input: {
  teamId: string;
  jobId: string;
  workerId: string;
  leaseToken: string;
  deliveryLeaseMs?: number;
}): ClaimCloudJobControlResult {
  return store.claimControl({ ...input, deliveryLeaseMs: input.deliveryLeaseMs ?? cloudJobLeaseMs() });
}

export function acknowledgeJobControl(input: {
  teamId: string;
  jobId: string;
  workerId: string;
  leaseToken: string;
  controlId: string;
  deliveryToken: string;
}): AcknowledgeCloudJobControlResult {
  const result = store.acknowledgeControl(input);
  if (result.accepted && result.job.status === 'cancelled') notifyTeam(input.teamId);
  return result;
}

export function listJobControls(teamId: string, jobId: string): CloudJobControl[] {
  return store.listControls(teamId, jobId);
}

export function getJobMetrics(teamId: string, jobId: string): CloudJobMetrics | undefined {
  return store.metrics(teamId, jobId);
}

export function beginJobDrain(teamId: string): CloudJobDrainStatus {
  return store.beginDrain(teamId, CLOUD_JOB_BOOT_ID);
}

export function finishJobDrain(teamId: string): CloudJobDrainStatus {
  return store.finishDrain(teamId, CLOUD_JOB_BOOT_ID);
}

export function getJobDrainStatus(teamId: string): CloudJobDrainStatus {
  return store.drainStatus(teamId, CLOUD_JOB_BOOT_ID);
}

export function cancelJob(teamId: string, jobId: string): CloudJob | undefined {
  const job = store.cancel(teamId, jobId);
  if (job) notifyTeam(teamId);
  return job;
}

/** Test-only reset for the durable queue and local waiter registry. */
export function __resetCloudQueueForTests(): void {
  for (const cancel of [...activeWaitCancels]) cancel();
  activeWaitCancels.clear();
  teamWaiters.clear();
  getSqlite().transaction(() => {
    getSqlite().prepare('DELETE FROM cloud_job_controls').run();
    getSqlite().prepare('DELETE FROM cloud_job_events').run();
    getSqlite().prepare('DELETE FROM cloud_jobs').run();
    getSqlite().prepare('DELETE FROM cloud_job_drain_state').run();
  })();
}
