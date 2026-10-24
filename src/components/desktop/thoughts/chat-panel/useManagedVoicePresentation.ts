'use client';
import { useEffect, useRef, type RefObject } from 'react';
import { canUseTauriEvents } from '@/lib/tauri/bridge';
import type { LiveSession, LiveState } from '@/lib/voice/managed-live/session';

export interface ManagedVoicePresentation {
  owner: string; epoch: number; phase: LiveState; label: string; level: number; connectedSeconds: number | null;
  dismissed: boolean;
}

/** The satellite paints facts only; the main chat retains audio and all execution authority. */
export function useManagedVoicePresentation(input: {
  state: LiveState; stateRef: RefObject<LiveState>; session: RefObject<LiveSession | null>;
  level: RefObject<number>; label: string; personalKey?: boolean;
}) {
  const current = useRef(input);
  useEffect(() => { current.current = input; });
  useEffect(() => {
    if (!canUseTauriEvents()) return;
    const owner = crypto.randomUUID();
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let presented = false;
    let publishing = false;
    let epoch: number | undefined;
    const publish = async () => {
      if (publishing) return;
      publishing = true;
      const value = current.current;
      const phase = value.stateRef.current;
      const ending = disposed || ['idle', 'unknown', 'closed', 'error'].includes(phase);
      try {
        if (!ending || presented) {
          const { invoke } = await import('@tauri-apps/api/core');
          epoch ??= await invoke<number>('managed_voice_presentation_epoch');
          const presentation: ManagedVoicePresentation = { owner, epoch, phase: phase === 'idle' ? 'closed' : phase,
            dismissed: disposed, label: value.label, level: value.level.current,
            connectedSeconds: (value.personalKey ? value.session.current?.elapsedSeconds : undefined)
              ?? value.session.current?.usage?.providerConnectedSeconds ?? null };
          await invoke('managed_voice_overlay_update', { presentation });
          presented = !ending;
        }
      } catch (error) { console.warn('[managed-voice] Native presentation unavailable:', error); }
      // Audio/session cleanup belongs to the chat. An unmounted chat has no desktop presentation.
      publishing = false;
      if (!disposed || presented) timer = setTimeout(() => { void publish(); }, 250);
    };
    void publish();
    return () => { disposed = true; clearTimeout(timer); void publish(); };
  }, []);
}
