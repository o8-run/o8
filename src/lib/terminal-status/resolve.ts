import type { ApprovalRecord } from '@/lib/approvals/types';
import type { AgentStatus } from '@/lib/fleet/types';
import type { Lane, LaneEvent, LaneStatus } from '@/lib/lane/types';
import type { RuntimeId, RuntimeSession, RuntimeSessionStatus } from '@/lib/runtimes/types';
import type { OwnedRunRecord, OwnedRunOutcome } from '@/lib/runtimes/shared/owned-session/types';

export type TerminalStatusState =
  | 'idle'
  | 'working'
  | 'blocked'
  | 'failed'
  | 'complete'
  | 'review-ready'
  | 'unknown';

export type TerminalStatusAuthority =
  | 'runtime-event'
  | 'lane-state'
  | 'known-screen-adapter'
  | 'raw-terminal';

export interface TerminalStatusEvidenceItem {
  source: string;
  value: string;
}

export interface TerminalStatusEvidence {
  sessionId: string;
  runtime: RuntimeId;
  state: TerminalStatusState;
  authority: TerminalStatusAuthority;
  observedAt: string;
  summary: string;
  evidence: TerminalStatusEvidenceItem[];
  fallbackReason?: string;
}

export interface TerminalRuntimeSessionEvidence {
  sessionKey: string;
  runtimeId: RuntimeId;
  status: RuntimeSessionStatus;
  observedAt: string;
  lifecycle?: Partial<NonNullable<RuntimeSession['lifecycle']>>;
  stale?: boolean;
}

export type TerminalOwnedRunEvidence = OwnedRunRecord & {
  stale?: boolean;
};

export interface TerminalReviewQueueEvidence {
  id: string;
  laneId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  updatedAt: string;
  lastError?: string | null;
}

export interface RawTerminalLifecycleEvidence {
  sessionId: string;
  runtime: RuntimeId;
  state: TerminalStatusState | 'active' | 'completed' | 'killed' | 'stalled';
  observedAt: string;
  exitCode?: number;
}

export interface ResolveTerminalStatusEvidenceInput {
  runtimeSession?: TerminalRuntimeSessionEvidence | null;
  ownedRun?: TerminalOwnedRunEvidence | null;
  lane?: Lane | null;
  laneEvents?: LaneEvent[];
  approvals?: ApprovalRecord[];
  reviewQueue?: TerminalReviewQueueEvidence[];
  rawLifecycle?: RawTerminalLifecycleEvidence | null;
}

interface StatusCandidate {
  authority: Exclude<TerminalStatusAuthority, 'known-screen-adapter'>;
  state: TerminalStatusState;
  observedAt: string;
  summary: string;
  source: string;
  value: string;
  sourceRank: number;
}

const STATE_PRIORITY: Record<TerminalStatusState, number> = {
  working: 6,
  'review-ready': 5,
  blocked: 4,
  failed: 3,
  idle: 2,
  complete: 1,
  unknown: 0,
};

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function validIso(value: string | number | Date | undefined): string | null {
  if (value === undefined || value === '') return null;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function newestIso(...values: Array<string | undefined>): string | null {
  return values
    .map(validIso)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.localeCompare(left))[0] ?? null;
}

function runtimeState(status: RuntimeSessionStatus): TerminalStatusState {
  switch (status) {
    case 'running': return 'working';
    case 'waiting': return 'blocked';
    case 'reviewing': return 'review-ready';
    case 'failed': return 'failed';
    case 'completed': return 'complete';
    case 'idle': return 'idle';
  }
}

function ownedRunState(outcome: OwnedRunOutcome): TerminalStatusState {
  switch (outcome) {
    case 'running': return 'working';
    case 'finished': return 'complete';
    case 'interrupted': return 'blocked';
    case 'failed': return 'failed';
  }
}

function runtimeLifecycleState(
  lifecycle: NonNullable<TerminalRuntimeSessionEvidence['lifecycle']>,
  fallback: TerminalStatusState,
): TerminalStatusState {
  if (lifecycle.availability === 'running') {
    return 'working';
  }
  switch (lifecycle.lastOutcome) {
    case 'failed': return 'failed';
    case 'finished': return 'complete';
    case 'interrupted': return 'blocked';
    default: return lifecycle.availability === 'awaiting-thread' ? 'blocked' : fallback;
  }
}

function laneState(status: LaneStatus): TerminalStatusState {
  switch (status) {
    case 'launching':
    case 'running':
    case 'recovering':
    case 'merging':
      return 'working';
    case 'awaiting_input':
    case 'awaiting_orchestrator':
    case 'awaiting_human':
      return 'blocked';
    case 'reviewing':
      return 'review-ready';
    case 'failed':
      return 'failed';
    case 'completed':
    case 'archived':
      return 'complete';
    case 'idle':
    case 'paused':
      return 'idle';
  }
}

