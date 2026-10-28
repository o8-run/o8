'use client';

import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { isCompactionTerminal } from '@/lib/orchestrator/compaction-status';
import { useCompactionStatus } from './useLiveCompaction';

const labels = { waiting: 'Waiting to compact', compacting: 'Compacting', complete: 'Context compacted',
  failed: 'Compaction failed', cancelled: 'Compaction cancelled', uncertain: 'Compaction unconfirmed' };
function elapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
export function CompactionStatus({ repoPath, threadId, messages, turnBusy }: {
  repoPath: string; threadId: string; messages: readonly MobileTranscriptEntry[]; turnBusy: boolean;
}) {
  const { operation, now, reconcile } = useCompactionStatus(repoPath, threadId, messages.at(-1)?.id, turnBusy);
  const start = operation?.startedAt ?? operation?.requestedAt ?? now;
  const duration = operation ? (operation.settledAt ?? now) - start : 0;
  const active = operation?.phase === 'waiting' || operation?.phase === 'compacting';
  const progress = operation?.progress;
  const measured = Boolean(progress && Number.isFinite(progress.completed) && Number.isFinite(progress.total)
    && progress.total > 0 && progress.completed >= 0 && progress.completed <= progress.total);
  const detail = operation?.phase === 'uncertain' ? 'The last operation could not be confirmed. Check its status; your queued messages remain visible.'
    : operation?.phase === 'waiting' ? 'Elapsed since compaction was requested; compaction has not started.'
      : 'Elapsed compaction time, separate from the assistant turn. No completion estimate is available.';
  return <div data-compaction-slot="" style={{ position: 'absolute', top: 0, left: 12, right: 12, height: 22, minWidth: 0 }}>
    {operation ? <div data-compaction-status="" data-compaction-phase={operation.phase} data-compaction-operation={operation.operationId}
      title={detail} style={{ display: 'flex', alignItems: 'center', height: 22, gap: 7, minWidth: 0, color: 'var(--t-text-secondary)',
        fontSize: 11.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.35 }}>
      {active ? measured ? <progress aria-label="Compaction work" value={progress!.completed} max={progress!.total}
        style={{ width: 30, height: 3, flexShrink: 0, accentColor: 'var(--t-text-secondary)' }} />
        : <span role="progressbar" aria-label="Compaction work; total unknown" style={{ flexShrink: 0, letterSpacing: 1 }}>···</span> : null}
      <span role="status" aria-live="polite" style={{ minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{labels[operation.phase]}</span>
      <span style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{elapsed(duration)}{operation.phase === 'uncertain' ? operation.startedAt === undefined ? ' since request' : ' since start' : ''}</span>
      {measured && active ? <span style={{ flexShrink: 0 }}>{progress!.completed}/{progress!.total}</span> : null}
      {!isCompactionTerminal(operation.phase) && (operation.phase === 'uncertain' || duration >= 30_000) ? <button type="button"
        onClick={() => { void reconcile(); }} style={{ marginLeft: 'auto', border: 0, padding: 0, background: 'transparent',
          color: 'var(--t-text)', font: 'inherit', whiteSpace: 'nowrap', flexShrink: 0, cursor: 'pointer' }}>Check status</button> : null}
    </div> : null}
  </div>;
}
