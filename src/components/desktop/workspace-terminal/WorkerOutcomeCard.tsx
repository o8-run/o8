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

/** Only worker-authored completion text supplies the outcome and destinations. */
export function WorkerOutcomeCard({ state, summary, expanded, transcriptId, onToggle, onOpenReview }: {
  state: string; summary: string; expanded: boolean; transcriptId: string;
  onToggle: () => void; onOpenReview?: () => void;
}) {
  const line = summary.split('\n').map(value => value.trim()).find(value => value
    && !/^#{1,6}\s|^\[.*\]\(https?:|^(?:\*\*)?(?:outcome|summary):?(?:\*\*)?$/i.test(value));
  const outcome = line?.replace(/^[-*]\s+|^(?:\*\*)?(?:outcome|summary):\s*(?:\*\*)?/i, '').replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1').replace(/[*`]/g, '');
  const writtenReceipts = [...summary.matchAll(/\[(?:receipt|evidence)\]\((https?:\/\/[^\s)]+)\)/gi)].map(match => match[1]);
  const links = [...new Set([...(summary.match(/https?:\/\/[^\s<>\])]+/g) ?? [])
    .filter(url => /\/pull\/\d+|\/(?:receipts?|artifacts?|reports?|evidence)(?:\/|[-_?#])/i.test(url)), ...writtenReceipts])];
  return <section data-worker-outcome-card style={{ paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, color: 'var(--t-text)', flexShrink: 0 }}>
    <div style={{ fontSize: 12, fontWeight: 300 }}>{state}</div>
    {outcome ? <div data-worker-outcome title={summary} style={{ marginTop: 4, fontSize: 13.5, fontWeight: 300, lineHeight: 1.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{outcome}</div> : null}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
      {links.map(url => <a key={url} href={url} target="_blank" rel="noopener noreferrer" style={actionStyle}>{/\/pull\/\d+/.test(url) ? 'PR' : 'Receipt'}</a>)}
      {state === 'Needs review' && onOpenReview ? <button type="button" data-worker-open-review onClick={onOpenReview} style={actionStyle}>Review merge</button> : null}
      <button type="button" aria-expanded={expanded} aria-controls={expanded ? transcriptId : undefined} onClick={onToggle} style={actionStyle}>{expanded ? 'Hide transcript' : 'Show transcript'}</button>
    </div>
  </section>;
}
