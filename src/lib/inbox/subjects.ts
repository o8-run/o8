/**
 * Adapted from T3 Code (https://github.com/pingdotgg/t3code),
 * apps/server/src/orchestration-v2/Orchestrator.ts and
 * packages/client-runtime/src/state/threadSettled.ts, commit
 * f58fad04162165653bf06f0c987bbfb0074a8a4b.
 * Copyright (c) 2026 T3 Tools Inc.; MIT; see licenses/t3code-MIT.txt.
 * Adapted for o8: conversation subjects, packet lineage and standalone runtime
 * identities, with existing approval, queue, lane and run evidence.
 */
import type { Lane } from '@/lib/lane/types';
import { getSqlite } from '@/lib/db';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getRuntime } from '@/lib/runtimes';
import type { AgentRuntime, RuntimeId } from '@/lib/runtimes/types';
import type { AgentSummary } from '@/lib/fleet/types';
import { PROCESS_TIMEOUT_MS } from '@/lib/lane/orchestrator-session-core';
import { listLanes } from '@/lib/lane/registry';
import { listOrchestratorTurnsForThread, isRehydratedTurnAlive } from '@/lib/lane/orchestrator-crash-survival';
import { readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { extractApprovalContextIds } from '@/lib/approvals/context';
import { listRecordedApprovals } from '@/lib/approvals/store';
import { listQueuedComposerSends } from '@/lib/orchestrator/composer-queue';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { listMissionRegistryEntries } from '@/lib/orchestrator/mission-registry';
import { inboxListingProjection, inboxReadStatement, inboxSubject, observeInboxRuntimeRun, readInboxState, type InboxReadContext } from './store';
import { hasQueuedTurnStart, type InboxSubject } from './settlement';

export class InboxMutationError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}
export function inboxPackets() {
  const current = readOrchestratorControlPlaneState({ strict: true }).packets;
  const others = listMissionRegistryEntries({ includeArchived: true, strict: true }).flatMap(entry => entry.mission.packets);
  return [...new Map([...others, ...current].map(packet => [packet.id, packet])).values()];
}
type InboxLane = Pick<Lane, 'sessionKey' | 'packetId' | 'repoPath' | 'projectId'>;
const laneReads = new WeakMap<ReturnType<typeof getSqlite>, {
  changes: number; version: number; lanes: Map<string, InboxLane>;
}>();
/** Revision checks invalidate on local writes and commits from other SQLite connections. */
export function readInboxLanes(): Map<string, InboxLane> {
  const db = getSqlite();
  const revision = inboxReadStatement('SELECT total_changes() AS changes, data_version AS version FROM pragma_data_version')
    .get() as { changes: number; version: number };
  const cached = laneReads.get(db);
  if (!db.inTransaction && cached && cached.changes === revision.changes && cached.version === revision.version) return cached.lanes;
  const rows = inboxReadStatement(`SELECT session_key, packet_id, repo_path, project_id FROM lanes
    WHERE session_key IS NOT NULL ORDER BY created_at DESC, updated_at DESC, rowid DESC`, true)
    .all() as Array<[string, string | null, string, string | null]>;
  const newest = new Map<string, InboxLane>();
  for (const row of rows) if (!newest.has(row[0])) newest.set(row[0], {
    sessionKey: row[0], packetId: row[1], repoPath: row[2], projectId: row[3],
  });
  if (!db.inTransaction) laneReads.set(db, { ...revision, lanes: newest });
  return newest;
}
export function runtimeInboxIdentity(agent: Pick<AgentSummary, 'sessionKey' | 'workspace'>, packets = inboxPackets(), lanes: Lane[] | Map<string, InboxLane> = listLanes(), context?: InboxReadContext) {
  const lane = lanes instanceof Map ? lanes.get(agent.sessionKey) : lanes.filter(candidate => candidate.sessionKey === agent.sessionKey).reverse()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.updatedAt.localeCompare(a.updatedAt))[0];
  const workspace = agent.workspace.startsWith('~/') ? join(homedir(), agent.workspace.slice(2)) : agent.workspace;
  const packet = packets.find(candidate => lane ? candidate.id === lane.packetId : candidate.lane?.sessionKey === agent.sessionKey);
  const parentId = packet?.orchestratorThreadId || packet?.launchContext?.parentThreadId;
  const parentHistory = parentId ? readPersistedLlmChat(parentId)?.history : null;
  const parentInboxSubject = parentId
    ? inboxSubject('conversation', parentId, parentHistory?.repoPath ?? packet?.workspaceTargetPath ?? workspace,
      (parentHistory as { projectId?: string } | null)?.projectId ?? packet?.projectId, context?.workspaces)
    : null;
  return { inboxSubject: parentInboxSubject ?? inboxSubject('runtime', agent.sessionKey, lane?.repoPath ?? workspace, lane?.projectId, context?.workspaces), parentInboxSubject };
}
function agentRunStartedAt(agent: AgentSummary): string | undefined {
  return agent.runtimeSurface?.lifecycle?.lastRunStartedAt
    ?? agent.statusEvidence?.evidence.find(item => item.source === 'codex-rollout.started-at')?.value;
}
export function projectRuntimeInbox(agent: AgentSummary, packets = inboxPackets(), lanes: Lane[] | Map<string, InboxLane> = listLanes(), context?: InboxReadContext) {
  const identity = runtimeInboxIdentity(agent, packets, lanes, context);
  const project = () => inboxListingProjection(identity.inboxSubject, identity.parentInboxSubject, context, agent);
  const startedAt = agentRunStartedAt(agent);
  if (startedAt) {
    observeInboxRuntimeRun(identity.inboxSubject, startedAt, context);
    return project();
  }
  const observed = observeAgentInboxRun(agent, identity.inboxSubject, false, context);
  return observed instanceof Promise ? observed.then(project) : project();
}

