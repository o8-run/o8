import { observedCacheTokens } from '@/lib/prompt-cache/usage-evidence';
import { open, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentSummary,
  EventItem,
  ReviewArtifact,
  RuntimeSurfaceSummary,
  SquadSummary,
} from '@/lib/fleet/types';
import { MODEL_IDS } from '@/lib/models';
import { listRecentDashboardCliSessions } from '@/lib/runtime/terminal-session-registry';
import { truncateText } from '@/lib/util/text';
import {
  codexSessionsRoot,
  defaultCodexHome,
  listCodexDiscoveryHomes,
  queryCodexThreadByIdFromHome,
  queryCodexThreadsFromHome,
  type CodexThreadRow,
} from './discovery-store';
import {
  buildCodexActivityMap,
  queryAllLiveCodexProcesses,
  type CodexThreadActivity,
  type LiveCodexProcess,
} from './live-process-discovery';

const CODEX_SOURCE_LABEL = 'Local Codex discovery';
const RECENT_WINDOW_MS = 6 * 60 * 60_000;
const DISCOVERED_STALE_WINDOW_MS = 24 * 60 * 60_000;
const CODEX_DISCOVERED_FLEET_TTL_MS = 15_000;
const CODEX_DISCOVERED_IDLE_TTL_MS = 30_000;

type CodexDiscoveredFleetAdditions = {
  agents: Array<AgentSummary & { pid?: number }>;
  squads: SquadSummary[];
  events: EventItem[];
  artifacts: ReviewArtifact[];
  sourceLabel?: string;
  note?: string;
};

let discoveredFleetCache: { value: CodexDiscoveredFleetAdditions; cachedAt: number } | null = null;
let discoveredFleetInflight: Promise<CodexDiscoveredFleetAdditions> | null = null;
let discoveredFleetGeneration = 0;

export function invalidateCodexDiscoveredFleetCache() {
  discoveredFleetGeneration += 1;
  discoveredFleetCache = null;
  discoveredFleetInflight = null;
}

export type RuntimeTailEntry = {
  model?: string;
  id: string;
  kind: 'message' | 'event' | 'tool' | 'tool-output';
  role?: 'user' | 'assistant' | 'system';
  label: string;
  text: string;
  timestamp?: string;
  timestampLabel?: string;
  thinking?: string;
  tokens?: import('@/lib/mobile/types').MobileTranscriptEntry['tokens'];
};

function compactText(value: string | null | undefined, max = 120) {
  return truncateText(value, max, { normalizeWhitespace: true });
}

function compactTitle(value: string | null | undefined, max = 72) {
  const firstParagraph = (value ?? '').split(/\n\n/)[0] ?? '';
  return compactText(firstParagraph, max) || 'Codex session';
}

function shortenPath(filePath?: string | null) {
  if (!filePath) return 'unknown';
  return filePath.replace(`${os.homedir()}/`, '~/');
}

function relativeAgeFromSeconds(unixSeconds: number) {
  const ageMs = Math.max(0, Date.now() - unixSeconds * 1000);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (ageMs < minute) return 'just now';
  if (ageMs < hour) return `${Math.max(1, Math.round(ageMs / minute))}m ago`;
  if (ageMs < day) return `${Math.max(1, Math.round(ageMs / hour))}h ago`;
  return `${Math.max(1, Math.round(ageMs / day))}d ago`;
}

function repoSlugFromOrigin(value?: string | null) {
  const normalized = (value ?? '').trim();
  if (!normalized) return undefined;

  const httpsMatch = normalized.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i);
  if (httpsMatch?.[1]) {
    return httpsMatch[1];
  }

  const sshMatch = normalized.match(/github\.com:([^/]+\/[^/.]+)(?:\.git)?$/i);
  if (sshMatch?.[1]) {
    return sshMatch[1];
  }

  return undefined;
}

