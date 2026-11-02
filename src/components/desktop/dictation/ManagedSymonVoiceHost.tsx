'use client';
import { useEffect, useRef, useState } from 'react';
import { getManagedSymonBackend, subscribeManagedSymonConfirmation, type ManagedSymonConfirmation } from '@/lib/voice/managed-live/symon-backend';
import { managedChatVoiceTargets, type ManagedChatVoiceTarget } from '@/lib/voice/managed-live/chat-targets';
import { startManagedLive, type LiveSession, type LiveState } from '@/lib/voice/managed-live/session';

export function ManagedSymonVoiceHost() {
  const [state, setState] = useState<LiveState>('idle');
  const stateRef = useRef<LiveState>('idle');
  const [detail, setDetail] = useState('');
  useEffect(() => { window.dispatchEvent(new CustomEvent('o8:managed-symon-status', { detail: state })); }, [state]);
  const [confirmation, setConfirmation] = useState<ManagedSymonConfirmation | null>(null);
  useEffect(() => subscribeManagedSymonConfirmation(setConfirmation), []);
  const session = useRef<LiveSession | null>(null);
  const starting = useRef(false);
  const startup = useRef<AbortController | null>(null);
  useEffect(() => {
    let alive = true;
    const toggle = async () => {
      if (stateRef.current === 'unknown' || stateRef.current === 'closing') return;
      if (starting.current) { startup.current?.abort(); stateRef.current = 'closing'; setState('closing'); return; }
      if (session.current && ['live', 'connecting', 'closing'].includes(session.current.state)) {
        await session.current.close(); return;
      }
      starting.current = true; stateRef.current = 'connecting'; setState('connecting');
      const controller = new AbortController(); startup.current = controller;
      try {
        const backend = await getManagedSymonBackend();
        const live = await startManagedLive(backend, (next, message) => {
          stateRef.current = next;
          if (alive) { setState(next); setDetail(message ?? ''); }
        }, controller.signal);
        if (!alive) await live.close(); else session.current = live;
      } catch (error) {
        stateRef.current = (stateRef.current as LiveState) === 'unknown' ? 'unknown' : 'error';
        if (alive) { setState(stateRef.current); setDetail(error instanceof Error ? error.message : 'Symon voice unavailable.'); }
      } finally { starting.current = false; }
    };
    const target: ManagedChatVoiceTarget = { standalone: true, eligible: () => alive, state: () => stateRef.current, toggle };
    const listener = () => { void managedChatVoiceTargets.request(target).then(accepted => {
      if (!accepted && alive) setDetail('Another chat owns voice or its closure is not confirmed.');
    }); };
    const stop = () => { startup.current?.abort(); void session.current?.close(); };
    window.addEventListener('o8:managed-symon-stop', stop);
    window.addEventListener('o8:managed-symon-toggle', listener);
    return () => { alive = false; window.removeEventListener('o8:managed-symon-stop', stop); startup.current?.abort(); window.removeEventListener('o8:managed-symon-toggle', listener); void session.current?.close(); };
  }, []);
  if (state === 'idle' && !confirmation) return null;
  return <><div role="status" style={{ position: 'fixed', bottom: 70, right: 24, zIndex: 1000,
    background: 'var(--t-bg-card)', color: 'var(--t-text)', maxWidth: 420 }}>
    {confirmation ? <><p>{confirmation.tool}: {confirmation.summary}</p>
      {confirmation.steps.map((step, index) => <p key={index}>{index + 1}. {step}</p>)}
      <button type="button" onClick={() => confirmation.decide(false)}>Decline</button>
      <button type="button" onClick={() => confirmation.decide(true)}>Approve this action</button></> : null}
  </div><button type="button" onClick={() => { if (state === 'closed') window.dispatchEvent(new Event('o8:managed-symon-toggle')); else { startup.current?.abort(); void session.current?.close(); } }}
    title={detail || 'Disconnect voice. Backend tasks and context remain active.'}
    style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 1000, background: 'var(--t-bg-card)', color: 'var(--t-text)',
      border: '1px solid var(--t-border)', borderRadius: 8, paddingTop: 6, paddingBottom: 6, paddingLeft: 12, paddingRight: 12, fontSize: 11, fontWeight: 300 }}>
    {state === 'closed' ? 'Resume Symon voice' : `Symon voice: ${state}`}{detail ? ` · ${detail}` : ''}
  </button></>;
}
