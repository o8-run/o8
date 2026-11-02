import { orchestratorRuntimeTone } from '@/lib/orchestrator/display';
import { listDispatchableRuntimes } from '@/lib/orchestrator/runtime-capabilities';
import { nextPacketReferenceLabel } from '@/lib/orchestrator/store';
import { preserveVoiceCaption } from '@/lib/transcripts/voice-captions';
import { mergeTranscriptSources } from '@/lib/transcripts/merge-ordered';
import type {
  OrchestratorPacket,
  OrchestratorRuntime,
  OrchestratorWorkspaceTarget,
} from '@/lib/orchestrator/types';

const VALID_ORCHESTRATOR_RUNTIMES = new Set<OrchestratorRuntime>(listDispatchableRuntimes());

function coerceAgentRuntime(value?: string | null): OrchestratorRuntime {
  if (value && VALID_ORCHESTRATOR_RUNTIMES.has(value as OrchestratorRuntime)) {
    return value as OrchestratorRuntime;
  }
  return 'codex';
}
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { retainTranscriptEntries } from '@/lib/transcripts/store';
import type { AgentTarget, ContextSuggestion, FleetAgent } from './types';

export function normalizeMissionText(value: string) {
  return value
    .replace(/\s+/g, ' ')
    .trim();
}

export function summarizeMissionPrompt(value: string) {
  const normalized = normalizeMissionText(value);
  if (!normalized) return '';
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 177).trimEnd()}...`;
}

export function createPacketId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `pkt-${crypto.randomUUID()}`;
  }
  return `pkt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createDraftPacket(
  runtime: OrchestratorRuntime,
  workspaceTargets: OrchestratorWorkspaceTarget[],
  existingPackets: Array<Pick<OrchestratorPacket, 'referenceLabel'>>,
  seed?: Partial<OrchestratorPacket>,
): OrchestratorPacket {
  const target = seed?.workspaceTargetPath
    ? workspaceTargets.find((entry) => entry.localPath === seed.workspaceTargetPath) ?? null
    : workspaceTargets[0] ?? null;
  const queueState = seed?.queueState ?? 'draft';
  const status = seed?.status
    ?? (queueState === 'queued'
      ? 'queued'
      : queueState === 'held'
        ? 'blocked'
        : 'draft');
  const branchTarget = seed?.branchTarget
    ?? (queueState === 'draft'
      ? ''
      : target?.branch ?? 'main');
  return {
    id: seed?.id ?? createPacketId(),
    referenceLabel: seed?.referenceLabel ?? nextPacketReferenceLabel(existingPackets),
    title: seed?.title ?? 'New work packet',
    summary: seed?.summary ?? '',
    workspaceTargetPath: seed?.workspaceTargetPath ?? target?.localPath ?? null,
    branchTarget,
    runtime: seed?.runtime ?? runtime,
    dependencyLabels: seed?.dependencyLabels ?? [],
    dependencyPacketIds: seed?.dependencyPacketIds ?? [],
    queueState,
    releaseState: seed?.releaseState ?? 'pending',
    status,
    blockedReason: seed?.blockedReason ?? null,
    lastEventAt: seed?.lastEventAt ?? null,
    lastEventLabel: seed?.lastEventLabel ?? null,
    lane: seed?.lane ?? null,
  };
}

export function packetTitleFromPrompt(value: string) {
  const normalized = normalizeMissionText(value);
  if (!normalized) return 'New work packet';
  const compact = normalized.replace(/[.?!]+$/g, '');
  if (compact.length <= 54) return compact;
  return `${compact.slice(0, 51).trimEnd()}...`;
}

export function pickWorkspaceTargetForText(
  text: string,
  workspaceTargets: OrchestratorWorkspaceTarget[],
) {
  const normalized = text.toLowerCase();
  return workspaceTargets.find((target) => {
    const repoName = target.repoName.toLowerCase();
    const label = target.label.toLowerCase();
    return normalized.includes(repoName) || normalized.includes(label);
  }) ?? workspaceTargets[0] ?? null;
}

export function buildPacketsFromMissionPrompt(
  prompt: string,
  workspaceTargets: OrchestratorWorkspaceTarget[],
  runtime: OrchestratorRuntime,
) {
  const clauses = prompt
    .split(/\n|;|(?:\s+and then\s+)|(?:\s+then\s+)/i)
    .map((part) => normalizeMissionText(part))
    .filter(Boolean)
    .slice(0, 5);
  const seeds = clauses.length > 0 ? clauses : [normalizeMissionText(prompt)].filter(Boolean);
  return seeds.map((seed, index) => {
    const target = pickWorkspaceTargetForText(seed, workspaceTargets);
    return createDraftPacket(runtime, workspaceTargets, Array.from({ length: index }).map((_, itemIndex) => ({
      referenceLabel: `P${itemIndex + 1}`,
    })), {
      title: packetTitleFromPrompt(seed),
      summary: seed,
      workspaceTargetPath: target?.localPath ?? null,
      dependencyLabels: index === 0 ? [] : [`P${index}`],
      dependencyPacketIds: [],
      queueState: 'draft',
      releaseState: 'pending',
    });
  });
}

