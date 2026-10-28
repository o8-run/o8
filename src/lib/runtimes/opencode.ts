/**
 * opencode Runtime Adapter
 *
 * Wraps opencode/owned.ts behind the universal AgentRuntime contract.
 * Peer to codex.ts and claude-code.ts — no changes to those files.
 *
 * Binary: `opencode2` (npm `@opencode-ai/cli@next`).
 * Sessions stored under: ~/.o8/owned-opencode/ (override: O8_OWNED_OPENCODE_ROOT).
 * surfaceIdPrefix: 'opencode-owned:'
 *
 * Resume strategy: thread-resume via --session <ses_xxx>.
 * The `ses_` prefixed session UUID is captured from the `init` JSONL event
 * during the first run and stored in the session metadata.
 */

import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeSession,
  RuntimeTranscriptEntry,
  RuntimeChangedFile,
  RuntimeActionResult,
  LaunchOptions,
  RuntimeTelemetry,
} from './types';
import { parseOpencodeSessionCost } from '@/lib/runtimes/opencode-cost-parser';
import { ownedTailToRuntimeTranscript } from '@/lib/runtimes/shared/owned-transcript';
import { monitorUsageDispatch, usageSnapshotFromTelemetry } from '@/lib/usage-log';

import {
  launchOwnedOpencodeSession,
  continueOwnedOpencodeSession,
  interruptOwnedOpencodeSession,
  getOwnedOpencodeFleetAdditions,
  getOwnedOpencodeRuntimeTail,
  getOwnedOpencodeReviewPacket,
  getOwnedOpencodeTelemetrySources,
} from '@/lib/opencode/owned';

// ── Capabilities ──────────────────────────────────────────────────────────────