function repoNameFromThread(thread: CodexThreadRow) {
  const localName = path.basename(thread.cwd);
  if (localName) {
    return localName;
  }

  const repoSlug = repoSlugFromOrigin(thread.git_origin_url);
  if (repoSlug) {
    return repoSlug.split('/').pop() ?? repoSlug;
  }

  return 'codex';
}

function branchLabel(branch?: string | null) {
  const compact = compactText(branch, 36);
  return compact || undefined;
}

function surfaceDisplayTitle(thread: CodexThreadRow) {
  const repoName = repoNameFromThread(thread);
  const branch = branchLabel(thread.git_branch);
  return branch ? `${repoName} • ${branch}` : repoName;
}

function taskSummary(thread: CodexThreadRow) {
  return compactTitle(thread.first_user_message || thread.title, 120);
}

export async function queryCodexThreads(limit = 6) {
  return queryCodexThreadsFromHome(defaultCodexHome(), limit);
}

async function findCodexThreadAcrossHomes(threadId: string, identityId?: string) {
  const homes = await listCodexDiscoveryHomes();
  const candidates = identityId
    ? homes.filter((home) => home.identityId === identityId)
    : homes;
  const matches: Array<{
    thread: CodexThreadRow;
    home: (typeof homes)[number];
  }> = [];
  for (const home of candidates) {
    const thread = await queryCodexThreadByIdFromHome(home.configHomeRef, threadId).catch(() => null);
    if (thread) matches.push({ thread, home });
  }
  return matches.length === 1 ? matches[0] : null;
}

export async function resolveCodexDiscoveredSessionHome(
  surfaceId: string,
  identityId?: string,
): Promise<{ threadId: string; identityId?: string; configHomeRef: string } | null> {
  const threadId = surfaceId.replace(/^codex(?:-discovered)?:/, '').trim();
  if (!threadId || threadId === surfaceId) return null;
  const found = await findCodexThreadAcrossHomes(threadId, identityId);
  return found ? {
    threadId,
    identityId: found.home.identityId,
    configHomeRef: found.home.configHomeRef,
  } : null;
}

export async function queryCodexThreadById(threadId: string, identityId?: string) {
  return (await findCodexThreadAcrossHomes(threadId, identityId))?.thread ?? null;
}

function classifyActivity(thread: CodexThreadRow, activity?: CodexThreadActivity) {
  if (activity?.active) {
    return 'active' as const;
  }

  const updatedAgeMs = Math.max(0, Date.now() - thread.updated_at * 1000);
  const lastLogAgeMs = activity?.lastLogTs ? Math.max(0, Date.now() - activity.lastLogTs * 1000) : Infinity;

  if (Math.min(updatedAgeMs, lastLogAgeMs) < RECENT_WINDOW_MS) {
    return 'recent' as const;
  }

  return 'stale' as const;
}

function shouldExposeDiscoveredThread(thread: CodexThreadRow, activity?: CodexThreadActivity) {
  if (activity?.active) return true;
  const freshestActivityMs = Math.max(
    thread.updated_at * 1000,
    (activity?.lastLogTs ?? 0) * 1000,
  );
  return (Date.now() - freshestActivityMs) <= DISCOVERED_STALE_WINDOW_MS;
}

function deriveStatus(thread: CodexThreadRow, activity?: CodexThreadActivity): AgentSummary['status'] {
  const activityState = classifyActivity(thread, activity);
  if (activityState === 'active') return 'running';
  if (activityState === 'recent') return 'reviewing';
  return 'idle';
}

