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
  const probed = useRef(false);
  const wasActive = useRef(false);
  const attempted = useRef<number | null>(null);
  const [suppressed, setSuppressed] = useState(false);
  const active = snapshot.state !== 'idle';
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // Observe the shell's actual presentation mode, including temporary overrides.
    // Listen before reading so a late read cannot undo a newer event.
    void (async () => {
      const [{ listen }, { invoke }] = await Promise.all([import('@tauri-apps/api/event'), import('@tauri-apps/api/core')]);
      let revision = 0;
      const apply = (active: boolean) => { setSuppressed(active); };
      const off = await listen<{ active?: boolean }>('o8:quiet-mode-changed', ({ payload }) => {
        if (!disposed) { revision++; apply(payload.active === true); }
      });
      if (disposed) { off(); return; }
      unlisten = off;
      const before = revision;
      const mode = await invoke<{ active?: boolean } | undefined>('presentation_quiet_mode_get');
      if (disposed) return;
      if (revision === before) apply(mode?.active === true);
    })().catch(() => { if (!disposed) setSuppressed(false); });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const request = async (action: string, checkSettings = false) => {
      const current = latest.current;
      const frame = current.snapshot;
      // Bound JSON-encoded UTF-8, including quotes/control characters.
      const bounded = (text: string | undefined, budget: number) => {
        if (text === undefined) return undefined;
        let result = '';
        let bytes = 2;
        for (const char of text) {
          const size = new TextEncoder().encode(JSON.stringify(char)).length - 2;
          if (bytes + size > budget) break;
          result += char; bytes += size;
        }
        return result;
      };
      const response = await fetch('/api/next/dictation-pill', {
        method: 'POST', headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + getMobileWsToken() },
        body: JSON.stringify({ action, checkSettings, snapshot: action === 'frame' ? {
          state: suppressed ? 'idle' : frame.state, session: current.session,
          audioLevel: frame.audioLevel, durationMs: frame.durationMs,
          pastedText: bounded(frame.pastedText ?? undefined, 4000), error: bounded(frame.error ?? undefined, 1000),
        } : undefined }), signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return { native: false, absent: false };
      const reply = await response.json();
      if (!disposed && !suppressed && reply.native === true && typeof reply.finishSession === 'number'
        && latest.current.session === reply.finishSession && latest.current.snapshot.state === 'recording') latest.current.onFinish();
      return reply;
    };
    const fallback = (absent: boolean) => {
      if (absent) setNative(false);
      else timer = setTimeout(() => { if (!disposed) setNative(false); }, 1000);
    };
    const send = async (first: boolean) => {
      try {
        const reply = await request(native ? 'frame' : 'prepare', first);
        if (disposed) return;
        if (!reply.native) { if (native) fallback(reply.absent === true); return; }
        if (!native) { setNative(true); return; }
        if (latest.current.snapshot.state !== 'idle') timer = setTimeout(() => { void send(false); }, 100);
      } catch { if (!disposed && native) fallback(false); }
    };
    if (active) {
      wasActive.current = true;
      if (native || attempted.current !== session) {
        attempted.current = session;
        void send(true);
      }
    } else if (wasActive.current) {
      wasActive.current = false;
      if (native) void request('release').then(reply => {
        if (!disposed && !reply.native) fallback(reply.absent === true);
      }).catch(() => { if (!disposed) fallback(false); });
    } else if (!probed.current) {
      probed.current = true;
      void send(true);
    }
    return () => { disposed = true; clearTimeout(timer); };
  }, [native, active, session, suppressed]);
  return { native, suppressed };
}
