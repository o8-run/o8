'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri, canUseTauriEvents } from '@/lib/tauri/bridge';
import type { DictationSnapshot, DictationStartOptions, DictationState } from './types';

const SUCCESS_FLASH_MS = 600;
const ERROR_FLASH_MS = 2500;

/**
 * Native (Apple-Speech sidecar) dictation path — OPT-IN alternate to
 * `useDictation`. It drives the Tauri `o8_stt_*` commands and listens to the
 * `o8:stt-event` window event emitted by the Rust STT engine (lifted from
 * aqua/Symon). The polished result arrives on the `polished` event after the
 * finalize chain (Whisper re-transcribe → Gemini polish) runs in Rust.
 *
 * This does NOT replace the webkitSpeechRecognition + HTTP `/api/dictation`
 * path in `useDictation.ts` — both ship. Callers choose the native path by
 * importing this hook (e.g. behind a settings flag). `isNativeDictationAvailable()`
 * reports whether the Tauri bridge is present.
 *
 * NOTE: o8 runs with `withGlobalTauri` off, so `window.__TAURI__` is undefined.
 * Detection + invoke/listen go through the same path as `@/lib/tauri/bridge`
 * (`'__TAURI_INTERNALS__' in window` + dynamic `import('@tauri-apps/api/*')`).
 */

export async function sttInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export function isNativeDictationAvailable(): boolean {
  return isTauri();
}

export interface SttEventPayload {
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
  /**
   * Origin discriminator (system-wide Symon fold P3 review HIGH). `o8:stt-event`
   * is broadcast to ALL windows; the SCREEN DOCK pill (`/dictation-pill`) owns
   * `origin === 'system'` (global-Fn) sessions, and this in-window hook owns
   * `in-window` (mic-button) sessions. We explicitly drop system-origin events
   * so a global-Fn dictation never bleeds into the composer pill — even though
   * `start()` gating already makes it inert, this is the belt-and-suspenders
   * guard the review asked for.
   */
  origin?: 'system' | 'in-window';
  /** Session lane: 'agent' = Right-Option Symon command (never painted here). */
  lane?: string;
  /** Opt-in Fn partials HUD (`fn_hud_partials`) — when the outside-the-window
   *  HUD owns this session's partials, this pill stands down too. */
  hud?: boolean;
  sessionId?: number;
  text?: string;
  level?: number;
  rawText?: string;
  appleText?: string;
  whisperUsed?: boolean;
}

