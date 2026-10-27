'use client';

import { Fragment, isValidElement, memo, useState, type ReactNode } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { ChatActionCard } from '../thoughts/chat-panel/ChatActionCard';
import { buildTurnSummaryStats, type TurnSummary } from '../thoughts/chat-panel/TurnSummaryCard';
import { TurnChevron } from '../thoughts/chat-panel/turn-line';
import { transcriptTurns, transcriptTurnFiles } from './turns';

export const TranscriptTurns = memo(function TranscriptTurns({ entries, nodes, busy, repoPath, summary, turnContent }: {
  entries: MobileTranscriptEntry[];
  nodes: ReactNode[];
  busy: boolean;
  repoPath?: string | null;
  summary?: TurnSummary | null;
  turnContent?: ReadonlyMap<string, ReactNode>;
}) {
  const starts = entries.flatMap((entry, index) => index === 0 || (entry.role === 'user' && !entry.voice) ? [index] : []);
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? entries.length;
    const turnEntries = entries.slice(start, end);
    return <TranscriptTurn key={entries[start].id} entries={turnEntries} nodes={nodes.slice(start, end)}
      busy={busy && end === entries.length} repoPath={repoPath} deferLayout={entries.length > 200}
      summary={summary && turnEntries.some(entry => entry.id === summary.assistantMessageId) ? summary : null}
      content={turnContent?.get(entries[start].id)} />;
  });
});

interface TranscriptTurnProps {
  deferLayout: boolean;
  entries: MobileTranscriptEntry[];
  nodes: ReactNode[];
  busy: boolean;
  repoPath?: string | null;
  summary?: TurnSummary | null;
  content?: ReactNode;
}

function sameArray<T>(left: T[], right: T[]) {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

// Callers may create fresh elements for unchanged entries. Compare their direct
// props just as memo would; callbacks and nested content must still match.
function sameNode(left: ReactNode, right: ReactNode) {
  if (Object.is(left, right)) return true;
  if (!isValidElement<Record<string, unknown>>(left) || !isValidElement<Record<string, unknown>>(right)
    || left.type !== right.type || left.key !== right.key) return false;
  const keys = Object.keys(left.props);
  return keys.length === Object.keys(right.props).length && keys.every(key => {
    const a = left.props[key]; const b = right.props[key];
    return Object.hasOwn(right.props, key) && (Object.is(a, b) || (Array.isArray(a) && Array.isArray(b) && sameArray(a, b)));
  });
}

const TranscriptTurn = memo(function TranscriptTurn({ entries, nodes, busy, repoPath, summary, content, deferLayout }: TranscriptTurnProps) {
  const turn = transcriptTurns(entries, busy)[0];
  const finalEntry = turn.final === null ? null : entries[turn.final];
  const receipt = finalEntry?.id === summary?.assistantMessageId ? summary : null;
  const history = new Set(turn.history);
  const files = finalEntry ? transcriptTurnFiles(entries.slice(turn.start, turn.end)) : [];
  const body = <Fragment>
    {nodes.slice(turn.start, turn.end).map((node, offset) => {
      const index = turn.start + offset;
      if (history.has(index)) return index === turn.history[0]
        ? <WorkHistory key="history" label={receipt ? `Worked for ${elapsedLabel(receipt.elapsedMs)}` : 'Work details'}>
            {turn.history.map(i => <Fragment key={entries[i].id}>{nodes[i]}</Fragment>)}
            {receipt ? <div style={{ fontSize: 11, color: 'var(--t-text-muted)', overflowWrap: 'anywhere' }}>{buildTurnSummaryStats(receipt).map(stat => stat.value).join(' · ')}</div> : null}
          </WorkHistory>
        : null;
      return <Fragment key={entries[index].id}>
        {node}
        {index === turn.final && files.length > 0 ? <ChatActionCard
          filesEditedCount={files.length} repoPath={repoPath ?? null} filePaths={files.map(file => file.path)}
          files={files} allowUndo={false}
        /> : null}
      </Fragment>;
    })}
    {content}
  </Fragment>;
  // Retain the real DOM for native selection, copy, find and keyboard focus.
  // The browser can skip layout/paint for distant turns and remember measured
  // heights without a second message cache or a scroll-driven React remount.
  return <div data-o8-turn-id={entries[0].id} style={{
    minWidth: 0, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 18,
    contentVisibility: deferLayout ? 'auto' : undefined, containIntrinsicSize: deferLayout ? 'auto 240px' : undefined,
  }}>{body}</div>;
}, (previous, next) => previous.deferLayout === next.deferLayout && previous.busy === next.busy && previous.repoPath === next.repoPath
  && previous.summary === next.summary && previous.content === next.content
  && sameArray(previous.entries, next.entries) && previous.nodes.length === next.nodes.length
  && previous.nodes.every((node, index) => sameNode(node, next.nodes[index])));

function elapsedLabel(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function WorkHistory({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} style={{ minWidth: 0 }}>
    <summary style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', listStyle: 'none',
      color: 'var(--t-text-muted)', fontSize: 12, paddingBottom: 10, borderBottom: '1px solid var(--t-divider-subtle)' }}>
      {label}<TurnChevron open={open} />
    </summary>
    {open ? <div style={{ display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 16, paddingBottom: 8 }}>{children}</div> : null}
  </details>;
}
