'use client';

import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import { useSharedDesktopWs } from '@/components/desktop/hooks/DesktopWebSocketContext';
import type { RealtimeMutationRecord } from '@/lib/realtime/types';
import type { CorrectableWorker, WorkerCorrectionMode, WorkerCorrectionPayload, WorkerCorrectionReceipt } from '@/lib/orchestrator/worker-correction-types';
import { SwarmStatusCard, visibleSwarmPackets, projectSwarmView, type SwarmSessionView } from './SwarmStatusCard';
import { WorkerCorrectionDock } from './WorkerCorrectionDock';
import { RamsButton } from '../../settings/RamsButton';

const labels: Record<WorkerCorrectionReceipt['deliveries'][number]['status'], string> = {
  pending: 'Pending', sending: 'Delivery unconfirmed', delivered: 'Accepted by runtime', stopped: 'Stopped',
  unavailable: 'Unavailable', unknown: 'Outcome unknown', held: 'Held',
};

export type WorkerCorrectionContext = Pick<ComponentProps<typeof SwarmStatusCard>, 'packets' | 'sessions' | 'scouts' | 'onFocusPacket' | 'onFocusSession'>;

/** Uses the ordinary composer's draft; corrections never create another message editor. */
export function WorkerCorrections({ repoPath, threadId, draft, hasAttachments, onDelivered, working, active = true, workerContext }: {
  repoPath: string; threadId: string; draft: string; hasAttachments: boolean; onDelivered: (draft: string) => void; working: boolean;
  active?: boolean; workerContext?: WorkerCorrectionContext;
}) {
  const [activityOpen, setActivityOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [workers, setWorkers] = useState<CorrectableWorker[]>([]);
  const [corrections, setCorrections] = useState<WorkerCorrectionReceipt[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [holdMerges, setHoldMerges] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = `${repoPath}\n${threadId}`;
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const requestRef = useRef<{ fingerprint: string; id: string; payload: WorkerCorrectionPayload } | null>(null);
  const latestDraft = useRef(draft); latestDraft.current = draft;
  const [pendingRequest, setPendingRequest] = useState(false);
  const storageKey = `o8-worker-correction:${scope}`;
  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/orchestrator/worker-corrections?${new URLSearchParams({ repoPath, threadId })}`, { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to read worker controls.');
      if (!Array.isArray(body.workers) || !Array.isArray(body.corrections)) throw new Error('Worker controls returned an invalid response. Refresh to try again.');
      if (scopeRef.current !== scope) return;
      setWorkers(body.workers); setCorrections(body.corrections); setError(null);
      setSelected(current => current.filter(id => body.workers.some((worker: CorrectableWorker) => worker.surfaceId === id)));
    } catch (cause) { if (scopeRef.current === scope) setError(cause instanceof Error ? cause.message : 'Unable to read worker controls.'); }
  }, [repoPath, threadId, scope]);
  useSharedDesktopWs(undefined, { onRealtimeEvent: event => {
    const mutation = event.channel === 'mutation' ? (event.data as { mutation?: RealtimeMutationRecord }).mutation : undefined;
    if ((mutation?.action === 'worker-correction' && mutation.surfaceId === threadId) || mutation?.action === 'worker-return') void refresh();
  } });
  useEffect(() => {
    setWorkers([]); setCorrections([]); setSelected([]); setActivityOpen(false); setRulesOpen(false); setHoldMerges(false); setBusy(false); setError(null); requestRef.current = null;
    try { requestRef.current = JSON.parse(localStorage.getItem(storageKey) ?? 'null'); } catch { /* No saved delivery. */ }
    setPendingRequest(Boolean(requestRef.current));
  }, [scope, storageKey]);
  useEffect(() => { void refresh(); }, [refresh, working]);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => { void refresh(); }, 3000);
    return () => clearInterval(timer);
  }, [busy, refresh]);
  useEffect(() => {
    if (!busy) { setShowProgress(false); return; }
    const timer = setTimeout(() => setShowProgress(true), 150);
    return () => clearTimeout(timer);
  }, [busy]);
  const targets = workers.filter(worker => selected.includes(worker.surfaceId));
  const send = async (mode: WorkerCorrectionMode) => {
    if (busy) return;
    const message = mode === 'stop' ? draft.trim() || 'Stop the selected workers.' : draft.trim();
    const payload: WorkerCorrectionPayload = { message, mode, holdMerges, targets: targets.map(({ surfaceId, runId }) => ({ surfaceId, runId })) };
    const fingerprint = JSON.stringify({ scope, payload });
    if (!requestRef.current) requestRef.current = { fingerprint, payload, id: `correction-${crypto.randomUUID()}` };
    try { localStorage.setItem(storageKey, JSON.stringify(requestRef.current)); } catch {
      setError('Unable to save this correction identity. Delivery has not started.'); return;
    }
    setPendingRequest(true);
    setBusy(true); setError(null);
    try {
      const response = await fetch('/api/orchestrator/worker-corrections', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPath, threadId, id: requestRef.current.id, payload: requestRef.current.payload }) });
      const body = await response.json();
      if (!response.ok) {
        if (body.notAdmitted === true && scopeRef.current === scope) { requestRef.current = null; localStorage.removeItem(storageKey); setPendingRequest(false); }
        throw new Error(body.error || 'Unable to correct workers.');
      }
      if (scopeRef.current !== scope) return;
      const sentDraft = requestRef.current.payload.message;
      const result = body.receipt as WorkerCorrectionReceipt;
      if (result.ruleId) window.dispatchEvent(new CustomEvent('o8:session-rules-changed'));
      if (!result.deliveries.some(delivery => ['pending', 'sending'].includes(delivery.status))) {
        requestRef.current = null; localStorage.removeItem(storageKey); setPendingRequest(false);
      }
      if (latestDraft.current.trim() === sentDraft && result.deliveries.every(delivery => ['delivered', 'stopped'].includes(delivery.status))) onDelivered(latestDraft.current);
      await refresh();
    } catch (cause) { if (scopeRef.current === scope) setError(cause instanceof Error ? cause.message : 'Correction outcome unknown. Inspect workers before retrying.'); }
    finally { if (scopeRef.current === scope) setBusy(false); }
  };
  const unavailableDraft = !draft.trim() || draft.trim().length > 2000 || hasAttachments;
  // Keep durable names after Stop removes a worker from the correctable list.
  const sessions: SwarmSessionView[] = [...(workerContext?.sessions ?? [])];
  for (const worker of workers) {
    const saved = sessions.findIndex(item => item.sessionKey === worker.surfaceId);
    const current = { sessionKey: worker.surfaceId, name: worker.taskName, runtime: worker.runtime, status: worker.running ? 'running' : 'idle' };
    if (saved < 0) sessions.push(current);
    else sessions[saved] = { ...sessions[saved], ...current };
  }
  const packets = visibleSwarmPackets(workerContext?.packets ?? []);
  const crew = projectSwarmView({ packets, sessions, scouts: workerContext?.scouts });
  if (!crew.count && !corrections.length && !pendingRequest && !error) return null;
  const names = new Map(sessions.map(session => [session.sessionKey, session.name]));
  const action = busy ? 'Sending correction' : pendingRequest ? 'Check delivery' : error ? 'Controls need attention' : selected.length ? `${selected.length} selected` : null;
  const summary = [`${crew.count} ${crew.count === 1 ? 'worker' : 'workers'}`, crew.summary, action].filter(Boolean).join(' · ');
  return <WorkerCorrectionDock key={`${scope}:${active}`} active={active} label={corrections.length ? 'Worker corrections' : 'Correct workers'} summary={summary}
    count={crew.count} state={error ? 'failed' : pendingRequest ? 'review' : busy ? 'running' : crew.state} onOpen={() => void refresh()}>
    <SwarmStatusCard {...workerContext} packets={packets} sessions={sessions} defaultExpanded crewMaxHeight="min(240px, 30vh)"
      selection={{ available: workers.map(worker => worker.surfaceId), selected, disabled: busy || pendingRequest,
        onToggle: id => setSelected(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]) }} />
    {workers.length ? <span>{targets.length ? `Your composer message will go to ${targets.length === 1 ? targets[0].taskName : `${targets.length} selected workers`}.` : 'Select workers, then write your correction in the composer.'}</span>
      : <span>{sessions.some(session => session.recovery?.actions.length)
        ? 'Resume saved work, or retire the worker and keep its branch and edits.'
        : 'No workers currently support corrections. Open a worker card to view its conversation.'}</span>}
    {pendingRequest ? <span>A saved correction needs a delivery receipt. Checking reuses that request and never resends an admitted correction.</span> : null}
    {hasAttachments ? <span>Worker corrections accept text. Send attachments through the worker’s regular composer.</span> : null}
    {draft.trim().length > 2000 ? <span>Keep the correction within 2,000 characters.</span> : null}
    {workers.length || pendingRequest || holdMerges ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <RamsButton busy={busy} disabled={!pendingRequest && (unavailableDraft || (!targets.length && !holdMerges))} onClick={() => void send(targets.some(worker => worker.running) ? 'pause-and-send' : 'send')}>
        {pendingRequest ? 'Check pending correction' : targets.some(worker => worker.running) ? 'Pause and correct selected' : targets.length ? 'Send correction' : 'Save merge restriction'}
      </RamsButton>
      {targets.length ? <RamsButton variant="ghost" disabled={busy || pendingRequest} onClick={() => void send('stop')}>Stop selected</RamsButton> : null}
    </div> : null}
    {showProgress ? <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <progress aria-label="Delivering correction" style={{ width: 64, height: 4 }} />
      {corrections.find(item => item.id === requestRef.current?.id)?.deliveries.filter(item => !['pending', 'sending'].includes(item.status)).length ?? 0} of {requestRef.current?.payload.targets.length ?? 0} worker receipts received
    </div> : null}
    {error ? <span role="alert" style={{ color: 'var(--t-error)' }}>{error}</span> : null}
    <div style={{ display: 'flex', gap: 8, borderTop: '1px solid var(--t-divider-subtle)', paddingTop: 10 }}>
      <RamsButton variant="ghost" aria-expanded={activityOpen} onClick={() => setActivityOpen(value => !value)}>View activity{corrections.length ? ` · ${corrections.length}` : ''}</RamsButton>
      <RamsButton variant="ghost" aria-expanded={rulesOpen} onClick={() => setRulesOpen(value => !value)}>Chat rules</RamsButton>
    </div>
    {rulesOpen ? <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}><input type="checkbox" checked={holdMerges} disabled={busy || pendingRequest} onChange={event => setHoldMerges(event.target.checked)} />
      Block o8 merges with this correction. Remove saved restrictions in this chat’s session rules.
    </label> : null}
    {activityOpen ? <div style={{ display: 'flex', flexDirection: 'column', gap: 12, overflowWrap: 'anywhere' }}>
      <span>Delivery receipts record what the runtime accepted. They do not confirm the worker applied the correction.</span>
      {!corrections.length ? <span>No corrections recorded in this chat.</span> : null}
      {corrections.slice(0, 5).map(correction => <div key={correction.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid var(--t-divider-subtle)', paddingTop: 10 }}>
        <span style={{ color: 'var(--t-text)' }}>{correction.payload.message}</span>
        {correction.createdAt ? <time dateTime={new Date(correction.createdAt).toISOString()} style={{ fontSize: 10 }}>{new Date(correction.createdAt).toLocaleString()}</time> : null}
        {correction.ruleId ? <span>Merge restriction saved. Manage it in this chat’s session rules.</span> : null}
        {correction.deliveries.map(delivery => <div key={delivery.surfaceId} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span>{names.get(delivery.surfaceId) ?? 'Worker'} · {labels[delivery.status]}</span>
          <span>{delivery.note}</span>
          <span style={{ fontSize: 10, color: 'var(--t-text-faint)' }}>{delivery.surfaceId}</span>
        </div>)}
      </div>)}
    </div> : null}
  </WorkerCorrectionDock>;
}
