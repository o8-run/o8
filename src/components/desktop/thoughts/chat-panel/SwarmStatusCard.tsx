'use client';

import { useId, useState } from 'react';
import { AgentStatusDot, agentStatusToDotState, type AgentDotState } from '@/components/desktop/AgentStatusDot';
import { packetRuntimeModelDisplayLabel, resolveDisplayRuntime, runtimeModelDisplayLabel } from '@/lib/orchestrator/display';
import { runtimeFromWorkerSessionKey } from '@/lib/orchestrator/worker-launch-context';
import { packetTerminalState } from '@/lib/orchestrator/packet-state';
import { projectWorkerParticipants } from '@/lib/orchestrator/participant-projection';
import type { OrchestratorPacket, OrchestratorPacketStatus } from '@/lib/orchestrator/types';
import { useWorkerDisclosure } from './WorkerDisclosure';
import { ProviderMarkGlyph } from '../composer-selector/provider-marks';
import { providerMarkForRuntime } from '../composer-selector/state';
import type { WorkerRecovery } from '@/lib/agent-control/types';
import { InterruptedWorkerActions } from './InterruptedWorkerActions';
import { SavedWorkerActions } from './SavedWorkerActions';

const FOCUS_LANE_EVENT = 'o8:focus-spawned-agent-lane';
export const SWARM_CREW_SCROLL_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  maxHeight: 'min(360px, 44vh)',
  overflowY: 'auto',
  overflowX: 'hidden',
  overscrollBehavior: 'contain',
  scrollbarWidth: 'none',
} as const;

/** Native child evidence, without implying a separately controllable session. */
export interface SwarmScoutView {
  id: string;
  label: string;
  status: 'running' | 'done' | 'failed' | 'stopped' | 'unknown';
}

/** Exact session membership from a saved Shared-team receipt. */
export interface SwarmSessionView {
  parentTurnId?: string | null;
  returnStatus?: 'pending' | 'running' | 'delivered' | 'held' | null;
  returnReason?: string | null;
  model?: string | null;
  effort?: string | null;
  sessionKey: string;
  name: string;
  runtime: string;
  status: string;
  recovery?: WorkerRecovery | null;
}

function sessionReturnState(session: SwarmSessionView) {
  const label = session.returnStatus === 'pending' ? 'Result queued'
    : session.returnStatus === 'running' ? 'Returning result'
      : session.returnStatus === 'held' ? 'Result needs attention' : null;
  if (!label) return null;
  const reason = session.returnReason?.replace(/\s+/g, ' ').trim();
  const detail = reason ? `${label}: ${reason}` : label;
  return { label, detail };
}

export function swarmSessionStatus(status: string): StatusTone {
  if (status === 'waiting' || status === 'awaiting_input' || status === 'needs-input') return { label: 'Waiting for input', state: 'review' };
  if (status === 'finished' || status === 'completed') return { label: 'Completed', state: 'idle' };
  if (status === 'interrupted') return { label: 'Interrupted', state: 'review' };
  if (status === 'retired') return { label: 'Retired', state: 'idle' };
  if (status === 'idle') return { label: 'Idle', state: 'idle' };
  if (status === 'running') return { label: 'Running', state: 'running' };
  if (status === 'failed') return { label: 'Failed', state: 'failed' };
  return { label: 'Unconfirmed', state: 'idle' };
}

const VISIBLE_STATUSES = new Set<OrchestratorPacketStatus>([
  'queued', 'launching', 'running', 'recovering', 'awaiting_review',
  'blocked', 'failed', 'released', 'archived',
]);

type StatusTone = { label: string; state: AgentDotState };

function packetCardStatus(packet: OrchestratorPacket): OrchestratorPacketStatus {
  const terminal = packetTerminalState(packet);
  if (terminal === 'released') return 'released';
  if (terminal === 'archived') return 'archived';
  if (terminal === 'failed') return packet.status === 'blocked' ? 'blocked' : 'failed';
  return packet.status;
}

export function visibleSwarmPackets(packets: OrchestratorPacket[]): OrchestratorPacket[] {
  return [...new Map(packets.map(packet => [packet.id, packet])).values()].filter(packet => {
    const status = packetCardStatus(packet);
    if (!VISIBLE_STATUSES.has(status)) return false;
    return !((status === 'queued' || status === 'launching') && !packet.lane?.laneId);
  });
}