function rawState(state: RawTerminalLifecycleEvidence['state']): TerminalStatusState {
  switch (state) {
    case 'active': return 'working';
    case 'completed': return 'complete';
    case 'killed': return 'failed';
    case 'stalled': return 'blocked';
    default: return state;
  }
}

function laneEventState(event: LaneEvent): TerminalStatusState | null {
  if (event.verb === 'runtime_process_exit') {
    const clean = event.payload.classification === 'clean-exit'
      || (event.payload.exitCode === 0 && !event.payload.signal);
    return clean ? 'complete' : 'failed';
  }
  if (event.verb === 'review_queue_blocked' || event.verb === 'spend_cap_hit') return 'blocked';
  if (event.verb === 'status_change') {
    switch (event.payload.status) {
      case 'idle':
      case 'launching':
      case 'running':
      case 'paused':
      case 'awaiting_input':
      case 'awaiting_orchestrator':
      case 'awaiting_human':
      case 'recovering':
      case 'reviewing':
      case 'merging':
      case 'failed':
      case 'completed':
      case 'archived':
        return laneState(event.payload.status);
      default:
        return null;
    }
  }
  if (event.verb !== 'agent_report') return null;
  switch (event.payload.event) {
    case 'blocked':
    case 'question':
      return 'blocked';
    case 'review':
    case 'review_ready':
      return 'review-ready';
    case 'complete':
    case 'completed':
      return 'complete';
    case 'progress':
      return 'working';
    default:
      return null;
  }
}

function laneEventSource(event: LaneEvent): string {
  if (event.verb === 'status_change' && typeof event.payload.eventLabel === 'string') {
    return `lane-event:${oneLine(event.payload.eventLabel)}`;
  }
  if (event.verb === 'agent_report' && typeof event.payload.event === 'string') {
    return `lane-event:${oneLine(event.payload.event)}`;
  }
  return `lane-event:${event.verb}`;
}

function newestAgentQuestion(events: LaneEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.verb !== 'agent_report' || event.payload.event !== 'question') continue;
    const message = event.payload.message;
    if (typeof message === 'string' && oneLine(message)) return oneLine(message);
  }
  return null;
}

function blockedLaneSummary(
  lane: Lane | null,
  laneEvents: LaneEvent[],
  approvals: ApprovalRecord[],
): string | null {
  if (!lane) return null;
  if (lane.status === 'awaiting_orchestrator' && lane.lastEventLabel) {
    return `Lane ${lane.label} is blocked: ${oneLine(lane.lastEventLabel)}.`;
  }
  if (lane.status === 'awaiting_human') {
    const approval = approvals
      .filter((candidate) => candidate.status === 'pending')
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (approval) return `Approval pending: ${oneLine(approval.title)}.`;
  }
  if (lane.status === 'awaiting_input') {
    const question = newestAgentQuestion(laneEvents);
    if (question) return `Agent question: ${question}`;
  }
  return null;
}

function selectNewest(candidates: StatusCandidate[]): StatusCandidate | null {
  return [...candidates].sort((left, right) => {
    const timeDelta = right.observedAt.localeCompare(left.observedAt);
    if (timeDelta !== 0) return timeDelta;
    const sourceDelta = right.sourceRank - left.sourceRank;
    if (sourceDelta !== 0) return sourceDelta;
    return STATE_PRIORITY[right.state] - STATE_PRIORITY[left.state];
  })[0] ?? null;
}