function buildRuntimeSurface(thread: CodexThreadRow, activity?: CodexThreadActivity): RuntimeSurfaceSummary {
  const repoSlug = repoSlugFromOrigin(thread.git_origin_url);
  const activityState = classifyActivity(thread, activity);
  const isLive = activityState === 'active';
  // Non-live discovered sessions can still be resumed: `codex exec resume
  // <threadId> <message>` spawns a fresh subprocess that picks up the
  // persisted thread state. We accept that pathway as valid input; the
  // adapter (src/lib/runtimes/codex.ts resume) routes closed sessions
  // through `codex exec resume`, live ones through the owned pipeline.
  const canSendInput = Boolean(thread.id);
  const activeProcessLabel = activity?.active
    ? `Local Codex discovery • live pid ${activity.pid}${activity.tty ? ` • ${activity.tty}` : ''}`
    : activityState === 'recent'
      ? 'Local Codex discovery • recent session history'
      : 'Local Codex discovery • persisted session history';

  return {
    id: `codex:${thread.id}`,
    runtime: 'codex',
    kind: 'terminal-session',
    ownership: 'discovered',
    title: surfaceDisplayTitle(thread),
    cwd: shortenPath(thread.cwd),
    branch: thread.git_branch || undefined,
    sourceLabel: activeProcessLabel,
    tailSourceLabel: '~/.codex/sessions/*.jsonl + state_5.sqlite',
    capabilities: {
      attach: true,
      readTail: true,
      sendInput: canSendInput,
      interrupt: isLive,
      resize: false,
      diffContext: Boolean(thread.git_branch || repoSlug),
      reviewContext: Boolean(thread.git_branch || repoSlug),
    },
    reviewContext: {
      repoSlug,
      branch: thread.git_branch || undefined,
      head: thread.git_sha || undefined,
    },
  };
}

function buildCurrentTask(thread: CodexThreadRow, activity?: CodexThreadActivity) {
  const summary = taskSummary(thread);
  const activityState = classifyActivity(thread, activity);

  if (activityState === 'active') {
    return `Live Codex process and thread identity verified${activity?.tty ? ` on ${activity.tty}` : ''}. ${summary}`;
  }

  if (activityState === 'recent') {
    return `Recent Codex session recovered from local runtime history. ${summary}`;
  }

  return `Historical Codex session recovered from local runtime history. ${summary}`;
}

function buildSyntheticLiveProcessSurface(
  pid: number,
  proc: LiveCodexProcess,
): RuntimeSurfaceSummary {
  const cwd = shortenPath(proc.cwd ?? '');
  const titleBase = path.basename(proc.cwd ?? '') || 'codex';

  return {
    id: `codex-live:${pid}`,
    runtime: 'codex',
    kind: 'terminal-session',
    ownership: 'discovered',
    title: `${titleBase}${proc.tty ? ` • ${proc.tty}` : ''}`,
    cwd,
    branch: undefined,
    sourceLabel: `Local Codex discovery • live pid ${pid}${proc.tty ? ` • ${proc.tty}` : ''} • process-only`,
    tailSourceLabel: 'live process inventory',
    capabilities: {
      attach: false,
      readTail: false,
      sendInput: false,
      interrupt: true,
      resize: false,
      diffContext: false,
      reviewContext: false,
    },
  };
}

