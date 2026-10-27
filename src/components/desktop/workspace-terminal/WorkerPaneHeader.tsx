'use client';

import type { CSSProperties, ReactNode } from 'react';
import { AgentStatusDot, agentStatusToDotState } from '@/components/desktop/AgentStatusDot';

export const WORKER_CONTROL_SIZE: CSSProperties = {
  width: 24, height: 24, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
};
export const WORKER_ICON_BUTTON: CSSProperties = {
  ...WORKER_CONTROL_SIZE, flexShrink: 0, border: 0, borderRadius: 8,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer',
};
const ellipsis: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

export function WorkerPaneHeader({ title, branch, issueNumber, runtime, model, status, statusLabel, compact, actions, outcome = false }: {
  title: string; branch?: string | null; issueNumber?: number; runtime: string; model?: string | null;
  status: string; statusLabel: string; compact: boolean; actions?: ReactNode; outcome?: boolean;
}) {
  return <div data-worker-pane-header style={{
    height: 28, minHeight: 28, display: 'grid', alignItems: 'center', gap: 6,
    // Prefer the natural identity width, then give metadata the remaining space.
    // A small metadata floor keeps its full-label tooltip reachable in narrow panes.
    gridTemplateColumns: issueNumber
      ? 'auto auto minmax(0, max-content) minmax(24px, 1fr) auto'
      : 'auto minmax(0, max-content) minmax(24px, 1fr) auto',
    paddingLeft: 8, paddingRight: 4, flexShrink: 0,
    borderBottom: '1px solid var(--t-divider-subtle, var(--t-border))',
    fontFamily: 'var(--font-sans-system)', fontWeight: 300, letterSpacing: '-0.1px',
  }}>
    <span title={statusLabel} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0, fontSize: 11, color: 'var(--t-text-muted)' }}>
      <AgentStatusDot state={agentStatusToDotState(status)} label={statusLabel} />
      {outcome ? null : statusLabel}
    </span>
    {issueNumber ? <span style={{ color: 'var(--t-text-faint)', fontSize: 12, flexShrink: 0 }}>#{issueNumber}</span> : null}
    <span data-worker-title title={branch || title} style={{ ...ellipsis, color: 'var(--t-text)', fontSize: 13 }}>{title}</span>
    <span title={[runtime, model].filter(Boolean).join(' · ')} style={{
      ...ellipsis, display: 'flex', gap: 4, justifyContent: 'flex-end', visibility: outcome ? 'hidden' : undefined,
      color: 'var(--t-text-faint)', fontSize: compact ? 10 : 12,
    }}>
      <span style={{ ...ellipsis, flexShrink: 0 }}>{runtime}</span>
      {model ? <span data-worker-model title={[runtime, model].join(' · ')} style={ellipsis}>· {model}</span> : null}
    </span>
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>{actions}</div>
  </div>;
}
