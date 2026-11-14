'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DictationSnapshot, DictationState } from '@/components/desktop/dictation/types';
import { isTauri } from '@/lib/tauri/bridge';
import { getMobileWsToken } from '@/lib/mobile/ws-token-client';
import timing from '@/lib/next/pill-timing.json';

export const IDLE_SNAPSHOT: DictationSnapshot = {
  state: 'idle',
  audioLevel: 0,
  durationMs: 0,
  error: null,
  partialTranscript: '',
};

/** Dock capsules the native panel draws besides dictation. */
export type NativeCapsuleState = 'speaking' | 'working' | 'voice';
/** One frame for the native panel: a dictation snapshot or one capsule. `handoff`
 * marks an idle frame whose surface moved to a still-web dock state. */
export type NativeDockSnapshot = Omit<DictationSnapshot, 'state'> & {
  state: DictationState | NativeCapsuleState;
  paused?: boolean;
  speed?: number;
  tool?: string;
  startedAt?: number;
  connecting?: boolean;
  handoff?: boolean;
};
/** A click the native panel reports; the web dock runs the matching command. */
export type NativeDockAction = { session: number; state: NativeCapsuleState; action: 'pause' | 'stop' | 'speed' | 'voice-stop' | 'interrupt'; value?: number | null };

const CAPSULE_ACTIONS: Record<NativeDockAction['action'], NativeCapsuleState> = {
  pause: 'speaking', stop: 'speaking', speed: 'speaking', interrupt: 'working', 'voice-stop': 'voice',
};
const family = (state: NativeDockSnapshot['state']) => state === 'speaking' || state === 'working' || state === 'voice' ? state : 'dictation';

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
 * Failed requests restore web drawing immediately and block the current session. */
