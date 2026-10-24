'use client';

import { useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { CheckCircle2 } from '../../../lucide-shims';
import { trackThreadDrag } from '@/lib/workspace-terminal/thread-drag';
import { formatElapsed, REPO_FOCUS_FONT } from '../../utils';
import { CHAT_ROW_RADIUS, COMPACT_CHAT_ROW_HEIGHT, HISTORY_ROW_TONES, SIDEBAR_REPO_MAX_WIDTH, SIDEBAR_TITLE_MAX_WIDTH } from './constants';
import {
  formatElapsedAgo,
  historySection,
  isAutomationSession,
  packetRepoLabel,
  packetTimestamp,
} from './helpers';
import { AgentStatusDot, type AgentDotState } from '@/components/desktop/AgentStatusDot';
import { ScheduledTaskMark } from '@/components/desktop/ScheduledTaskMark';
import type { ArchivedLaneRow, ChatHistoryItem, HistoryRowTone } from './types';
import { repoSuffix } from './sections';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { IdeWorkspaceSession } from '../../types';

export function ArchivedLaneCompactRow({
  lane,
  onSelectSession,
}: {
  lane: ArchivedLaneRow;
  onSelectSession?: (sessionKey: string, hint?: { title?: string }) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const disabled = !lane.sessionKey || !onSelectSession;
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      onClick={() => {
        if (disabled || !lane.sessionKey) return;
        onSelectSession?.(lane.sessionKey, { title: lane.label });
      }}
      onKeyDown={(event) => {
        if (disabled || !lane.sessionKey) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelectSession?.(lane.sessionKey, { title: lane.label });
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-disabled={disabled}
      style={{
        width: '100%',
        minHeight: COMPACT_CHAT_ROW_HEIGHT,
        borderRadius: CHAT_ROW_RADIUS,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: hovered && !disabled ? 'var(--t-hover)' : 'transparent',
        color: 'var(--t-text)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        textAlign: 'left',
        outline: 'none',
        fontFamily: REPO_FOCUS_FONT,
        paddingTop: 5,
        paddingRight: 13,
        paddingBottom: 5,
        paddingLeft: 12,
        transition: 'background 180ms ease',
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'clip',
          whiteSpace: 'nowrap',
          fontSize: 13.5,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          lineHeight: 1.25,
          color: 'var(--t-text-muted)',
        }}
      >
        {lane.label}
      </span>
      {/* Match active chat rows — timestamp + 5px static ring in a
          flex container so the ring sits at the same column as the
          ring on active chats above. No runtime brand logo; the
          Archived header tells the operator everything here is dormant. */}
      <span
        style={{
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          color: 'var(--t-text-faint)',
          fontSize: 9.5,
          fontWeight: 260,
          letterSpacing: '-0.4px',
        }}
      >
        <span>{formatElapsedAgo(lane.updatedAt)}</span>
        <span className="o8-static-ring" aria-hidden style={{ width: 5, height: 5 }} />
      </span>
    </div>
  );
}

export function MergedPacketRow({ packet, compact }: { packet: OrchestratorPacket; compact: boolean }) {
  const releasedAt = packetTimestamp(packet);
  const meta = releasedAt
    ? `${packetRepoLabel(packet)} · Merged · ${formatElapsedAgo(releasedAt)}`
    : `${packetRepoLabel(packet)} · Merged`;
  return (
    <div
      title={packet.title}
      style={{
        width: '100%',
        minHeight: compact ? COMPACT_CHAT_ROW_HEIGHT : 42,
        borderRadius: compact ? CHAT_ROW_RADIUS : undefined,
        display: 'flex',
        alignItems: 'center',
        gap: compact ? 6 : 8,
        background: 'transparent',
        color: 'var(--t-text)',
        textAlign: 'left',
        fontFamily: REPO_FOCUS_FONT,
        paddingTop: compact ? 2 : 5,
        paddingRight: 12,
        paddingBottom: compact ? 2 : 5,
        // Compact merged rows share the history title column.
        paddingLeft: compact ? 12 : 37,
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 13.5,
            lineHeight: 1.25,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            overflow: 'hidden',
            textOverflow: 'clip',
            whiteSpace: 'nowrap',
          }}
        >
          {packet.title}
        </span>
        {!compact ? (
          <span
            style={{
              display: 'block',
              marginTop: 4,
              color: 'var(--t-text-faint)',
              fontSize: 9.5,
              lineHeight: 1.25,
              fontWeight: 260,
              letterSpacing: '-0.4px',
              overflow: 'hidden',
              textOverflow: 'clip',
              whiteSpace: 'nowrap',
            }}
          >
            {meta.replace(/ · Merged.*$/, '')}
          </span>
        ) : null}
      </span>
      <span
        aria-hidden
        style={{
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          color: '#16a34a',
          fontSize: 9.5,
          fontWeight: 260,
          letterSpacing: '-0.4px',
        }}
      >
        {releasedAt ? <span>{formatElapsedAgo(releasedAt)}</span> : null}
        <CheckCircle2 size={compact ? 13 : 14} strokeWidth={2.1} />
      </span>
    </div>
  );
}

export function HistoryChatRow({
  item,
  active,
  disabled,
  compact,
  tone,
  onOpen,
  onOpenMenu,
  ownedCount = 0,
  repoLabel,
  recede = false,
  preview,
  scheduled = false,
  roomy = false,
  onHoverChange,
}: {
  item: ChatHistoryItem;
  active: boolean;
  disabled: boolean;
  compact: boolean;
  tone?: HistoryRowTone | null;
  onOpen: () => void;
  onOpenMenu?: (event: MouseEvent<HTMLDivElement>) => void;
  /** Static count only; worker rows live in the flat Agents section. */
  ownedCount?: number;
  repoLabel?: string | null;
  recede?: boolean;
  preview?: string;
  scheduled?: boolean;
  roomy?: boolean;
  /** Fleet-reveal hook: rect on enter, null on leave. Wired only for threads
   *  that own live packets — see ChatsTab. */
  onHoverChange?: (rect: DOMRect | null) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [keyboardFocused, setKeyboardFocused] = useState(false);
  // Drag-to-split (Claude Code parity): a pointerdown that travels past the
  // threshold becomes a workspace drag; the trailing click is suppressed so
  // a real drag never ALSO opens the thread in place.
  const dragActivatedRef = useRef(false);
  const dragDisposeRef = useRef<(() => void) | null>(null);
  // If the row unmounts mid-drag (list refresh under the pointer), cancel the
  // tracker explicitly instead of waiting for the next global pointerup.
  useEffect(() => () => {
    dragDisposeRef.current?.();
    dragDisposeRef.current = null;
  }, []);
  const handleDragPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    dragActivatedRef.current = false;
    dragDisposeRef.current?.();
    dragDisposeRef.current = trackThreadDrag(
      { clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId },
      {
        threadId: item.tabId,
        title: item.title,
        mode: historySection(item) === 'orchestrator' ? 'orchestrator' : 'chat',
        repoPath: item.repoPath ?? null,
      },
      { source: event.currentTarget, onActivate: () => { dragActivatedRef.current = true; } },
    );
  };
  const rowTone = active
    ? HISTORY_ROW_TONES.active
    : (tone ?? (historySection(item) === 'orchestrator' ? HISTORY_ROW_TONES.activity : HISTORY_ROW_TONES.neutral));
  const statusTone = tone ?? rowTone;
  const dotState: AgentDotState =
    statusTone.key === 'running' ? 'running'
      : statusTone.key === 'review' ? 'review'
        : statusTone.key === 'merged' ? 'merged'
          : statusTone.key === 'failed' ? 'failed'
            : 'idle';
  const statusLabel = statusTone.label ?? 'Idle';
  const inlineRepo = dotState === 'running' ? null : repoLabel;

  return (
    <div
      role="button"
      title={onHoverChange && (hovered || keyboardFocused) ? undefined : [item.title, repoSuffix(item), item.repoBranch, item.repoPath, statusLabel].filter(Boolean).join(' · ')}
      aria-label={`${item.title} · ${statusLabel}`}
      onFocus={(event) => {
        setKeyboardFocused(event.currentTarget.matches(':focus-visible'));
        onHoverChange?.(event.currentTarget.getBoundingClientRect());
      }}
      onBlur={() => { setKeyboardFocused(false); onHoverChange?.(null); }}
      tabIndex={disabled ? -1 : 0}
      onClick={() => {
        if (dragActivatedRef.current) {
          dragActivatedRef.current = false;
          return;
        }
        if (!disabled) onOpen();
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onOpen();
      }}
      onPointerDown={handleDragPointerDown}
      onMouseEnter={(event) => {
        setHovered(true);
        onHoverChange?.(event.currentTarget.getBoundingClientRect());
      }}
      onMouseLeave={() => {
        setHovered(false);
        onHoverChange?.(null);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu?.(event);
      }}
      aria-disabled={disabled}
      style={{
        width: '100%',
        minHeight: roomy ? (preview ? 'var(--o8-navigation-preview-height, 78px)' : 'var(--o8-navigation-row-height, 52px)') : preview ? 64 : compact ? COMPACT_CHAT_ROW_HEIGHT : 42,
        borderRadius: compact ? CHAT_ROW_RADIUS : undefined,
        display: 'flex',
        alignItems: preview ? 'flex-start' : 'center',
        gap: 8,
        // Selection + hover both paint on the rounded inset layer below —
        // the row itself stays transparent so the fill never hits the rail's
        // edges sharp (Q ruling 2026-07-16: rounded selector, no shimmer).
        background: 'transparent',
        color: 'var(--t-text)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.72 : 1,
        textAlign: 'left',
        outline: keyboardFocused ? '2px solid var(--t-accent)' : 'none',
        outlineOffset: -3,
        fontFamily: REPO_FOCUS_FONT,
        paddingTop: roomy ? 'var(--o8-navigation-row-padding, 8px)' : 3,
        paddingRight: 12,
        paddingBottom: roomy ? 'var(--o8-navigation-row-padding, 8px)' : 3,
        paddingLeft: 12,
        position: 'relative',
        transition: 'background 180ms ease, opacity 180ms ease',
      }}
    >
      {/* Rounded selection/hover layer (Q ruling 2026-07-16): the selected
          chat gets a soft rounded fill — var(--t-input-bg), the same active
          vocabulary as the workspace tab pill — readable in light AND dark,
          glass AND solid, replacing the 07-14 title-shimmer experiment
          (invisible in light mode). Hover shares the geometry with the
          lighter var(--t-hover) fill so sibling states stay cohesive. Inset
          so the fill never touches the rail edges; text X stays exactly 37
          (the hurttlocker indent is untouched — this layer is behind it). */}
      {(active || hovered) ? (
        <span
          aria-hidden
          style={{
              position: 'absolute',
              top: 2,
              right: 4,
              bottom: 2,
              left: 4,
              borderRadius: compact ? CHAT_ROW_RADIUS : 9,
              background: active ? 'var(--t-input-bg)' : 'var(--t-hover)',
              zIndex: 0,
          }}
        />
      ) : null}
      <span style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, height: 17 }}>
          <span style={{ minWidth: 0, maxWidth: SIDEBAR_TITLE_MAX_WIDTH, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontSize: 13.5, lineHeight: 1.25, fontWeight: 300, letterSpacing: '-0.1px',
            color: recede && !active && !hovered ? 'var(--t-text-muted)' : 'var(--t-text)' }}>
            {item.title}
          </span>
          {inlineRepo ? <span style={{ flexShrink: 1, minWidth: 0, maxWidth: SIDEBAR_REPO_MAX_WIDTH, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontSize: 11.5, fontWeight: 260, color: 'var(--t-text-faint)' }}>{inlineRepo}</span> : null}
        </span>
        {preview ? <span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', marginTop: roomy ? 'var(--o8-navigation-preview-gap, 6px)' : 4, fontSize: 11.5, lineHeight: roomy ? 1.45 : 1.4, color: 'var(--t-text-muted)' }}>{preview}</span> : null}

      </span>
      {/* Trailing meta — Antigravity-style: timestamp + status indicator
          live on the right edge so the title can breathe at the left. */}
      <span
        style={{
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          height: 17,
          color: 'var(--t-text-faint)',
          fontSize: 9.5,
          fontWeight: 260,
          letterSpacing: '-0.4px',
          // Above the rounded selection layer (positioned siblings stack in
          // DOM order; unpositioned content would paint beneath it).
          position: 'relative',
        }}
      >
        {scheduled ? <ScheduledTaskMark /> : null}
        {compact && ownedCount > 0 ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              color: 'var(--t-text-faint)',
            }}
          >
            <span>{ownedCount} {ownedCount === 1 ? 'agent' : 'agents'}</span>
          </span>
        ) : null}
        <span>{formatElapsedAgo(item.modifiedAt)}</span>
        <AgentStatusDot state={dotState} label={statusLabel} />
      </span>
    </div>
  );
}

