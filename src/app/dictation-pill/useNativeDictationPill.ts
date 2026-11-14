'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DictationSnapshot } from '@/components/desktop/dictation/types';
import { isTauri } from '@/lib/tauri/bridge';
import { getMobileWsToken } from '@/lib/mobile/ws-token-client';

export const IDLE_SNAPSHOT: DictationSnapshot = {
  state: 'idle',
  audioLevel: 0,
  durationMs: 0,
  error: null,
  partialTranscript: '',
};

/** Keep retained controls below the native capsule without reasserting a quiet window. */
export function useNativePillDockExtent(native: boolean, active: boolean, visible: boolean, askOpen: boolean, suppressed: boolean, invoke: (command: string, args: Record<string, unknown>) => void) {
  const overridden = useRef(false);
  useEffect(() => {
    if (suppressed) return;
    if (native) {
      overridden.current = true;
      invoke('dock_set_expanded', { expanded: askOpen || (active && visible) });
    } else if (overridden.current) {
      overridden.current = false;
      invoke('dock_set_expanded', { expanded: askOpen });
    }
  }, [native, active, visible, askOpen, suppressed, invoke]);
}

/** The native window acknowledges preparation before React relinquishes drawing.
 * Frames are sent only from the effect after that hidden render has committed.
 * On failure wait beyond the native 750ms lease and 160ms exit before restoring web drawing. */
export function useNativeDictationPill(snapshot: DictationSnapshot, session: number, onFinish: () => void): { native: boolean; suppressed: boolean } {
  const latest = useRef({ snapshot, session, onFinish });
  useLayoutEffect(() => { latest.current = { snapshot, session, onFinish }; }, [snapshot, session, onFinish]);
  const [native, setNative] = useState(false);
  const owned = useRef(false);
  const quiet = useRef(false);
  const [suppressed, setSuppressed] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let unlisten: (() => void) | undefined;
    const request = async (action: string, frame?: DictationSnapshot, generation?: number) => {
      const response = await fetch('/api/next/dictation-pill', {
        method: 'POST', headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + getMobileWsToken() },
        body: JSON.stringify({ action, snapshot: frame ? { ...frame, state: quiet.current ? 'idle' : frame.state, session: generation, partialTranscript: frame.partialTranscript.slice(0, 1000), pastedText: frame.pastedText?.slice(0, 1000), error: frame.error?.slice(0, 240) ?? null } : undefined }), signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return false;
      const reply = await response.json();
      if (!disposed && !quiet.current && reply.native === true && typeof reply.finishSession === 'number') {
        if (!disposed && !quiet.current && latest.current.session === reply.finishSession && latest.current.snapshot.state === 'recording') {
          latest.current.onFinish();
        }
      }
      return reply.native === true;
    };
    const poll = async () => {
      let available = false;
      try { available = await request(owned.current ? 'frame' : 'prepare', owned.current ? latest.current.snapshot : undefined, latest.current.session); } catch { /* lease restores the web fallback */ }
      if (disposed) return;
      if (available && !owned.current) {
        setNative(true);
        // A separate effect publishes only after the hidden web render commits.
        return;
      }
      if (!available && owned.current) {
        timer = setTimeout(() => {
          if (disposed) return;
          owned.current = false;
          setNative(false);
        }, 1000);
        return;
      }
      timer = setTimeout(() => { void poll(); }, available ? 100 : 1000);
    };
    if (native) owned.current = true;
    // Observe the shell's actual presentation mode, including temporary overrides.
    // Listen before reading so a late read cannot undo a newer event.
    void (async () => {
      const [{ listen }, { invoke }] = await Promise.all([import('@tauri-apps/api/event'), import('@tauri-apps/api/core')]);
      let revision = 0;
      const apply = (active: boolean) => { quiet.current = active; setSuppressed(active); };
      const off = await listen<{ active?: boolean }>('o8:quiet-mode-changed', ({ payload }) => {
        if (!disposed) { revision++; apply(payload.active === true); }
      });
      if (disposed) { off(); return; }
      unlisten = off;
      const before = revision;
      const mode = await invoke<{ active?: boolean } | undefined>('presentation_quiet_mode_get');
      if (disposed) return;
      if (revision === before) apply(mode?.active === true);
      void poll();
    })().catch(() => { if (!disposed) { quiet.current = native; setSuppressed(native); void poll(); } });
    return () => { disposed = true; clearTimeout(timer); unlisten?.(); };
  }, [native]);
  return { native, suppressed };
}