export function swarmPacketStatus(packet: OrchestratorPacket): StatusTone {
  const status = packetCardStatus(packet);
  if (packet.operatorStopped && status !== 'released' && status !== 'archived') {
    return { label: 'Stopped', state: 'idle' };
  }
  if (status === 'released') {
    return packet.releaseState === 'released' && packet.releaseStatePayload?.mergeCommit?.trim()
      ? { label: 'Merged', state: 'merged' }
      : { label: 'Completed', state: 'idle' };
  }
  const labels: Record<OrchestratorPacketStatus, string> = {
    draft: 'Draft', queued: 'Queued', launching: 'Launching', idle: 'Waiting', running: 'Running',
    awaiting_review: 'Awaiting review', recovering: 'Recovering', failed: 'Failed', blocked: 'Blocked',
    released: 'Completed', archived: 'Archived',
  };
  return { label: labels[status], state: agentStatusToDotState(status) };
}

function scoutTone(status: SwarmScoutView['status']): StatusTone {
  switch (status) {
    case 'running': return { label: 'Running', state: 'running' };
    case 'done': return { label: 'Done', state: 'idle' };
    case 'failed': return { label: 'Failed', state: 'failed' };
    case 'stopped': return { label: 'Stopped', state: 'idle' };
    default: return { label: 'Unconfirmed', state: 'idle' };
  }
}

export interface WorkerCardSelection {
  available: string[];
  selected: string[];
  disabled: boolean;
  onToggle: (sessionKey: string) => void;
}

function CrewRow({ title, sub, status, onClick, detail, selection }: {
  title: string; sub: string; status: StatusTone; onClick?: () => void; detail?: string;
  selection?: { checked: boolean; disabled: boolean; onChange: () => void };
}) {
  const style = {
    width: '100%', display: 'grid', gridTemplateColumns: '14px minmax(0, 1fr) auto',
    alignItems: 'center', gap: 10, minHeight: 44,
    paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 12,
    borderWidth: 0, borderTopWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-divider-subtle)',
    background: 'transparent', textAlign: 'left', cursor: onClick ? 'pointer' : 'default',
    fontFamily: 'var(--font-sans-system)',
  } as const;
  const content = <>
    <AgentStatusDot state={status.state} label={status.label} />
    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <span style={{ color: 'var(--t-text)', fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
      <span style={{ marginTop: 4, color: 'var(--t-text-muted)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', lineHeight: 1.25, overflowWrap: 'anywhere' }}>{sub}</span>
      {detail ? <span style={{ marginTop: 4, color: 'var(--t-text-muted)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', lineHeight: 1.25, overflowWrap: 'anywhere' }}>{detail.length > 180 ? `${detail.slice(0, 177)}…` : detail}</span> : null}
    </span>
    <span style={{ color: 'var(--t-text-muted)', fontSize: 10, fontWeight: 300, lineHeight: 1.25, textAlign: 'right', maxWidth: 82 }}>{status.label}</span>
  </>;
  const row = onClick
    ? <button type="button" onClick={onClick} title={detail ? `Open ${title}\n${detail}` : `Open ${title}`} style={style}
      onMouseEnter={event => { event.currentTarget.style.background = 'var(--t-panel-hover)'; }}
      onMouseLeave={event => { event.currentTarget.style.background = 'transparent'; }}>{content}</button>
    : <div style={style}>{content}</div>;
  return selection ? <div style={{ display: 'grid', gridTemplateColumns: '28px minmax(0, 1fr)', alignItems: 'center' }}>
    <input type="checkbox" aria-label={`Select ${title}`} checked={selection.checked} disabled={selection.disabled}
      onChange={selection.onChange} style={{ marginLeft: 12, accentColor: 'var(--t-accent)', cursor: selection.disabled ? 'default' : 'pointer' }} />
    {row}
  </div> : row;
}

/** Only recorded parent identity associates a worker with this conversation. */
export function packetsForOrchestratorThread(
  packets: OrchestratorPacket[], threadId: string | null | undefined,
): OrchestratorPacket[] {
  const normalized = threadId?.trim();
  if (!normalized) return [];
  return packets.filter(packet => {
    const stamped = packet.orchestratorThreadId?.trim();
    return stamped ? stamped === normalized
      : packet.dispatcher?.surface === 'orchestrator' && packet.dispatcher.id.trim() === normalized;
  });
}

export function focusSwarmPacket(packet: OrchestratorPacket, onFocusPacket?: (packet: OrchestratorPacket) => void) {
  if (onFocusPacket) { onFocusPacket(packet); return; }
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(FOCUS_LANE_EVENT, { detail: {
    packetId: packet.id, laneId: packet.lane?.laneId ?? null,
    sessionKey: packet.lane?.sessionKey ?? packet.lane?.tabId ?? null, title: packet.title,
  } }));
}

