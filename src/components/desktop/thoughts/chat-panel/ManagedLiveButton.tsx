'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { formatGptLiveUsage } from '@/lib/voice/managed-live/usage';
import { useChatLiveController, type ChatLiveOptions } from './useChatLiveController';
import { useManagedChatVoiceTarget } from './useManagedChatVoiceTarget';
import { useManagedVoicePresentation } from './useManagedVoicePresentation';
import { useTurnByTurnVoice } from './useTurnByTurnVoice';
import { VoiceModeChooser } from './VoiceModeChooser';

/** The selected conversation remains the only agent; voice has no tool executor. */
export function ManagedLiveButton(props: ChatLiveOptions) {
  const [available, setAvailable] = useState(false);
  const [localPreview, setLocalPreview] = useState(false);
  const [personalAvailable, setPersonalAvailable] = useState(false);
  const [chooser, setChooser] = useState(false);
  const [selectedMode, setSelectedMode] = useState<'turn' | 'byok' | 'managed' | null>(null);
  const [checking, setChecking] = useState(false);
  const [readinessError, setReadinessError] = useState('');
  const turn = useTurnByTurnVoice(props);
  const requestedMode = useRef<'turn' | 'byok' | 'managed' | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const chooserId = useId();
  const { state, stateRef, targetState, detail, setDetail, level, session, refreshAvailability, startLive, stopLive } = useChatLiveController(props, source => {
    setChooser(false); setSelectedMode(source); turn.stop();
  });
  const [usageLine, setUsageLine] = useState('');
  useEffect(() => {
    if (selectedMode !== 'byok') return;
    const refresh = () => {
      const live = session.current;
      const seconds = live?.elapsedSeconds ?? live?.usage?.providerConnectedSeconds;
      setUsageLine(seconds == null ? 'Connecting…' : formatGptLiveUsage(seconds));
    };
    refresh();
    if (!['connecting', 'live', 'closing'].includes(state)) return;
    const timer = setInterval(refresh, 250);
    return () => clearInterval(timer);
  }, [selectedMode, state, session]);
  useEffect(() => {
    let alive = true;
    void refreshAvailability().then(data => {
      if (!alive) return;
      setAvailable(data.enabled === true && data.entitled === true);
      setLocalPreview(data.transport === 'local-preview');
      setPersonalAvailable(data.byokAvailable === true);
    }).catch(() => {});
    return () => { alive = false; };
  }, [refreshAvailability]);
  const current = useRef(props); current.current = props;
  const openChooser = async () => {
    if (turn.enabled || ['live', 'connecting', 'closing', 'unknown'].includes(stateRef.current)) { setDetail('Stop the current voice session before choosing another mode.'); return; }
    setChooser(true); setChecking(true); setReadinessError('');
    const binding = props.binding;
    try {
      const data = await refreshAvailability();
      if (current.current.binding !== binding) return;
      setAvailable(data.enabled === true && data.entitled === true);
      setLocalPreview(data.transport === 'local-preview');
      setPersonalAvailable(data.byokAvailable === true);
    } catch (error) { setReadinessError(error instanceof Error ? error.message : 'Live availability could not be checked.'); }
    finally { setChecking(false); }
  };
  const active = turn.enabled || state === 'live' || state === 'connecting' || state === 'closing';
  useEffect(() => { targetState.current = turn.enabled ? 'live' : state; }, [turn.enabled, state, targetState]);
  const pilotDefault = available && (selectedMode === null || selectedMode === 'managed');
  const toggle = async () => {
    if (turn.enabled) { targetState.current = 'idle'; turn.stop(); return; }
    const mode = requestedMode.current;
    requestedMode.current = null;
    if (mode) {
      if (mode === 'turn') { setSelectedMode('turn'); setChooser(false); targetState.current = 'live'; if (!await turn.start()) targetState.current = 'idle'; }
      else await startLive(mode);
      return;
    }
    if (['live', 'connecting', 'closing'].includes(stateRef.current)) {
      await stopLive();
      return;
    }
    if (stateRef.current === 'closed' && selectedMode === 'byok') await startLive('byok');
    else if (pilotDefault) await startLive('managed');
    else await openChooser();
  };
  const requestToggle = useManagedChatVoiceTarget({ available: true, root: props.chatRoot, trigger, state: targetState, toggle });
  useManagedVoicePresentation({ state, stateRef, session, level, label: props.label ?? 'This chat', personalKey: selectedMode === 'byok' });
  const continueLive = selectedMode === 'byok' && state === 'closed';
  return <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
    <button ref={trigger} type="button" onContextMenu={event => { event.preventDefault(); void openChooser(); }}
      onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); void openChooser(); } }}
      onClick={() => { void requestToggle().then(accepted => { if (!accepted) setDetail('Voice belongs to another chat or its closure is not confirmed.'); }); }} disabled={state === 'closing' || state === 'unknown'}
      aria-label={turn.enabled ? 'Stop turn-by-turn voice' : active ? selectedMode === 'byok' ? 'Disconnect personal-key Live' : 'Disconnect managed voice' : continueLive ? 'Continue GPT Live for this conversation' : pilotDefault ? state === 'closed' ? 'Resume managed voice for this conversation' : 'Start managed voice for this conversation' : 'Choose voice for this conversation'}
      aria-haspopup="dialog" aria-expanded={chooser} aria-controls={chooserId}
      aria-pressed={active} title={turn.detail || detail || (active && selectedMode === 'byok' ? 'Live with your OpenAI key · voice usage is billed to your key. Caps Lock stops voice.' : pilotDefault ? 'Managed pilot · Caps Lock starts or stops voice. Right-click or press Arrow Down to choose turn-by-turn or personal-key Live.' : 'Voice for this chat · Caps Lock chooses a mode or stops active voice.')}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4, width: continueLive ? 'auto' : 24, height: 24, padding: 0, fontSize: 11, fontWeight: 300, background: 'transparent', color: active ? 'var(--t-accent)' : 'var(--t-text-muted)', border: 0, borderRadius: 6, cursor: state === 'closing' || state === 'unknown' ? 'default' : 'pointer' }}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
        <path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" />
      </svg>
      {continueLive ? 'Continue' : null}
    </button>
    <VoiceModeChooser id={chooserId} anchorRef={trigger} open={chooser} close={() => setChooser(false)} checking={checking} error={readinessError}
      turnAvailable={turn.available} managedAvailable={available} personalAvailable={personalAvailable} localPreview={localPreview}
      startTurn={() => { requestedMode.current = 'turn'; void requestToggle().then(accepted => { if (!accepted) { requestedMode.current = null; setDetail('Another chat owns voice. Stop its session before starting this mode.'); } }); }} startLive={source => { requestedMode.current = source; void requestToggle().then(accepted => { if (!accepted) { requestedMode.current = null; setDetail('Another chat owns voice. Stop its session before starting this mode.'); } }); }} />
    {selectedMode === 'byok' && usageLine ? <span role="status" style={{ marginLeft: 6, fontSize: 11, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text-muted)', whiteSpace: 'nowrap' }}>
      {state === 'error' ? 'Voice unavailable.' : usageLine}{state === 'closed' ? ` · ${detail || 'Voice paused.'}` : state === 'unknown' ? ' · Closure unconfirmed.' : ''}
    </span> : detail || turn.detail ? <span role="status" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>{detail || turn.detail}</span> : null}
  </span>;
}
