'use client';

import type { CSSProperties } from 'react';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

export function workerOutcomeState(packet: OrchestratorPacket | null | undefined): string | null {
  if (!packet) return null;
  if (packet.status === 'awaiting_review'
    || (packet.status === 'blocked' && packet.blockedReason === 'Awaiting operator input')) return 'Needs review';
  if (packet.status === 'released') return 'Complete';
  if (packet.status === 'archived') return 'Archived';
  if (packet.status === 'failed') return 'Failed';
  if (packet.operatorStopped) return 'Stopped';
  return null;
}

const actionStyle: CSSProperties = {
  minHeight: 26, paddingTop: 0, paddingRight: 9, paddingBottom: 0, paddingLeft: 9,
  border: 0, borderRadius: 7, background: 'var(--t-input-bg)', color: 'var(--t-text)',
  fontFamily: 'inherit', fontSize: 12, fontWeight: 300, cursor: 'pointer', textDecoration: 'none',
  display: 'inline-flex', alignItems: 'center',
};

function OutcomeIcon({ action }: { action: 'pr' | 'receipt' | 'review' | 'transcript' }) {
  const paths = {
    pr: 'M14 3h7v7M21 3 10 14M10 3H3v18h18v-7',
    receipt: 'M6 3h9l3 3v15H6zM9 10h6M9 14h6',
    review: 'M6 3v18M18 3v6a6 6 0 0 1-6 6H6',
    transcript: 'M4 6h16M4 12h16M4 18h10',
  };
  return <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[action]} /></svg>;
}

/** Only worker-authored completion text supplies the outcome and destinations. */
export function WorkerOutcomeCard({ state, summary, expanded, transcriptId, onToggle, onOpenReview, compact = false }: {
  state: string; summary: string; expanded: boolean; transcriptId: string;
  onToggle: () => void; onOpenReview?: () => void; compact?: boolean;
}) {
  const line = summary.split('\n').map(value => value.trim()).find(value => value
    && !/^#{1,6}\s|^\[.*\]\(https?:|^(?:\*\*)?(?:outcome|summary):?(?:\*\*)?$/i.test(value));
  const outcome = line?.replace(/^[-*]\s+|^(?:\*\*)?(?:outcome|summary):\s*(?:\*\*)?/i, '').replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1').replace(/[*`]/g, '');
  const writtenReceipts = [...summary.matchAll(/\[(?:receipt|evidence)\]\((https?:\/\/[^\s)]+)\)/gi)].map(match => match[1]);
  const links = [...new Set([...(summary.match(/https?:\/\/[^\s<>\])]+/g) ?? [])
    .filter(url => /\/pull\/\d+|\/(?:receipts?|artifacts?|reports?|evidence)(?:\/|[-_?#])/i.test(url)), ...writtenReceipts])];
  const controlStyle: CSSProperties = compact ? { ...actionStyle, width: 26, paddingRight: 0, paddingLeft: 0, justifyContent: 'center' } : actionStyle;
  const transcriptAction = expanded ? 'Hide transcript' : 'Show transcript';
  return <section data-worker-outcome-card style={{ paddingTop: 8, paddingRight: 8, paddingBottom: 8, paddingLeft: 8, color: 'var(--t-text)', minHeight: 0, flexShrink: 1, overflowY: 'auto', boxSizing: 'border-box' }}>
    <div style={{ fontSize: 12, fontWeight: 300, lineHeight: 1.25 }}>{state}</div>
    {outcome ? <div data-worker-outcome title={summary} style={{ marginTop: 4, fontSize: 13.5, fontWeight: 300, lineHeight: 1.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{outcome}</div> : null}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
      {links.map(url => {
        const pr = /\/pull\/\d+/.test(url);
        const label = pr ? 'Open PR' : 'Open receipt';
        return <a key={url} href={url} target="_blank" rel="noopener noreferrer" aria-label={label} title={compact ? label : undefined} style={controlStyle}>{compact ? <OutcomeIcon action={pr ? 'pr' : 'receipt'} /> : pr ? 'PR' : 'Receipt'}</a>;
      })}
      {state === 'Needs review' && onOpenReview ? <button type="button" data-worker-open-review aria-label="Review merge" title={compact ? 'Review merge' : undefined} onClick={onOpenReview} style={controlStyle}>{compact ? <OutcomeIcon action="review" /> : 'Review merge'}</button> : null}
      <button type="button" aria-label={transcriptAction} title={compact ? transcriptAction : undefined} aria-expanded={expanded} aria-controls={expanded ? transcriptId : undefined} onClick={onToggle} style={controlStyle}>{compact ? <OutcomeIcon action="transcript" /> : transcriptAction}</button>
    </div>
  </section>;
}
