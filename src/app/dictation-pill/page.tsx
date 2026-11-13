'use client';

/**
 * The always-on top dock retains agent, Ask, TTS and legacy surface-off flows.
 * Plain Fn with a visible caret/HUD modal leaves this dock idle; that modal
 * owns recording, processing, delivered text and dismissal.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@/lib/tauri/bridge';
import { SystemDictationSession } from '@/lib/dictation/system-dictation-session';
import {
  PARKED_LANES_STALE_AFTER_MS,
  parkedSnapshotIsStale,
  parkedSnapshotIsUsable,
  type ParkedLanesStatusPayload,
} from '@/lib/presentation/parked-lanes-snapshot';
import { useMicLevel } from '@/components/desktop/dictation/useMicLevel';
import { DockNotchSurface } from '@/components/desktop/dictation/DockNotchSurface';
import { formatPlanProgressGlint, type PlanProgressEvent, type PlanProgressGlint } from '@/components/desktop/dictation/planPresentation';
import { useDockFileDrop, type StagedChip } from '@/components/desktop/dictation/useDockFileDrop';
import { useAgentConfirmations } from '@/components/desktop/dictation/useAgentConfirmations';
import type { AskTurn } from '@/components/desktop/dictation/DockAskPanel';
import type { DictationSnapshot, DictationState } from '@/components/desktop/dictation/types';
import { EditRevertChip } from './EditRevertChip';
import { useNativeDictationPill } from './useNativeDictationPill';
import { DockGlint } from './DockGlint';

export const dynamic = 'force-dynamic';

/**
 * Dock-route morph instrumentation. This route runs in a SECOND webview whose
 * `console.log` does NOT reach `~/Library/Logs/ai.o8.desktop/o8.log`, so when
 * the dock fails to morph there is no server trace to inspect. `o8_dock_log`
 * (a thin Tauri command → `tracing::info!("[dock-route] …")`) lets us SEE which
 * `o8:stt-event` payloads actually arrive at the dock webview. Fire-and-forget;
 * never throws. Skip the high-frequency partial/level events at the call site.
 */
function dockLog(msg: string) {
  if (!isTauri()) return;
  import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('o8_dock_log', { msg }))
    .catch(() => { /* noop — never let logging break the morph */ });
}

/** Fire a Tauri command from the dock webview (TTS controls, dock resize).
 * Fire-and-forget; never throws (the dock must never crash on a control tap). */
function invokeCmd(cmd: string, args?: Record<string, unknown>) {
  if (!isTauri()) return;
  import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke(cmd, args))
    .catch((err) => dockLog(`invoke ${cmd} failed: ${err instanceof Error ? err.message : String(err)}`));
}

/** TTS playback state mirrored from the native engine via `o8:tts-state`. */
type TtsControlState = 'idle' | 'playing' | 'paused';

/** Ask answer panel (voice P4 C3). */
type AskMode = 'idle' | 'listening' | 'answer';
type WorkerSnapshot = { count: number; working: number; waiting: number; repos: string[] };
type ParkedLaneSnapshot = { waiting: number; repos: string[]; tooltip: string | null; receivedAt: number };
type DockGlint = PlanProgressGlint;
const ASK_IDLE_COLLAPSE_MS = 45_000; // auto-collapse the panel after idle
const ASK_RESUME_WINDOW_MS = 60_000; // preserve the thread if reopened within
const ASK_MAX_TURNS = 16; // 8 exchanges before trimming the oldest

const SUCCESS_FLASH_MS = 900;
const ERROR_FLASH_MS = 2500;
// Polish (Whisper/LLM cleanup + paste) normally lands in 1–4s; past this the
// session is considered hung and the pill frees itself.
const POLISH_WATCHDOG_MS = 20_000;

const IDLE_SNAPSHOT: DictationSnapshot = {
  state: 'idle',
  audioLevel: 0,
  durationMs: 0,
  error: null,
  partialTranscript: '',
};

interface SttEventPayload {
  type:
    | 'ready'
    | 'system-start'
    | 'system-idle'
    | 'partial'
    | 'final'
    | 'level'
    | 'audio_file'
    | 'status'
    | 'error'
    | 'complete'
    | 'polished'
    | 'system-pasted';
  /** Origin discriminator (system-wide Symon fold P3 review HIGH). Only the
   * dock window reacts to `system`; the in-window pill reacts to the rest. */
  origin?: 'system' | 'in-window';
  /** Lane marker — `agent` on the Option-gesture start, so a dictation that
   * begins mid-conversation can render INSIDE the open panel as a pending
   * chat turn instead of collapsing the panel to the listening capsule. */
  lane?: string;
  hud?: boolean;
  surface?: 'caret' | 'hud' | 'off';
  sessionId?: number;
  startId?: string;
  text?: string;
  level?: number;
  chars?: number;
}

/** Pending in-panel dictation (chat continuity): listening → polishing →
 * handoff (final transcript on its way to the agent). */
type PanelPending = { phase: 'listening' | 'polishing' | 'handoff'; text: string };


