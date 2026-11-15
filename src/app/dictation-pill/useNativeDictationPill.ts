'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DictationSnapshot, DictationState } from '@/components/desktop/dictation/types';
import { isTauri } from '@/lib/tauri/bridge';
import { getMobileWsToken } from '@/lib/mobile/ws-token-client';
import timing from '@/lib/next/pill-timing.json';
import type { NativeAskFrame } from './nativeDockAsk';

export const IDLE_SNAPSHOT: DictationSnapshot = {
  state: 'idle',
  audioLevel: 0,
  durationMs: 0,
  error: null,
  partialTranscript: '',
};

/** Dock capsules the native panel draws besides dictation. `workers` is the
 * fleet orbit or its expanded capsule; `extras` is the edit chip and/or glint
 * with no capsule above them. */
export type NativeCapsuleState = 'speaking' | 'working' | 'voice' | 'workers' | 'extras' | 'ask' | 'confirm' | 'drop' | 'staged';
/** The fleet detail DockNotchSurface draws. */
export interface DockWorkers { count: number; working: number; waiting: number; label: string; repos: string[] }
/** One frame for the native panel: a dictation snapshot or one capsule. `handoff`
 * marks an idle frame whose surface moved to a still-web dock state. `edit` and
 * `glint` are drawn below whatever the frame draws. */
export type NativeDockSnapshot = Omit<DictationSnapshot, 'state'> & {
  state: DictationState | NativeCapsuleState;
  paused?: boolean;
  speed?: number;
  tool?: string;
  startedAt?: number;
  connecting?: boolean;
  handoff?: boolean;
  edit?: { id: number; app: string; status: string; until: number };
  glint?: { key: string; text: string; tone: string; fadeAt: number; until: number };
  workers?: DockWorkers;
  expanded?: boolean;
  /** The Ask conversation panel (state `ask`). */
  ask?: NativeAskFrame;
  /** The confirmation card (state `confirm`): the exact identity the web decides on. */
  confirm?: NativeConfirmFrame;
  /** The staged-file chips (state `staged`): at most three, then a count. */
  staged?: { files: { name: string; size: string }[]; extra: number };
  /** Caret/HUD feedback (the `hud` surface only): what the panel draws and where. */
  hud?: NativeHudDetail;
};
/** DockConfirmationCard's content and the confirmation/task identity it decides. */
export interface NativeConfirmFrame { id: string; task: string; kind: 'action' | 'plan'; summary: string; steps?: { index: number; summary: string }[] }
/** Wording is chosen by the web page so both surfaces read the same. `placement`
 * is the classic shell's anchor in top-left desktop points, or absent until known. */
export interface NativeHudDetail {
  surface: 'caret' | 'hud'; title: string; text: string; dim: boolean; solid: boolean; reducedMotion: boolean;
  placement?: { x: number; y: number; width: number; height: number };
}
/** Which native panel a feed drives: the dock, or the caret/HUD feedback window. */
export type NativeFeedSurface = 'dock' | 'hud';
/** A click the native panel reports; the web dock runs the matching command. A
 * revert names the chip (`edit`) as well as the frame it was drawn under; an
 * Ask intent names the thread revision (`ref`) it was drawn for. */
export type NativeDockAction = {
  session: number; state: NativeDockSnapshot['state'];
  action: 'pause' | 'stop' | 'speed' | 'voice-stop' | 'interrupt' | 'workers-expand' | 'revert' | 'ask-close' | 'ask-copy' | 'ask-active'
    | 'confirm-allow' | 'confirm-deny';
  value?: number | null; edit?: number; ref?: string; task?: string;
};

const CAPSULE_ACTIONS: Record<Exclude<NativeDockAction['action'], 'revert'>, NativeCapsuleState> = {
  pause: 'speaking', stop: 'speaking', speed: 'speaking', interrupt: 'working', 'voice-stop': 'voice', 'workers-expand': 'workers',
  'ask-close': 'ask', 'ask-copy': 'ask', 'ask-active': 'ask', 'confirm-allow': 'confirm', 'confirm-deny': 'confirm',
};
const CAPSULES = new Set<string>(['speaking', 'working', 'voice', 'workers', 'extras', 'ask', 'confirm', 'drop', 'staged']);
/** A decision applies only to the exact card it was drawn for. */
const cardCurrent = (clicked: NativeDockAction, frame: NativeDockSnapshot) => !clicked.action.startsWith('confirm-')
  || !!frame.confirm && clicked.ref === frame.confirm.id && clicked.task === frame.confirm.task;
