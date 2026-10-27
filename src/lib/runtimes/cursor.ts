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
import { parseCursorSessionCost } from '@/lib/runtimes/cursor-cost-parser';
import { ownedTailToRuntimeTranscript } from '@/lib/runtimes/shared/owned-transcript';
import { monitorUsageDispatch, usageSnapshotFromTelemetry } from '@/lib/usage-log';
import {
  continueOwnedCursorSession,
  getOwnedCursorFleetAdditions,
  getOwnedCursorReviewPacket,
  getOwnedCursorRuntimeTail,
  getOwnedCursorTelemetrySources,
  interruptOwnedCursorSession,
  launchOwnedCursorSession,
} from '@/lib/cursor/owned';

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

type OwnedAgentLike = {
  id: string;
  name: string;
  sessionKey: string;
  status: string;
  currentTask: string;
  workspace: string;
  branch: string;
  model: string;
  lastEventAt: string;
  tmuxSession?: string;
  runtimeSurface?: {
    ownership?: string;
    capabilities?: { sendInput?: boolean; interrupt?: boolean; diffContext?: boolean };
    lifecycle?: {
      availability?: string;
      lastOutcome?: string;
      lastRunMode?: string;
      lastRunStartedAt?: string;
      lastRunFinishedAt?: string;
      summary?: string;
    };
    reviewContext?: { repoSlug?: string; branch?: string; head?: string };
    cwd?: string;
  };
};

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
  const parsedLastActivity = lifecycleTime ? new Date(lifecycleTime) : new Date(agent.lastEventAt);
  return {
    sessionKey: agent.sessionKey,
    runtimeId: 'cursor',
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
    lastActivityAt: Number.isNaN(parsedLastActivity.getTime()) ? new Date() : parsedLastActivity,
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
    tmuxSession: agent.tmuxSession,
  };
}

async function waitForCursorRunToFinish(sessionKey: string, startedAtMs: number): Promise<number> {
  for (let attempt = 0; attempt < 7200; attempt += 1) {
    const lifecycle = (await getOwnedCursorFleetAdditions({ fresh: true }).catch(() => null))
      ?.agents.find((entry) => entry.sessionKey === sessionKey)?.runtimeSurface?.lifecycle;
    const finishedAtMs = lifecycle?.lastRunFinishedAt ? Date.parse(lifecycle.lastRunFinishedAt) : Number.NaN;
    if (Number.isFinite(finishedAtMs) && finishedAtMs >= startedAtMs && lifecycle?.availability !== 'running') {
      return finishedAtMs;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return Date.now();
}

function scheduleCursorUsageDispatch(
  sessionKey: string,
  startedAtMs: number,
  baseline?: ReturnType<typeof usageSnapshotFromTelemetry>,
  laneId?: string,
  model?: string,
) {
  monitorUsageDispatch({
    dispatchKey: `cursor:${sessionKey}:${startedAtMs}`,
    runtime: 'cursor',
    laneId,
    sessionKey,
    model,
    startedAtMs,
    baseline,
    awaitCompletion: async () => ({
      finishedAtMs: await waitForCursorRunToFinish(sessionKey, startedAtMs),
      snapshot: usageSnapshotFromTelemetry(await cursorRuntime.getTelemetry?.(sessionKey)),
    }),
  });
}

export const cursorRuntime: AgentRuntime = {
  id: 'cursor',
  displayName: 'Cursor',
  capabilities,

  async discoverSessions(options = {}): Promise<RuntimeSession[]> {
    // Fresh means fresh session state, not a repeated installation probe.
    const owned = await getOwnedCursorFleetAdditions({ fresh: options.fresh ?? false }).catch((error) => {
      console.warn('[cursor-runtime] discoverSessions owned fleet failed:', error);
      return null;
    });
    return owned?.agents.map((agent) => mapAgentToSession(agent as OwnedAgentLike)) ?? [];
  },

  async readTranscript(sessionKey: string, sinceId?: string, limit?: number): Promise<RuntimeTranscriptEntry[]> {
    if (!sessionKey.startsWith('cursor-owned:')) return [];
    const tail = await getOwnedCursorRuntimeTail(sessionKey, sinceId ? 200 : limit);
    return ownedTailToRuntimeTranscript(tail, sinceId, limit);
  },

  async launch(opts: LaunchOptions): Promise<RuntimeActionResult> {
    const startedAtMs = Date.now();
    const result = await launchOwnedCursorSession({
      cwd: opts.cwd,
      prompt: opts.prompt,
      promptMemoryRevision: opts.promptMemoryRevision,
      clientMutationId: opts.clientMutationId,
      model: opts.model,
      laneId: opts.laneId,
      packetId: opts.packetId,
    });
    if (result.ok && result.surfaceId) {
      scheduleCursorUsageDispatch(result.surfaceId, startedAtMs, undefined, opts.laneId, opts.model);
    }
    return { ok: result.ok, note: result.note, sessionKey: result.surfaceId, sideEffect: result.sideEffect };
  },

  async resume(sessionKey: string, message: string): Promise<RuntimeActionResult> {
    if (!sessionKey.startsWith('cursor-owned:')) return { ok: false, note: 'Cursor runtime only supports owned session resume.' };
    const startedAtMs = Date.now();
    const baseline = usageSnapshotFromTelemetry(await cursorRuntime.getTelemetry?.(sessionKey));
    const result = await continueOwnedCursorSession(sessionKey, message);
    scheduleCursorUsageDispatch(sessionKey, startedAtMs, baseline);
    return { ok: result.ok, note: result.note, sessionKey };
  },

  async interrupt(sessionKey: string): Promise<RuntimeActionResult> {
    if (!sessionKey.startsWith('cursor-owned:')) return { ok: false, note: 'Only owned Cursor sessions can be interrupted.', sessionKey };
    const result = await interruptOwnedCursorSession(sessionKey);
    return { ok: result.interrupted, note: result.note, sessionKey };
  },

  async getChangedFiles(sessionKey: string): Promise<RuntimeChangedFile[]> {
    if (!sessionKey.startsWith('cursor-owned:')) return [];
    try {
      const packet = await getOwnedCursorReviewPacket(sessionKey);
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
    if (!sessionKey.startsWith('cursor-owned:')) return undefined;
    const sources = await getOwnedCursorTelemetrySources(sessionKey);
    if (!sources || sources.stdoutPaths.length === 0) return undefined;
    const sessionCost = await parseCursorSessionCost(sources.stdoutPaths).catch(() => null);
    if (!sessionCost) return undefined;
    return {
      totalTokens: sessionCost.inputTokens + sessionCost.outputTokens + sessionCost.cacheReadTokens,
      estimatedCostUsd: sessionCost.totalCostUsd,
      inputTokens: sessionCost.inputTokens,
      outputTokens: sessionCost.outputTokens,
      cacheReadTokens: sessionCost.cacheReadTokens,
      cacheWriteTokens: sessionCost.cacheWriteTokens,
      costSource: sessionCost.costSource ?? 'unknown',
      model: sessionCost.model ?? undefined,
    };
  },
};
