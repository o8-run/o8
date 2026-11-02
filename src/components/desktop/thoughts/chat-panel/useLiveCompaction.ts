'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSharedDesktopWs } from '@/components/desktop/hooks/DesktopWebSocketContext';
import type { RealtimeMutationRecord } from '@/lib/realtime/types';

import { COMPACTION_TERMINAL_DISPLAY_MS, COMPACTION_UNVERIFIED_MS, isCompactionOperation,
  isCompactionTerminal, type CompactionOperation } from '@/lib/orchestrator/compaction-status';

interface Observed { operation: CompactionOperation; verifiedAt: number; confirmed: boolean }
interface Saved { scope: string; operations: Map<string, Observed> }

/** Status never comes from transcript wording, a summary's age, or a turn timer. */
export function useCompactionStatus(repoPath: string | null | undefined, threadId: string | null | undefined, historyRevision?: string, turnBusy?: boolean) {
  const scope = JSON.stringify([repoPath, threadId]);
  const [saved, setSaved] = useState<Saved | null>(null);
  if (saved && saved.scope !== scope) setSaved(null);
  const [now, setNow] = useState(() => Date.now());
  const receiptRevision = useRef(0);
  const currentScope = useRef(scope);
  useLayoutEffect(() => { currentScope.current = scope; return () => { currentScope.current = ''; }; }, [scope]);
  const accept = useCallback((snapshot: CompactionOperation, confirmed = false, startReceipt = false, verifiedAt = Date.now()) => {
    if (currentScope.current !== scope || snapshot.repoPath !== repoPath || snapshot.threadId !== threadId) return;
    receiptRevision.current += 1;
    setSaved(previous => {
      const operations = new Map(previous?.scope === scope ? previous.operations : []);
      const observed = operations.get(snapshot.operationId);
      const known = observed?.operation;
      if (!confirmed && known && JSON.stringify(known) === JSON.stringify(snapshot)) return previous;
      // A live start can itself have been delayed across reload. Until this
      // operation has readback, it is evidence of a start, not current liveness.
      const operation = startReceipt && (!observed?.confirmed || known?.phase === 'uncertain')
        ? { ...snapshot, phase: 'uncertain' as const } : snapshot;
      if (known && (known.updatedAt > operation.updatedAt || (isCompactionTerminal(known.phase) && !isCompactionTerminal(operation.phase)))) return previous;
      if (known?.startedAt !== undefined && operation.phase === 'waiting') return previous;
      if (!confirmed && known && JSON.stringify(known) === JSON.stringify(operation)) return previous;
      // A bounded tombstone map plus a request watermark prevents arbitrarily
      // late starts from resurrecting old work after the map has been pruned.
      const latestRequest = Math.max(0, ...[...operations.values()].map(item => item.operation.requestedAt));
      if (!known && operation.requestedAt < latestRequest) return previous;
      operations.set(operation.operationId, { operation, verifiedAt, confirmed: confirmed || observed?.confirmed === true });
      return { scope, operations: new Map([...operations].slice(-64)) };
    });
  }, [repoPath, scope, threadId]);

  const reconcile = useCallback(async () => {
    if (!repoPath || !threadId) return;
    const revision = receiptRevision.current;
    const verifiedAt = Date.now();
    try {
      const response = await fetch(`/api/orchestrator/compact?${new URLSearchParams({ repoPath, threadId })}`, { cache: 'no-store', signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return;
      const data: { operation?: unknown } = await response.json();
      if (currentScope.current !== scope) return;
      if (isCompactionOperation(data.operation)) accept(data.operation, true, false, verifiedAt);
      else if (data.operation === null && revision === receiptRevision.current) {
        setSaved(previous => {
          if (previous?.scope !== scope) return previous;
          const operations = new Map([...previous.operations].map(([id, item]) => [id, isCompactionTerminal(item.operation.phase) ? item
            : { ...item, operation: { ...item.operation, phase: 'uncertain' as const } }]));
          return { scope, operations };
        });
      }
    } catch { /* Keep the last receipt; elapsed verification age makes uncertainty explicit. */ }
  }, [accept, repoPath, scope, threadId]);

  const socket = useSharedDesktopWs(undefined, { onRealtimeEvent: event => {
    if (event.channel === 'history') {
      if ((event.data as { sessionKey?: string }).sessionKey === threadId) void reconcile();
      return;
    }
    if (event.channel !== 'mutation' || !repoPath || !threadId) return;
    const mutation = (event.data as { mutation?: RealtimeMutationRecord }).mutation;
    if (mutation?.action !== 'orchestrator-compaction' || mutation.source !== 'server'
      || mutation.repoPath !== repoPath || mutation.surfaceId !== threadId) return;
    if ((mutation.status === 'pending' || mutation.status === 'queued') && (event.delivery === 'replay' || event.delivery === 'bootstrap')) { void reconcile(); return; }
    if (isCompactionOperation(mutation.compaction) && mutation.compaction.operationId === mutation.mutationId) {
      const startReceipt = !isCompactionTerminal(mutation.compaction.phase);
      accept(mutation.compaction, false, startReceipt);
      if (startReceipt) void reconcile();
      return;
    }
    // Compatibility with a bridge still sending the earlier receipt shape.
    setSaved(previous => {
      const observed = previous?.scope === scope ? previous.operations.get(mutation.mutationId) : undefined;
      const known = observed?.operation;
      const createdAt = Date.parse(mutation.createdAt);
      if (!Number.isFinite(createdAt)) return previous;
      const operation: CompactionOperation = { operationId: mutation.mutationId, repoPath, threadId,
        phase: mutation.status === 'queued' ? 'waiting' : mutation.status === 'pending' ? 'compacting' : mutation.status === 'completed' ? 'complete' : 'failed',
        requestedAt: known?.requestedAt ?? createdAt, startedAt: known?.startedAt ?? createdAt,
        updatedAt: Date.parse(mutation.settledAt ?? mutation.createdAt),
        ...(mutation.settledAt ? { settledAt: Date.parse(mutation.settledAt) } : {}) };
      const operations = new Map(previous?.scope === scope ? previous.operations : []);
      if (known && isCompactionTerminal(known.phase) && !isCompactionTerminal(operation.phase)) return previous;
      if (known?.phase === operation.phase && known.updatedAt === operation.updatedAt) return previous;
      const watermark = Math.max(0, ...[...operations.values()].map(item => item.operation.requestedAt));
      if (!known && operation.requestedAt < watermark) return previous;
      if (known?.startedAt !== undefined && operation.phase === 'waiting') return previous;
      if (!isCompactionTerminal(operation.phase) && !observed?.confirmed) operation.phase = 'uncertain';
      operations.set(operation.operationId, { operation, verifiedAt: Date.now(), confirmed: observed?.confirmed === true });
      return { scope, operations: new Map([...operations].slice(-64)) };
    });
    if (mutation.status === 'pending' || mutation.status === 'queued') void reconcile();
  } });
  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => { if (mounted) void reconcile(); });
    return () => { mounted = false; };
  }, [reconcile, socket?.connectionState, historyRevision, turnBusy]);
  const observed = saved?.scope === scope ? [...saved.operations.values()]
    .sort((a, b) => b.operation.requestedAt - a.operation.requestedAt || b.operation.operationId.localeCompare(a.operation.operationId))[0] : undefined;
  const operation = observed?.operation;
  const terminal = operation && isCompactionTerminal(operation.phase);
  const ticking = Boolean(operation && (!terminal || now - (operation.settledAt ?? operation.updatedAt) < COMPACTION_TERMINAL_DISPLAY_MS));
  useEffect(() => {
    if (!ticking) return;
    const interval = setInterval(() => { setNow(Date.now()); if (!terminal) void reconcile(); }, 1000);
    return () => clearInterval(interval);
  }, [reconcile, terminal, ticking]);
  const phase = operation && !terminal && observed && now - observed.verifiedAt >= COMPACTION_UNVERIFIED_MS ? 'uncertain' : operation?.phase;
  const visible = Boolean(operation && (!terminal || now - (operation.settledAt ?? operation.updatedAt) < COMPACTION_TERMINAL_DISPLAY_MS));
  return { operation: visible && operation ? { ...operation, phase: phase! } : null, now, reconcile };
}

/** Kept for callers interested only in verified live activity. */
export function useLiveCompaction(repoPath: string | null | undefined, threadId: string | null | undefined): boolean {
  const { operation } = useCompactionStatus(repoPath, threadId);
  return operation?.phase === 'waiting' || operation?.phase === 'compacting';
}
