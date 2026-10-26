/**
 * TTSEngine — unified TTS playback for o8.
 *
 * Desktop (Tauri): routes to the native Rust streaming engine via the
 *   `tts_speak` command — the Symon `reading.rs` port (src-tauri/src/tts/
 *   playback.rs): a ~200-char lead chunk cut at a clause boundary (first audio
 *   ~1–2s), a one-chunk-lookahead prefetch (no gap between chunks), single-
 *   flight, process reaping, and a macOS `say` safety net. Playback state
 *   mirrors back through the `o8:tts-state` event. Uses the app's read-aloud
 *   voice (Google Neural2-J / ElevenLabs), matching the dock / Ask panel.
 * Browser / mobile: server-side edge-tts via /api/tts (en-US-SteffanNeural),
 *   then browser SpeechSynthesis (offline fallback).
 *
 * The desktop reroute exists because the old edge-tts path synthesized the
 * ENTIRE response before a word played (1–2 min on long replies) and cold-
 * spawned an un-reaped python per click. The native engine already solves both.
 *
 * Used by both desktop and mobile message action bars.
 */

import { isTauri } from '@/lib/tauri/bridge';
import { isEdgeVoiceError, type EdgeVoiceError } from '@/lib/tts/edge-voice-error';

export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

export interface TTSEngineState {
  state: PlaybackState;
  currentTime: number;
  duration: number;
  playbackRate: number;
  activeMessageId: string | null;
  usingFallback: boolean;
  voiceError: EdgeVoiceError | null;
  /** The source block currently being spoken, for voice-playback line
   *  highlighting (desktop native path only — mirrors the Rust `o8:tts-chunk`
   *  event). `null` when idle or on the web fallback (no boundary signal). */
  activeChunk: {
    messageId: string;
    srcStart: number;
    srcEnd: number;
    chunkIndex: number;
    chunkCount: number;
  } | null;
}

type StateListener = (state: TTSEngineState) => void;