export async function getCodexDiscoveredFleetAdditions(
  options: { fresh?: boolean } = {},
): Promise<CodexDiscoveredFleetAdditions> {
  const fresh = options.fresh ?? false;
  const now = Date.now();
  const generation = discoveredFleetGeneration;
  if (discoveredFleetCache) {
    const hasLiveSession = discoveredFleetCache.value.agents.some((agent) => agent.status === 'running');
    const cacheTtlMs = hasLiveSession
      ? CODEX_DISCOVERED_FLEET_TTL_MS
      : CODEX_DISCOVERED_IDLE_TTL_MS;
    const effectiveTtlMs = fresh ? Math.min(cacheTtlMs, 5_000) : cacheTtlMs;
    if ((now - discoveredFleetCache.cachedAt) < effectiveTtlMs) {
      return discoveredFleetCache.value;
    }
  }

  if (discoveredFleetInflight) {
    return discoveredFleetInflight;
  }

  const promise = (async () => {
  try {
    const homes = await listCodexDiscoveryHomes();
    const liveProcesses = await queryAllLiveCodexProcesses();
    const agentsBySession = new Map<string, AgentSummary & { pid?: number }>();
    const ambiguousSessionKeys = new Set<string>();
    const matchedLivePids = new Set<number>();
    const boundThreadIds = new Set(
      listRecentDashboardCliSessions('codex')
        .map(({ sessionKey }) => sessionKey.match(/^codex:([0-9a-f-]{36})$/)?.[1])
        .filter((id): id is string => Boolean(id)),
    );
    let discoveredThreadCount = 0;

    for (const home of homes) {
      const [recentThreads, boundThreads] = await Promise.all([
        queryCodexThreadsFromHome(home.configHomeRef, 64).catch(() => []),
        Promise.all([...boundThreadIds].map((id) => (
          queryCodexThreadByIdFromHome(home.configHomeRef, id).catch(() => null)
        ))),
      ]);
      const threads = [...new Map(
        [...recentThreads, ...boundThreads.filter((row): row is CodexThreadRow => Boolean(row))]
          .map((row) => [row.id, row]),
      ).values()];
      discoveredThreadCount += threads.length;
      if (!threads.length) continue;
      const activityMap = await buildCodexActivityMap(threads, home.configHomeRef, liveProcesses).catch(
        () => new Map<string, CodexThreadActivity>(),
      );
      const visibleThreads = threads.filter((thread) => (
        shouldExposeDiscoveredThread(thread, activityMap.get(thread.id))
      ));
      for (const thread of visibleThreads) {
        const sessionKey = `codex:${thread.id}`;
        if (ambiguousSessionKeys.has(sessionKey)) continue;
        if (agentsBySession.has(sessionKey)) {
          agentsBySession.delete(sessionKey);
          ambiguousSessionKeys.add(sessionKey);
          continue;
        }
        const activity = activityMap.get(thread.id);
        const surface = buildRuntimeSurface(thread, activity);
        const status = deriveStatus(thread, activity);
        const branch = thread.git_branch || 'detached';
        const workspace = shortenPath(thread.cwd);
        const activityState = classifyActivity(thread, activity);
        if (activity?.pid) matchedLivePids.add(activity.pid);

        agentsBySession.set(sessionKey, {
          id: sessionKey,
          name: surface.title,
          squadId: 'squad-codex-local',
          runtime: 'codex',
          model: thread.model || MODEL_IDS.codexCliDefault,
          status,
          currentTask: buildCurrentTask(thread, activity),
          workspace,
          branch,
          sessionKey,
          approvalStatus: 'none',
          lastEventAt: relativeAgeFromSeconds(activity?.lastLogTs ?? thread.updated_at),
          context: {
            usedPercent: 0,
            trend: activityState === 'stale' ? 'falling' : 'stable',
          },
          alerts: 0,
          sessionId: thread.id,
          identityId: home.identityId,
          sessionKind: 'terminal',
          pid: activity?.active ? activity.pid : undefined,
          surfaceLabel: activityState === 'active' ? 'Codex terminal • active' : 'Codex terminal • recent',
          runtimeSurface: surface,
        } satisfies AgentSummary & { pid?: number });
      }
    }

    if (!discoveredThreadCount) {
      return {
        agents: [],
        squads: [],
        events: [],
        artifacts: [],
      };
    }

    if (!agentsBySession.size) {
      return {
        agents: [],
        squads: [],
        events: [],
        artifacts: [],
        sourceLabel: CODEX_SOURCE_LABEL,
        note: 'Codex discovery skipped stale local thread history with no live pid binding.',
      };
    }
    const agents = [...agentsBySession.values()];
    for (const [pid, proc] of liveProcesses) {
      if (matchedLivePids.has(pid)) continue;
      const surface = buildSyntheticLiveProcessSurface(pid, proc);
      agents.push({
        id: surface.id,
        name: surface.title,
        squadId: 'squad-codex-local',
        runtime: 'codex',
        model: MODEL_IDS.codexCliDefault,
        status: 'running',
        currentTask: `Live Codex terminal detected${proc.tty ? ` on ${proc.tty}` : ''}. Durable thread binding has not been recovered yet, so transcript/resume stay disabled.`,
        workspace: surface.cwd ?? shortenPath(proc.cwd ?? ''),
        branch: 'detached',
        sessionKey: surface.id,
        approvalStatus: 'none',
        lastEventAt: 'just now',
        context: {
          usedPercent: 0,
          trend: 'stable',
        },
        alerts: 0,
        sessionId: `live:${pid}`,
        sessionKind: 'terminal',
        surfaceLabel: 'Codex terminal • live',
        runtimeSurface: surface,
      } satisfies AgentSummary & { pid?: number });
    }

    const activeCount = agents.filter((agent) => agent.status === 'running').length;
    const squad: SquadSummary = {
      id: 'squad-codex-local',
      name: 'Codex Local',
      status: activeCount > 0 ? 'healthy' : 'watching',
      throughputLabel: activeCount > 0 ? `${activeCount} live, ${agents.length} visible terminal surface${agents.length === 1 ? '' : 's'}` : `${agents.length} local terminal surface${agents.length === 1 ? '' : 's'}`,
      blockers: 0,
      alerts: 0,
      liveSessions: agents.length,
      members: agents.map((agent) => agent.id),
    };

    const events: EventItem[] = agents.slice(0, 4).map((agent) => ({
      id: `evt-${agent.id}`,
      agentId: agent.id,
      squadId: agent.squadId,
      severity: agent.status === 'running' ? 'info' : agent.status === 'reviewing' ? 'warning' : 'warning',
      title: `${agent.name} • ${agent.surfaceLabel}`,
      detail: `${agent.currentTask} ${agent.runtimeSurface?.reviewContext?.repoSlug ? `• ${agent.runtimeSurface.reviewContext.repoSlug}` : ''}`.trim(),
      timestamp: agent.lastEventAt,
    }));

    const artifacts: ReviewArtifact[] = agents.slice(0, 3).map((agent) => ({
      kind: 'run_log',
      title: `${agent.name} tail`,
      state: 'reviewing',
      agentId: agent.id,
      detail: 'Readable rollout tail recovered from Codex runtime history.',
    }));

    return {
      agents,
      squads: [squad],
      events,
      artifacts,
      sourceLabel: CODEX_SOURCE_LABEL,
      note:
        activeCount > 0
          ? 'Codex runtime inventory distinguishes live pid-backed terminals from closed sessions. Both support resume via `codex exec resume <threadId>`, routed through the adapter.'
          : 'Codex local sessions are read from state_5.sqlite + rollout history. Closed sessions still accept input — the adapter spawns `codex exec resume <threadId> <message>` to continue the thread.',
    };
  } catch (error) {
    return {
      agents: [],
      squads: [],
      events: [],
      artifacts: [],
      note: error instanceof Error ? `Codex discovery unavailable: ${error.message}` : 'Codex discovery unavailable.',
    };
  }
  })();

  discoveredFleetInflight = promise;
  return promise.finally(() => {
    if (discoveredFleetInflight === promise) {
      discoveredFleetInflight = null;
    }
  }).then((value) => {
    if (generation === discoveredFleetGeneration) {
      discoveredFleetCache = { value, cachedAt: Date.now() };
    }
    return value;
  });
}

