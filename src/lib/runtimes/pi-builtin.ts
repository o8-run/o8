import type {
  AgentRuntime,
  LaunchOptions,
  RuntimeActionResult,
  RuntimeCapabilities,
  RuntimeChangedFile,
  RuntimeSession,
  RuntimeTranscriptEntry,
} from './types';
import { ownedTailToRuntimeTranscript } from './shared/owned-transcript';
import {
  getOwnedPiBuiltinFleetAdditions,
  getOwnedPiBuiltinReviewPacket,
  getOwnedPiBuiltinRuntimeTail,
  interruptOwnedPiBuiltinSession,
  launchOwnedPiBuiltinSession,
  resumeOwnedPiBuiltinSession,
} from '@/lib/pi-builtin/owned';
import { PI_BUILTIN_SURFACE_PREFIX } from '@/lib/pi-builtin/types';

// Transcripts are written per finished message, not streamed. No per-session
// cost telemetry: usage counts against the managed plan or free allowance.
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

type OwnedAgent = Awaited<ReturnType<typeof getOwnedPiBuiltinFleetAdditions>>['agents'][number];

function mapAgent(agent: OwnedAgent): RuntimeSession {
  const surface = agent.runtimeSurface;
  const lifecycleTime = surface?.lifecycle?.lastRunFinishedAt ?? surface?.lifecycle?.lastRunStartedAt ?? agent.lastEventAt;
  const lastActivityAt = new Date(lifecycleTime);
  return {
    sessionKey: agent.sessionKey,
    runtimeId: 'pi-builtin',
    displayName: agent.name,
    cwd: surface?.cwd ?? agent.workspace,
    branch: surface?.reviewContext?.branch ?? agent.branch,
    headSha: surface?.reviewContext?.head,
    repoSlug: surface?.reviewContext?.repoSlug,
    status: agent.status === 'running' ? 'running' : agent.status === 'failed' ? 'failed' : 'reviewing',
    ownership: 'owned',
    sessionCapabilities: {
      canSendInput: surface?.capabilities.sendInput ?? false,
      canInterrupt: surface?.capabilities.interrupt ?? false,
      canReviewDiffs: surface?.capabilities.diffContext ?? false,
    },
    lastActivityAt: Number.isNaN(lastActivityAt.getTime()) ? new Date() : lastActivityAt,
    initialTask: agent.currentTask,
    model: agent.model,
    lifecycle: surface?.lifecycle ? {
      availability: surface.lifecycle.availability ?? 'ready-for-resume',
      lastOutcome: surface.lifecycle.lastOutcome,
      lastRunMode: surface.lifecycle.lastRunMode,
      lastRunStartedAt: surface.lifecycle.lastRunStartedAt,
      lastRunFinishedAt: surface.lifecycle.lastRunFinishedAt,
      summary: surface.lifecycle.summary,
    } : undefined,
  };
}

export const piBuiltinRuntime: AgentRuntime = {
  id: 'pi-builtin',
  displayName: 'Pi (built-in)',
  capabilities,

  async discoverSessions(): Promise<RuntimeSession[]> {
    const owned = await getOwnedPiBuiltinFleetAdditions().catch((error) => {
      console.warn('[pi-builtin-runtime] owned-session discovery failed:', error);
      return null;
    });
    return owned?.agents.map(mapAgent) ?? [];
  },

  async readTranscript(sessionKey: string, sinceId?: string, limit?: number): Promise<RuntimeTranscriptEntry[]> {
    if (!sessionKey.startsWith(PI_BUILTIN_SURFACE_PREFIX)) return [];
    return ownedTailToRuntimeTranscript(await getOwnedPiBuiltinRuntimeTail(sessionKey), sinceId, limit);
  },

  async launch(opts: LaunchOptions): Promise<RuntimeActionResult> {
    const result = await launchOwnedPiBuiltinSession({
      cwd: opts.cwd,
      prompt: opts.prompt,
      promptMemoryRevision: opts.promptMemoryRevision,
      clientMutationId: opts.clientMutationId,
      laneId: opts.laneId,
      packetId: opts.packetId,
      workMode: opts.workMode,
      // Only an OpenRouter pin changes the route (#3584); anything else stays on the managed model.
      model: opts.model,
    });
    return { ok: result.ok, note: result.note, sessionKey: result.surfaceId || undefined, sideEffect: result.sideEffect };
  },

  async resume(sessionKey: string, message: string): Promise<RuntimeActionResult> {
    if (!sessionKey.startsWith(PI_BUILTIN_SURFACE_PREFIX)) {
      return { ok: false, sideEffect: 'none', note: 'Pi (built-in) can resume only its own o8-owned sessions.' };
    }
    return { ...await resumeOwnedPiBuiltinSession(sessionKey, message), sessionKey };
  },

  async interrupt(sessionKey: string): Promise<RuntimeActionResult> {
    if (!sessionKey.startsWith(PI_BUILTIN_SURFACE_PREFIX)) {
      return { ok: false, note: 'Pi (built-in) can interrupt only its own o8-owned sessions.', sessionKey };
    }
    const result = await interruptOwnedPiBuiltinSession(sessionKey);
    return { ok: result.interrupted, note: result.note, sessionKey };
  },

  async getChangedFiles(sessionKey: string): Promise<RuntimeChangedFile[]> {
    if (!sessionKey.startsWith(PI_BUILTIN_SURFACE_PREFIX)) return [];
    const packet = await getOwnedPiBuiltinReviewPacket(sessionKey).catch(() => null);
    return packet?.changedFiles.map((file) => ({
      path: file.path,
      status: (file.status ?? 'modified') as RuntimeChangedFile['status'],
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
    })) ?? [];
  },
};
