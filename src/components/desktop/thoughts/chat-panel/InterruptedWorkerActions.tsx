'use client';

import { useRef, useState } from 'react';
import type { WorkerRecovery } from '@/lib/agent-control/types';
import { ThreadActionButton } from '../../o8-panel/ThreadActions';

export function InterruptedWorkerActions({ sessionKey, name, recovery, status }: {
  sessionKey: string; name: string; recovery: WorkerRecovery; status: string;
}) {
  const [busy, setBusy] = useState<'resume' | 'retire' | null>(null);
  const [settled, setSettled] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mutations = useRef(new Map<string, string>());
  const control = async (kind: 'resume' | 'retire') => {
    setBusy(kind); setNotice(null);
    const clientMutationId = mutations.current.get(kind) ?? `worker-${kind}-${crypto.randomUUID()}`;
    mutations.current.set(kind, clientMutationId);
    try {
      const response = await fetch('/api/agent-control/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: { kind: 'session', id: sessionKey }, action: { kind }, clientMutationId }) });
      const payload = await response.json();
      const result = payload.result;
      setNotice(result?.note ?? payload.error?.message ?? 'Worker control could not be confirmed. Inspect the worker before retrying.');
      if (response.ok && result?.ok && !result.inProgress) {
        setSettled(true);
        window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
      } else if (!result?.inProgress && result?.reason !== 'outcome_unknown') mutations.current.delete(kind);
    } catch {
      setNotice('Worker control outcome is unconfirmed. Retry the same action to recover its receipt.');
    } finally { setBusy(null); }
  };
  if (!recovery.actions.length) return recovery.retired
    ? <div style={{ fontSize: 11, fontWeight: 300, color: 'var(--t-text-muted)', overflowWrap: 'anywhere' }}>{name} · Retired. Branch {recovery.branch ?? '(unrecorded)'} and edits remain at {recovery.worktreePath}.</div> : null;
  return <div aria-label={`${name} recovery`} style={{ fontSize: 11, fontWeight: 300, color: 'var(--t-text-muted)', overflowWrap: 'anywhere' }}>
    {!settled ? <>
      <div>{name} · {status === 'failed' ? 'Failed' : 'Interrupted'}. Edits preserved on {recovery.branch ?? 'the saved branch'} at {recovery.worktreePath}.</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
        {recovery.actions.map(kind => <ThreadActionButton key={kind}
          label={busy === kind ? kind === 'resume' ? 'Resuming…' : 'Retiring…' : kind === 'resume' ? 'Resume' : 'Retire'}
          disabled={Boolean(busy)} onClick={() => { void control(kind); }} />)}
      </div>
    </> : null}
    {notice ? <p role="status" style={{ marginTop: 6, marginBottom: 0 }}>{notice}</p> : null}
  </div>;
}