export function CompactSessionRow({
  session,
  onSelectSession,
}: {
  session: IdeWorkspaceSession;
  onSelectSession?: (sessionKey: string) => void;
}) {
  const automation = isAutomationSession(session);
  const metaLabel = automation
    ? `${session.branch || 'workspace'} · automation · ${session.status}`
    : `${session.branch || 'workspace'} · ${formatElapsed(session.lastActivityAt ?? session.lastEventAt)} idle`;
  // Motion vocabulary: running → pulse (B), anything else → ring (A) since
  // the row only renders for live sessions in the first place ("alive").
  const isRunning = (session.status ?? '').toLowerCase() === 'running';
  return (
    <button
      type="button"
      title={[session.name, session.workspace, session.branch, session.status].filter(Boolean).join(' · ')}
      onClick={() => onSelectSession?.(session.sessionKey)}
      style={{
        width: '100%',
        minHeight: 36,
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        borderWidth: 0,
        background: 'transparent',
        color: 'var(--t-text)',
        cursor: 'pointer',
        textAlign: 'left',
        outline: 'none',
        fontFamily: REPO_FOCUS_FONT,
        paddingTop: 4,
        paddingRight: 12,
        paddingBottom: 4,
        paddingLeft: 12,
        position: 'relative',
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13.5, lineHeight: 1.25, fontWeight: 300, letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'clip', whiteSpace: 'nowrap' }}>
          {session.name || session.runtime || 'Agent'}
        </span>
        <span style={{ display: 'block', marginTop: 4, color: 'var(--t-text-faint)', fontSize: 9.5, lineHeight: 1.25, fontWeight: 260, letterSpacing: '-0.4px', overflow: 'hidden', textOverflow: 'clip', whiteSpace: 'nowrap' }}>
          {metaLabel}
        </span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 9.5, color: 'var(--t-text-faint)' }}>{formatElapsed(session.lastActivityAt ?? session.lastEventAt)}</span>
        <AgentStatusDot state={isRunning ? 'running' : 'idle'} />
      </span>
    </button>
  );
}
