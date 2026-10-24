'use client';
import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { currentWindowLabel } from '@/lib/tauri/bridge';
import { subscribeTauriEvent } from '@/lib/tauri/events';
import type { ManagedVoicePresentation } from '@/components/desktop/thoughts/chat-panel/useManagedVoicePresentation';
import { formatGptLiveUsage } from '@/lib/voice/managed-live/usage';

export default function ManagedChatVoicePage() {
  const [state, setState] = useState<ManagedVoicePresentation | null>(null);
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    if (currentWindowLabel() !== 'managed-chat-voice') return;
    const oldHtml = document.documentElement.style.background;
    const oldBody = document.body.style.background;
    document.documentElement.style.background = 'transparent'; document.body.style.background = 'transparent';
    const release = subscribeTauriEvent<ManagedVoicePresentation>('o8:managed-chat-voice-presentation', event => setState(event.payload));
    return () => { release(); document.documentElement.style.background = oldHtml; document.body.style.background = oldBody; };
  }, []);
  const visible = state && ['connecting', 'live', 'closing', 'unknown'].includes(state.phase);
  const phase = state?.phase === 'live' ? 'Voice live' : state?.phase === 'connecting' ? 'Connecting'
    : state?.phase === 'closing' ? 'Disconnecting' : 'Closure unconfirmed';
  const seconds = state?.connectedSeconds;
  const usage = typeof seconds === 'number' ? formatGptLiveUsage(seconds) : 'Usage pending';
  return <AnimatePresence>{visible ? <motion.div key={state.owner} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
    transition={{ duration: reducedMotion ? 0 : 0.2 }} style={{ position: 'fixed', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
    <motion.div animate={{ opacity: state.phase === 'live' ? 0.55 + state.level * 0.35 : 0.45 }}
      transition={{ duration: reducedMotion ? 0 : 0.2 }} style={{ position: 'absolute', inset: 0,
        background: 'radial-gradient(ellipse 85% 90% at 50% 120%, rgba(255, 77, 30, 0.85), rgba(231, 49, 48, 0.3) 50%, transparent 82%)' }} />
    <motion.div initial={{ y: reducedMotion ? 0 : 12 }} animate={{ y: 0 }} transition={{ duration: reducedMotion ? 0 : 0.25 }}
      style={{ position: 'absolute', bottom: 34, left: '50%', translate: '-50% 0', display: 'flex', alignItems: 'center', gap: 12,
        maxWidth: 'calc(100% - 40px)', paddingTop: 11, paddingBottom: 11, paddingLeft: 16, paddingRight: 16,
        borderRadius: 18, background: 'rgba(15, 17, 19, 0.9)', border: '1px solid var(--t-border)',
        color: '#edf0f3', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', backdropFilter: 'blur(24px)' }}>
      <span aria-hidden="true" style={{ display: 'flex', alignItems: 'center', gap: 3, width: 27, height: 24 }}>
        {[0.5, 0.85, 1, 0.65, 0.4].map((height, index) => <motion.span key={index}
          animate={{ height: 4 + (state.phase === 'live' ? state.level : 0) * height * 20 }} transition={{ duration: reducedMotion ? 0 : 0.15 }}
          style={{ width: 3, borderRadius: 2, background: '#ff743e' }} />)}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <span style={{ fontSize: 12, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{state.label} · {phase}</span>
        <span style={{ fontSize: 10, color: '#a9b1ba' }}>{state.phase === 'unknown' ? 'Check voice status in your chat' : 'Caps Lock to stop'} · {usage}</span>
      </span>
    </motion.div>
  </motion.div> : null}</AnimatePresence>;
}