export function isRunnableCliSession(agent: FleetAgent) {
  const runtime = agent.runtime;
  const sessionKey = agent.sessionKey?.trim();
  if (!sessionKey) return false;
  if (runtime !== 'codex' && runtime !== 'claude-code' && runtime !== 'gemini' && runtime !== 'opencode') return false;
  if (sessionKey.includes(':ide-tab-')) return false;
  return true;
}

export function isRuntimeSessionKey(sessionKey: string): boolean {
  return sessionKey.startsWith('claude-code:')
    || sessionKey.startsWith('codex:')
    || sessionKey.startsWith('codex-owned:')
    || sessionKey.startsWith('codex-discovered:')
    || sessionKey.startsWith('codex-live:')
    || sessionKey.startsWith('gemini-owned:')
    || sessionKey.startsWith('opencode-owned:');
}

export function repoPathLabel(path: string | null | undefined): string | null {
  if (!path?.trim()) return null;
  return path.split('/').filter(Boolean).pop() ?? path;
}

export function buildAgentTargets(
  agents: FleetAgent[],
  preferredRuntime: OrchestratorRuntime,
) {
  const cliAgents = agents
    .filter(isRunnableCliSession)
    .sort((left, right) => {
      const runtimeScore = (runtime?: string) => (runtime === preferredRuntime ? 2 : 1);
      const currentScore = (agent: FleetAgent) => (agent.isCurrentSession ? 2 : 0);
      const statusScore = (status?: string) => (status === 'running' ? 2 : status === 'reviewing' ? 1 : 0);
      const delta = runtimeScore(right.runtime) + currentScore(right) + statusScore(right.status)
        - runtimeScore(left.runtime) - currentScore(left) - statusScore(left.status);
      if (delta !== 0) return delta;
      return (right.lastEventAt ?? '').localeCompare(left.lastEventAt ?? '');
    });

  return cliAgents.map((agent) => {
    const runtime = coerceAgentRuntime(agent.runtime);
    const runtimeTone = orchestratorRuntimeTone(runtime);
    return {
      key: agent.sessionKey!,
      name: agent.name?.trim() || runtimeTone.label,
      runtime,
      color: runtimeTone.color,
      workspace: agent.workspace?.trim() || null,
      isCurrentSession: Boolean(agent.isCurrentSession),
    } satisfies AgentTarget;
  });
}

export function entrySignature(entry: MobileTranscriptEntry) {
  return JSON.stringify({
    role: entry.role,
    text: entry.text,
    media: (entry.media ?? []).map((item) => `${item.kind}:${item.path}`),
    toolCalls: (entry.toolCalls ?? []).map((tool) => ({
      name: tool.name,
      args: tool.args,
      status: tool.status,
    })),
    command: entry.command,
    timestamp: entry.timestamp,
    timestampLabel: entry.timestampLabel,
  });
}

export function isRenderableThoughtEntry(entry: MobileTranscriptEntry) {
  return Boolean(
    entry.text.trim()
    || entry.media?.length
    || entry.toolCalls?.length
    || entry.command,
  );
}

export function mergeTranscriptEntries(
  existing: MobileTranscriptEntry[],
  incoming: MobileTranscriptEntry[],
) {
  if (incoming.length === 0) return existing;

  return retainTranscriptEntries(mergeTranscriptSources(existing, incoming));
}

export function mergeSameThreadHistoryLoad(
  liveEntries: MobileTranscriptEntry[],
  fetchedEntries: MobileTranscriptEntry[],
) {
  if (liveEntries.length === 0) return { entries: fetchedEntries, preservedLiveEntries: false };
  if (fetchedEntries.length === 0) return { entries: liveEntries, preservedLiveEntries: true };

  const liveById = new Map(liveEntries.map((entry) => [entry.id, entry]));
  let preservedLiveEntries = false;
  const fetched = fetchedEntries.map((fetchedEntry) => {
    const liveEntry = liveById.get(fetchedEntry.id);
    if (!liveEntry) return fetchedEntry;
    liveById.delete(fetchedEntry.id);

    // The server increments persistedVersion on every incremental and terminal
    // persist. A history request can race one of those writes, so an older page
    // must not roll a newer live entry back to partial content. Fetched wins
    // when revisions tie (including the legacy undefined/undefined case).
    const liveVersion = liveEntry.persistedVersion ?? 0;
    const fetchedVersion = fetchedEntry.persistedVersion ?? 0;
    if (liveVersion <= fetchedVersion && preserveVoiceCaption(liveEntry, fetchedEntry) === fetchedEntry) return fetchedEntry;
    preservedLiveEntries = true;
    return liveEntry;
  });

  if (liveById.size > 0) {
    preservedLiveEntries = true;
  }

  return {
    entries: mergeTranscriptSources(liveEntries, fetched),
    preservedLiveEntries,
  };
}