/** Shared membership and state for the compact dock and its expanded worker list. */
export function projectSwarmView({ packets, scouts = [], sessions = [] }: {
  packets: OrchestratorPacket[]; scouts?: SwarmScoutView[]; sessions?: SwarmSessionView[];
}) {
  const active = visibleSwarmPackets(packets);
  const byId = new Map(active.map(packet => [packet.id, packet]));
  const participants = projectWorkerParticipants({ packets: active });
  const native = [...new Map(scouts.map(scout => [scout.id, scout])).values()];
  const packetSessions = new Set(participants.map(participant => participant.sessionKey));
  const shared = [...new Map(sessions.map(session => [session.sessionKey, session])).values()].filter(session => !packetSessions.has(session.sessionKey));
  const count = participants.length + native.length + shared.length;
  const statuses = [...participants.map(participant => swarmPacketStatus(byId.get(participant.id)!)), ...native.map(scout => scoutTone(scout.status)), ...shared.map(session => swarmSessionStatus(session.status))];
  const totals = new Map<string, number>();
  for (const { label } of statuses) totals.set(label.toLowerCase(), (totals.get(label.toLowerCase()) ?? 0) + 1);
  for (const session of shared) {
    const label = sessionReturnState(session)?.label;
    if (label) totals.set(label, (totals.get(label) ?? 0) + 1);
  }
  const summary = [...totals].map(([label, total]) => `${total} ${label}`).join(' · ');
  const state: AgentDotState = statuses.some(status => status.state === 'failed') ? 'failed'
    : statuses.some(status => status.state === 'review') || shared.some(session => session.returnStatus === 'held') ? 'review'
      : statuses.some(status => status.state === 'running') ? 'running'
        : count > 0 && statuses.every(status => status.state === 'merged') ? 'merged' : 'idle';
  return { byId, participants, native, shared, count, summary, state };
}

