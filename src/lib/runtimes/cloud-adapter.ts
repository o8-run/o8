import { assertCloudLaunchMemory } from '@/lib/cloud/worker-payload';
/**
 * Cloud Runtime Adapter
 *
 * Workers run on customer infra (Kubernetes, VMs, bare metal) and open
 * outbound-only HTTPS to the o8 backend. They long-poll the job queue, pick
 * up dispatched jobs, and stream transcripts + diffs back over POST.
 *
 * This is the o8-side durable runtime surface. Mission dispatch remains
 * gated until external worker availability is surfaced in its picker. The
 * packaged worker lives in scripts/worker. In-flight Codex process resume is
 * unsupported; durable transcript and diff retrieval use the job queue.
 *
 * Parallel to `codex.ts` and `claude-code.ts`. Registered under runtime id
 * `cloud` via `src/lib/runtimes/index.ts`.
 *
 * Design choice: the durable job queue is team-scoped so N workers in a
 * pool can share a queue and each tracks its own cursor. This matches the
 * Cursor self-hosted shape (10 workers/user, 50 workers/team).
 */
import { assertOwnedActionGuard } from './shared/owned-session/action-admission';
import type {
  AgentRuntime,
  LaunchOptions,
  RuntimeActionResult,
  RuntimeCapabilities,
  RuntimeChangedFile,
  RuntimeSession,
  RuntimeTranscriptEntry,
} from './types';
import {
  CloudPacketActiveError,
  enqueueCloudJob,
  getLatestSessionJob,
  listJobs,
  queueJobControl,
  readSessionJobEvents,
} from '@/lib/cloud/job-queue';
import { DEFAULT_CLOUD_TEAM_ID } from '@/lib/cloud/team';
import { randomUUID } from 'node:crypto';
import { resolveCloudRemoteSource } from '@/lib/cloud/remote-source';
import { resolveRemoteWorkspaceManifest } from '@/lib/cloud/remote-manifest';

/**
 * Launch, discovery, transcript replay, and interrupt use the durable job
 * ledger. Resume and diff retrieval remain unavailable.
 */
const capabilities: RuntimeCapabilities = {
  discover: true,
  readTranscript: true,
  launch: true,
  resume: true,
  interrupt: true,
  reviewDiffs: true,
  costTelemetry: false,
  // Server-sent streaming lives in the worker-stream POST endpoint, but the
  // adapter can't surface it until the CLI is producing chunks.
  streaming: false,
};

const RUNTIME_ID = 'cloud' as const;

/**
 * V0 has no multi-team scoping in the operator UI yet — everything runs on
 * the local desktop, so there's exactly one team scope. We pin it to a
 * constant here; when teams show up in the dispatch flow (separate issue),
 * the LaunchOptions will carry a teamId and we'll read from that instead.
 */
const DEFAULT_TEAM_ID = DEFAULT_CLOUD_TEAM_ID;

function sessionKeyFor(jobId: string): string {
  return `${RUNTIME_ID}:${jobId}`;
}

function jobIdFromSessionKey(sessionKey: string): string {
  const prefix = `${RUNTIME_ID}:`;
  return sessionKey.startsWith(prefix) ? sessionKey.slice(prefix.length) : sessionKey;
}

function textFromPayload(payload: unknown, fallback: string): string {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fallback;
  const record = payload as Record<string, unknown>;
  for (const key of ['text', 'message', 'output', 'result', 'error', 'reason']) {
    if (typeof record[key] === 'string' && record[key]) return record[key];
  }
  return fallback;
}

