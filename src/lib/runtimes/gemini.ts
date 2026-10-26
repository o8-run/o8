/**
 * Gemini Runtime Adapter
 *
 * Wraps `src/lib/gemini/owned.ts` behind the universal AgentRuntime contract,
 * peer to Codex and Claude Code.
 *
 * Discovery covers only IDE-owned sessions for now. Unlike Codex, we don't
 * scan the user's terminal history because the Gemini CLI doesn't emit a
 * widely-used on-disk session format outside `~/.gemini/tmp/<hash>/chats/`,
 * which is already covered by the owned store.
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
// Side-effect import: registers the 'gemini' cost parser on module load.
import '@/lib/runtimes/gemini-cost-parser';
import { parseCost } from '@/lib/runtimes/shared/cost-parser-registry';
import { ownedTailToRuntimeTranscript } from '@/lib/runtimes/shared/owned-transcript';
import type { DispatchCapability } from '@/lib/runtimes/shared/turn-dispatcher';
import { monitorUsageDispatch, usageSnapshotFromTelemetry, type UsageSnapshot } from '@/lib/usage-log';

import {
  launchOwnedGeminiSession,
  continueOwnedGeminiSession,
  interruptOwnedGeminiSession,
  getOwnedGeminiFleetAdditions,
  getOwnedGeminiRuntimeTail,
  getOwnedGeminiReviewPacket,
  getOwnedGeminiTelemetrySources,
} from '@/lib/gemini/owned';

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

// ── Session mapping helpers ──────────────────────────────────────────────────

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

function mapAgentToSession(agent: OwnedAgentLike): RuntimeSession {
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
    runtimeId: 'gemini',
    displayName: agent.name,
    cwd: surface?.cwd ?? agent.workspace,
    branch: surface?.reviewContext?.branch ?? agent.branch,
    headSha: surface?.reviewContext?.head,
    repoSlug: surface?.reviewContext?.repoSlug,
    status,
    ownership,
    sessionCapabilities: {
      canSendInput: surface?.capabilities?.sendInput ?? (ownership !== 'owned'),
      canInterrupt: surface?.capabilities?.interrupt ?? false,
      canReviewDiffs: surface?.capabilities?.diffContext ?? false,
    },
    lastActivityAt,
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

// ── Usage-dispatch bookkeeping ────────────────────────────────────────────────

async function waitForOwnedRunToFinish(sessionKey: string, startedAtMs: number) {
  for (let attempt = 0; attempt < 7200; attempt += 1) {
    const lifecycle = (await getOwnedGeminiFleetAdditions({ fresh: true }).catch(() => null))
      ?.agents.find((entry) => entry.sessionKey === sessionKey)?.runtimeSurface?.lifecycle;
    const finishedAtMs = lifecycle?.lastRunFinishedAt ? Date.parse(lifecycle.lastRunFinishedAt) : Number.NaN;
    if (Number.isFinite(finishedAtMs) && finishedAtMs >= startedAtMs && lifecycle?.availability !== 'running') {
      return finishedAtMs;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return Date.now();
}

function scheduleGeminiUsageDispatch(
  sessionKey: string,
  startedAtMs: number,
  baseline?: UsageSnapshot,
  laneId?: string,
  model?: string,
  awaitFinishedAtMs?: () => Promise<number>,
) {
  monitorUsageDispatch({
    dispatchKey: `gemini:${sessionKey}:${startedAtMs}`,
    runtime: 'gemini',
    laneId,
    sessionKey,
    model,
    startedAtMs,
    baseline,
    awaitCompletion: async () => ({
      finishedAtMs: awaitFinishedAtMs ? await awaitFinishedAtMs() : Date.now(),
      snapshot: usageSnapshotFromTelemetry(await geminiRuntime.getTelemetry?.(sessionKey)),
    }),
  });
}

// ── Dispatch capability (turn-dispatcher wiring) ─────────────────────────────
//
// Gemini supports both thread-resume (via --resume <uuid>) and
// append-transcript (as a fallback when no thread id is persisted yet). The
// dispatcher walks the modes in order and picks the first one that succeeds.

const dispatchCapability: DispatchCapability = {
  modes: ['thread-resume', 'append-transcript'],
  resolveThreadId: async (sessionKey) => {
    const sources = await getOwnedGeminiTelemetrySources(sessionKey).catch(() => null);
    return sources?.threadId ?? null;
  },
  loadTranscript: async (sessionKey) => {
    try {
      const tail = await getOwnedGeminiRuntimeTail(sessionKey);
      return tail.entries
        .filter((entry) => entry.kind === 'message')
        .map((entry) => ({
          // 'Gemini' label is emitted by the parser for assistant messages.
          role: entry.label === 'Gemini' ? ('assistant' as const) : ('user' as const),
          text: entry.text,
        }));
    } catch {
      return [];
    }
  },
  formatTranscriptPrompt: (turns, userMessage) => {
    const history = turns
      .map((t) => `${t.role === 'user' ? 'User' : 'Gemini'}: ${t.text}`)
      .join('\n\n');
    return history ? `${history}\n\nUser: ${userMessage}` : userMessage;
  },
};

// ── The runtime ──────────────────────────────────────────────────────────────

export const geminiRuntime: AgentRuntime = {
  id: 'gemini',
  displayName: 'Gemini CLI',
  capabilities,
  dispatchCapability,

  async discoverSessions(options = {}): Promise<RuntimeSession[]> {
    const owned = await getOwnedGeminiFleetAdditions({ fresh: options.fresh ?? false }).catch((err) => {
      console.warn('[gemini-runtime] discoverSessions owned fleet failed:', err);
      return null;
    });
    if (!owned) return [];
    return owned.agents.map((agent) => mapAgentToSession(agent as OwnedAgentLike));
  },

  async readTranscript(sessionKey: string, sinceId?: string, limit?: number): Promise<RuntimeTranscriptEntry[]> {
    if (!sessionKey.startsWith('gemini-owned:')) {
      return [];
    }
    const tail = await getOwnedGeminiRuntimeTail(sessionKey, sinceId ? 200 : limit);
    return ownedTailToRuntimeTranscript(tail, sinceId, limit);
  },

  async launch(opts: LaunchOptions): Promise<RuntimeActionResult> {
    const startedAtMs = Date.now();
    const result = await launchOwnedGeminiSession({
      cwd: opts.cwd,
      prompt: opts.prompt,
      clientMutationId: opts.clientMutationId,
      model: opts.model,
      effort: opts.effort,
      laneId: opts.laneId,
      packetId: opts.packetId,
    });
    if (result.ok && result.surfaceId) {
      scheduleGeminiUsageDispatch(
        result.surfaceId,
        startedAtMs,
        undefined,
        opts.laneId,
        opts.model,
        () => waitForOwnedRunToFinish(result.surfaceId, startedAtMs),
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
    if (!sessionKey.startsWith('gemini-owned:')) {
      return {
        ok: false,
        note: 'Unknown Gemini session key — only owned sessions are resumable right now.',
      };
    }
    const startedAtMs = Date.now();
    const baseline = usageSnapshotFromTelemetry(await geminiRuntime.getTelemetry?.(sessionKey));
    try {
      const result = await continueOwnedGeminiSession(sessionKey, message);
      scheduleGeminiUsageDispatch(
        sessionKey,
        startedAtMs,
        baseline,
        undefined,
        undefined,
        () => waitForOwnedRunToFinish(sessionKey, startedAtMs),
      );
      return { ok: true, note: result.note, sessionKey };
    } catch (err) {
      scheduleGeminiUsageDispatch(sessionKey, startedAtMs, baseline);
      return { ok: false, note: err instanceof Error ? err.message : String(err) };
    }
  },

  async interrupt(sessionKey: string): Promise<RuntimeActionResult> {
    if (!sessionKey.startsWith('gemini-owned:')) {
      return {
        ok: false,
        note: 'Only owned Gemini sessions can be interrupted from the sidebar.',
        sessionKey,
      };
    }
    const result = await interruptOwnedGeminiSession(sessionKey);
    return {
      ok: result.interrupted,
      note: result.note,
      sessionKey,
    };
  },

  async getChangedFiles(sessionKey: string): Promise<RuntimeChangedFile[]> {
    if (!sessionKey.startsWith('gemini-owned:')) return [];
    try {
      const packet = await getOwnedGeminiReviewPacket(sessionKey);
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
    if (!sessionKey.startsWith('gemini-owned:')) return undefined;
    const sources = await getOwnedGeminiTelemetrySources(sessionKey);
    if (!sources) return undefined;

    const sessionCost = sources.stdoutPaths.length > 0
      ? await parseCost('gemini', sources.stdoutPaths)
      : null;
    if (!sessionCost) return undefined;

    const totalTokens = sessionCost.inputTokens + sessionCost.outputTokens + sessionCost.cacheReadTokens;
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
