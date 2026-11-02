'use client';
import type { InboxLane, InboxScope } from '@/lib/inbox/maintainer-types';
import { PullRequestPicker } from '../pull-requests/controls';

const LANES: Array<{ id: InboxLane; label: string }> = [
  { id: 'replies', label: 'Needs reply' }, { id: 'contributions', label: 'Contributions' }, { id: 'approvals', label: 'Approvals' }, { id: 'agents', label: 'Agent issues' }, { id: 'history', label: 'History' },
];

export function MaintainerInboxHeader({ lane, onLaneChange, scope, onScopeChange, counts, repoLabel, projectAvailable, freshness, onRefresh, refreshing, active }: {
  lane: InboxLane; onLaneChange: (lane: InboxLane) => void; scope: InboxScope; onScopeChange: (scope: InboxScope) => void;
  counts: Record<InboxLane, number>; repoLabel: string | null; projectAvailable: boolean; freshness: string; onRefresh: () => void; refreshing: boolean; active: boolean;
}) {
  return <header style={{ paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, borderBottom: '1px solid var(--t-divider-subtle)', flexShrink: 0 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 15, fontWeight: 300, color: 'var(--t-text)', flex: 1 }}>Inbox</span>
      <PullRequestPicker<InboxScope> label="Inbox scope" disabled={lane === 'approvals'} active={active && lane !== 'approvals'} value={lane === 'approvals' ? 'all' : scope} onChange={onScopeChange} options={[...(repoLabel ? [{ value: 'repo' as const, label: repoLabel }] : []), ...(projectAvailable ? [{ value: 'project' as const, label: 'This project' }] : []), { value: 'all', label: lane === 'approvals' ? 'All workspaces' : 'All repositories' }]} style={{ maxWidth: '65%', height: 26, minHeight: 26, border: 0, borderRadius: 7, fontSize: 11, fontWeight: 300 }} />
      <button type="button" aria-label="Refresh inbox" disabled={refreshing} onClick={onRefresh} style={{ width: 28, height: 28, padding: 0, display: 'grid', placeItems: 'center', border: 0, borderRadius: 7, background: 'transparent', color: 'var(--t-text-muted)', cursor: refreshing ? 'default' : 'pointer', opacity: refreshing ? 0.5 : 1 }}><svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M20 12a8 8 0 0 0-14-5M4 12a8 8 0 0 0 14 5" /></svg></button>
    </div>
    <div style={{ marginTop: 4, color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', lineHeight: 1.4 }}>{freshness}</div>
    <div role="tablist" aria-label="Inbox views" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2, marginTop: 12 }}>
      {LANES.map((entry) => <button key={entry.id} type="button" role="tab" tabIndex={lane === entry.id ? 0 : -1} aria-selected={lane === entry.id} onClick={() => onLaneChange(entry.id)} onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const i = LANES.findIndex((item) => item.id === lane);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? LANES.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + LANES.length) % LANES.length;
        onLaneChange(LANES[next].id); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
      }} style={{ height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', paddingTop: 0, paddingRight: 6, paddingBottom: 0, paddingLeft: 6, lineHeight: 1, border: 0, borderRadius: 7, background: lane === entry.id ? 'var(--t-input-bg)' : 'transparent', color: lane === entry.id ? 'var(--t-text)' : 'var(--t-text-muted)', fontFamily: 'inherit', fontSize: 11, fontWeight: 300, cursor: 'pointer', whiteSpace: 'nowrap' }}>{entry.label}{counts[entry.id] ? <span style={{ marginLeft: 5, color: 'var(--t-text-faint)', fontSize: 9.5 }}>{counts[entry.id]}</span> : null}</button>)}
    </div>
  </header>;
}