function eventText(type: string, payload: unknown): string {
  if (type === 'service' && payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const receipt = payload as Record<string, unknown>;
    if (typeof receipt.name === 'string' && typeof receipt.state === 'string') {
      return `Workspace service ${receipt.name}: ${receipt.state}.`;
    }
  }
  switch (type) {
    case 'accepted': return 'Cloud job accepted.';
    case 'claimed': return 'Cloud worker claimed the job.';
    case 'chunk': return textFromPayload(payload, 'Cloud worker emitted output.');
    case 'diff': return 'Cloud worker persisted changed-file evidence.';
    case 'heartbeat': return 'Cloud worker lease renewed.';
    case 'completed': return textFromPayload(payload, 'Cloud job completed.');
    case 'errored': return `Error: ${textFromPayload(payload, 'Cloud worker execution failed.')}`;
    case 'lease_recovered': return 'Cloud worker lease expired; the job returned to the queue.';
    case 'lease_released': return 'Cloud worker lease released for app restart.';
    case 'control_queued': return 'Cloud session control persisted.';
    case 'control_delivered': return 'Cloud session control delivered to the worker.';
    case 'control_applied': return 'Cloud session control applied by the worker.';
    case 'follow_up_queued': return 'Cloud steer queued as a follow-up turn.';
    case 'cancelled': return 'Cloud job cancelled.';
    default: return `Cloud job event: ${type}`;
  }
}