/**
 * RC1 seam 2 — decide whether a history load may RESET the live stream.
 *
 * `handleLoadThread` fetches persisted history and applies it. When the loaded
 * thread is the SAME thread already open and streaming, calling `orchStream.reset()`
 * (which bumps the epoch, nulls the in-flight assistant, and clears the transcript)
 * kills a still-running turn — its answer tokens are then dropped by the epoch
 * guard (D7HY6S / RRB3ND). The server turn is durable and keeps streaming, so a
 * same-thread load must be MERGE-ONLY: never reset, never wholesale-replace a live
 * in-flight turn. A DIFFERENT thread is a genuine switch and resets as before.
 *
 * `mergeSameThreadHistoryLoad` still computes the merged entries; this decides the
 * reset. The prior code reset whenever the merge found no live-only entries — which
 * is exactly the mid-turn case where the incremental server persist already mirrored
 * the live transcript (no live-only delta), so it reset a turn that was still live.
 */
export function resolveThreadLoadPlan(input: {
  isSameOpenThread: boolean;
  streamBusy: boolean;
  merged: { entries: MobileTranscriptEntry[]; preservedLiveEntries: boolean };
}): { entries: MobileTranscriptEntry[]; reset: boolean } {
  // A live in-flight turn on the same thread is never reset — merge only.
  if (input.isSameOpenThread && input.streamBusy) {
    return { entries: input.merged.entries, reset: false };
  }
  // A same-thread load that already preserved live entries also stays merge-only.
  if (input.isSameOpenThread && input.merged.preservedLiveEntries) {
    return { entries: input.merged.entries, reset: false };
  }
  return { entries: input.merged.entries, reset: !input.merged.preservedLiveEntries };
}

export function generateSuggestions(agents: FleetAgent[], targets: AgentTarget[]): ContextSuggestion[] {
  const suggestions: ContextSuggestion[] = [];
  const targetBySessionKey = new Map(targets.map((target) => [target.key, target]));
  const targetByName = new Map(targets.map((target) => [target.name.toLowerCase(), target]));
  const targetByRuntime = new Map<OrchestratorRuntime, AgentTarget>();
  targets.forEach((target) => {
    if (!targetByRuntime.has(target.runtime)) {
      targetByRuntime.set(target.runtime, target);
    }
  });

  for (const agent of agents) {
    const name = agent.name || 'Unknown';
    const runtime = coerceAgentRuntime(agent.runtime);
    const target = (agent.sessionKey ? targetBySessionKey.get(agent.sessionKey) : null)
      ?? targetByName.get(name.toLowerCase())
      ?? targetByRuntime.get(runtime)
      ?? targets[0];
    if (!target) continue;

    const ctx = agent.context?.usedPercent ?? 0;
    if (ctx > 80) {
      suggestions.push({
        text: `${name} is at ${Math.round(ctx)}% context — approaching limit`,
        action: `What's your context status? Do you need to compact?`,
        agent: target,
        priority: ctx > 90 ? 'critical' : 'warn',
      });
    }

    if (agent.status === 'failed' || agent.status === 'error') {
      suggestions.push({
        text: `${name} has failed — may need intervention`,
        action: `What happened? Can you recover?`,
        agent: target,
        priority: 'critical',
      });
    }

    if (agent.status === 'idle' && agent.currentTask) {
      const lastEvent = agent.lastEventAt ? new Date(agent.lastEventAt).getTime() : 0;
      const idleMinutes = lastEvent ? (Date.now() - lastEvent) / 60000 : 0;
      if (idleMinutes > 30) {
        suggestions.push({
          text: `${name} has been idle ${Math.round(idleMinutes)}min with task: "${agent.currentTask}"`,
          action: `Status update on "${agent.currentTask}"?`,
          agent: target,
          priority: 'warn',
        });
      }
    }

    if (agent.alerts && agent.alerts > 0) {
      suggestions.push({
        text: `${name} has ${agent.alerts} alert${agent.alerts > 1 ? 's' : ''}`,
        action: `What alerts do you have? Anything I should know?`,
        agent: target,
        priority: 'warn',
      });
    }
  }

  const priorityOrder = { critical: 0, warn: 1, info: 2 };
  suggestions.sort((left, right) => priorityOrder[left.priority] - priorityOrder[right.priority]);

  return suggestions.slice(0, 3);
}