export default function DictationPillPage() {
  const [snapshot, setSnapshot] = useState<DictationSnapshot>(IDLE_SNAPSHOT);
  // Drive the waveform + glow from the mic directly (native 'level' events never
  // reach the dock). Only while recording; overrides the always-0 native level.
  const applyMicLevel = useCallback((level: number) => {
    setSnapshot((prev) => (prev.state === 'recording' ? { ...prev, audioLevel: level } : prev));
  }, []);
  useMicLevel(snapshot.state === 'recording', applyMicLevel, dockLog);
  const [ttsState, setTtsState] = useState<TtsControlState>('idle');
  // Realtime voice-to-voice presence (Track B) — mirrored from the session via
  // `o8:realtime-status`, so the dock pill shows "voice live" up where Symon
  // lives, not only the in-window indicator.
  const [realtimeVoice, setRealtimeVoice] = useState<'off' | 'connecting' | 'live'>('off');
  const [askOpen, setAskOpen] = useState(false);
  const [askMode, setAskMode] = useState<AskMode>('idle');
  const [askThread, setAskThread] = useState<AskTurn[]>([]);
  const [agentConfirm, setAgentConfirm] = useAgentConfirmations(dockLog);
  const [agentWorking, setAgentWorking] = useState(false);
  // Current running tool + when the task started — drive the working capsule's
  // "Synthesizing…/Working…" label + live elapsed timer.
  const [agentTool, setAgentTool] = useState<string>('');
  const [agentStartedAt, setAgentStartedAt] = useState<number>(0);
  const askIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const askLastClosedRef = useRef<number>(0);
  const askOpenRef = useRef(false);
  const askThreadRef = useRef<AskTurn[]>([]);
  // The intent of the in-flight agent task, captured on `running` so the `done`
  // event can show it as the "You" turn in the shared answer panel.
  const agentIntentRef = useRef<string>('');
  // Last agent task whose terminal (done/failed) event we've handled — guards
  // the dual-emit (emit_to dock + broadcast both reach the dock window) from
  // appending the answer twice.
  const agentDoneRef = useRef<string>('');
  // The set of currently-running task ids. A heavy ask runs TWO tasks at once:
  // the fast foreground voice turn (`task-*`, which acks "on it" and finishes
  // almost immediately) and the slow background brain (`claude-task-*`). The
  // working capsule must stay lit until BOTH drain, so `agentWorking` is driven
  // by this set being non-empty — not by any single task's terminal event.
  const runningTasksRef = useRef<Set<string>>(new Set());

  // Chat continuity: an agent-lane dictation that starts while the conversation
  // panel is open renders as a pending turn INSIDE the panel — the dock never
  // collapses to the capsule mid-conversation. Ref mirrors state so the stable
  // stt-event handler can read it without re-subscribing.
  const [panelPending, setPanelPending] = useState<PanelPending | null>(null);
  const panelPendingRef = useRef<PanelPending | null>(null);
  const pendingHandoffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agentWorkingRef = useRef(false);
  const updatePanelPending = useCallback((next: PanelPending | null) => {
    panelPendingRef.current = next;
    setPanelPending(next);
  }, []);

  const stateRef = useRef<DictationState>('idle');
  const startTimeRef = useRef<number>(0);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const polishWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef(new SystemDictationSession());
  const modalOwnsDictationRef = useRef(false);

  const setState = useCallback((next: DictationState, patch?: Partial<DictationSnapshot>) => {
    stateRef.current = next;
    setSnapshot((prev) => ({ ...prev, ...patch, state: next }));
  }, []);

  const returnToIdleAfter = useCallback((ms: number) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => {
      flashTimerRef.current = null;
      stateRef.current = 'idle';
      setSnapshot(IDLE_SNAPSHOT);
    }, ms);
  }, []);

  const beginRecording = useCallback(() => {
    if (flashTimerRef.current) {
      clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
    if (polishWatchdogRef.current) {
      clearTimeout(polishWatchdogRef.current);
      polishWatchdogRef.current = null;
    }
    startTimeRef.current = Date.now();
    stateRef.current = 'recording';
    setSnapshot({ state: 'recording', audioLevel: 0, durationMs: 0, error: null, partialTranscript: '' });
  }, []);

  const handleEvent = useCallback((payload: SttEventPayload) => {
    // ── Origin discriminator ──
    // Only react to SYSTEM-origin sessions. `o8:stt-event` is broadcast to all
    // windows; the in-window DictationHost handles `in-window` (and unmarked
    // legacy) sessions. `system-pasted` is system by construction even if the
    // origin field is absent, so we accept it unconditionally.
    if (payload.type !== 'system-pasted' && payload.origin !== 'system') {
      return;
    }
    if (!sessionRef.current.accepts(payload)) return;
    if (payload.type === 'system-start') {
      // Plain Fn feedback belongs at the caret, away from the screen notch.
      // Agent/Ask sessions and the explicit surface-off preference retain the dock.
      modalOwnsDictationRef.current = !payload.lane && payload.hud === true
        && (payload.surface === 'caret' || payload.surface === 'hud');
      if (modalOwnsDictationRef.current) {
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        if (polishWatchdogRef.current) clearTimeout(polishWatchdogRef.current);
        stateRef.current = 'idle';
        setSnapshot(IDLE_SNAPSHOT);
      }
    }
    if (payload.type === 'system-pasted' || payload.type === 'error' || payload.type === 'system-idle') {
      sessionRef.current.finish();
    }
    if (modalOwnsDictationRef.current) return;

    // Trace the morph path: confirms the dock webview is RECEIVING system events
    // (the prior bug was the broadcast not reaching this second window — now
    // Rust emit_to(DOCK_LABEL, …) targets it directly). This route's
    // `console.log` does NOT reach the server log, so we ALSO write to the Rust
    // tracing log via `o8_dock_log` — that's the only way to SEE in o8.log
    // whether/which events arrive at the dock route. Skip the per-frame
    // `level`/`partial` events so the trace stays brief — the morph-driving
    // events (system-start/idle/pasted, final, audio_file, error) are what
    // matter.
    if (payload.type !== 'level' && payload.type !== 'partial') {
      console.log('[dock-pill] system stt-event', payload.type, '→ state', stateRef.current);
      dockLog(`stt-event ${payload.type} → state ${stateRef.current}`);
    }

    switch (payload.type) {
      case 'system-start':
        // Chat continuity: an AGENT-lane dictation starting while the
        // conversation panel is open (with turns) renders inside the panel as
        // a pending You turn — the panel keeps the dock, no capsule collapse.
        if (payload.lane === 'agent' && askOpenRef.current && askThreadRef.current.length > 0) {
          if (pendingHandoffTimerRef.current) {
            clearTimeout(pendingHandoffTimerRef.current);
            pendingHandoffTimerRef.current = null;
          }
          updatePanelPending({ phase: 'listening', text: '' });
          // Suspend the idle auto-collapse while the user is mid-turn.
          if (askIdleTimerRef.current) {
            clearTimeout(askIdleTimerRef.current);
            askIdleTimerRef.current = null;
          }
        }
        beginRecording();
        break;
      case 'system-idle':
        // Brush discarded / start error / agent finalize teardown — morph the
        // dock back. With a pending in-panel turn this is the HANDOFF moment
        // (polish done, transcript on its way to the agent): hold the pending
        // turn briefly; if no `running` status claims it, it was a discard.
        if (panelPendingRef.current) {
          updatePanelPending({ ...panelPendingRef.current, phase: 'handoff' });
          if (pendingHandoffTimerRef.current) clearTimeout(pendingHandoffTimerRef.current);
          pendingHandoffTimerRef.current = setTimeout(() => {
            pendingHandoffTimerRef.current = null;
            if (panelPendingRef.current?.phase === 'handoff' && !agentWorkingRef.current) {
              updatePanelPending(null);
            }
          }, 5000);
        }
        if (flashTimerRef.current) {
          clearTimeout(flashTimerRef.current);
          flashTimerRef.current = null;
        }
        if (polishWatchdogRef.current) {
          clearTimeout(polishWatchdogRef.current);
          polishWatchdogRef.current = null;
        }
        stateRef.current = 'idle';
        setSnapshot(IDLE_SNAPSHOT);
        break;
      case 'ready':
      case 'complete':
        // Recognizer teardown signals heal the STUCK states only. The v1 fix
        // reset to idle unconditionally, which killed the polishing pill the
        // instant fn was released (audio_file → polishing, then complete/ready
        // wiped it) and a trailing `ready` clobbered the pasted-confirmation
        // flash mid-play (operator regression, 0.1.561). `polishing` has its
        // own terminals — system-pasted / error / the watchdog below — and an
        // active success/error flash must play out.
        if (panelPendingRef.current?.phase === 'listening') {
          updatePanelPending({ ...panelPendingRef.current, phase: 'handoff' });
        }
        if (stateRef.current === 'recording' || stateRef.current === 'transcribing') {
          stateRef.current = 'idle';
          setSnapshot(IDLE_SNAPSHOT);
        }
        break;
      case 'level':
        if (stateRef.current === 'recording' && typeof payload.level === 'number') {
          const level = Math.min(1, payload.level);
          const duration = Date.now() - startTimeRef.current;
          setSnapshot((prev) => (prev.state === 'recording'
            ? { ...prev, audioLevel: level, durationMs: duration }
            : prev));
        }
        break;
      case 'partial':
        if (stateRef.current === 'recording' && typeof payload.text === 'string') {
          if (panelPendingRef.current?.phase === 'listening') {
            updatePanelPending({ phase: 'listening', text: payload.text });
          }
          setSnapshot((prev) => (prev.state === 'recording' && prev.partialTranscript !== payload.text
            ? { ...prev, partialTranscript: payload.text ?? '' }
            : prev));
        }
        break;
      case 'final':
        if (panelPendingRef.current?.phase === 'listening') {
          updatePanelPending({ ...panelPendingRef.current, phase: 'polishing' });
        }
        if (stateRef.current === 'recording') setState('transcribing');
        break;
      case 'audio_file':
        if (stateRef.current === 'recording' || stateRef.current === 'transcribing') {
          setState('polishing');
          // Anti-stuck watchdog: `polishing` is no longer reset by the
          // recognizer's complete/ready teardown (see above), so if the polish
          // path hangs with no system-pasted/error the pill must still free
          // itself — the works-once-then-stuck bug this route was healing.
          if (polishWatchdogRef.current) clearTimeout(polishWatchdogRef.current);
          polishWatchdogRef.current = setTimeout(() => {
            polishWatchdogRef.current = null;
            if (stateRef.current === 'polishing') {
              stateRef.current = 'idle';
              setSnapshot(IDLE_SNAPSHOT);
            }
          }, POLISH_WATCHDOG_MS);
        }
        break;
      case 'system-pasted':
        // Paste landed in the focused app — flash the ACTUAL pasted words in
        // the dock (Symon parity: the notch shows the text, not just "Pasted"),
        // then collapse back to the idle capsule.
        if (polishWatchdogRef.current) {
          clearTimeout(polishWatchdogRef.current);
          polishWatchdogRef.current = null;
        }
        setState('success', { audioLevel: 0, pastedText: payload.text ?? null });
        returnToIdleAfter(SUCCESS_FLASH_MS);
        break;
      case 'error':
        // A failed dictation clears any pending in-panel turn — the existing
        // error capsule takes the dock (worth the morph for a real failure).
        if (polishWatchdogRef.current) {
          clearTimeout(polishWatchdogRef.current);
          polishWatchdogRef.current = null;
        }
        if (panelPendingRef.current) updatePanelPending(null);
        stateRef.current = 'error';
        setSnapshot({ state: 'error', audioLevel: 0, durationMs: 0, error: payload.text ?? 'Dictation failed', partialTranscript: '' });
        returnToIdleAfter(ERROR_FLASH_MS);
        break;
      default:
        break;
    }
  }, [beginRecording, returnToIdleAfter, setState, updatePanelPending]);

  // Subscribe to the broadcast STT event stream.
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen<SttEventPayload>('o8:stt-event', (e) => handleEvent(e.payload)))
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlistenRef.current = unlisten;
        // Confirm the dock webview actually subscribed — surfaces in o8.log so
        // we can tell a non-morphing dock from one that never wired the listener.
        dockLog('subscribed to o8:stt-event');
      })
      .catch((err) => {
        console.warn('[dock-pill] failed to subscribe to o8:stt-event', err);
        dockLog(`subscribe FAILED: ${err instanceof Error ? err.message : String(err)}`);
      });
    return () => {
      disposed = true;
      if (unlistenRef.current) {
        try { unlistenRef.current(); } catch { /* noop */ }
        unlistenRef.current = null;
      }
    };
  }, [handleEvent]);

  // ── TTS playback state (o8:tts-state) — drives the play/pause/stop controls ──
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let off: (() => void) | null = null;
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen<{ state?: TtsControlState }>('o8:tts-state', (e) => {
        const next = e.payload?.state;
        if (next === 'playing' || next === 'paused' || next === 'idle') {
          setTtsState(next);
        }
      }))
      .then((unlisten) => {
        if (disposed) { unlisten(); return; }
        off = unlisten;
      })
      .catch((err) => dockLog(`tts-state subscribe failed: ${err instanceof Error ? err.message : String(err)}`));
    return () => {
      disposed = true;
      if (off) { try { off(); } catch { /* noop */ } off = null; }
    };
  }, []);

  // ── Realtime voice presence (o8:realtime-status) ──
  // The session lives in the MAIN window (RealtimeVoiceHost / realtime-client);
  // it forwards `off | connecting | live | error` here via Rust
  // (realtime_status_changed → emit_to dock). `live` persists until `off`;
  // `connecting` self-clears if it never lands (stuck negotiation); `error`
  // flashes off — the in-window pill already says "Voice unavailable".
  const rtSafetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let off: (() => void) | null = null;
    const clearSafety = () => {
      if (rtSafetyTimerRef.current) { clearTimeout(rtSafetyTimerRef.current); rtSafetyTimerRef.current = null; }
    };
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen<{ status?: string }>('o8:realtime-status', (e) => {
        const s = e.payload?.status;
        dockLog(`realtime-status ${s ?? '?'}`);
        clearSafety();
        if (s === 'live') {
          setRealtimeVoice('live');
        } else if (s === 'connecting') {
          setRealtimeVoice('connecting');
          // Never strand a "Connecting…" pill if the session dies mid-negotiate.
          rtSafetyTimerRef.current = setTimeout(() => setRealtimeVoice('off'), 15_000);
        } else {
          // 'off' | 'error' | anything else → clear the presence.
          setRealtimeVoice('off');
        }
      }))
      .then((unlisten) => {
        if (disposed) { unlisten(); return; }
        off = unlisten;
      })
      .catch((err) => dockLog(`realtime-status subscribe failed: ${err instanceof Error ? err.message : String(err)}`));
    return () => {
      disposed = true;
      clearSafety();
      if (off) { try { off(); } catch { /* noop */ } off = null; }
    };
  }, []);

  // Tap the dock voice-live capsule → toggle the realtime session off. The
  // session lives in the main window, so broadcast the SAME toggle the
  // double-tap right ⌘ hotkey emits; RealtimeVoiceHost (main) flips it off.
  const stopRealtimeVoice = useCallback(() => {
    if (!isTauri()) return;
    import('@tauri-apps/api/event')
      .then(({ emit }) => emit('o8:realtime-toggle', { origin: 'dock-tap' }))
      .catch((err) => dockLog(`realtime toggle emit failed: ${err instanceof Error ? err.message : String(err)}`));
  }, []);

  const finishSystemDictation = useCallback(() => {
    if (!isTauri() || stateRef.current === 'idle' || stateRef.current === 'success' || stateRef.current === 'error') return;
    setState('transcribing');
    import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('o8_system_dictation_finish'))
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        dockLog(`finish system dictation failed: ${message}`);
        stateRef.current = 'error';
        setSnapshot({ state: 'error', audioLevel: 0, durationMs: 0, error: message || 'Could not finish dictation', partialTranscript: '' });
        returnToIdleAfter(ERROR_FLASH_MS);
      });
  }, [returnToIdleAfter, setState]);

  const handleTogglePause = useCallback(() => { invokeCmd('tts_toggle_pause'); }, []);
  const handleStop = useCallback(() => { invokeCmd('tts_stop'); }, []);
  // Tap-to-stop on the working capsule: cancel the running task(s) + any speech.
  const handleInterrupt = useCallback(() => { invokeCmd('agent_interrupt'); }, []);

  // Symon speaking speed (dock slider + durable). Seed from the persisted
  // reading_speed pref so the slider shows the real default on first paint;
  // a change applies live AND persists via tts_set_speed.
  const [speechSpeed, setSpeechSpeed] = useState(1);
  const [topPillEnabled, setTopPillEnabled] = useState(false);
  const topPillRevisionRef = useRef(0);
  useEffect(() => {
    if (!isTauri()) return;
    const revision = topPillRevisionRef.current;
    import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<Record<string, unknown>>('voice_prefs_get'))
      .then((prefs) => {
        if (topPillRevisionRef.current === revision) setTopPillEnabled(prefs?.dictation_top_pill === true);
        const raw = prefs?.reading_speed;
        const n = typeof raw === 'number' ? raw : Number(raw);
        if (Number.isFinite(n) && n > 0) setSpeechSpeed(Math.min(1.2, Math.max(0.7, n)));
      })
      .catch(() => { /* default 1× */ });
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let off: (() => void) | undefined;
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen<{ enabled?: boolean }>('o8:top-pill-preference', e => {
        topPillRevisionRef.current += 1;
        setTopPillEnabled(e.payload?.enabled === true);
      }))
      .then(unlisten => { if (disposed) unlisten(); else off = unlisten; })
      .catch(err => dockLog(`top-pill preference subscribe failed: ${String(err)}`));
    return () => { disposed = true; off?.(); };
  }, []);
  const handleSpeechSpeed = useCallback((rate: number) => {
    setSpeechSpeed(rate);
    invokeCmd('tts_set_speed', { rate });
  }, []);

  // Keep a ref of the live thread for the open-time resume decision.
  useEffect(() => { askThreadRef.current = askThread; }, [askThread]);

  const closeAsk = useCallback(() => {
    if (!askOpenRef.current) return;
    // Never collapse mid-turn: a pending in-panel dictation or a working agent
    // owns the panel until its answer lands (openPanel re-arms the idle timer).
    if (panelPendingRef.current || agentWorkingRef.current) return;
    askOpenRef.current = false;
    askLastClosedRef.current = Date.now();
    if (askIdleTimerRef.current) { clearTimeout(askIdleTimerRef.current); askIdleTimerRef.current = null; }
    setAskOpen(false);
    setAskMode('idle');
    invokeCmd('dock_set_expanded', { expanded: false });
  }, []);

  const armAskIdleTimer = useCallback(() => {
    if (askIdleTimerRef.current) clearTimeout(askIdleTimerRef.current);
    askIdleTimerRef.current = setTimeout(() => { closeAsk(); }, ASK_IDLE_COLLAPSE_MS);
  }, [closeAsk]);

  // Grow the dock into the full answer panel. Shared by the Ask flow and the
  // Symon agent flow (an agent result lands in the SAME Symon conversation).
  const openPanel = useCallback(() => {
    askOpenRef.current = true;
    setAskOpen(true);
    invokeCmd('dock_set_expanded', { expanded: true });
    armAskIdleTimer();
  }, [armAskIdleTimer]);

  // ── Ask answer panel events (o8:ask-open / -answer / -error) ──
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const offs: Array<() => void> = [];
    import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        const add = (u: () => void) => { if (disposed) u(); else offs.push(u); };
        add(await listen('o8:ask-open', () => {
          const within = Date.now() - askLastClosedRef.current < ASK_RESUME_WINDOW_MS;
          dockLog('ask-open');
          if (!within) setAskThread([]);
          askOpenRef.current = true;
          setAskOpen(true);
          setAskMode('listening');
          // Listening shows the compact capsule with the LIVE transcript +
          // waveform (driven by the system-origin dictation events) — don't grow
          // into the panel until the answer arrives.
          invokeCmd('dock_set_expanded', { expanded: false });
          armAskIdleTimer();
        }));
        add(await listen<{ question?: string; answer?: string }>('o8:ask-answer', (e) => {
          const q = e.payload?.question ?? '';
          const a = e.payload?.answer ?? '';
          dockLog(`ask-answer q="${q.slice(0, 40)}"`);
          setAskThread((prev) => {
            const next = [...prev, { role: 'user' as const, text: q }, { role: 'assistant' as const, text: a }];
            return next.length > ASK_MAX_TURNS ? next.slice(next.length - ASK_MAX_TURNS) : next;
          });
          setAskMode('answer');
          openPanel();
        }));
        add(await listen<{ message?: string }>('o8:ask-error', (e) => {
          const msg = e.payload?.message ?? 'Ask failed';
          dockLog(`ask-error ${msg.slice(0, 40)}`);
          setAskThread((prev) => [...prev, { role: 'assistant' as const, text: `Error: ${msg}` }]);
          setAskMode('answer');
          openPanel();
        }));
      })
      .catch((err) => dockLog(`ask subscribe failed: ${err instanceof Error ? err.message : String(err)}`));
    return () => {
      disposed = true;
      for (const off of offs) { try { off(); } catch { /* noop */ } }
    };
  }, [armAskIdleTimer, openPanel]);

  // Resolve a pending agent confirm card → tell Rust, clear the card locally.
  const handleAgentConfirm = useCallback((confirmationId: string, taskId: string, allow: boolean) => {
    invokeCmd('agent_confirm_exact', { confirmationId, taskId, allow });
    setAgentConfirm(null);
  }, [setAgentConfirm]);

  // Memory glint (dossier #4): a quiet one-line chip under the dock that fades
  // in, holds ~4s, fades out. Driven by `kind: glint` agent events.
  const [glint, setGlint] = useState<DockGlint | null>(null);
  const [glintFading, setGlintFading] = useState(false);
  const glintTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const showGlint = useCallback((
    text: string,
    options: { key?: string; tone?: DockGlint['tone'] } = {},
  ) => {
    for (const t of glintTimersRef.current) clearTimeout(t);
    glintTimersRef.current = [];
    setGlint({
      key: options.key ?? 'ambient',
      text,
      tone: options.tone ?? 'progress',
    });
    setGlintFading(false);
    glintTimersRef.current.push(setTimeout(() => setGlintFading(true), 4200));
    glintTimersRef.current.push(setTimeout(() => { setGlint(null); setGlintFading(false); }, 4800));
  }, []);
  useEffect(() => {
    return () => { for (const t of glintTimersRef.current) clearTimeout(t); };
  }, []);

  // Fleet visibility (dossier #8): worker-pulse pushes `o8:worker-status`;
  // the idle sliver carries the orbit + count, tap expands the detail capsule.
  const [workers, setWorkers] = useState<WorkerSnapshot>({ count: 0, working: 0, waiting: 0, repos: [] });
  const [parkedWorkers, setParkedWorkers] = useState<ParkedLaneSnapshot | null>(null);
  const [showWorkers, setShowWorkers] = useState(false);
  const showWorkersTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let workerUnlisten: (() => void) | undefined;
    let parkedUnlisten: (() => void) | undefined;
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen<{ count?: number; working?: number; waiting?: number; repos?: string[] }>('o8:worker-status', (e) => {
        const count = Math.max(0, e.payload?.count ?? 0);
        const waiting = Math.max(0, e.payload?.waiting ?? 0);
        const working = Math.max(0, e.payload?.working ?? (count - waiting));
        setWorkers({ count, working, waiting, repos: e.payload?.repos ?? [] });
        if (count === 0) setShowWorkers(false);
      }))
      .then((u) => { workerUnlisten = u; })
      .catch((err) => dockLog(`worker-status subscribe failed: ${err instanceof Error ? err.message : String(err)}`));
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen<ParkedLanesStatusPayload>('o8:parked-lanes-status', (e) => {
        // #2147 — an unstamped or already-expired payload is dropped. This
        // window outlives the dashboard, so without the check a count from a
        // previous run paints here indefinitely.
        if (!e.payload || !parkedSnapshotIsUsable(e.payload, Date.now())) return;
        const waiting = Math.max(0, e.payload.waiting ?? e.payload.count ?? 0);
        setParkedWorkers({
          waiting,
          repos: e.payload.repos ?? [],
          tooltip: e.payload.tooltip ?? null,
          receivedAt: Date.now(),
        });
        if (waiting === 0) setShowWorkers(false);
      }))
      .then((u) => { parkedUnlisten = u; })
      .catch((err) => dockLog(`parked-lanes-status subscribe failed: ${err instanceof Error ? err.message : String(err)}`));
    return () => {
      workerUnlisten?.();
      parkedUnlisten?.();
      if (showWorkersTimerRef.current) clearTimeout(showWorkersTimerRef.current);
    };
  }, []);

  // #2147 — expire the parked-lane snapshot when the dashboard stops
  // heartbeating it (reload, quit-to-tray, crashed render). Dropping it beats
  // showing a count that no longer describes anything in flight. The sweep reads
  // through a ref so the interval never has to re-subscribe, and so the staleness
  // check stays outside a state updater.
  const parkedWorkersRef = useRef(parkedWorkers);
  useEffect(() => { parkedWorkersRef.current = parkedWorkers; }, [parkedWorkers]);
  useEffect(() => {
    if (!isTauri()) return;
    const sweep = setInterval(() => {
      const current = parkedWorkersRef.current;
      if (!current) return;
      if (!parkedSnapshotIsStale({ emittedAt: current.receivedAt }, Date.now())) return;
      setParkedWorkers(null);
      setShowWorkers(false);
    }, Math.round(PARKED_LANES_STALE_AFTER_MS / 3));
    return () => clearInterval(sweep);
  }, []);

  // ── Symon voice agent events (o8:agent-confirm / o8:agent-task-event) ──
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const offs: Array<() => void> = [];
    import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        const add = (u: () => void) => { if (disposed) u(); else offs.push(u); };
        add(await listen<{ kind?: string; status?: string; taskId?: string; result?: string; intent?: string; tool?: string; glint?: string; text?: string; planId?: string; stepIndex?: number; stepCount?: number; summary?: string; sources?: Array<{ kind?: string; title?: string; url?: string }> }>('o8:agent-task-event', (e) => {
          const kind = e.payload?.kind;
          if (kind === 'plan_progress') {
            const progress = formatPlanProgressGlint(e.payload as PlanProgressEvent);
            if (progress) {
              showGlint(progress.text, { key: progress.key, tone: progress.tone });
            }
            return;
          }
          if (kind === 'tool_call') {
            // Track the live tool so the working capsule can say "Synthesizing…"
            // for the Brain (o8_ask) vs a generic "Working…".
            if (e.payload?.tool) setAgentTool(e.payload.tool);
            return;
          }
          if (kind === 'glint') {
            // Memory surfaced (dossier #4): one quiet line under the dock.
            // Free-text glints carry their own line (terminal watcher etc.).
            const g = e.payload?.glint;
            if (g === 'recovered') showGlint('Recovered — found another way');
            else if (g === 'remembered') showGlint('Remembered');
            else if (typeof e.payload?.text === 'string' && e.payload.text) showGlint(e.payload.text);
            return;
          }
          if (kind !== 'status') return;
          const status = e.payload?.status;
          const tid = e.payload?.taskId;
          if (status === 'cancelled') {
            // User interrupted (Escape / tap-to-stop). Drain the task and clear
            // the capsule if nothing else is running — no panel turn, no voice.
            if (tid) runningTasksRef.current.delete(tid);
            const stillWorking = runningTasksRef.current.size > 0;
            setAgentWorking(stillWorking);
            agentWorkingRef.current = stillWorking;
            if (!stillWorking) setAgentTool('');
            if (panelPendingRef.current?.phase === 'handoff') updatePanelPending(null);
            setAgentConfirm((c) => (c && c.taskId === tid ? null : c));
            return;
          }
          if (status === 'running') {
            // Start the timer only on the idle→working edge so a background task
            // spawning behind a still-visible foreground ack doesn't reset it.
            const wasIdle = runningTasksRef.current.size === 0;
            if (tid) runningTasksRef.current.add(tid);
            setAgentWorking(true);
            agentWorkingRef.current = true;
            setAgentTool('');
            if (wasIdle) setAgentStartedAt(Date.now());
            if (e.payload?.intent) agentIntentRef.current = e.payload.intent;
            // The agent claimed the pending in-panel turn: lock its text to
            // the polished intent and cancel the discard timeout.
            if (panelPendingRef.current) {
              if (pendingHandoffTimerRef.current) {
                clearTimeout(pendingHandoffTimerRef.current);
                pendingHandoffTimerRef.current = null;
              }
              updatePanelPending({
                phase: 'handoff',
                text: e.payload?.intent || panelPendingRef.current.text,
              });
            }
          } else if (status === 'done' || status === 'failed') {
            // Dual-emit guard: the dock receives this terminal event twice
            // (emit_to dock + broadcast). Handle each task's done once.
            if (tid && agentDoneRef.current === tid) return;
            if (tid) agentDoneRef.current = tid;
            // Drain this task; keep the capsule lit if another (e.g. the
            // background brain behind a foreground ack) is still running.
            if (tid) runningTasksRef.current.delete(tid);
            const stillWorking = runningTasksRef.current.size > 0;
            setAgentWorking(stillWorking);
            agentWorkingRef.current = stillWorking;
            if (!stillWorking) setAgentTool('');
            // The real turns replace the pending in-panel rows in place — but
            // ONLY a handed-off pending. A listening/polishing pending belongs
            // to a NEWER dictation the user already started over this task.
            if (panelPendingRef.current?.phase === 'handoff') updatePanelPending(null);
            // Only clear a pending confirm if it belongs to THIS task.
            setAgentConfirm((c) => (c && c.taskId === tid ? null : c));
            // Show the spoken answer in the panel instead of collapsing to idle.
            // The agent IS Symon, so it lands in the same conversation thread:
            // the intent as a "You" turn, the result as a "Symon" turn.
            const intent = agentIntentRef.current.trim();
            const answer = (e.payload?.result ?? '').trim()
              || (status === 'failed' ? 'Symon hit an error.' : 'Done.');
            // Titled Brain sources (when the run consulted o8_ask) render as
            // a quiet meta line under the answer — sources-parity 2026-06-11.
            const sources = Array.isArray(e.payload?.sources)
              ? e.payload.sources
                  .filter((s) => typeof s?.title === 'string' && s.title)
                  .map((s) => ({ kind: s.kind ?? 'source', title: s.title as string, url: s.url }))
              : undefined;
            agentIntentRef.current = '';
            setAskThread((prev) => {
              const turns: AskTurn[] = [];
              if (intent) turns.push({ role: 'user', text: intent });
              turns.push({ role: 'assistant', text: answer, sources: sources && sources.length > 0 ? sources : undefined });
              const next = [...prev, ...turns];
              return next.length > ASK_MAX_TURNS ? next.slice(next.length - ASK_MAX_TURNS) : next;
            });
            setAskMode('answer');
            openPanel();
          }
        }));
      })
      .catch((err) => dockLog(`agent subscribe failed: ${err instanceof Error ? err.message : String(err)}`));
    return () => {
      disposed = true;
      for (const off of offs) { try { off(); } catch { /* noop */ } }
    };
  }, [openPanel, setAgentConfirm, showGlint, updatePanelPending]);

  // Escape collapses the open Ask panel.
  useEffect(() => {
    if (!isTauri()) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && askOpenRef.current) closeAsk(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeAsk]);

  // Drag-files-into-Symon (dossier #3): a Finder drag over the dock morphs the
  // sliver into the glass drop zone; a drop stages content for the next ⌥-ask
  // (agent_files_stage) and shows the chips for a beat before relaxing.
  const [stagedChips, setStagedChips] = useState<StagedChip[] | null>(null);
  const stagedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropActive = useDockFileDrop(useCallback((chips: StagedChip[]) => {
    setStagedChips(chips);
    dockLog(`staged ${chips.length} dropped file(s)`);
    if (stagedTimerRef.current) clearTimeout(stagedTimerRef.current);
    stagedTimerRef.current = setTimeout(() => setStagedChips(null), 6000);
  }, []));
  useEffect(() => {
    return () => {
      if (stagedTimerRef.current) clearTimeout(stagedTimerRef.current);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  // Hit-rect reporting: the dock WINDOW is a 520-wide strip that would hijack
  // every click at the top of the screen, so the Rust side keeps it
  // click-through except while the cursor is over the PAINTED pill. Report the
  // content wrapper's rect on every morph (ResizeObserver fires through the
  // 0.5s geometry transition; rAF-throttled so we invoke at most per-frame).
  const nativeDictation = useNativeDictationPill(snapshot);
  const [editVisible, setEditVisible] = useState(false);
  const webSnapshot = nativeDictation ? IDLE_SNAPSHOT : snapshot;
  const hitRectHostRef = useRef<HTMLDivElement | null>(null);
  const dockVisible = (!nativeDictation && (topPillEnabled || snapshot.state !== 'idle')) || ttsState !== 'idle'
    || askOpen || agentWorking || !!agentConfirm || realtimeVoice !== 'off'
    || (nativeDictation && (editVisible || dropActive || !!stagedChips || (workers.count > 0 || (parkedWorkers?.waiting ?? 0) > 0) || !!glint));
  useEffect(() => {
    if (!isTauri()) return;
    if (!dockVisible) {
      // Invisible overlays must never retain a click-accepting strip.
      invokeCmd('dock_set_hit_rect', { x: 0, y: 0, w: 0, h: 0 });
      return;
    }
    const host = hitRectHostRef.current;
    if (!host) return;
    let raf = 0;
    const report = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const r = host.getBoundingClientRect();
        invokeCmd('dock_set_hit_rect', { x: r.left, y: r.top, w: r.width, h: r.height });
      });
    };
    const ro = new ResizeObserver(report);
    ro.observe(host);
    report();
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [dockVisible]);

  // The dock window is transparent at the OS level (clearColor + setOpaque
  // false). The page's html/body must NOT paint a background or the window
  // shows a solid rectangle instead of just the pill. globals.css / the root
  // layout set #1C1C1E; override to transparent for this surface only.
  useEffect(() => {
    const prevHtmlBg = document.documentElement.style.background;
    const prevBodyBg = document.body.style.background;
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    return () => {
      document.documentElement.style.background = prevHtmlBg;
      document.body.style.background = prevBodyBg;
    };
  }, []);

  const displayedWaiting = parkedWorkers?.waiting ?? workers.waiting;
  const displayedWorkers = {
    count: parkedWorkers ? workers.working + displayedWaiting : workers.count,
    working: workers.working,
    waiting: displayedWaiting,
    repos: parkedWorkers
      ? Array.from(new Set([...workers.repos, ...parkedWorkers.repos])).filter(Boolean).slice(0, 4)
      : workers.repos,
    waitingLabel: parkedWorkers ? 'ready' : 'waiting',
    tooltip: parkedWorkers?.tooltip ?? null,
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: dockVisible ? 'flex' : 'none',
        alignItems: 'flex-start',
        justifyContent: 'center',
        // Keep a small internal inset so the rounded top corners are visible
        // when the dock window is floating instead of flush to a screen notch.
        paddingTop: 8,
        paddingLeft: 28,
        paddingRight: 28,
        boxSizing: 'border-box',
        background: 'transparent',
        // The React layer keeps the dead-zone tight: the wrapper ignores
        // pointer events, only the pill itself (hideCancel = no buttons) sits
        // on top. set_ignore_cursor_events stays FALSE on the Rust side.
        pointerEvents: 'none',
      }}
    >
      <div
        style={{ pointerEvents: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center' }}
        onMouseMove={() => { if (askOpenRef.current) armAskIdleTimer(); }}
        onClick={() => {
          // Tap the resting sliver while the worker orbit is up → transient
          // capsule naming the in-flight packets (dossier #8).
          if (snapshot.state === 'idle' && ttsState === 'idle' && !askOpen && !agentWorking && displayedWorkers.count > 0) {
            setShowWorkers(true);
            if (showWorkersTimerRef.current) clearTimeout(showWorkersTimerRef.current);
            showWorkersTimerRef.current = setTimeout(() => setShowWorkers(false), 5000);
          }
        }}
        onDoubleClick={() => {
          // Double-tap the IDLE dock to open the standalone Voice settings
          // window (Symon parity — works even with the main app closed). Gated
          // to idle so it never fires over the ask panel / speaking controls.
          if (snapshot.state === 'idle' && ttsState === 'idle' && !askOpen) {
            invokeCmd('open_voice_settings');
          }
        }}
      >
        {/* The ONE morphing notch dock — idle ⇄ listening ⇄ thinking ⇄ done ⇄
            ask, in place (Symon NotchSurface). Not the in-window floating pill.
            The hit-rect ref wraps ONLY the pill — the glint chip below is
            visual-only (pointer-events none) and must not extend the
            click-accepting zone over the menu bar. */}
        <div ref={hitRectHostRef} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <DockNotchSurface
            snapshot={webSnapshot}
            ttsState={ttsState}
            onTogglePause={handleTogglePause}
            onStop={handleStop}
            onInterrupt={handleInterrupt}
            speechSpeed={speechSpeed}
            onSpeechSpeed={handleSpeechSpeed}
            askOpen={askOpen}
            askMode={askMode}
            askThread={askThread}
            onCloseAsk={closeAsk}
            agentConfirm={agentConfirm}
            agentWorking={agentWorking}
            agentTool={agentTool}
            agentStartedAt={agentStartedAt}
            onAgentConfirm={handleAgentConfirm}
            dropActive={dropActive}
            stagedFiles={stagedChips}
            workerCount={displayedWorkers.count}
            workerWorking={displayedWorkers.working}
            workerWaiting={displayedWorkers.waiting}
            workerWaitingLabel={displayedWorkers.waitingLabel}
            workerTooltip={displayedWorkers.tooltip}
            workerRepos={displayedWorkers.repos}
            showWorkers={showWorkers}
            panelPending={nativeDictation ? null : panelPending}
            realtimeVoice={realtimeVoice}
            onStopRealtime={stopRealtimeVoice}
            onFinishDictation={finishSystemDictation}
          />
          <EditRevertChip onError={dockLog} onVisible={setEditVisible} />
        </div>
        {glint ? <DockGlint key={glint.key} glint={glint} fading={glintFading} /> : null}
      </div>
    </div>
  );
}
