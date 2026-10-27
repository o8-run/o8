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
  continueOwnedHermesSession,
  getOwnedHermesFleetAdditions,
  getOwnedHermesReviewPacket,
  getOwnedHermesRuntimeTail,
  interruptOwnedHermesSession,
  launchOwnedHermesSession,
} from '@/lib/hermes/owned';
import { ownedTailToRuntimeTranscript } from './shared/owned-transcript';

const SESSION_PREFIX = 'hermes-owned:';

const capabilities: RuntimeCapabilities = {
  discover: true,
  readTranscript: true,
  launch: true,
  resume: true,
  interrupt: true,
  reviewDiffs: true,
  costTelemetry: false,
  streaming: false,
};

type OwnedAgent = Awaited<ReturnType<typeof getOwnedHermesFleetAdditions>>['agents'][number];

function mapStatus(status: string): RuntimeSession['status'] {
  return status === 'running' || status === 'launched' ? 'running'
    : status === 'completed' || status === 'finished' ? 'completed'
    : status === 'failed' || status === 'error' ? 'failed'
    : status === 'waiting' || status === 'blocked' ? 'waiting'
    : status === 'reviewing' || status === 'review_ready' ? 'reviewing'
    : 'idle';
}

function mapAgent(agent: OwnedAgent): RuntimeSession {
  const surface = agent.runtimeSurface;
  const lifecycleTime = surface?.lifecycle?.lastRunFinishedAt
    ?? surface?.lifecycle?.lastRunStartedAt
    ?? agent.lastEventAt;
  const lastActivityAt = new Date(lifecycleTime);
  return {
    sessionKey: agent.sessionKey,
    runtimeId: 'hermes',
    displayName: agent.name,
    cwd: surface?.cwd ?? agent.workspace,
    branch: surface?.reviewContext?.branch ?? agent.branch,
    headSha: surface?.reviewContext?.head,
    repoSlug: surface?.reviewContext?.repoSlug,
    status: mapStatus(agent.status),
    ownership: 'owned',
    sessionCapabilities: {
      canSendInput: surface?.capabilities?.sendInput ?? false,
      canInterrupt: surface?.capabilities?.interrupt ?? false,
      canReviewDiffs: surface?.capabilities?.diffContext ?? false,
    },
    lastActivityAt: Number.isNaN(lastActivityAt.getTime()) ? new Date() : lastActivityAt,
    initialTask: agent.currentTask,
    model: agent.model,
    lifecycle: surface?.lifecycle ? {
      availability: surface.lifecycle.availability as RuntimeSession['lifecycle'] extends infer L
        ? L extends { availability: infer A } ? A : never
        : never,
      lastOutcome: surface.lifecycle.lastOutcome as 'finished' | 'interrupted' | 'failed' | undefined,
      lastRunMode: surface.lifecycle.lastRunMode as 'launch' | 'resume' | undefined,
      lastRunStartedAt: surface.lifecycle.lastRunStartedAt,
      lastRunFinishedAt: surface.lifecycle.lastRunFinishedAt,
      summary: surface.lifecycle.summary,
    } : undefined,
  };
}

export const hermesRuntime: AgentRuntime = {
  id: 'hermes',
  displayName: 'Hermes',
  capabilities,

  async discoverSessions(): Promise<RuntimeSession[]> {
    const owned = await getOwnedHermesFleetAdditions().catch((error) => {
      console.warn('[hermes-runtime] owned fleet discovery failed:', error);
      return null;
    });
    return owned?.agents.map(mapAgent) ?? [];
  },

  async readTranscript(
    sessionKey: string,
    sinceId?: string,
    limit?: number,
  ): Promise<RuntimeTranscriptEntry[]> {
    if (!sessionKey.startsWith(SESSION_PREFIX)) return [];
    const tail = await getOwnedHermesRuntimeTail(sessionKey);
    return ownedTailToRuntimeTranscript(tail, sinceId, limit);
  },

  async launch(opts: LaunchOptions): Promise<RuntimeActionResult> {
    const result = await launchOwnedHermesSession({
      cwd: opts.cwd,
      prompt: opts.prompt,
      promptMemoryRevision: opts.promptMemoryRevision,
      clientMutationId: opts.clientMutationId,
      model: opts.model,
      laneId: opts.laneId,
      packetId: opts.packetId,
    });
    return {
      ok: result.ok,
      note: result.note,
      sessionKey: result.surfaceId,
      sideEffect: result.sideEffect,
    };
  },

  async resume(sessionKey: string, message: string): Promise<RuntimeActionResult> {
    if (!sessionKey.startsWith(SESSION_PREFIX)) {
      return { ok: false, sideEffect: 'none', note: 'Hermes can resume only an o8-owned Hermes session.' };
    }
    const result = await continueOwnedHermesSession(sessionKey, message);
    return { ...result, sessionKey };
  },

  async interrupt(sessionKey: string): Promise<RuntimeActionResult> {
    if (!sessionKey.startsWith(SESSION_PREFIX)) {
      return { ok: false, note: 'Hermes can interrupt only an o8-owned Hermes session.' };
    }
    const result = await interruptOwnedHermesSession(sessionKey);
    return { ok: result.interrupted, note: result.note, sessionKey };
  },

  async getChangedFiles(sessionKey: string): Promise<RuntimeChangedFile[]> {
    if (!sessionKey.startsWith(SESSION_PREFIX)) return [];
    const packet = await getOwnedHermesReviewPacket(sessionKey).catch(() => null);
    return packet?.changedFiles.map((file) => ({
      path: file.path,
      status: (file.status ?? 'modified') as RuntimeChangedFile['status'],
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
    })) ?? [];
  },
};