async function readTailChunk(filePath: string, maxBytes = 220_000) {
  const handle = await open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const bytesToRead = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, stat.size - bytesToRead);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

function parseTimestampLabel(value?: string) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function extractTextParts(content: Array<Record<string, unknown>> | undefined) {
  if (!content?.length) return '';
  return content
    .filter((item) => item.type === 'output_text' || item.type === 'input_text')
    .map((item) => String(item.text ?? ''))
    .join(' ');
}

function extractReasoningSummary(summary: unknown) {
  if (!Array.isArray(summary)) return '';
  return summary
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.text === 'string') return candidate.text;
      if (typeof candidate.summary_text === 'string') return candidate.summary_text;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function summarizeTailFromJsonl(raw: string, limit = 50) {
  const retainedLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
  const entries: RuntimeTailEntry[] = [];
  const lines = raw.split('\n').slice(-Math.max(180, retainedLimit * 4));
  let pendingThinking = '';
  let model: string | undefined;
  let turnModel: string | undefined;
  let userIndex = -1;
  let cumulative: Record<string, unknown> | undefined;
  let baseline: Record<string, unknown> | undefined;

  for (const line of lines) {
    if (!line.trim()) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = String(parsed.type ?? '');
    const payload = (parsed.payload ?? {}) as Record<string, unknown>;
    if (parsed.type === 'turn_context' && typeof payload.model === 'string') model = payload.model;
    const timestampLabel = parseTimestampLabel(typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined);

    if (type === 'event_msg' && payload.type === 'agent_message') {
      const text = String(payload.message ?? '').trim();
      if (!text) continue;
      entries.push({
        id: `${entries.length}-event`,
        kind: 'event',
        label: 'Agent update',
        text,
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined,
        timestampLabel,
      });
      continue;
    }

    if (type === 'response_item' && payload.type === 'reasoning') {
      const text = extractReasoningSummary(payload.summary);
      if (text) {
        pendingThinking = text;
      }
      continue;
    }

    if (type === 'response_item' && payload.type === 'message') {
      const role = String(payload.role ?? 'message');
      const phase = compactText(String(payload.phase ?? ''), 32);
      const text = extractTextParts((payload.content ?? []) as Array<Record<string, unknown>>).trim();
      if (role !== 'assistant' && role !== 'user') continue;
      if (!text) continue;
      if (role === 'user') {
        userIndex = entries.length;
        baseline = cumulative;
        turnModel = model;
      }
      entries.push({
        id: typeof payload.id === 'string' ? payload.id : `${String(parsed.timestamp ?? entries.length)}-${role}-message`,
        kind: 'message',
        label: compactText(`${role}${phase ? ` • ${phase}` : ''}`, 40),
        role: role === 'user' ? 'user' : 'assistant',
        text,
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined,
        timestampLabel,
        thinking: role === 'assistant' ? (pendingThinking || undefined) : undefined,
      });
      pendingThinking = '';
      continue;
    }

    if (
      (type === 'response_item' && payload.type === 'function_call')
      || (type === 'response_item' && payload.type === 'custom_tool_call')
    ) {
      const name = compactText(String(payload.name ?? 'tool'), 40);
      const rawToolInput = payload.type === 'custom_tool_call'
        ? payload.input
        : payload.arguments;
      const toolText = typeof rawToolInput === 'string'
        ? rawToolInput
        : JSON.stringify(rawToolInput ?? '');
      entries.push({
        id: `${entries.length}-tool`,
        kind: 'tool',
        label: name || 'Tool call',
        text: toolText || 'Tool invoked.',
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined,
        timestampLabel,
      });
      continue;
    }

    if (type === 'response_item' && payload.type === 'function_call_output') {
      const text = compactText(String(payload.output ?? ''), 500);
      if (!text) continue;
      entries.push({
        id: `${entries.length}-tool-output`,
        kind: 'tool-output',
        label: 'Tool output',
        text,
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined,
        timestampLabel,
      });
      continue;
    }

    if (type === 'turn.completed' || (type === 'event_msg' && payload.type === 'token_count')) {
      const info = payload.info && typeof payload.info === 'object' ? payload.info as Record<string, unknown> : {};
      const reportedTotal = info.total_token_usage as Record<string, unknown> | undefined;
      if (reportedTotal && typeof reportedTotal === 'object') cumulative = reportedTotal;
      // A bounded tail can begin mid-turn. Without a pre-turn cumulative baseline,
      // last_token_usage cannot describe all API calls in that turn: keep it unknown.
      let usage = (parsed.usage ?? payload.usage) as Record<string, unknown> | undefined;
      if (type === 'event_msg' && reportedTotal && baseline) {
        usage = {};
        for (const field of ['input_tokens', 'cached_input_tokens', 'output_tokens']) {
          const end = reportedTotal[field]; const start = baseline[field];
          if (typeof end === 'number' && Number.isFinite(end) && typeof start === 'number' && Number.isFinite(start) && end >= start) usage[field] = end - start;
        }
      }
      if (!usage || userIndex < 0) continue;
      for (let index = userIndex + 1; index < entries.length; index += 1) {
        entries[index].tokens = undefined;
        entries[index].model = undefined;
      }
      for (let index = entries.length - 1; index > userIndex; index -= 1) {
        const candidate = entries[index];
        if (candidate.kind !== 'message' || candidate.role !== 'assistant') continue;
        candidate.tokens = observedCacheTokens(usage, true);
        candidate.model = model;
        if (typeof parsed.timestamp === 'string') candidate.timestamp = parsed.timestamp;
        if (turnModel !== model) candidate.tokens.cacheObserved = false;
        break;
      }
    }
  }

  return entries.slice(-retainedLimit);
}