/** Providers without lifecycle markers still expose timestamped run messages.
 * Only an actual user/assistant transcript entry can clear an override; file
 * mtimes, titles, inventory polling and lastActivityAt never qualify.
 */
export interface RuntimeInboxActivity {
  latestUserMessageAt?: number;
  latestRunAt?: number;
  failed?: boolean;
}
export function observeAgentInboxRun(agent: AgentSummary, subject: InboxSubject, forMutation = false, context?: InboxReadContext): RuntimeInboxActivity | Promise<RuntimeInboxActivity> {
  const startedAt = agentRunStartedAt(agent);
  const finishedAt = agent.runtimeSurface?.lifecycle?.lastRunFinishedAt;
  const runTimes = [startedAt, finishedAt].flatMap(value => value && Number.isFinite(Date.parse(value)) ? [Date.parse(value)] : []);
  const activity: RuntimeInboxActivity = { latestRunAt: runTimes.length ? Math.max(...runTimes) : undefined, failed: agent.status === 'failed' };
  if (startedAt) {
    observeInboxRuntimeRun(subject, startedAt, context);
    if (!forMutation) return activity;
  }
  const prior = readInboxState(subject, context);
  if (!forMutation && prior.settledOverride === null) return activity;
  const runtime = getRuntime(agent.runtime as RuntimeId);
  if (!runtime?.capabilities.readTranscript) return activity;
  return observeAgentInboxTranscript(runtime, agent, subject, activity, context);
}

async function observeAgentInboxTranscript(runtime: AgentRuntime, agent: AgentSummary, subject: InboxSubject,
  activity: RuntimeInboxActivity, context?: InboxReadContext): Promise<RuntimeInboxActivity> {
  let transcript;
  try { transcript = await runtime.readTranscript(agent.sessionKey, undefined, 50); }
  catch { return activity; } // Missing evidence retains the explicit override.
  let latestActivity = 0;
  for (const entry of transcript) {
    if ((entry.role !== 'user' && entry.role !== 'assistant') || entry.type === 'compaction'
      || !entry.activityAt || !Number.isFinite(entry.activityAt.getTime())) continue;
    const time = entry.activityAt.getTime();
    latestActivity = Math.max(latestActivity, time);
    if (entry.role === 'user') activity.latestUserMessageAt = Math.max(activity.latestUserMessageAt ?? -Infinity, time);
    else activity.latestRunAt = Math.max(activity.latestRunAt ?? -Infinity, time);
  }
  if (latestActivity > 0) observeInboxRuntimeRun(subject, new Date(latestActivity).toISOString(), context);
  return activity;
}

