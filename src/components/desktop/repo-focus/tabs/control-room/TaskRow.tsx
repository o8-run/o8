'use client';

import { useState, type CSSProperties } from 'react';
import { ExternalLink, MoreHorizontal } from '../../../lucide-shims';
import { REPO_FOCUS_FONT } from '../../utils';
import type { TaskPoolTask } from './types';
import { FLAT_HOVER_SURFACE, GROUP_LABELS, GROUP_TONES } from './constants';
import {
  baseName,
  intentLabel,
  isStaleTask,
  runtimeLabel,
  shimmerTextStyle,
  taskSessionKey,
  taskSignal,
  taskTimeLabel,
} from './helpers';
import { RuntimeIcon, TaskIconButton } from './shared';

export function TaskRow({
  task,
  active,
  onSelectSession,
  onOpenMenu,
  compactActions = false,
}: {
  task: TaskPoolTask;
  active: boolean;
  onSelectSession?: (sessionKey: string) => void;
  onOpenMenu?: (task: TaskPoolTask, x: number, y: number) => void;
  compactActions?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const tone = GROUP_TONES[task.group] ?? GROUP_TONES.ready;
  const sessionKey = taskSessionKey(task);
  const selectedRuntime = task.workerRouting?.selectedRuntime ?? task.runtime;
  const taskIntent = task.workerRouting?.workerIntent ?? task.workerIntent;
  const requestedProvider = task.workerRouting?.requestedProvider;
  const repoLabel = (task.repoName ?? baseName(task.repoPath)) || 'repo';
  const remote = task.execution;
  const remoteState = remote?.leaseState === 'expired' ? 'lease expired'
    : remote?.leaseState === 'active' ? `worker ${remote.workerId ?? 'unknown'}`
      : remote?.status ?? null;
  const detail = remote
    ? [taskSignal(task), `Remote attempt ${remote.attempt} · ${remoteState}`, remote.previewAccess === 'requestable' ? 'Preview on request · editor unavailable' : 'Editor and preview unavailable'].filter(Boolean).join(' · ')
    : taskSignal(task) || task.summary;
  const stale = isStaleTask(task);
  const metaParts = [
    repoLabel,
    `${intentLabel(taskIntent)} - ${runtimeLabel(selectedRuntime)}`,
    task.runtimeSubstitution,
    taskTimeLabel(task),
  ].filter(Boolean);
  const showActions = compactActions || hovered || active;

  return (
    <div
      role="button"
      tabIndex={sessionKey ? 0 : -1}
      aria-disabled={!sessionKey}
      onClick={() => {
        if (sessionKey) onSelectSession?.(sessionKey);
      }}
      onKeyDown={(event) => {
        if (!sessionKey) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelectSession?.(sessionKey);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu?.(task, event.clientX, event.clientY);
      }}
      style={{
        width: '100%',
        minHeight: compactActions ? 43 : 49,
        borderWidth: 0,
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
        background: active ? 'color-mix(in srgb, var(--t-accent) 6%, transparent)' : hovered ? FLAT_HOVER_SURFACE : 'transparent',
        color: 'var(--t-text)',
        cursor: sessionKey ? 'pointer' : 'default',
        display: 'flex',
        alignItems: 'center',
        gap: compactActions ? 7 : 8,
        paddingTop: compactActions ? 5 : 6,
        paddingRight: 0,
        paddingBottom: compactActions ? 5 : 6,
        paddingLeft: 0,
        textAlign: 'left',
        outline: 'none',
        fontFamily: REPO_FOCUS_FONT,
        transition: 'background 140ms ease',
      } as CSSProperties}
    >
      <span
        aria-hidden
        style={{
          width: 20,
          height: 20,
          flexShrink: 0,
          borderRadius: 6,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: tone.text,
          background: active ? tone.soft : 'transparent',
        }}
      >
        <RuntimeIcon runtime={selectedRuntime} size={14} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          className={active ? 'o8-text-shimmer' : undefined}
          style={{
            display: 'block',
            fontSize: compactActions ? 11.5 : 12,
            lineHeight: compactActions ? '15px' : '16px',
            fontWeight: active ? 600 : 520,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            ...(active ? shimmerTextStyle('var(--t-text)') : {}),
          }}
        >
          {task.title}
        </span>
        <span
          style={{
            display: 'block',
            marginTop: 1,
            color: 'var(--t-text-faint)',
            fontSize: compactActions ? 9.75 : 10.25,
            lineHeight: compactActions ? '12px' : '13px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {metaParts.join(' - ')}
          {requestedProvider && requestedProvider !== 'codex' ? ` - requested ${requestedProvider}` : ''}
        </span>
        {detail ? (
          <span
            title={detail}
            style={{
              display: 'block',
            marginTop: 2,
            color: task.group === 'blocked' ? '#dc2626' : 'var(--t-text-muted)',
            fontSize: compactActions ? 9.75 : 10.25,
            lineHeight: compactActions ? '12px' : '13px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
          {detail}
          </span>
        ) : null}
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: compactActions ? 2 : 4, flexShrink: 0 }}>
        <span
          style={{
            minHeight: compactActions ? 18 : 20,
            display: 'inline-flex',
            alignItems: 'center',
            borderRadius: 7,
            borderWidth: task.group === 'ready' && !stale ? 0 : 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider-subtle)',
            background: stale ? 'color-mix(in srgb, var(--t-text-faint) 8%, transparent)' : task.group === 'ready' ? 'transparent' : tone.soft,
            color: stale ? 'var(--t-text-faint)' : tone.text,
            paddingTop: 0,
            paddingRight: task.group === 'ready' && !stale ? 0 : compactActions ? 5 : 6,
            paddingBottom: 0,
            paddingLeft: task.group === 'ready' && !stale ? 0 : compactActions ? 5 : 6,
            fontSize: compactActions ? 9.25 : 9.75,
            lineHeight: '12px',
            fontWeight: 580,
            flexShrink: 0,
          }}
        >
          {stale ? 'Stale' : GROUP_LABELS[task.group]}
        </span>
        {sessionKey ? (
          <TaskIconButton
            label={`Open ${task.title}`}
            visible={showActions}
            active={active}
            onClick={(event) => {
              event.stopPropagation();
              onSelectSession?.(sessionKey);
            }}
          >
            <ExternalLink size={12} strokeWidth={2} />
          </TaskIconButton>
        ) : null}
        <TaskIconButton
          label={`Actions for ${task.title}`}
          visible={showActions}
          active={active}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            onOpenMenu?.(task, rect.right - 8, rect.bottom + 5);
          }}
        >
          <MoreHorizontal size={13} strokeWidth={2.1} />
        </TaskIconButton>
      </span>
    </div>
  );
}
