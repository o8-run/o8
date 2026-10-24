'use client';

import { workerPacketForSession } from '@/lib/orchestrator/worker-session-packet';

import {
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { DesktopAgentMessage } from '@/components/desktop/DesktopAgentMessage';
import { useOrchestratorData } from '@/components/desktop/orchestrator-data-context';
import { SessionTranscriptPane } from '@/components/desktop/SessionTranscriptPane';
import type { FleetAgent } from '@/components/desktop/thoughts/types';
import { agentDisplayLabel, runtimeDisplayLabel } from '@/lib/orchestrator/display';
import {
  projectWorkerParticipants,
  type WorkerParticipantRuntimeTruth,
  type WorkerParticipant,
} from '@/lib/orchestrator/participant-projection';
import type { SessionTileLeaf } from '@/lib/orchestrator/session-tiles';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { runtimeFromWorkerSessionKey, workerLaunchOriginLabel } from '@/lib/orchestrator/worker-launch-context';
import { bootstrapTranscripts } from '@/lib/transcripts/bootstrap';
import { useTranscript } from '@/lib/transcripts/useTranscript';

export type LiveSessionAttention = 'error' | 'action' | 'review' | 'live' | 'idle';

export interface LiveSessionMeshParticipant {
  participantId: string;
  sessionKey: string;
  leafId: string;
  arrivalOrder: number;
  name: string;
  repo: string;
  runtime: string;
  model: string | null;
  origin: string;
  task: string;
  attention: LiveSessionAttention;
  repoPath: string | null;
}

interface LiveSessionMeshProps {
  participants: LiveSessionMeshParticipant[];
  focusedSessionKey: string | null;
  onFocusSession: (sessionKey: string) => void;
  onCloseSession: (sessionKey: string) => void;
  renderFocused?: (participant: LiveSessionMeshParticipant) => ReactNode;
}

interface ConnectedLiveSessionMeshProps {
  leaves: SessionTileLeaf[];
  focusedSessionKey: string | null;
  onFocusSession: (sessionKey: string) => void;
  onCloseLeaf: (leafId: string) => void;
}

const ATTENTION_ORDER: Record<LiveSessionAttention, number> = {
  error: 0,
  action: 1,
  review: 2,
  live: 3,
  idle: 4,
};

const ATTENTION_LABEL: Record<LiveSessionAttention, string> = {
  error: 'Error',
  action: 'Needs input',
  review: 'Review',
  live: 'Live',
  idle: 'Idle',
};

const TAIL_HISTORY_LIMIT = 12;

function pathTail(path: string | null | undefined): string {
  const normalized = path?.trim().replace(/\\/g, '/').replace(/\/$/, '') ?? '';
  return normalized.split('/').filter(Boolean).pop() ?? 'Workspace';
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  return values.map((value) => value?.trim()).find(Boolean) ?? null;
}

/** Attention is derived only from explicit fleet/packet/lane state. Transcript
 *  text never affects ordering. */
export function resolveLiveSessionAttention(
  agentStatus: string | null | undefined,
  packetStatus: string | null | undefined,
  blockedReason: string | null | undefined,
): LiveSessionAttention {
  const values = [agentStatus, packetStatus, blockedReason]
    .map((value) => value?.trim().toLowerCase() ?? '')
    .filter(Boolean);
  if (values.some((value) => value.includes('fail') || value.includes('error') || value === 'runtime_process_exit')) {
    return 'error';
  }
  if (values.some((value) => value.includes('blocked') || value.includes('awaiting_') || value.includes('pending') || value.includes('wait'))) {
    return 'action';
  }
  if (values.some((value) => value.includes('review') || value.includes('complete'))) {
    return 'review';
  }
  if (values.some((value) => value.includes('running') || value.includes('active') || value.includes('working') || value.includes('launch'))) {
    return 'live';
  }
  return 'idle';
}

export function orderLiveSessionMeshParticipants(
  participants: LiveSessionMeshParticipant[],
): LiveSessionMeshParticipant[] {
  return participants.slice().sort((left, right) => (
    ATTENTION_ORDER[left.attention] - ATTENTION_ORDER[right.attention]
    || left.arrivalOrder - right.arrivalOrder
    || left.participantId.localeCompare(right.participantId)
  ));
}

function packetForSession(
  packets: OrchestratorPacket[],
  sessionKey: string,
): OrchestratorPacket | null {
  return workerPacketForSession(packets, sessionKey);
}

function agentForSession(agents: FleetAgent[], sessionKey: string): FleetAgent | null {
  return agents.find((agent) => agent.sessionKey === sessionKey) ?? null;
}

function projectedParticipantMatchesLeaf(
  participant: WorkerParticipant,
  leaf: SessionTileLeaf,
): boolean {
  if (leaf.participantId) return participant.id === leaf.participantId;
  if (leaf.packetId && participant.packetId) return participant.packetId === leaf.packetId;
  if (leaf.laneId && participant.laneId) return participant.laneId === leaf.laneId;
  return participant.sessionKey === leaf.sessionKey;
}

export function buildLiveSessionMeshParticipants(
  leaves: SessionTileLeaf[],
  agents: FleetAgent[],
  packets: OrchestratorPacket[],
): LiveSessionMeshParticipant[] {
  const projected = projectLiveSessionMeshParticipants(agents, packets);
  return leaves.flatMap((leaf, treeIndex) => {
    const participant = projected.find((candidate) => projectedParticipantMatchesLeaf(candidate, leaf));
    const sessionKey = participant?.sessionKey ?? leaf.sessionKey;
    if (!sessionKey) return [];
    const agent = agentForSession(agents, sessionKey);
    const packet = packetForSession(packets, sessionKey);
    const runtimeId = leaf.runtime ?? participant?.runtime ?? runtimeFromWorkerSessionKey(sessionKey);
    const repoPath = firstNonEmpty(
      participant?.repoPath,
      packet?.lane?.worktreePath,
      packet?.lane?.repoPath,
      packet?.workspaceTargetPath,
      leaf.repoPath,
      agent?.workspace,
    );
    const projectedTask = participant?.taskSummary === 'Worker'
      ? null
      : participant?.taskSummary;
    return [{
      participantId: participant?.id ?? leaf.participantId ?? sessionKey,
      sessionKey,
      leafId: leaf.id,
      arrivalOrder: leaf.arrivalOrder ?? treeIndex,
      name: agentDisplayLabel({
        name: agent?.name,
        title: packet?.title ?? participant?.taskSummary,
        sessionKey,
        runtime: runtimeId,
      }),
      repo: pathTail(repoPath),
      runtime: runtimeDisplayLabel(runtimeId),
      model: firstNonEmpty(
        participant?.model,
        agent?.model,
        packet?.assignedModel,
        packet?.workerRouting?.selectedModel,
      ),
      origin: participant?.origin ?? workerLaunchOriginLabel(leaf.launchContext) ?? 'Orchestrator',
      task: firstNonEmpty(
        projectedTask,
        agent?.currentTask,
        packet?.title,
        leaf.title,
        agent?.activity?.headline,
      ) ?? 'Worker session',
      attention: resolveLiveSessionAttention(
        participant?.lifecycle.runtimeStatus ?? agent?.status,
        participant?.lifecycle.laneStatus ?? participant?.lifecycle.packetStatus ?? packet?.status,
        packet?.blockedReason ?? participant?.lifecycle.lastEventLabel,
      ),
      repoPath,
    }];
  });
}

export function projectLiveSessionMeshParticipants(
  agents: FleetAgent[],
  packets: OrchestratorPacket[],
): WorkerParticipant[] {
  const runtimeTruth: WorkerParticipantRuntimeTruth[] = agents.flatMap((agent) => (
    agent.sessionKey ? [{
      sessionKey: agent.sessionKey,
      runtime: runtimeFromWorkerSessionKey(agent.sessionKey),
      model: agent.model,
      status: agent.status,
      currentTask: agent.currentTask,
      lastEventAt: agent.lastEventAt,
    }] : []
  ));
  return projectWorkerParticipants({ packets, runtimeTruth });
}

function hasTranscriptContent(entry: ReturnType<typeof useTranscript>['messages'][number]): boolean {
  return Boolean(
    entry.text.trim()
    || entry.compaction?.summary?.trim()
    || (entry.toolCalls?.length ?? 0) > 0
    || (entry.media?.length ?? 0) > 0,
  );
}

function LiveSessionTail({
  participant,
  onFocus,
}: {
  participant: LiveSessionMeshParticipant;
  onFocus: (sessionKey: string) => void;
}) {
  const slice = useTranscript(participant.sessionKey);
  const latestEntry = useMemo(
    () => slice.messages.findLast(hasTranscriptContent) ?? null,
    [slice.messages],
  );
  const runtimeModel = participant.model
    ? `${participant.runtime} · ${participant.model}`
    : participant.runtime;

  return (
    <div
      data-live-session-tail={participant.sessionKey}
      data-attention={participant.attention}
      style={{
        minWidth: 0,
        height: 152,
        minHeight: 108,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 12,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider-subtle, var(--t-border))',
        background: 'var(--t-chat-surface-bg)',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      <button
        type="button"
        aria-label={`Focus ${participant.name} transcript`}
        data-live-session-focus={participant.sessionKey}
        onClick={() => onFocus(participant.sessionKey)}
        onMouseEnter={(event) => {
          event.currentTarget.style.background = 'var(--t-hover)';
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = 'transparent';
        }}
        style={{
          width: '100%',
          minWidth: 0,
          display: 'block',
          paddingTop: 8,
          paddingRight: 10,
          paddingBottom: 7,
          paddingLeft: 10,
          borderTopWidth: 0,
          borderRightWidth: 0,
          borderBottomWidth: 1,
          borderBottomStyle: 'solid',
          borderBottomColor: 'var(--t-divider-subtle, var(--t-border))',
          borderLeftWidth: 0,
          background: 'transparent',
          color: 'inherit',
          fontFamily: 'var(--font-sans-system)',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <div style={{ minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span
            style={{
              minWidth: 0,
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 12,
              fontWeight: 300,
              letterSpacing: '-0.1px',
              color: 'var(--t-text)',
            }}
          >
            {participant.name}
          </span>
          <span
            style={{
              flexShrink: 0,
              fontSize: 9.5,
              fontWeight: 260,
              letterSpacing: '-0.4px',
              color: 'var(--t-text-faint)',
            }}
          >
            {ATTENTION_LABEL[participant.attention]}
          </span>
        </div>
        <div
          title={`${participant.repo} · ${runtimeModel} · ${participant.origin}`}
          style={{
            marginTop: 4,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 9.5,
            fontWeight: 260,
            letterSpacing: '-0.4px',
            color: 'var(--t-text-faint)',
          }}
        >
          {participant.repo} · {runtimeModel} · {participant.origin}
        </div>
        <div
          title={participant.task}
          style={{
            marginTop: 4,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 9.5,
            fontWeight: 260,
            letterSpacing: '-0.4px',
            color: 'var(--t-text-muted)',
          }}
        >
          {participant.task}
        </div>
      </button>
      <div
        data-live-session-transcript={participant.sessionKey}
        style={{
          minWidth: 0,
          minHeight: 0,
          flex: 1,
          overflow: 'hidden',
          paddingTop: 6,
          paddingRight: 8,
          paddingBottom: 8,
          paddingLeft: 8,
          color: 'var(--t-chat-surface-text)',
          fontSize: 11,
        }}
      >
        {latestEntry ? (
          <DesktopAgentMessage
            entry={latestEntry}
            isLast={false}
            isStreaming={false}
            repoPath={participant.repoPath}
          />
        ) : (
          <span style={{ color: 'var(--t-chat-surface-text-muted)', fontSize: 10.5, fontWeight: 300 }}>
            {slice.status === 'error' ? 'Transcript unavailable' : 'Waiting for transcript'}
          </span>
        )}
      </div>
    </div>
  );
}

export function LiveSessionMesh({
  participants,
  focusedSessionKey,
  onFocusSession,
  onCloseSession,
  renderFocused,
}: LiveSessionMeshProps) {
  const ordered = useMemo(
    () => orderLiveSessionMeshParticipants(participants),
    [participants],
  );
  const requestedFocus = focusedSessionKey
    ? ordered.find((participant) => participant.sessionKey === focusedSessionKey) ?? null
    : null;
  const focused = requestedFocus ?? ordered[0] ?? null;
  const tails = useMemo(
    () => ordered.filter((participant) => participant.sessionKey !== focused?.sessionKey),
    [focused?.sessionKey, ordered],
  );
  const tailKeySignature = tails.map((participant) => participant.sessionKey).join('\n');

  useEffect(() => {
    const keys = tailKeySignature ? tailKeySignature.split('\n') : [];
    if (keys.length === 0) return undefined;
    const controller = new AbortController();
    void bootstrapTranscripts(keys, {
      limit: TAIL_HISTORY_LIMIT,
      concurrency: 2,
      signal: controller.signal,
    });
    return () => {
      controller.abort();
    };
  }, [tailKeySignature]);

  if (!focused) return null;

  const focusParticipant = (sessionKey: string) => {
    onFocusSession(sessionKey);
  };

  return (
    <div
      data-live-session-mesh="true"
      data-focused-session={focused.sessionKey}
      style={{
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        display: 'grid',
        gridTemplateColumns: tails.length > 0 ? 'minmax(0, 1fr) clamp(184px, 30%, 280px)' : 'minmax(0, 1fr)',
        gap: tails.length > 0 ? 8 : 0,
        paddingTop: 8,
        paddingRight: 8,
        paddingBottom: 8,
        paddingLeft: 8,
        overflow: 'hidden',
        background: 'var(--t-chat-surface-bg)',
      }}
    >
      <div
        data-live-session-focused={focused.sessionKey}
        style={{ minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden' }}
      >
        {renderFocused ? renderFocused(focused) : (
          <SessionTranscriptPane
            key={focused.participantId}
            sessionKey={focused.sessionKey}
            focused
            onFocus={focusParticipant}
            onClose={onCloseSession}
          />
        )}
      </div>
      {tails.length > 0 ? (
        <div
          aria-label="Other live worker transcripts"
          style={{
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            overflowX: 'hidden',
            overflowY: 'auto',
            overscrollBehaviorY: 'contain',
            paddingTop: 0,
            paddingRight: 2,
            paddingBottom: 0,
            paddingLeft: 0,
          }}
        >
          {ordered.length > 8 ? (
            <div
              data-live-session-remainder={ordered.length - 8}
              style={{ color: 'var(--t-chat-surface-text-muted)', fontSize: 10, fontWeight: 400 }}
            >
              {ordered.length} live workers · scroll for all transcripts
            </div>
          ) : null}
          {tails.map((participant) => (
            <LiveSessionTail
              key={participant.participantId}
              participant={participant}
              onFocus={focusParticipant}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ConnectedLiveSessionMesh({
  leaves,
  focusedSessionKey,
  onFocusSession,
  onCloseLeaf,
}: ConnectedLiveSessionMeshProps) {
  const data = useOrchestratorData();
  const participants = useMemo(
    () => buildLiveSessionMeshParticipants(
      leaves,
      data?.agents ?? [],
      data?.missionState?.packets ?? [],
    ),
    [data?.agents, data?.missionState?.packets, leaves],
  );
  const leafIdBySession = useMemo(
    () => new Map(participants.map((participant) => [participant.sessionKey, participant.leafId])),
    [participants],
  );

  return (
    <LiveSessionMesh
      participants={participants}
      focusedSessionKey={focusedSessionKey}
      onFocusSession={onFocusSession}
      onCloseSession={(sessionKey) => {
        const leafId = leafIdBySession.get(sessionKey);
        if (leafId) onCloseLeaf(leafId);
      }}
    />
  );
}