function candidateEvidence(candidates: StatusCandidate[]): TerminalStatusEvidenceItem[] {
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const key = `${candidate.source}\u0000${candidate.value}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ source: candidate.source, value: candidate.value }];
  });
}

function fallbackReason(
  selectedAuthority: StatusCandidate['authority'],
  runtimeWasStale: boolean,
  hasRuntimeInput: boolean,
  hasLaneCandidate: boolean,
): string | undefined {
  if (selectedAuthority === 'runtime-event') return undefined;
  if (selectedAuthority === 'lane-state') {
    return runtimeWasStale
      ? 'Runtime event evidence was stale, so lane state is the next available authority.'
      : 'No runtime event evidence was available, so lane state is the next available authority.';
  }
  if (runtimeWasStale && !hasLaneCandidate) {
    return 'Runtime event evidence was stale and no lane state evidence was available.';
  }
  if (hasRuntimeInput) {
    return 'No current runtime event or lane state evidence was available.';
  }
  return 'No runtime event or lane state evidence was available.';
}

export function unknownTerminalStatusEvidence(input: {
  sessionId: string;
  runtime: RuntimeId;
  observedAt?: string | number | Date;
  summary?: string;
  fallbackReason: string;
}): TerminalStatusEvidence {
  return {
    sessionId: input.sessionId,
    runtime: input.runtime,
    state: 'unknown',
    authority: 'raw-terminal',
    observedAt: validIso(input.observedAt) ?? new Date().toISOString(),
    summary: input.summary ?? 'No observation with a valid time was available.',
    evidence: [],
    fallbackReason: input.fallbackReason,
  };
}

/** Resolve one semantic session state through the shared authority ladder. */
export function resolveTerminalStatusEvidence(
  input: ResolveTerminalStatusEvidenceInput,
): TerminalStatusEvidence {
  const runtimeSession = input.runtimeSession ?? null;
  const ownedRun = input.ownedRun ?? null;
  const lane = input.lane ?? null;
  const rawLifecycle = input.rawLifecycle ?? null;
  const sessionId = runtimeSession?.sessionKey ?? lane?.sessionKey ?? lane?.id ?? rawLifecycle?.sessionId;
  const runtime = runtimeSession?.runtimeId ?? lane?.runtime ?? rawLifecycle?.runtime;
  if (!sessionId || !runtime) {
    throw new Error('Terminal status evidence requires an existing session id and registered runtime.');
  }

  const runtimeCandidates: StatusCandidate[] = [];
  const staleRuntimeCandidates: StatusCandidate[] = [];
  if (runtimeSession) {
    const observedAt = validIso(runtimeSession.observedAt);
    if (observedAt) {
      const state = runtimeState(runtimeSession.status);
      const candidate: StatusCandidate = {
        authority: 'runtime-event',
        state,
        observedAt,
        summary: `${runtime} runtime reports this session as ${state}.`,
        source: 'runtime-session.status',
        value: runtimeSession.status,
        sourceRank: 1,
      };
      (runtimeSession.stale ? staleRuntimeCandidates : runtimeCandidates).push(candidate);
      if (runtimeSession.lifecycle) {
        const lifecycleValue = [
          runtimeSession.lifecycle.availability,
          runtimeSession.lifecycle.lastOutcome,
        ].filter(Boolean).join(' · ');
        if (lifecycleValue) {
          const lifecycleCandidate: StatusCandidate = {
            ...candidate,
            state: runtimeLifecycleState(runtimeSession.lifecycle, state),
            observedAt: newestIso(
              runtimeSession.lifecycle.lastRunFinishedAt,
              runtimeSession.lifecycle.lastRunStartedAt,
              observedAt,
            ) ?? observedAt,
            source: 'runtime-session.lifecycle',
            value: lifecycleValue,
            sourceRank: 2,
          };
          (runtimeSession.stale ? staleRuntimeCandidates : runtimeCandidates).push(lifecycleCandidate);
        }
      }
    }
  }
  if (ownedRun) {
    const observedAt = newestIso(ownedRun.finishedAt, ownedRun.startedAt);
    if (observedAt) {
      const state = ownedRunState(ownedRun.outcome);
      const candidate: StatusCandidate = {
        authority: 'runtime-event',
        state,
        observedAt,
        summary: `Owned ${runtime} run ${ownedRun.id} is ${state}.`,
        source: `owned-run:${ownedRun.id}`,
        value: ownedRun.outcome,
        sourceRank: 3,
      };
      (ownedRun.stale ? staleRuntimeCandidates : runtimeCandidates).push(candidate);
    }
  }

  const laneCandidates: StatusCandidate[] = [];
  if (lane) {
    const observedAt = newestIso(lane.lastEventAt ?? undefined, lane.updatedAt);
    if (observedAt) {
      const state = laneState(lane.status);
      laneCandidates.push({
        authority: 'lane-state',
        state,
        observedAt,
        summary: `Lane ${lane.label} is ${state}.`,
        source: `lane:${lane.id}.status`,
        value: lane.status,
        sourceRank: 1,
      });
    }
  }
  for (const event of input.laneEvents ?? []) {
    const state = laneEventState(event);
    const observedAt = validIso(event.timestamp);
    if (!state || !observedAt) continue;
    laneCandidates.push({
      authority: 'lane-state',
      state,
      observedAt,
      summary: `Lane event ${event.verb} reports ${state}.`,
      source: laneEventSource(event),
      value: oneLine(JSON.stringify(event.payload)),
      sourceRank: 2,
    });
  }
  // Historical questions and review reports stay in the evidence list, but
  // only the latest lane observation can describe its current lifecycle.
  // Pending approval/review rows below remain independently unresolved.
  const latestLaneState = selectNewest(laneCandidates);
  const currentGovernanceCandidates = latestLaneState
    && (latestLaneState.state === 'blocked' || latestLaneState.state === 'review-ready')
    ? [latestLaneState]
    : [];
  for (const approval of input.approvals ?? []) {
    if (approval.status !== 'pending') continue;
    const observedAt = validIso(approval.updatedAt);
    if (!observedAt) continue;
    const candidate: StatusCandidate = {
      authority: 'lane-state',
      state: 'blocked',
      observedAt,
      summary: `Approval pending: ${oneLine(approval.title)}.`,
      source: `approval:${approval.id}`,
      value: `pending · ${oneLine(approval.summary || approval.title)}`,
      sourceRank: 3,
    };
    laneCandidates.push(candidate);
    currentGovernanceCandidates.push(candidate);
  }
  for (const review of input.reviewQueue ?? []) {
    const observedAt = validIso(review.updatedAt);
    if (!observedAt) continue;
    const state = review.status === 'pending' || review.status === 'in_progress'
      ? 'review-ready'
      : null;
    if (!state) continue;
    const candidate: StatusCandidate = {
      authority: 'lane-state',
      state,
      observedAt,
      summary: `Lane review ${review.id} is ${review.status === 'pending' ? 'queued' : 'in progress'}.`,
      source: `review_queue:${review.id}`,
      value: review.status,
      sourceRank: 3,
    };
    laneCandidates.push(candidate);
    currentGovernanceCandidates.push(candidate);
  }

  const rawCandidates: StatusCandidate[] = [];
  if (rawLifecycle) {
    const observedAt = validIso(rawLifecycle.observedAt);
    if (observedAt) {
      const state = rawState(rawLifecycle.state);
      rawCandidates.push({
        authority: 'raw-terminal',
        state,
        observedAt,
        summary: `Raw terminal lifecycle reports this session as ${state}.`,
        source: 'raw-terminal.lifecycle',
        value: rawLifecycle.exitCode === undefined
          ? rawLifecycle.state
          : `${rawLifecycle.state} · exit ${rawLifecycle.exitCode}`,
        sourceRank: 1,
      });
    }
  }

  const selectedRuntime = selectNewest(runtimeCandidates);
  const selectedGovernanceLane = selectNewest(currentGovernanceCandidates);
  const governanceLaneOutranksFinishedRuntime = selectedRuntime?.state === 'complete'
    && Boolean(selectedGovernanceLane);
  const selected = governanceLaneOutranksFinishedRuntime
    ? selectedGovernanceLane
    : selectedRuntime ?? selectNewest(laneCandidates) ?? selectNewest(rawCandidates);
  if (!selected) {
    return unknownTerminalStatusEvidence({
      sessionId,
      runtime,
      fallbackReason: 'Runtime event, lane state, and raw terminal evidence were absent or had invalid observation times.',
    });
  }

  const allCandidates = [
    ...runtimeCandidates,
    ...staleRuntimeCandidates,
    ...laneCandidates,
    ...rawCandidates,
  ];
  return {
    sessionId,
    runtime,
    state: selected.state,
    authority: selected.authority,
    observedAt: selected.observedAt,
    summary: oneLine(
      selected.authority === 'lane-state' && selected.state === 'blocked'
        ? blockedLaneSummary(lane, input.laneEvents ?? [], input.approvals ?? []) ?? selected.summary
        : selected.summary,
    ),
    evidence: candidateEvidence(allCandidates),
    fallbackReason: governanceLaneOutranksFinishedRuntime
      ? undefined
      : fallbackReason(
          selected.authority,
          staleRuntimeCandidates.length > 0,
          Boolean(runtimeSession || ownedRun),
          laneCandidates.length > 0,
        ),
  };
}

export function agentStatusFromTerminalState(
  state: TerminalStatusState,
  fallback: AgentStatus = 'idle',
): AgentStatus {
  switch (state) {
    case 'working': return 'running';
    case 'blocked': return 'blocked';
    case 'failed': return 'failed';
    case 'complete': return 'completed';
    case 'review-ready': return 'reviewing';
    case 'idle': return 'idle';
    case 'unknown': return fallback;
  }
}

export function runtimeSessionStatusFromTerminalState(
  state: TerminalStatusState,
  fallback: RuntimeSessionStatus = 'idle',
): RuntimeSessionStatus {
  switch (state) {
    case 'working': return 'running';
    case 'blocked': return 'waiting';
    case 'failed': return 'failed';
    case 'complete': return 'completed';
    case 'review-ready': return 'reviewing';
    case 'idle': return 'idle';
    case 'unknown': return fallback;
  }
}

export function compareTerminalStatusEvidence(
  left: TerminalStatusEvidence,
  right: TerminalStatusEvidence,
): number {
  const stateDelta = STATE_PRIORITY[right.state] - STATE_PRIORITY[left.state];
  if (stateDelta !== 0) return stateDelta;
  return right.observedAt.localeCompare(left.observedAt);
}