/** An Ask intent applies only to the thread it was drawn for; a copy only to an answer on screen. */
function askCurrent(clicked: NativeDockAction, frame: NativeDockSnapshot) {
  if (!clicked.action.startsWith('ask-')) return true;
  if (!frame.ask || clicked.ref !== String(frame.ask.rev)) return false;
  return clicked.action !== 'ask-copy'
    || frame.ask.turns.some(turn => turn.index === clicked.value && turn.role === 'assistant');
}
/** The frame records the dictation a click can finish: the capsule, or the pending turn inside Ask. */
const recording = (frame: NativeDockSnapshot) => frame.state === 'recording' || frame.state === 'ask' && frame.ask?.pending?.phase === 'listening';
const family = (state: NativeDockSnapshot['state']) => CAPSULES.has(state) ? state : 'dictation';
/** Static frames draw nothing that changes between events, so they hold the
 * panel for up to `staticMs` and send a keep-alive only when they outlast it. */
const isStatic = (state: NativeDockSnapshot['state']) => state === 'workers' || state === 'extras' || state === 'drop' || state === 'staged';
function holdFor(frame: NativeDockSnapshot, now: number) {
  if (!isStatic(frame.state)) return undefined;
  const ends = frame.state === 'extras' ? Math.max(frame.edit?.until ?? 0, frame.glint?.until ?? 0) - now : Infinity;
  return Math.max(0, Math.min(timing.staticMs, ends));
}

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
 * Failed requests restore web drawing immediately and block the current session.
 *
 * The `hud` surface hands over per session: the web keeps painting until a
 * visible frame of the current session is acknowledged (`drawn`); the native
 * panel acknowledges a first frame only once it has drawn it and is on screen.
 * A disabled flag is rechecked at each session instead of for the life of the
 * page, and retiring a session for a newer one hides it at once. */
