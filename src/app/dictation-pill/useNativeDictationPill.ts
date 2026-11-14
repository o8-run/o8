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
  const [native, setNative] = useState(false);
  const [suppressed, setSuppressed] = useState(false);
  const active = snapshot.state !== 'idle';
  const latest = useRef({ snapshot, session, onFinish, native, active: false, generation: 0, retirement: 0, retiredGeneration: 0 });
  const wake = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const previous = latest.current;
    const generation = active && (!previous.active || previous.session !== session) ? previous.generation + 1 : previous.generation;
    const retiring = previous.active && !active;
    latest.current = {
      snapshot, session, onFinish, native, active, generation,
      retirement: previous.retirement + (retiring ? 1 : 0),
      retiredGeneration: retiring ? previous.generation : previous.retiredGeneration,
    };
  }, [snapshot, session, onFinish, native, active]);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let ready = false;
    let quiet = false;
    let busy = false;
    let pending = false;
    let probed = false;
    let awaitingCommit = false;
    let attempted = -1;
    let checked = -1;
    let blocked = -1;
    let retirementSeen = 0;
    let failureGeneration = -1;
    let frameTimer: ReturnType<typeof setTimeout> | undefined;
    let failureTimer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;
    const bounded = (text: string | undefined, budget: number) => {
      if (text === undefined) return undefined;
      let result = '';
      let bytes = 2;
      const encoder = new TextEncoder();
      for (const char of text) {
        const size = encoder.encode(JSON.stringify(char)).length - 2;
        if (bytes + size > budget) break;
        result += char; bytes += size;
      }
      return result;
    };
    const fallback = (absent: boolean, generation: number) => {
      blocked = generation;
      clearTimeout(failureTimer);
      failureGeneration = generation;
      if (absent) setNative(false);
      else failureTimer = setTimeout(() => {
        if (!disposed && latest.current.generation === generation) setNative(false);
      }, 1000);
    };
    // One request owns the transport until its reply settles. Wakes only replace
    // the latest committed snapshot; they never append work to a frame queue.
    const pump = async () => {
      if (disposed || !ready) return;
      if (busy) { pending = true; return; }
      const current = latest.current;
      if (failureGeneration !== current.generation) clearTimeout(failureTimer);
      if (awaitingCommit && !current.native) return;
      awaitingCommit = false;
      let action: 'prepare' | 'frame' | 'release';
      let generation = current.generation;
      const releasing = current.retirement !== retirementSeen && current.native;
      retirementSeen = current.retirement;
      if (releasing) {
        action = 'release';
        generation = current.retiredGeneration;
      } else if (blocked === generation) return;
      else if (current.active) {
        if (current.native) action = 'frame';
        else {
          if (attempted === generation) return;
          attempted = generation;
          action = 'prepare';
        }
      } else {
        if (probed || current.native) return;
        action = 'prepare';
      }
      probed = true;
      const checkSettings = action === 'prepare' || action === 'frame' && checked !== generation;
      if (checkSettings) checked = generation;
      busy = true;
      pending = false;
      try {
        const frame = current.snapshot;
        const response = await fetch('/api/next/dictation-pill', {
          method: 'POST', headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + getMobileWsToken() },
          body: JSON.stringify({ action, checkSettings, snapshot: action === 'frame' ? {
            state: quiet ? 'idle' : frame.state, session: current.session,
            audioLevel: frame.audioLevel, durationMs: frame.durationMs,
            pastedText: bounded(frame.pastedText ?? undefined, 4000), error: bounded(frame.error ?? undefined, 1000),
          } : undefined }), signal: AbortSignal.timeout(10000),
        });
        const reply = response.ok ? await response.json() : { native: false, absent: false };
        if (disposed) return;
        if (generation !== latest.current.generation) { pending = true; return; }
        if (!reply.native) {
          blocked = generation;
          if (latest.current.native) fallback(reply.absent === true, generation);
          return;
        }
        if (action === 'prepare') {
          // A later effect wakes the pump after the hidden web render commits.
          awaitingCommit = true;
          setNative(true);
        } else if (action === 'frame') {
          if (!quiet && latest.current.native && reply.finishSession === latest.current.session
            && latest.current.snapshot.state === 'recording') latest.current.onFinish();
          if (!pending && latest.current.active) frameTimer = setTimeout(() => { void pump(); }, 100);
        }
      } catch {
        if (!disposed) {
          if (generation !== latest.current.generation) pending = true;
          else {
            blocked = generation;
            if (latest.current.native) fallback(false, generation);
          }
        }
      } finally {
        busy = false;
        if (!disposed && (pending || retirementSeen !== latest.current.retirement)) void pump();
      }
    };
    const notify = () => {
      clearTimeout(frameTimer);
      void pump();
    };
    wake.current = notify;
    // Both the listener registration and initial read precede all traffic. A
    // newer event wins over a late initial read, including temporary overrides.
    void (async () => {
      const [{ listen }, { invoke }] = await Promise.all([import('@tauri-apps/api/event'), import('@tauri-apps/api/core')]);
      let revision = 0;
      const apply = (value: boolean) => { quiet = value; setSuppressed(value); };
      const off = await listen<{ active?: boolean }>('o8:quiet-mode-changed', ({ payload }) => {
        if (!disposed) { revision++; apply(payload.active === true); }
      });
      if (disposed) { off(); return; }
      unlisten = off;
      const before = revision;
      const mode = await invoke<{ active?: boolean } | undefined>('presentation_quiet_mode_get');
      if (disposed) return;
      if (revision === before) apply(mode?.active === true);
      ready = true;
      notify();
    })().catch(() => { /* Without readiness the web retains drawing ownership. */ });
    return () => {
      disposed = true;
      wake.current = null;
      clearTimeout(frameTimer);
      clearTimeout(failureTimer);
      unlisten?.();
    };
  }, []);
  useEffect(() => { wake.current?.(); }, [active, session, native, suppressed]);
  return { native, suppressed };
}
