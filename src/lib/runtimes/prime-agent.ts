import type {
  AgentRuntime,
  RuntimeActionResult,
  RuntimeCapabilities,
  RuntimeChangedFile,
  RuntimeSession,
  RuntimeTelemetry,
  RuntimeTranscriptEntry,
  LaunchOptions,
} from './types';
import { parsePrimeAgentSessionCost } from '@/lib/runtimes/prime-agent-cost-parser';
import { ownedTailToRuntimeTranscript } from '@/lib/runtimes/shared/owned-transcript';
import {
  continueOwnedPrimeAgentSession,
  getOwnedPrimeAgentFleetAdditions,
  getOwnedPrimeAgentReviewPacket,
  getOwnedPrimeAgentRuntimeTail,
  getOwnedPrimeAgentTelemetrySources,
  interruptOwnedPrimeAgentSession,
  launchOwnedPrimeAgentSession,
} from '@/lib/prime-agent/owned';

const capabilities: RuntimeCapabilities = {
  discover: true,
  readTranscript: true,
  launch: true,
  resume: true,
  interrupt: true,
  reviewDiffs: true,
  costTelemetry: true,
  streaming: true,
};

type OwnedAgentLike = Awaited<ReturnType<typeof getOwnedPrimeAgentFleetAdditions>>['agents'][number];

function mapStatus(rawStatus: string): RuntimeSession['status'] {
  return rawStatus === 'completed' || rawStatus === 'finished' ? 'completed'
    : rawStatus === 'running' || rawStatus === 'launched' ? 'running'
    : rawStatus === 'waiting' || rawStatus === 'blocked' || rawStatus === 'awaiting_input' ? 'waiting'
    : rawStatus === 'reviewing' || rawStatus === 'review_ready' ? 'reviewing'
    : rawStatus === 'failed' || rawStatus === 'error' ? 'failed'
    : 'idle';
}

function mapAgentToSession(agent: OwnedAgentLike): RuntimeSession {
  const surface = agent.runtimeSurface;
  const lifecycleTime = surface?.lifecycle?.lastRunFinishedAt ?? surface?.lifecycle?.lastRunStartedAt;
  const lastActivityAt = lifecycleTime ? new Date(lifecycleTime) : new Date(agent.lastEventAt);
  return {
    sessionKey: agent.sessionKey,
    runtimeId: 'prime-agent',
    displayName: agent.name,
    cwd: surface?.cwd ?? agent.workspace,
    branch: surface?.reviewContext?.branch ?? agent.branch,
    headSha: surface?.reviewContext?.head,
    repoSlug: surface?.reviewContext?.repoSlug,
    status: mapStatus(agent.status),
    ownership: (surface?.ownership ?? 'owned') as RuntimeSession['ownership'],
    sessionCapabilities: {
      canSendInput: surface?.capabilities?.sendInput ?? false,
      canInterrupt: surface?.capabilities?.interrupt ?? false,
      canReviewDiffs: surface?.capabilities?.diffContext ?? false,
    },
    lastActivityAt: Number.isNaN(lastActivityAt.getTime()) ? new Date() : lastActivityAt,
    initialTask: agent.currentTask,
    model: agent.model,
    lifecycle: surface?.lifecycle ? {
      availability: (surface.lifecycle.availability ?? 'running') as 'awaiting-thread' | 'running' | 'ready-for-resume',
      lastOutcome: surface.lifecycle.lastOutcome as 'finished' | 'interrupted' | 'failed' | undefined,
      lastRunMode: surface.lifecycle.lastRunMode as 'launch' | 'resume' | undefined,
      lastRunStartedAt: surface.lifecycle.lastRunStartedAt,
      lastRunFinishedAt: surface.lifecycle.lastRunFinishedAt,
      summary: surface.lifecycle.summary,
    } : undefined,
  };
}

export const primeAgentRuntime: AgentRuntime = {
  id: 'prime-agent',
  displayName: 'Prime Agent',
  capabilities,

  async discoverSessions(): Promise<RuntimeSession[]> {
    // Saved sessions remain discoverable without probing the launch executable.
    const owned = await getOwnedPrimeAgentFleetAdditions().catch((error) => {
      console.warn('[prime-agent-runtime] discoverSessions owned fleet failed:', error);
      return null;
    });
    return owned?.agents.map((agent) => mapAgentToSession(agent as OwnedAgentLike)) ?? [];
  },

  async readTranscript(sessionKey: string, sinceId?: string, limit?: number): Promise<RuntimeTranscriptEntry[]> {
    if (!sessionKey.startsWith('prime-agent-owned:')) return [];
    const tail = await getOwnedPrimeAgentRuntimeTail(sessionKey, sinceId ? 200 : limit);
    return ownedTailToRuntimeTranscript(tail, sinceId, limit);
  },

  async launch(opts: LaunchOptions): Promise<RuntimeActionResult> {
    const result = await launchOwnedPrimeAgentSession({
      cwd: opts.cwd,
      prompt: opts.prompt,
      promptMemoryRevision: opts.promptMemoryRevision,
      clientMutationId: opts.clientMutationId,
      laneId: opts.laneId,
      packetId: opts.packetId,
    });
    return { ok: result.ok, note: result.note, sessionKey: result.surfaceId, sideEffect: result.sideEffect };
  },

  async resume(sessionKey: string, message: string): Promise<RuntimeActionResult> {
    if (!sessionKey.startsWith('prime-agent-owned:')) {
      return { ok: false, note: 'Prime Agent runtime only supports owned session resume.' };
    }
    const result = await continueOwnedPrimeAgentSession(sessionKey, message);
    return { ok: result.ok, note: result.note, sessionKey };
  },

  async interrupt(sessionKey: string): Promise<RuntimeActionResult> {
    if (!sessionKey.startsWith('prime-agent-owned:')) {
      return { ok: false, note: 'Only owned Prime Agent sessions can be interrupted.', sessionKey };
    }
    const result = await interruptOwnedPrimeAgentSession(sessionKey);
    return { ok: result.interrupted, note: result.note, sessionKey };
  },

  async getChangedFiles(sessionKey: string): Promise<RuntimeChangedFile[]> {
    if (!sessionKey.startsWith('prime-agent-owned:')) return [];
    try {
      const packet = await getOwnedPrimeAgentReviewPacket(sessionKey);
      return (packet.changedFiles ?? []).map((file) => ({
        path: file.path,
        status: (file.status ?? 'modified') as RuntimeChangedFile['status'],
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
      }));
    } catch {
      return [];
    }
  },

  async getTelemetry(sessionKey: string): Promise<RuntimeTelemetry | undefined> {
    if (!sessionKey.startsWith('prime-agent-owned:')) return undefined;
    const sources = await getOwnedPrimeAgentTelemetrySources(sessionKey);
    if (!sources || sources.stdoutPaths.length === 0) return undefined;
    const sessionCost = await parsePrimeAgentSessionCost(sources.stdoutPaths).catch(() => null);
    if (!sessionCost) return undefined;
    return {
      totalTokens: sessionCost.inputTokens + sessionCost.outputTokens + sessionCost.cacheReadTokens,
      estimatedCostUsd: sessionCost.totalCostUsd,
      inputTokens: sessionCost.inputTokens,
      outputTokens: sessionCost.outputTokens,
      cacheReadTokens: sessionCost.cacheReadTokens,
      cacheWriteTokens: sessionCost.cacheWriteTokens,
      costSource: sessionCost.totalCostUsd > 0 ? 'gateway' : 'unknown',
      model: sessionCost.model ?? undefined,
    };
  },
};