export const cloudRuntime: AgentRuntime = {
  id: RUNTIME_ID,
  displayName: 'Cloud Worker',
  capabilities,

  // ── Discovery ──
  //
  // Includes terminal jobs so status remains readable after a restart.
  async discoverSessions(): Promise<RuntimeSession[]> {
    const latestBySession = new Map<string, ReturnType<typeof listJobs>[number]>();
    for (const job of listJobs(DEFAULT_TEAM_ID)) {
      if (!latestBySession.has(job.sessionId)) latestBySession.set(job.sessionId, job);
    }
    return [...latestBySession.values()].map((job) => ({
      sessionKey: sessionKeyFor(job.sessionId),
      runtimeId: RUNTIME_ID,
      displayName: job.packetId
        ? `Cloud packet ${job.packetId}`
        : `Cloud job ${job.id.slice(0, 8)}`,
      cwd: job.launch.cwd,
      status: job.status === 'leased'
        ? 'running'
        : job.status === 'pending'
          ? 'waiting'
          : job.status === 'completed'
            ? 'completed'
            : 'failed',
      ownership: 'provider',
      sessionCapabilities: {
        canSendInput: true,
        canInterrupt: job.status === 'pending' || job.status === 'leased',
        canReviewDiffs: true,
      },
      lastActivityAt: new Date(job.updatedAt),
      initialTask: job.launch.prompt,
      model: job.launch.model,
    }));
  },

  // ── Transcript ──
  async readTranscript(
    sessionKey: string,
    sinceId?: string,
    limit?: number,
  ): Promise<RuntimeTranscriptEntry[]> {
    const jobId = jobIdFromSessionKey(sessionKey);
    // Transcript authority is per job, not per key prefix. A `cloud:` key whose
    // job this queue has never seen is UNKNOWN, not empty -- returning [] here
    // publishes an authoritative empty snapshot for a session we cannot vouch
    // for, which is exactly the "empty destructive snapshot" the mobile sync
    // route's adapter fall-through is written to avoid.
    if (!getLatestSessionJob(DEFAULT_TEAM_ID, jobId)) {
      throw new Error(`Transcript sync is unsupported for unknown cloud session ${sessionKey}.`);
    }
    const parsedSince = sinceId ? Number.parseInt(sinceId, 10) : 0;
    return readSessionJobEvents(
      DEFAULT_TEAM_ID,
      jobId,
      Number.isFinite(parsedSince) ? parsedSince : 0,
      limit,
    ).map((event) => ({
      id: String(event.id),
      role: event.type === 'chunk' ? 'assistant' : event.type === 'errored' ? 'tool' : 'system',
      text: eventText(event.type, event.payload),
      timestamp: new Date(event.createdAt),
      type: 'message',
    }));
  },

  // ── Lifecycle ──

  /**
   * Enqueue a job onto the team queue. The next long-poll tick on
   * /api/cloud/worker-poll will hand it to an idle worker.
   *
   * The SQLite insert commits before this method reports success.
   */
  async launch(opts: LaunchOptions): Promise<RuntimeActionResult> {
    let remoteSource: Awaited<ReturnType<typeof resolveCloudRemoteSource>>;
    try {
      remoteSource = await resolveCloudRemoteSource(opts);
      const manifest = await resolveRemoteWorkspaceManifest(opts.sourceRepoPath!, remoteSource.baseSha);
      opts = { ...opts, remoteManifestHash: manifest.remoteManifestHash, remotePreview: manifest.remotePreview };
    } catch (error) {
      return {
        ok: false,
        note: error instanceof Error ? error.message : String(error),
        sideEffect: 'none',
      };
    }
    try {
      const jobId = randomUUID();
      assertOwnedActionGuard();
      assertCloudLaunchMemory(opts);
      const job = enqueueCloudJob(DEFAULT_TEAM_ID, jobId, { ...opts, remoteSource });
      return {
        ok: true,
        note: `Cloud job ${job.id} enqueued (cursor ${job.cursor}). Waiting for worker pickup.`,
        sessionKey: sessionKeyFor(job.id),
      };
    } catch (error) {
      if (error instanceof CloudPacketActiveError) {
        return {
          ok: false,
          note: error.message,
          sessionKey: sessionKeyFor(error.activeJob.id),
        };
      }
      throw error;
    }
  },

  async resume(sessionKey: string, message: string): Promise<RuntimeActionResult> {
    const sessionId = jobIdFromSessionKey(sessionKey);
    const result = queueJobControl({
      teamId: DEFAULT_TEAM_ID,
      sessionId,
      controlId: randomUUID(),
      type: 'steer',
      payload: { message },
    });
    if (!result) {
      return { ok: false, note: `No cloud session found for ${sessionKey}.`, sessionKey };
    }
    return {
      ok: true,
      note: result.followUpJob
        ? `Cloud session had already reached terminal state; steer queued as follow-up job ${result.followUpJob.id}.`
        : `Cloud steer ${result.control.id} persisted for ordered worker delivery.`,
      sessionKey,
    };
  },

  /**
   * Mark the job cancelled. Any in-flight worker will observe this on its
   * next stream POST and will clean up; the actual abort signal delivery is
   * stubbed until the worker CLI wires its own side.
   */
  async interrupt(sessionKey: string): Promise<RuntimeActionResult> {
    const sessionId = jobIdFromSessionKey(sessionKey);
    const job = getLatestSessionJob(DEFAULT_TEAM_ID, sessionId);
    if (!job) {
      return {
        ok: false,
        note: `No cloud job found for session ${sessionKey}.`,
        sessionKey,
      };
    }
    const result = queueJobControl({
      teamId: DEFAULT_TEAM_ID,
      sessionId,
      controlId: randomUUID(),
      type: 'abort',
      payload: {},
    });
    if (!result || result.control.status === 'superseded') {
      return {
        ok: false,
        note: `Cloud session ${sessionKey} is already terminal; abort was recorded as superseded.`,
        sessionKey,
      };
    }
    return {
      ok: true,
      note: result.control.status === 'applied'
        ? `Cloud job ${job.id} was cancelled before worker pickup.`
        : `Cloud abort ${result.control.id} persisted for one-time worker delivery.`,
      sessionKey,
    };
  },

  // ── Review ──
  async getChangedFiles(sessionKey: string): Promise<RuntimeChangedFile[]> {
    const sessionId = jobIdFromSessionKey(sessionKey);
    const latestDiff = readSessionJobEvents(DEFAULT_TEAM_ID, sessionId, 0, 5_000)
      .filter((event) => event.type === 'diff')
      .at(-1)?.payload;
    if (!latestDiff || typeof latestDiff !== 'object' || Array.isArray(latestDiff)) return [];
    const files = (latestDiff as { files?: unknown }).files;
    if (!Array.isArray(files)) return [];
    return files.filter((file): file is RuntimeChangedFile => {
      if (!file || typeof file !== 'object' || Array.isArray(file)) return false;
      const candidate = file as Partial<RuntimeChangedFile>;
      return typeof candidate.path === 'string'
        && ['added', 'modified', 'deleted', 'renamed'].includes(String(candidate.status))
        && Number.isInteger(candidate.additions)
        && Number.isInteger(candidate.deletions);
    });
  },
};