class TTSEngineImpl {
  private audio: HTMLAudioElement | null = null;
  private currentBlobUrl: string | null = null;
  private utterance: SpeechSynthesisUtterance | null = null;
  private listeners = new Set<StateListener>();
  private _state: TTSEngineState = {
    state: 'idle',
    currentTime: 0,
    duration: 0,
    playbackRate: 1,
    activeMessageId: null,
    usingFallback: false,
    voiceError: null,
    activeChunk: null,
  };
  private animFrameId: number | null = null;
  // Set up the native `o8:tts-state` subscription exactly once (desktop only).
  private tauriListenerSetup = false;
  private webPlayback = false;

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this._state);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) {
      listener({ ...this._state });
    }
  }

  private updateState(patch: Partial<TTSEngineState>) {
    Object.assign(this._state, patch);
    this.emit();
  }

  private startTimeTracking() {
    const tick = () => {
      if (this.audio && this._state.state === 'playing') {
        this.updateState({
          currentTime: this.audio.currentTime,
          duration: this.audio.duration || 0,
        });
      }
      this.animFrameId = requestAnimationFrame(tick);
    };
    this.animFrameId = requestAnimationFrame(tick);
  }

  private stopTimeTracking() {
    if (this.animFrameId != null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  /** Play a message. Desktop → native streaming engine; browser → edge-tts. */
  async play(text: string, messageId: string): Promise<void> {
    this.cleanup();
    this.webPlayback = false;
    if (isTauri()) return this.playViaTauri(text, messageId);
    return this.playViaWeb(text, messageId);
  }

  /** Explicit no-key read aloud, including desktop: Edge, then system speech only. */
  async playNoKey(text: string, messageId: string): Promise<void> {
    // Release prior native reading before starting browser audio on desktop.
    if (isTauri() && !this.webPlayback && this._state.activeMessageId) this.invokeTauri('tts_stop');
    this.webPlayback = true;
    return this.playViaWeb(text, messageId);
  }

  // ── Desktop: native Rust streaming engine (Symon reading.rs port) ──

  private async playViaTauri(text: string, messageId: string): Promise<void> {
    this.setupTauriStateListener();
    this.updateState({
      state: 'loading',
      activeMessageId: messageId,
      currentTime: 0,
      duration: 0,
      usingFallback: false,
      voiceError: null,
    });
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      if (this._state.activeMessageId !== messageId || this.webPlayback) return;
      // Raw text on purpose — the Rust engine runs its own speech_text
      // normalization (numbers / units / URLs / markdown) + chunking. Its
      // single-flight supersedes any current playback, so we deliberately do
      // NOT stop() first: a stop would emit a spurious `idle` that races the
      // new `playing` and clears activeMessageId.
      await invoke('tts_speak', { text, messageId });
      // state transitions ('playing' → 'idle') arrive via o8:tts-state, and the
      // spoken-block spans (for line highlighting) via o8:tts-chunk.
    } catch (err) {
      if (this._state.activeMessageId !== messageId || this.webPlayback) return;
      console.warn('[TTS] Native tts_speak failed, using web path:', err);
      await this.playViaWeb(text, messageId);
    }
  }

  /** Mirror native playback state into the engine so the ▷/stop toggle stays
   *  honest. Idempotent — subscribes once for the life of the singleton. */
  private setupTauriStateListener() {
    if (this.tauriListenerSetup) return;
    this.tauriListenerSetup = true;
    import('@tauri-apps/api/event')
      .then(({ listen }) => {
        void listen<{ state?: 'idle' | 'playing' | 'paused'; messageId?: string | null; usingFallback?: boolean; voiceError?: unknown }>('o8:tts-state', (e) => {
          if (this.webPlayback) return;
          if (e.payload?.usingFallback) {
            // A late native fallback must not warn on a stopped/new message or
            // on unrelated Symon read-back (which has no message ID).
            if (typeof e.payload.messageId !== 'string' || e.payload.messageId !== this._state.activeMessageId) return;
            this.updateState({
              state: 'playing',
              usingFallback: true,
              voiceError: isEdgeVoiceError(e.payload.voiceError) ? e.payload.voiceError : null,
              activeChunk: null,
            });
            return;
          }
          const next = e.payload?.state;
          if (next === 'playing') {
            this.updateState({ state: 'playing' });
          } else if (next === 'paused') {
            this.updateState({ state: 'paused' });
          } else if (next === 'idle') {
            // Clear the highlight alongside the active message on stop/complete;
            // leave activeChunk untouched on paused/playing.
            this.updateState({ state: 'idle', activeMessageId: null, activeChunk: null, currentTime: 0, duration: 0 });
          }
        });
        void listen<{ messageId?: string; chunkIndex?: number; chunkCount?: number; srcStart?: number; srcEnd?: number }>('o8:tts-chunk', (e) => {
          const p = e.payload;
          // Only reflect chunks for the message we believe is active — guards a
          // late chunk from a playback that a newer speak already superseded.
          if (!p || typeof p.messageId !== 'string' || p.messageId !== this._state.activeMessageId) {
            return;
          }
          this.updateState({
            activeChunk: {
              messageId: p.messageId,
              srcStart: p.srcStart ?? 0,
              srcEnd: p.srcEnd ?? 0,
              chunkIndex: p.chunkIndex ?? 0,
              chunkCount: p.chunkCount ?? 0,
            },
          });
        });
      })
      .catch((err) => {
        console.warn('[TTS] o8:tts-state subscribe failed:', err);
        this.tauriListenerSetup = false; // allow a retry on the next play
      });
  }

  private invokeTauri(cmd: string, args?: Record<string, unknown>) {
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke(cmd, args))
      .catch((err) => console.warn(`[TTS] invoke ${cmd} failed:`, err));
  }

  // ── Browser / mobile: server-side edge-tts → SpeechSynthesis ──

  private async playViaWeb(text: string, messageId: string): Promise<void> {
    this.cleanup();
    this.webPlayback = true;
    this.updateState({
      state: 'loading',
      activeMessageId: messageId,
      currentTime: 0,
      duration: 0,
      usingFallback: false,
      voiceError: null,
    });

    const cleanText = stripMarkdown(text);

    // Try server-side edge-tts
    try {
      console.log('[TTS] Requesting /api/tts...');
      const resp = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: cleanText, voice: 'en-US-SteffanNeural' }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        if (this._state.activeMessageId !== messageId) return;
        try {
          const { code } = JSON.parse(errText);
          if (isEdgeVoiceError(code)) this.updateState({ voiceError: code });
        } catch { /* Older servers may return a plain-text error. */ }
        throw new Error(`TTS API ${resp.status}: ${errText}`);
      }

      const blob = await resp.blob();
      console.log(`[TTS] Got audio: ${blob.size} bytes`);

      if (this._state.activeMessageId !== messageId) {
        return; // Stopped during request
      }

      const blobUrl = URL.createObjectURL(blob);
      this.currentBlobUrl = blobUrl;
      this.audio = new Audio(blobUrl);
      this.audio.playbackRate = this._state.playbackRate;

      this.audio.onplay = () => {
        this.updateState({ state: 'playing' });
        this.startTimeTracking();
      };

      this.audio.onpause = () => {
        if (this._state.state !== 'idle') {
          this.updateState({ state: 'paused' });
        }
      };

      this.audio.onended = () => {
        this.cleanup();
        this.updateState({
          state: 'idle',
          activeMessageId: null,
          currentTime: 0,
          duration: 0,
        });
      };

      this.audio.onerror = () => {
        console.warn('[TTS] Audio playback error, trying fallback');
        this.cleanup();
        this.playFallback(cleanText, messageId);
      };

      await this.audio.play();
      console.log('[TTS] Playing Mister voice (SteffanNeural)');
      return;
    } catch (err) {
      console.warn('[TTS] Server-side TTS failed, using fallback:', err);
      if (this._state.activeMessageId === messageId) this.playFallback(cleanText, messageId);
    }
  }

  /** Fallback: browser SpeechSynthesis API */
  private playFallback(text: string, messageId: string) {
    if (!('speechSynthesis' in window)) {
      this.updateState({ state: 'error', activeMessageId: null });
      return;
    }

    console.log('[TTS] Using SpeechSynthesis fallback');
    this.updateState({
      state: 'playing',
      activeMessageId: messageId,
      usingFallback: true,
    });

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = this._state.playbackRate;
    utterance.lang = 'en-US';

    // Prefer a MALE voice to match the product's Steffan voice — the old
    // Samantha-first pick was the "choppy female" a keyless machine heard when
    // edge-tts was unavailable (Q report 2026-07-15). Fall through to any en-US
    // only if no known male voice is installed.
    const voices = speechSynthesis.getVoices();
    const preferred = voices.find(v => v.name.includes('Alex'))
      ?? voices.find(v => v.name.includes('Daniel'))
      ?? voices.find(v => v.name.includes('Fred'))
      ?? voices.find(v => v.lang === 'en-US' && v.localService)
      ?? voices.find(v => v.lang === 'en-US');
    if (preferred) utterance.voice = preferred;

    utterance.onend = () => {
      if (this._state.activeMessageId !== messageId) return;
      this.updateState({
        state: 'idle',
        activeMessageId: null,
        currentTime: 0,
        duration: 0,
      });
    };

    utterance.onerror = () => {
      if (this._state.activeMessageId !== messageId) return;
      this.updateState({ state: 'error', activeMessageId: null });
    };

    this.utterance = utterance;
    speechSynthesis.speak(utterance);
  }

  pause() {
    if (isTauri() && !this.webPlayback) {
      if (this._state.state === 'playing') this.invokeTauri('tts_toggle_pause');
      return;
    }
    if (this.audio && this._state.state === 'playing') {
      this.audio.pause();
    } else if (this.utterance && this._state.state === 'playing') {
      speechSynthesis.pause();
      this.updateState({ state: 'paused' });
    }
  }

  resume() {
    if (isTauri() && !this.webPlayback) {
      if (this._state.state === 'paused') this.invokeTauri('tts_toggle_pause');
      return;
    }
    if (this.audio && this._state.state === 'paused') {
      void this.audio.play();
    } else if (this.utterance && this._state.state === 'paused') {
      speechSynthesis.resume();
      this.updateState({ state: 'playing' });
    }
  }

  stop() {
    if (isTauri() && !this.webPlayback) this.invokeTauri('tts_stop');
    this.cleanup();
    this.updateState({
      state: 'idle',
      activeMessageId: null,
      currentTime: 0,
      duration: 0,
    });
  }

  seek(seconds: number) {
    if (this.audio && Number.isFinite(this.audio.duration)) {
      this.audio.currentTime = Math.max(0, Math.min(seconds, this.audio.duration));
    }
  }

  seekRelative(delta: number) {
    if (this.audio && Number.isFinite(this.audio.duration)) {
      this.seek(this.audio.currentTime + delta);
    }
  }

  setRate(rate: number) {
    this.updateState({ playbackRate: rate });
    if (isTauri() && !this.webPlayback) {
      this.invokeTauri('tts_set_speed', { rate });
      return;
    }
    if (this.audio) this.audio.playbackRate = rate;
  }

  get state(): TTSEngineState {
    return { ...this._state };
  }

  private cleanup() {
    this.stopTimeTracking();
    if (this.audio) {
      this.audio.pause();
      this.audio.onplay = null;
      this.audio.onpause = null;
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio = null;
    }
    if (this.currentBlobUrl) {
      URL.revokeObjectURL(this.currentBlobUrl);
      this.currentBlobUrl = null;
    }
    if (this.utterance) {
      this.utterance.onend = null;
      this.utterance.onerror = null;
      speechSynthesis.cancel();
      this.utterance = null;
    }
  }
}

/** Strip markdown for cleaner speech */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' code block omitted ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\|/g, ', ')
    .replace(/^[\s-:]+$/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*_]{3,}$/gm, '')
    .replace(/─\s*\w+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const ttsEngine = new TTSEngineImpl();