export function useNativeDictationPill(
  snapshot: NativeDockSnapshot, session: number, onFinish: () => void, onAction?: (action: NativeDockAction) => void,
  surface: NativeFeedSurface = 'dock',
): { native: boolean; suppressed: boolean; drawn: boolean } {
  const [native, setNative] = useState(false);
  const [suppressed, setSuppressed] = useState(false);
  const [drawnSession, setDrawnSession] = useState<number | null>(null);
  const active = snapshot.state !== 'idle';
  const drawn = surface === 'hud' ? native && active && drawnSession === session : native;
  // A static frame changes only on events, so each change wakes the feed.
  const staticKey = native && isStatic(snapshot.state) ? JSON.stringify(snapshot) : '';
  const latest = useRef({
    snapshot, session, onFinish, onAction, native, drawn, active: false, family: family(snapshot.state),
    generation: 0, retirement: 0, retiredGeneration: 0, retiredSession: session, retiredFamily: family(snapshot.state),
  });
  const wake = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const previous = latest.current;
    const kind = family(snapshot.state);
    const generation = active && (!previous.active || previous.session !== session || previous.family !== kind)
      ? previous.generation + 1 : previous.generation;
    const retiring = previous.active && !active;
    latest.current = {
      snapshot, session, onFinish, onAction, native, drawn, active, family: kind, generation,
      retirement: previous.retirement + (retiring ? 1 : 0),
      retiredGeneration: retiring ? previous.generation : previous.retiredGeneration,
      retiredSession: retiring ? previous.session : previous.retiredSession,
      retiredFamily: retiring ? previous.family : previous.retiredFamily,
    };
  }, [snapshot, session, onFinish, onAction, native, drawn, active]);
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
    // Set only by a reply that says the flag is on. Until then a fleet orbit,
    // chip or glint never starts a request (a failed probe retries at the next
    // dictation or capsule session, as before).
    let enabled = false;
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
            body: JSON.stringify({ ...body, ...(surface === 'hud' ? { surface } : {}), deadline: Date.now() + timing.requestMs }), signal: controller.signal,
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
      const now = latest.current;
      void request({ action: 'release', immediate: true, ...(now.active ? { session: now.session, kind: now.family } : { session: now.retiredSession, kind: now.retiredFamily }) })
        .catch(() => undefined);
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
      let releaseKind = current.family;
      const releasing = current.retirement !== retirementSeen && current.native;
      retirementSeen = current.retirement;
      if (releasing || releasePending) {
        if (releasing) { releaseSession = current.retiredSession; releaseKind = current.retiredFamily; }
        releasePending = false;
        action = 'release';
        generation = current.retiredGeneration;
      } else if (blocked === generation || quiet) return;
      else if (current.active) {
        if (current.native) action = 'frame';
        else {
          if (attempted === generation || isStatic(current.snapshot.state) && !enabled) return;
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
        const holdMs = action === 'frame' ? holdFor(frame, Date.now()) : undefined;
        const reply = await request({ action, checkSettings, snapshot: action === 'frame' ? {
          state: frame.state, session: current.session,
          audioLevel: frame.audioLevel, durationMs: frame.durationMs,
          pastedText: bounded(frame.pastedText ?? undefined, 4000), error: bounded(frame.error ?? undefined, 1000),
          paused: frame.paused, speed: frame.speed, tool: bounded(frame.tool, 200),
          startedAt: frame.startedAt, connecting: frame.connecting,
          edit: frame.edit && { ...frame.edit, app: bounded(frame.edit.app, 120) },
          glint: frame.glint && { ...frame.glint, key: undefined, text: bounded(frame.glint.text, 200) },
          workers: frame.workers && { ...frame.workers, label: bounded(frame.workers.label, 20), repos: frame.workers.repos.slice(0, 4).map(repo => bounded(repo, 60)) },
          expanded: frame.expanded, holdMs, ask: frame.ask,
          confirm: frame.confirm && { ...frame.confirm, summary: bounded(frame.confirm.summary, 1500),
            steps: frame.confirm.steps?.slice(0, 5).map(step => ({ index: step.index, summary: bounded(step.summary, 300) })) },
          staged: frame.staged && { extra: frame.staged.extra, files: frame.staged.files.slice(0, 3).map(file => ({ name: bounded(file.name, 200), size: file.size })) },
          hud: frame.hud && { ...frame.hud, title: bounded(frame.hud.title, 120), text: bounded(frame.hud.text, 2400) },
        } : undefined,
        // A HUD session retired by a newer one hides at once under the new web bar.
        ...(action === 'release' ? { session: releaseSession, kind: releaseKind,
          immediate: current.snapshot.handoff === true || surface === 'hud' && current.session !== releaseSession } : {}) });
        if (disposed) return;
        if (reply.enabled === true) enabled = true;
        if (generation !== latest.current.generation) { pending = true; return; }
        if (!reply.native) {
          if (reply.enabled === false && surface !== 'hud') disabled = true;
          blocked = generation;
          if (latest.current.native) fallback(generation);
          return;
        }
        if (action === 'prepare') {
          // A later effect wakes the pump after the hidden web render commits.
          awaitingCommit = true;
          setNative(true);
        } else if (action === 'frame') {
          // The panel is on screen with this session: the web bar can go.
          if (surface === 'hud' && current.active && current.snapshot.hud) setDrawnSession(current.session);
          if (!quiet && latest.current.native && reply.finishSession === latest.current.session
            && recording(latest.current.snapshot)) latest.current.onFinish();
          // Each reported click runs once, only for the capsule still on screen.
          let reverted = false;
          let decided = false;
          for (const clicked of Array.isArray(reply.actions) ? reply.actions as NativeDockAction[] : []) {
            const now = latest.current;
            if (quiet || disposed || !now.native || clicked?.session !== now.session || clicked.state !== now.snapshot.state) continue;
            if (clicked.action === 'revert') {
              // The chip on screen, still offering Revert; at most one per reply.
              if (reverted || now.snapshot.edit?.id !== clicked.edit || now.snapshot.edit?.status !== 'ready') continue;
              reverted = true;
            } else if (CAPSULE_ACTIONS[clicked.action] !== now.snapshot.state || !askCurrent(clicked, now.snapshot)
              || !cardCurrent(clicked, now.snapshot)) continue;
            // One decision per reply; the page clears the card when it runs it.
            if (clicked.action.startsWith('confirm-')) { if (decided) continue; decided = true; }
            if (clicked.action === 'voice-stop' && now.snapshot.connecting) continue;
            now.onAction?.(clicked);
          }
          // Active frames keep the 100 ms keep-alive. A static frame needs one
          // only if it outlasts its hold; otherwise events and retirement wake the feed.
          const keepAlive = holdMs === undefined ? 100 : holdMs >= timing.staticMs ? timing.staticMs - 1000 : null;
          if (!pending && latest.current.active && keepAlive !== null) frameTimer = setTimeout(() => { void pump(); }, keepAlive);
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
      if (initial.enabled === false && surface !== 'hud') { disabled = true; return; }
      if (initial.enabled === true) enabled = true;
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
  }, [surface]);
  useEffect(() => { wake.current?.(); }, [active, session, native, drawn, suppressed, snapshot.state, staticKey]);
  return { native, suppressed, drawn };
}