export function useNativeDictationPill(
  snapshot: NativeDockSnapshot, session: number, onFinish: () => void, onAction?: (action: NativeDockAction) => void,
): { native: boolean; suppressed: boolean } {
  const [native, setNative] = useState(false);
  const [suppressed, setSuppressed] = useState(false);
  const active = snapshot.state !== 'idle';
  const latest = useRef({
    snapshot, session, onFinish, onAction, native, active: false, family: family(snapshot.state),
    generation: 0, retirement: 0, retiredGeneration: 0, retiredSession: session,
  });
  const wake = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const previous = latest.current;
    const kind = family(snapshot.state);
    const generation = active && (!previous.active || previous.session !== session || previous.family !== kind)
      ? previous.generation + 1 : previous.generation;
    const retiring = previous.active && !active;
    latest.current = {
      snapshot, session, onFinish, onAction, native, active, family: kind, generation,
      retirement: previous.retirement + (retiring ? 1 : 0),
      retiredGeneration: retiring ? previous.generation : previous.retiredGeneration,
      retiredSession: retiring ? previous.session : previous.retiredSession,
    };
  }, [snapshot, session, onFinish, onAction, native, active]);
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
    let releasePending = false;
    let disabled = false;
    let frameTimer: ReturnType<typeof setTimeout> | undefined;

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
    const request = async (body: Record<string, unknown>) => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          fetch('/api/next/dictation-pill', {
            method: 'POST', headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + getMobileWsToken() },
            body: JSON.stringify({ ...body, deadline: Date.now() + timing.requestMs }), signal: controller.signal,
          }).then(async response => response.ok ? response.json() : { native: false }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Pill deadline')); }, timing.requestMs); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    const fallback = (generation: number) => {
      blocked = generation;
      setNative(false);
      // Independent best effort: a lost acknowledgement must not block retirement.
      // It names its session, so a late arrival cannot hide the next session.
      void request({ action: 'release', session: latest.current.session }).catch(() => undefined);
    };
    // One request owns the transport until its reply settles. Wakes only replace
    // the latest committed snapshot; they never append work to a frame queue.
    const pump = async () => {
      if (disposed || !ready || disabled) return;
      if (busy) { pending = true; return; }
      const current = latest.current;
      if (awaitingCommit && !current.native) return;
      awaitingCommit = false;
      let action: 'prepare' | 'frame' | 'release';
      let generation = current.generation;
      let releaseSession = current.session;
      const releasing = current.retirement !== retirementSeen && current.native;
      retirementSeen = current.retirement;
      if (releasing || releasePending) {
        if (releasing) releaseSession = current.retiredSession;
        releasePending = false;
        action = 'release';
        generation = current.retiredGeneration;
      } else if (blocked === generation || quiet) return;
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
        const reply = await request({ action, checkSettings, snapshot: action === 'frame' ? {
          state: frame.state, session: current.session,
          audioLevel: frame.audioLevel, durationMs: frame.durationMs,
          pastedText: bounded(frame.pastedText ?? undefined, 4000), error: bounded(frame.error ?? undefined, 1000),
          paused: frame.paused, speed: frame.speed, tool: bounded(frame.tool, 200),
          startedAt: frame.startedAt, connecting: frame.connecting,
        } : undefined,
        ...(action === 'release' ? { session: releaseSession, immediate: current.snapshot.handoff === true } : {}) });
        if (disposed) return;
        if (generation !== latest.current.generation) { pending = true; return; }
        if (!reply.native) {
          if (reply.enabled === false) disabled = true;
          blocked = generation;
          if (latest.current.native) fallback(generation);
          return;
        }
        if (action === 'prepare') {
          // A later effect wakes the pump after the hidden web render commits.
          awaitingCommit = true;
          setNative(true);
        } else if (action === 'frame') {
          if (!quiet && latest.current.native && reply.finishSession === latest.current.session
            && latest.current.snapshot.state === 'recording') latest.current.onFinish();
          // Each reported click runs once, only for the capsule still on screen.
          for (const clicked of Array.isArray(reply.actions) ? reply.actions as NativeDockAction[] : []) {
            const now = latest.current;
            if (quiet || disposed || !now.native || clicked?.session !== now.session) continue;
            if (CAPSULE_ACTIONS[clicked.action] !== now.snapshot.state || clicked.state !== now.snapshot.state) continue;
            if (clicked.action === 'voice-stop' && now.snapshot.connecting) continue;
            now.onAction?.(clicked);
          }
          if (!pending && latest.current.active) frameTimer = setTimeout(() => { void pump(); }, 100);
        }
      } catch {
        if (!disposed) {
          if (generation !== latest.current.generation) {
            // A deadline proves the shared transport is stalled even if a new
            // session arrived while it was in flight. Do not hide web for a
            // second deadline while the last native frame expires.
            if (latest.current.native) fallback(latest.current.generation);
            else pending = true;
          } else {
            blocked = generation;
            if (latest.current.native) fallback(generation);
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
    // Listener registration and the initial quiet read precede all frames. A
    // newer event wins over a late initial read, including temporary overrides.
    void (async () => {
      const generation = latest.current.generation;
      const initial = await request({ action: 'prepare', checkSettings: true }).catch(() => ({ native: false }));
      if (disposed) return;
      probed = true;
      if (initial.enabled === false) { disabled = true; return; }
      if (!initial.native) blocked = generation;
      const [{ listen }, { invoke }] = await Promise.all([import('@tauri-apps/api/event'), import('@tauri-apps/api/core')]);
      let revision = 0;
      const apply = (value: boolean) => {
        if (value && !quiet && latest.current.native) releasePending = true;
        quiet = value; setSuppressed(value); if (ready) notify();
      };
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
      if (initial.native && generation === latest.current.generation) {
        awaitingCommit = true;
        setNative(true);
      } else notify();
    })().catch(() => { /* Without readiness the web retains drawing ownership. */ });
    return () => {
      disposed = true;
      wake.current = null;
      clearTimeout(frameTimer);
      unlisten?.();
    };
  }, []);
  useEffect(() => { wake.current?.(); }, [active, session, native, suppressed, snapshot.state]);
  return { native, suppressed };
}
