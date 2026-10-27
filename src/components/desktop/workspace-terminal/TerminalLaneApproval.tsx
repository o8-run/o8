'use client';

import { useEffect, useRef, useState } from 'react';
import { RamsButton } from '@/components/desktop/settings/RamsButton';
import { isTerminalApprovalAdapter, type TerminalApprovalAdapter } from '@/lib/terminal-status/approval-adapter';
import type { TerminalStatusEvidence } from '@/lib/terminal-status/resolve';

export function TerminalLaneApproval({ terminalSession, evidence, active, readOnly }: {
  terminalSession: string;
  evidence?: TerminalStatusEvidence;
  active: boolean;
  readOnly?: boolean;
}) {
  const [view, setView] = useState<{ key: string; generation: number; adapter: TerminalApprovalAdapter | null; note?: string } | null>(null);
  const [hiddenRevision, setHiddenRevision] = useState<string | null>(null);
  const [busyRequest, setBusyRequest] = useState<{ key: string; generation: number; action: 'approve' | 'reject' } | null>(null);
  const [reload, setReload] = useState(0);
  const pending = useRef(false);
  const generation = useRef(0);
  const sessionKey = evidence?.sessionId ?? '';
  const runtime = evidence?.runtime;
  const eligible = active && !readOnly && evidence?.state === 'blocked' && evidence.authority === 'lane-state'
    && (runtime === 'codex' || runtime === 'claude-code');
  const owner = JSON.stringify([sessionKey, terminalSession, runtime, evidence?.observedAt, eligible]);
  const busy = busyRequest?.key === owner && busyRequest.generation === view?.generation ? busyRequest.action : null;

  useEffect(() => {
    const current = ++generation.current;
    pending.current = false;
    if (!eligible) return;
    const controller = new AbortController();
    void fetch(`/api/panel/approvals?sessionKey=${encodeURIComponent(sessionKey)}&terminalSession=${encodeURIComponent(terminalSession)}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('Unable to read the lane decision.');
        const body = await response.json();
        if (controller.signal.aborted) return;
        const adapter = body.terminalAdapter;
        setView({ key: owner, generation: current, adapter: isTerminalApprovalAdapter(adapter)
          && adapter.sessionKey === sessionKey && adapter.terminalSession === terminalSession
          && adapter.runtime === runtime ? adapter : null });
      }).catch(() => {
        if (!controller.signal.aborted) setView({ key: owner, generation: current, adapter: null, note: 'Unable to read the lane decision.' });
      });
    return () => { controller.abort(); if (generation.current === current) generation.current += 1; };
  }, [eligible, owner, reload, runtime, sessionKey, terminalSession]);

  const current = eligible && view?.key === owner && view.generation === generation.current ? view : null;
  const adapter = current?.adapter;
  const resolve = async (action: 'approve' | 'reject') => {
    if (!adapter || pending.current || current?.generation !== generation.current) return;
    const requestGeneration = generation.current;
    pending.current = true;
    setBusyRequest({ key: owner, generation: requestGeneration, action });
    try {
      const response = await fetch('/api/panel/approvals', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: adapter.approvalId, action, terminalAdapter: adapter }) });
      const result = await response.json();
      if (generation.current !== requestGeneration) return;
      setView({ key: owner, generation: requestGeneration, adapter: null, note: response.ok && result.ok
        ? result.note || (action === 'approve' ? 'Lane continuation recorded.' : 'Lane decision rejected.')
        : result.error || result.note || 'Decision outcome is unconfirmed. Read the current lane before retrying.' });
    } catch {
      if (generation.current === requestGeneration) setView({ key: owner, generation: requestGeneration, adapter: null, note: 'Decision outcome is unconfirmed. Read the current lane before retrying.' });
    } finally {
      if (generation.current === requestGeneration) { pending.current = false; setBusyRequest(null); }
    }
  };
  if (!current || (!adapter && !current.note)) return null;
  return <div style={{ paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 12, color: 'var(--t-text)', fontSize: 12 }}>
    {adapter && hiddenRevision !== adapter.revision ? <>
      <div style={{ marginBottom: 8 }}>{adapter.summary}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <RamsButton busy={busy === 'approve'} disabled={busy !== null} onClick={() => void resolve('approve')}>{busy === 'approve' ? 'Resuming lane…' : 'Resume lane'}</RamsButton>
        <RamsButton variant="ghost" busy={busy === 'reject'} disabled={busy !== null} onClick={() => void resolve('reject')}>{busy === 'reject' ? 'Rejecting…' : 'Reject decision'}</RamsButton>
        <RamsButton variant="ghost" onClick={() => setHiddenRevision(adapter.revision)}>Show raw terminal</RamsButton>
      </div>
    </> : adapter ? <RamsButton variant="ghost" onClick={() => setHiddenRevision(null)}>Show lane decision</RamsButton> : <>
      <div role="status" style={{ marginBottom: 8 }}>{current.note}</div>
      <RamsButton variant="ghost" onClick={() => setReload(value => value + 1)}>Read lane decision</RamsButton>
    </>}
  </div>;
}