async function findCodexThreadBySurfaceId(surfaceId: string, identityId?: string) {
  const threadId = surfaceId.replace(/^codex(?:-discovered|-live|-owned)?:/, '');
  return findCodexThreadAcrossHomes(threadId, identityId);
}

export async function getCodexRolloutPath(surfaceId: string, identityId?: string): Promise<string | null> {
  const found = await findCodexThreadBySurfaceId(surfaceId, identityId);
  if (!found) {
    return null;
  }

  const { thread, home } = found;
  const resolvedRollout = await realpath(thread.rollout_path).catch(() => null);
  const resolvedRoot = await realpath(codexSessionsRoot(home.configHomeRef)).catch(() => null);
  if (!resolvedRollout || !resolvedRoot) {
    return null;
  }

  return resolvedRollout.startsWith(`${resolvedRoot}${path.sep}`) || resolvedRollout === resolvedRoot
    ? resolvedRollout
    : null;
}

export async function getCodexRuntimeTail(surfaceId: string, limit = 50, identityId?: string): Promise<{
  surface: RuntimeSurfaceSummary;
  entries: RuntimeTailEntry[];
}> {
  const livePidMatch = surfaceId.match(/^codex-live:(\d+)$/);
  if (livePidMatch?.[1]) {
    const pid = Number(livePidMatch[1]);
    const liveProcesses = await queryAllLiveCodexProcesses();
    const proc = liveProcesses.get(pid);
    if (!proc) {
      throw new Error('Live Codex process was not found.');
    }
    const surface = buildSyntheticLiveProcessSurface(pid, proc);
    return {
      surface,
      entries: [{
        id: `live-${pid}-notice`,
        kind: 'event',
        label: 'Live process',
        text: `Live Codex process ${pid}${proc.tty ? ` on ${proc.tty}` : ''} is running in ${shortenPath(proc.cwd ?? '')}. Transcript and resume stay unavailable until Codex writes a durable thread binding.`,
      }],
    };
  }

  const found = await findCodexThreadBySurfaceId(surfaceId, identityId);
  if (!found) {
    throw new Error('Codex runtime surface was not found.');
  }

  const { thread, home } = found;
  const activityMap = await buildCodexActivityMap([thread], home.configHomeRef);
  const resolvedRollout = await realpath(thread.rollout_path);
  const resolvedRoot = await realpath(codexSessionsRoot(home.configHomeRef));
  if (!resolvedRollout.startsWith(`${resolvedRoot}${path.sep}`) && resolvedRollout !== resolvedRoot) {
    throw new Error('Codex rollout path escaped the expected sessions root.');
  }

  const retainedLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
  const raw = await readTailChunk(resolvedRollout, Math.max(220_000, retainedLimit * 4_400));
  return {
    surface: buildRuntimeSurface(thread, activityMap.get(thread.id)),
    entries: summarizeTailFromJsonl(raw, retainedLimit),
  };
}