const capabilities: RuntimeCapabilities = {
  discover: true,
  readTranscript: true,
  launch: true,
  resume: true,     // --session <ses_xxx>
  interrupt: true,
  reviewDiffs: true,
  costTelemetry: true,
  streaming: true,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function waitForOwnedOpencodeRunToFinish(sessionKey: string, startedAtMs: number): Promise<number> {
  for (let attempt = 0; attempt < 7200; attempt += 1) {
    const lifecycle = (await getOwnedOpencodeFleetAdditions({ fresh: true }).catch(() => null))
      ?.agents.find((entry) => entry.sessionKey === sessionKey)?.runtimeSurface?.lifecycle;
    const finishedAtMs = lifecycle?.lastRunFinishedAt
      ? Date.parse(lifecycle.lastRunFinishedAt)
      : Number.NaN;
    if (Number.isFinite(finishedAtMs) && finishedAtMs >= startedAtMs && lifecycle?.availability !== 'running') {
      return finishedAtMs;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return Date.now();
}

function scheduleOpencodeUsageDispatch(
  sessionKey: string,
  startedAtMs: number,
  baseline?: ReturnType<typeof usageSnapshotFromTelemetry>,
  laneId?: string,
  model?: string,
  awaitFinishedAtMs?: () => Promise<number>,
) {
  monitorUsageDispatch({
    dispatchKey: `opencode:${sessionKey}:${startedAtMs}`,
    runtime: 'opencode',
    laneId,
    sessionKey,
    model,
    startedAtMs,
    baseline,
    awaitCompletion: async () => ({
      finishedAtMs: awaitFinishedAtMs ? await awaitFinishedAtMs() : Date.now(),
      snapshot: usageSnapshotFromTelemetry(await opencodeRuntime.getTelemetry?.(sessionKey)),
    }),
  });
}

/**
 * Map an owned opencode fleet agent to the universal RuntimeSession shape.
 */
function mapAgentToSession(
  agent: {
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
  },
): RuntimeSession {
  const surface = agent.runtimeSurface;
  const ownership = (surface?.ownership ?? 'owned') as RuntimeSession['ownership'];
  const rawStatus = agent.status;
  const status: RuntimeSession['status'] =
    rawStatus === 'completed' || rawStatus === 'finished' ? 'completed'
    : rawStatus === 'running' || rawStatus === 'launched' ? 'running'
    : rawStatus === 'waiting' || rawStatus === 'blocked' || rawStatus === 'awaiting_input' ? 'waiting'
    : rawStatus === 'reviewing' || rawStatus === 'review_ready' ? 'reviewing'
    : rawStatus === 'failed' || rawStatus === 'error' ? 'failed'
    : rawStatus === 'idle' ? 'idle'
    : 'idle';
  const lifecycleTime = surface?.lifecycle?.lastRunFinishedAt ?? surface?.lifecycle?.lastRunStartedAt;
  const parsedLastActivity = lifecycleTime ? new Date(lifecycleTime) : new Date(agent.lastEventAt);
  const lastActivityAt = Number.isNaN(parsedLastActivity.getTime()) ? new Date() : parsedLastActivity;

  return {
    sessionKey: agent.sessionKey,
    runtimeId: 'opencode',
    displayName: agent.name,
    cwd: surface?.cwd ?? agent.workspace,
    branch: surface?.reviewContext?.branch ?? agent.branch,
    headSha: surface?.reviewContext?.head,
    repoSlug: surface?.reviewContext?.repoSlug,
    status,
    ownership,
    sessionCapabilities: {
      canSendInput: surface?.capabilities?.sendInput ?? false,
      canInterrupt: surface?.capabilities?.interrupt ?? false,
      canReviewDiffs: surface?.capabilities?.diffContext ?? false,
    },
    lastActivityAt,
    initialTask: agent.currentTask,
    model: agent.model,
    lifecycle: surface?.lifecycle
      ? {
          availability: (surface.lifecycle.availability ?? 'running') as 'awaiting-thread' | 'running' | 'ready-for-resume',
          lastOutcome: surface.lifecycle.lastOutcome as 'finished' | 'interrupted' | 'failed' | undefined,
          lastRunMode: surface.lifecycle.lastRunMode as 'launch' | 'resume' | undefined,
          lastRunStartedAt: surface.lifecycle.lastRunStartedAt,
          lastRunFinishedAt: surface.lifecycle.lastRunFinishedAt,
          summary: surface.lifecycle.summary,
        }
      : undefined,
    tmuxSession: agent.tmuxSession,
  };
}

// ── The runtime object ────────────────────────────────────────────────────────

export const opencodeRuntime: AgentRuntime = {
  id: 'opencode',
  displayName: 'OpenCode 2',
  capabilities,

  async discoverSessions(options = {}): Promise<RuntimeSession[]> {
    const [owned] = await Promise.allSettled([
      getOwnedOpencodeFleetAdditions({ fresh: options.fresh ?? false }),
    ]);

    const sessions: RuntimeSession[] = [];

    if (owned.status === 'fulfilled') {
      for (const agent of owned.value.agents) {
        sessions.push(mapAgentToSession(agent));
      }
    } else {
      console.error('[opencode-runtime] owned-session discovery failed:', owned.reason);
    }

    return sessions;
  },

  async readTranscript(sessionKey: string, sinceId?: string, limit?: number): Promise<RuntimeTranscriptEntry[]> {
    if (!sessionKey.startsWith('opencode-owned:')) {
      console.warn('[opencode-runtime] readTranscript called with non-owned sessionKey:', sessionKey);
      return [];
    }

    const tail = await getOwnedOpencodeRuntimeTail(sessionKey, sinceId ? 200 : limit);
    return ownedTailToRuntimeTranscript(tail, sinceId, limit);
  },

  async launch(opts: LaunchOptions): Promise<RuntimeActionResult> {
    const startedAtMs = Date.now();
    const result = await launchOwnedOpencodeSession({
      cwd: opts.cwd,
      prompt: opts.prompt,
      promptMemoryRevision: opts.promptMemoryRevision,
      clientMutationId: opts.clientMutationId,
      model: opts.model,
      effort: opts.effort,
      laneId: opts.laneId,
      packetId: opts.packetId,
    });
    if (result.ok && result.surfaceId) {
      scheduleOpencodeUsageDispatch(
        result.surfaceId,
        startedAtMs,
        undefined,
        opts.laneId,
        opts.model,
        () => waitForOwnedOpencodeRunToFinish(result.surfaceId, startedAtMs),
      );
    }
    return {
      ok: result.ok,
      note: result.note,
      sessionKey: result.surfaceId,
      sideEffect: result.sideEffect,
    };
  },

  async resume(sessionKey: string, message: string): Promise<RuntimeActionResult> {
    const startedAtMs = Date.now();
    const baseline = usageSnapshotFromTelemetry(await opencodeRuntime.getTelemetry?.(sessionKey));

    if (!sessionKey.startsWith('opencode-owned:')) {
      return {
        ok: false,
        note: 'opencode runtime only supports resume for owned sessions (opencode-owned: prefix).',
      };
    }

    const result = await continueOwnedOpencodeSession(sessionKey, message);
    scheduleOpencodeUsageDispatch(
      sessionKey,
      startedAtMs,
      baseline,
      undefined,
      undefined,
      () => waitForOwnedOpencodeRunToFinish(sessionKey, startedAtMs),
    );
    return { ok: result.ok, note: result.note, sessionKey };
  },

  async interrupt(sessionKey: string): Promise<RuntimeActionResult> {
    if (!sessionKey.startsWith('opencode-owned:')) {
      return {
        ok: false,
        note: 'opencode runtime only supports interrupt for owned sessions (opencode-owned: prefix).',
        sessionKey,
      };
    }

    const result = await interruptOwnedOpencodeSession(sessionKey);
    return {
      ok: result.interrupted,
      note: result.note,
      sessionKey,
    };
  },

  async getChangedFiles(sessionKey: string): Promise<RuntimeChangedFile[]> {
    try {
      const packet = await getOwnedOpencodeReviewPacket(sessionKey);
      return (packet.changedFiles ?? []).map((f) => ({
        path: f.path,
        status: (f.status ?? 'modified') as RuntimeChangedFile['status'],
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
      }));
    } catch {
      return [];
    }
  },

  async getTelemetry(sessionKey: string): Promise<RuntimeTelemetry | undefined> {
    if (!sessionKey.startsWith('opencode-owned:')) {
      return undefined;
    }

    const telemetrySources = await getOwnedOpencodeTelemetrySources(sessionKey);
    if (!telemetrySources || telemetrySources.stdoutPaths.length === 0) {
      return undefined;
    }

    const sessionCost = await parseOpencodeSessionCost(
      telemetrySources.stdoutPaths,
      { fallbackModel: telemetrySources.model ?? null },
    ).catch(() => null);

    if (!sessionCost) return undefined;

    const totalTokens = sessionCost.inputTokens + sessionCost.outputTokens;
    return {
      totalTokens,
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
