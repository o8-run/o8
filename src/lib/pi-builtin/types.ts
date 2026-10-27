import type { OwnedReviewDisposition, OwnedRunOutcome } from '@/lib/runtimes/shared/owned-session/types';

export const PI_BUILTIN_RUNTIME_ID = 'pi-builtin';
export const PI_BUILTIN_SURFACE_PREFIX = 'pi-builtin-owned:';

export interface PiWorkerRunRecord {
  id: string;
  mode: 'launch' | 'resume';
  prompt: string;
  startedAt: string;
  finishedAt?: string;
  outcome: OwnedRunOutcome;
  /** The run's normalized transcript: text and tool activity only. */
  stdoutPath: string;
  /** The Pi worker process for this turn; it exits when the turn settles. */
  pid?: number;
  commandIdentity?: string;
  finishReason?: string;
  interruptRequestedAt?: string;
}

export interface PiWorkerSessionRecord {
  promptMemoryRevision?: string;
  surfaceId: string;
  launchMutationId?: string;
  laneId?: string;
  packetId?: string;
  sessionDir: string;
  /** The real path Pi works in: the packet worktree for a lane launch. */
  cwd: string;
  repoPath: string;
  repoSlug?: string;
  branch?: string;
  head?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Pi's own session id, stable across turns. */
  threadId?: string;
  latestPrompt: string;
  latestSummary: string;
  model: string;
  /** A read-only packet: Pi gets `read_file` only. */
  readOnly: boolean;
  reviewDisposition?: OwnedReviewDisposition;
  reviewDispositionUpdatedAt?: string;
  activeRun?: PiWorkerRunRecord;
  recentRuns: PiWorkerRunRecord[];
  detachedAt?: string;
  detachedReason?: string;
}

/** One line of a run log. Raw Pi messages never reach it, so provider diagnostics stay out. */
export type PiWorkerLogLine =
  | { type: 'assistant'; text: string }
  | { type: 'tool_call'; id?: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id?: string; name: string; output: string; isError: boolean }
  | { type: 'settled'; outcome: OwnedRunOutcome; summary: string };