export function useNativeDictation() {
  const [snapshot, setSnapshot] = useState<DictationSnapshot>({
    state: 'idle',
    audioLevel: 0,
    durationMs: 0,
    error: null,
    partialTranscript: '',
  });

  const stateRef = useRef<DictationState>('idle');
  const optionsRef = useRef<DictationStartOptions | null>(null);
  const sessionIdRef = useRef<number>(0);
  const systemActiveRef = useRef(false);
  const systemAgentRef = useRef(false);
  const startTimeRef = useRef<number>(0);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  const setState = useCallback((next: DictationState, patch?: Partial<DictationSnapshot>) => {
    stateRef.current = next;
    setSnapshot((prev) => ({ ...prev, ...patch, state: next }));
  }, []);

  const returnToIdleAfter = useCallback((ms: number) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => {
      flashTimerRef.current = null;
      setSnapshot({ state: 'idle', audioLevel: 0, durationMs: 0, error: null, partialTranscript: '' });
      stateRef.current = 'idle';
    }, ms);
  }, []);

  const goError = useCallback((message: string) => {
    stateRef.current = 'error';
    setSnapshot({ state: 'error', audioLevel: 0, durationMs: 0, error: message, partialTranscript: '' });
    returnToIdleAfter(ERROR_FLASH_MS);
    optionsRef.current?.onAbort?.(message);
  }, [returnToIdleAfter]);

  const handleEvent = useCallback((payload: SttEventPayload) => {
    const systemEvent = payload.origin === 'system' || payload.type === 'system-pasted' || payload.type === 'system-start' || payload.type === 'system-idle';
    if (systemEvent) {
      // Agent-mode (Right-Option) sessions NEVER paint the in-window pill —
      // their partials belong to the canvas presence pill / screen surfaces.
      // Same for Fn sessions tagged `hud: true` (the opt-in outside-the-window
      // partials HUD owns them). Only `system-start` carries the tags, so latch
      // for the session and swallow everything until it tears down (2026-07-08:
      // the big white pill was double-painting over the black partials bar).
      if (payload.type === 'system-start') {
        systemAgentRef.current = payload.lane === 'agent' || payload.hud === true;
      }
      if (systemAgentRef.current) {
        if (payload.type === 'system-idle' || payload.type === 'system-pasted' || payload.type === 'error') {
          systemAgentRef.current = false;
        }
        return;
      }
      if (payload.sessionId !== undefined) sessionIdRef.current = payload.sessionId;
      switch (payload.type) {
        case 'system-start':
          systemActiveRef.current = true;
          sessionIdRef.current = payload.sessionId ?? 0;
          startTimeRef.current = Date.now();
          setState('recording', { audioLevel: 0, durationMs: 0, error: null, partialTranscript: '' });
          break;
        case 'system-idle':
          if (systemActiveRef.current) {
            systemActiveRef.current = false;
            sessionIdRef.current = 0;
            setSnapshot({ state: 'idle', audioLevel: 0, durationMs: 0, error: null, partialTranscript: '' });
            stateRef.current = 'idle';
          }
          break;
        case 'level':
          if (systemActiveRef.current && stateRef.current === 'recording' && typeof payload.level === 'number') {
            const level = Math.min(1, payload.level);
            const duration = Date.now() - startTimeRef.current;
            setSnapshot((prev) => (prev.state === 'recording'
              ? { ...prev, audioLevel: level, durationMs: duration }
              : prev));
          }
          break;
        case 'partial':
          if (systemActiveRef.current && stateRef.current === 'recording' && typeof payload.text === 'string') {
            setSnapshot((prev) => (prev.state === 'recording' && prev.partialTranscript !== payload.text
              ? { ...prev, partialTranscript: payload.text ?? '' }
              : prev));
          }
          break;
        case 'final':
          if (systemActiveRef.current && stateRef.current === 'recording') setState('transcribing');
          break;
        case 'audio_file':
          if (systemActiveRef.current && stateRef.current === 'transcribing') setState('polishing');
          break;
        case 'system-pasted':
          if (systemActiveRef.current) {
            systemActiveRef.current = false;
            sessionIdRef.current = 0;
            setState('success', { audioLevel: 0 });
            returnToIdleAfter(SUCCESS_FLASH_MS);
          }
          break;
        case 'error':
          if (systemActiveRef.current) {
            systemActiveRef.current = false;
            sessionIdRef.current = 0;
            goError(payload.text ?? 'Dictation failed');
          }
          break;
        default:
          break;
      }
      return;
    }
    // Origin discriminator: the in-window pill never reacts to system (global-Fn)
    // dictation — that surface is owned by the screen dock window. `system-pasted`
    // is system by construction. See SttEventPayload.origin.
    if (payload.origin === 'system') return;
    // Only react to events for the active session (rapid-tap safety).
    if (
      payload.sessionId !== undefined
      && sessionIdRef.current !== 0
      && payload.sessionId !== sessionIdRef.current
    ) {
      return;
    }
    switch (payload.type) {
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
          setSnapshot((prev) => (prev.state === 'recording' && prev.partialTranscript !== payload.text
            ? { ...prev, partialTranscript: payload.text ?? '' }
            : prev));
        }
        break;
      case 'final':
        // Apple's final transcript — move to transcribing while the Rust
        // finalize chain (Whisper → polish) runs. The `polished` event lands next.
        if (stateRef.current === 'recording') {
          setState('transcribing');
        }
        break;
      case 'audio_file':
        if (stateRef.current === 'transcribing') {
          setState('polishing');
        }
        break;
      case 'polished': {
        const options = optionsRef.current;
        const finalText = (payload.text ?? payload.rawText ?? payload.appleText ?? '').trim();
        if (!finalText) {
          setSnapshot({ state: 'idle', audioLevel: 0, durationMs: 0, error: null, partialTranscript: '' });
          stateRef.current = 'idle';
          options?.onAbort?.('No speech detected.');
          break;
        }
        setState('success', { audioLevel: 0 });
        options?.onComplete(finalText);
        returnToIdleAfter(SUCCESS_FLASH_MS);
        break;
      }
      case 'error':
        if (stateRef.current === 'recording' || stateRef.current === 'transcribing' || stateRef.current === 'polishing') {
          goError(payload.text ?? 'Dictation failed');
        }
        break;
      default:
        break;
    }
  }, [goError, returnToIdleAfter, setState]);

  // Install the o8:stt-event listener once.
  useEffect(() => {
    // Main-window only — this listener in the native browser-view would
    // ACL-crash (see canUseTauriEvents).
    if (!canUseTauriEvents()) return;
    let disposed = false;
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen<SttEventPayload>('o8:stt-event', (e) => handleEvent(e.payload)))
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlistenRef.current = unlisten;
      })
      .catch((err) => {
        console.warn('[native-dictation] failed to subscribe to o8:stt-event', err);
      });
    return () => {
      disposed = true;
      if (unlistenRef.current) {
        try { unlistenRef.current(); } catch { /* noop */ }
        unlistenRef.current = null;
      }
    };
  }, [handleEvent]);

  const start = useCallback(async (options: DictationStartOptions) => {
    if (stateRef.current !== 'idle' && stateRef.current !== 'error') return;
    if (!isTauri()) {
      goError('Native dictation unavailable');
      return;
    }
    if (flashTimerRef.current) {
      clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
    optionsRef.current = options;
    setState('requesting-mic', { audioLevel: 0, durationMs: 0, error: null, partialTranscript: '' });
    try {
      const sessionId = await sttInvoke<number>('o8_stt_start');
      sessionIdRef.current = sessionId;
      startTimeRef.current = Date.now();
      setState('recording', { audioLevel: 0, durationMs: 0, error: null, partialTranscript: '' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[native-dictation] o8_stt_start failed', err);
      goError(msg || 'Could not start dictation');
    }
  }, [goError, setState]);

  const stopAndSubmit = useCallback(async () => {
    if (stateRef.current !== 'recording') return;
    if (!isTauri()) return;
    // Move to transcribing; the `final`/`audio_file`/`polished` events drive
    // the rest of the state machine.
    setState('transcribing');
    try {
      await sttInvoke(systemActiveRef.current ? 'o8_system_dictation_finish' : 'o8_stt_stop');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[native-dictation] o8_stt_stop failed', err);
      goError(msg || 'Could not stop dictation');
    }
  }, [goError, setState]);

  const cancel = useCallback(() => {
    if (stateRef.current === 'idle') return;
    // Bump the session so any in-flight events are ignored.
    sessionIdRef.current += 1;
    if (isTauri()) {
      sttInvoke('o8_stt_stop').catch(() => { /* noop */ });
    }
    setSnapshot({ state: 'idle', audioLevel: 0, durationMs: 0, error: null, partialTranscript: '' });
    stateRef.current = 'idle';
    optionsRef.current?.onAbort?.(null);
  }, []);

  const setLocale = useCallback(async (locale: string) => {
    if (!isTauri()) return;
    try {
      await sttInvoke('o8_stt_locale', { locale });
    } catch (err) {
      console.warn('[native-dictation] o8_stt_locale failed', err);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  return { snapshot, start, stopAndSubmit, cancel, setLocale };
}