export function assertInboxCanSettle(subject: InboxSubject, agents: AgentSummary[], runtimeActivity?: RuntimeInboxActivity): void {
  const packets = inboxPackets();
  const lanes = listLanes();
  const childPackets = subject.kind === 'conversation' ? packets.filter(packet =>
    (packet.orchestratorThreadId || packet.launchContext?.parentThreadId) === subject.id) : [];
  const childIds = new Set(childPackets.map(packet => packet.id));
  const relevantLanes = lanes.filter(lane => subject.kind === 'runtime'
    ? lane.sessionKey === subject.id : childIds.has(lane.packetId ?? ''));
  const sessionKeys = new Set(relevantLanes.flatMap(lane => {
    if (!lane.sessionKey) return [];
    const current = runtimeInboxIdentity({ sessionKey: lane.sessionKey, workspace: lane.repoPath }, packets, lanes);
    return current.inboxSubject.kind === subject.kind && current.inboxSubject.id === subject.id
      ? [lane.sessionKey] : [];
  }));
  if (subject.kind === 'runtime') sessionKeys.add(subject.id);
  else sessionKeys.add(`llm-chat:${subject.id}`);
  const history = subject.kind === 'conversation' ? readPersistedLlmChat(subject.id)?.history : null;
  const boundIds = (history as { orchestratorSessionIds?: Record<string, string> } | null)?.orchestratorSessionIds;
  for (const [runtime, id] of Object.entries(boundIds ?? {})) if (id) sessionKeys.add(`${runtime === 'claude' ? 'claude-code' : runtime}:${id}`);
  const relevantAgents = agents.filter(agent => sessionKeys.has(agent.sessionKey));
  const approvals = listRecordedApprovals();
  if (approvals.some(approval => {
    const context = extractApprovalContextIds(approval.metadata);
    return sessionKeys.has(approval.sessionKey) || approval.sessionKey === subject.id
      || (approval.continuation?.kind === 'llm-chat' && approval.continuation.tabId === subject.id)
      || approval.metadata?.threadId === subject.id
      || (context.packetId !== null && childIds.has(context.packetId))
      || relevantLanes.some(lane => lane.id === context.laneId
        || (approval.continuation?.kind === 'lane' && approval.continuation.laneId === lane.id));
  })
    || relevantAgents.some(agent => agent.approvalStatus === 'pending' || agent.statusEvidence?.state === 'blocked' || ['waiting', 'blocked', 'huddling'].includes(agent.status))
    || relevantLanes.some(lane => ['awaiting_input', 'awaiting_orchestrator', 'awaiting_human'].includes(lane.status))) {
    throw new InboxMutationError('Thread is waiting on an approval or question. Answer it before settling.', 409);
  }
  const state = readInboxState(subject);
  let liveOwner = false;
  if (state.ownerPid) { try { process.kill(state.ownerPid, 0); liveOwner = true; } catch { /* A dead owner is not running. */ } }
  const turns = subject.kind === 'conversation' ? listOrchestratorTurnsForThread(subject.id) : [];
  if ((state.runStatus === 'running' && liveOwner && state.runAt && Date.now() - Date.parse(state.runAt) < PROCESS_TIMEOUT_MS)
    || turns.some(turn => !turn.settledAt && isRehydratedTurnAlive(turn, PROCESS_TIMEOUT_MS))
    || relevantAgents.some(agent => agent.status === 'running' || agent.statusEvidence?.state === 'working')
    || relevantLanes.some(lane => ['launching', 'running', 'merging'].includes(lane.status))
    || childPackets.some(packet => ['running', 'launching'].includes(packet.status) && !lanes.some(lane => lane.packetId === packet.id))) {
    throw new InboxMutationError('Thread is still running. Stop it before settling.', 409);
  }
  const messages = history?.messages ?? [];
  const latestUserMessageAt = runtimeActivity?.latestUserMessageAt ?? messages.filter(message => message.role === 'user').reduce<number | undefined>(
    (max, message) => Number.isFinite(message.timestamp) ? Math.max(max ?? -Infinity, message.timestamp) : max, undefined);
  const latestRunAt = runtimeActivity?.latestRunAt ?? messages.filter(message => message.role === 'assistant' && message.content?.trim()).reduce<number | undefined>(
    (max, message) => Number.isFinite(message.timestamp) ? Math.max(max ?? -Infinity, message.timestamp) : max, undefined);
  const recordedRunAt = state.runAt ? Date.parse(state.runAt) : NaN;
  const latestKnownRunAt = Number.isFinite(recordedRunAt) ? Math.max(latestRunAt ?? -Infinity, recordedRunAt) : latestRunAt;
  const failed = runtimeActivity?.failed || (history as { orchestratorTerminalStatus?: string } | null)?.orchestratorTerminalStatus === 'failed';
  if ((subject.kind === 'conversation' && subject.workspace && listQueuedComposerSends({ repoPath: subject.workspace, threadId: subject.id }).length > 0)
    || hasQueuedTurnStart({ latestUserMessageAt, latestRunAt: latestKnownRunAt, failed }, Date.now())) {
    throw new InboxMutationError('Thread has a queued message. Send it or remove it before settling.', 409);
  }
  // Keep the synchronous guard in the mutation's SQLite transaction so a
  // concurrent queue/approval write cannot slip between validation and commit.
}