export function SwarmStatusCard({ packets, scouts = [], sessions = [], onFocusSession, onFocusPacket, defaultExpanded = false, selection, coordinated = false, crewMaxHeight }: {
  packets: OrchestratorPacket[]; scouts?: SwarmScoutView[];
  sessions?: SwarmSessionView[];
  onFocusSession?: (sessionKey: string) => void;
  onFocusPacket?: (packet: OrchestratorPacket) => void;
  defaultExpanded?: boolean;
  selection?: WorkerCardSelection;
  coordinated?: boolean;
  crewMaxHeight?: number | string;
}) {
  const [localExpanded, setExpanded] = useState(defaultExpanded);
  const panelId = useId();
  const disclosure = useWorkerDisclosure();
  const expanded = coordinated && disclosure ? disclosure.activeId === panelId : localExpanded;
  const toggle = () => {
    if (coordinated && disclosure) {
      if (expanded) disclosure.deactivate(panelId); else disclosure.activate(panelId);
    } else setExpanded(value => !value);
  };
  const { byId, participants, native, shared, count, summary } = projectSwarmView({ packets, scouts, sessions });
  const runtimes = [...participants.map(participant => resolveDisplayRuntime(byId.get(participant.id)!)), ...native.map(() => 'claude-code' as const), ...shared.map(session => runtimeFromWorkerSessionKey(session.sessionKey))];
  const selectionFor = (key: string | null | undefined) => key && selection?.available.includes(key) ? {
    checked: selection.selected.includes(key), disabled: selection.disabled, onChange: () => selection.onToggle(key),
  } : undefined;
  if (!count) return null;

  return <div role="group" aria-label={`Subagents: ${count}`} style={{
    display: 'flex', flexDirection: 'column', flexShrink: 0, borderRadius: 12, borderWidth: 1,
    borderStyle: 'solid', borderColor: 'var(--t-border)', background: 'var(--t-input-bg)', overflow: 'hidden',
  }}>
    <button type="button" aria-expanded={expanded} aria-controls={panelId}
      onClick={toggle} style={{
        display: 'flex', alignItems: 'center', gap: 12, minHeight: 52, width: '100%',
        paddingTop: 10, paddingRight: 12, paddingBottom: 10, paddingLeft: 12,
        borderWidth: 0, background: 'transparent', color: 'var(--t-text)', textAlign: 'left',
        fontFamily: 'var(--font-sans-system)', cursor: 'pointer',
      }}>
      <span aria-hidden style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
        {runtimes.slice(0, 3).map((runtime, index) => <span key={`${runtime}:${index}`} style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26,
          marginLeft: index ? -7 : 0, borderRadius: 999, border: '1px solid var(--t-border)',
          background: 'var(--t-popover-surface)',
        }}><ProviderMarkGlyph mark={providerMarkForRuntime(runtime)} size={14} /></span>)}
        {count > 3 ? <span style={{ marginLeft: 5, fontSize: 10, fontWeight: 300, color: 'var(--t-text-muted)' }}>+{count - 3}</span> : null}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25 }}>{count} {count === 1 ? 'subagent' : 'subagents'}</span>
        <span style={{ display: 'block', marginTop: 4, fontSize: 10, fontWeight: 300, color: 'var(--t-text-muted)', lineHeight: 1.4 }}>{summary}</span>
      </span>
      <svg aria-hidden width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, transform: expanded ? 'rotate(180deg)' : undefined }}><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {expanded ? <div id={panelId} data-swarm-crew="scrollable" style={{ ...SWARM_CREW_SCROLL_STYLE, ...(crewMaxHeight ? { maxHeight: crewMaxHeight } : {}) }}>
      {participants.map(participant => {
        const packet = byId.get(participant.id)!;
        const detail = packet.blockedReason?.trim() || participant.lifecycle.lastEventLabel;
        return <div key={participant.id}><CrewRow title={packet.title?.trim() || 'Worker'}
          sub={`${packetRuntimeModelDisplayLabel(packet)}${detail ? ` · ${detail}` : ''}`}
          status={swarmPacketStatus(packet)} selection={selectionFor(participant.sessionKey)} onClick={() => focusSwarmPacket(packet, onFocusPacket)} />
          {participant.sessionKey ? <SavedWorkerActions sessionKey={participant.sessionKey} name={packet.title?.trim() || 'Worker'} status={packet.status} /> : null}
        </div>;
      })}
      {native.map(scout => <CrewRow key={`native:${scout.id}`} title={scout.label}
        sub="Claude Code · Native subagent · Managed by this conversation"
        status={scoutTone(scout.status)} />)}
      {shared.map(session => <div key={session.sessionKey}><CrewRow title={session.name}
        sub={`${runtimeModelDisplayLabel(session.runtime || runtimeFromWorkerSessionKey(session.sessionKey), session.model)} · Shared checkout`} status={swarmSessionStatus(session.status)} selection={selectionFor(session.sessionKey)} detail={sessionReturnState(session)?.detail}
        onClick={() => onFocusSession ? onFocusSession(session.sessionKey) : window.dispatchEvent(new CustomEvent(FOCUS_LANE_EVENT, { detail: { sessionKey: session.sessionKey, title: session.name } }))} />
        {session.recovery && (session.recovery.actions.length || session.recovery.retired) ? <div style={{ paddingTop: 4, paddingRight: 12, paddingBottom: 10, paddingLeft: 12 }}>
          <InterruptedWorkerActions key={session.recovery.runId} sessionKey={session.sessionKey} name={session.name} recovery={session.recovery} status={session.status} />
        </div> : null}
      </div>)}
    </div> : null}
  </div>;
}
