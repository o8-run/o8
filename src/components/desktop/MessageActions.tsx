'use client';

/**
 * MessageActions — inline action bar under each agent message.
 *
 * Default mode:  ▶ Play  📋 Copy  🔖 Keep
 * Playing mode:  ⏪ 10s  ⏸ Pause  ⏩ 10s  1x  0:24/1:47  ■ Stop
 *
 * The row morphs in place — zero new UI elements (Option A).
 * Option B (floating pill) filed for later enhancement.
 *
 * Trimmed 2026-06-22 (operator): dropped 👍/👎 (good/bad response) and ⎇ Fork —
 * Codex doesn't surface them and they cluttered the row. Play + Copy + Keep stay.
 */

import { memo, useCallback, useEffect, useState } from 'react';
import {
  Check,
  Bookmark,
  Copy,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Square,
  Volume2,
} from './lucide-shims';
import { ttsEngine, type PlaybackState, type TTSEngineState } from '@/lib/tts/engine';
import { edgeVoiceNotice, type EdgeVoiceError } from '@/lib/tts/edge-voice-error';

const THEME_ACCENT = 'var(--t-accent, #2563eb)';
const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))';
const THEME_ACCENT_BORDER = 'var(--t-accent-border, rgba(37, 99, 235, 0.22))';

interface MessageActionsProps {
  messageId: string;
  messageText: string;
  canPinContext?: boolean;
  isPinnedContext?: boolean;
  onTogglePinContext?: () => void;
  /** @deprecated Fork button removed 2026-06-22. Prop retained so existing
   *  callers typecheck without a ripple; it is intentionally ignored. */
  onFork?: () => void;
}

const iconBtnBase: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 26,
  height: 26,
  borderRadius: 7,
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--t-text-secondary)',
  cursor: 'pointer',
  transition: 'background-color 140ms ease, border-color 140ms ease, color 140ms ease',
  paddingTop: 0,
  paddingRight: 0,
  paddingBottom: 0,
  paddingLeft: 0,
};

const RATES = [1, 1.25, 1.5, 2];

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export const MessageActions = memo(function MessageActions({
  messageId,
  messageText,
  canPinContext = false,
  isPinnedContext = false,
  onTogglePinContext,
}: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const [ttsState, setTtsState] = useState<PlaybackState>('idle');
  const [isThisMessage, setIsThisMessage] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [voiceError, setVoiceError] = useState<EdgeVoiceError | null>(null);

  useEffect(() => {
    return ttsEngine.subscribe((state: TTSEngineState) => {
      const active = state.activeMessageId === messageId;
      setIsThisMessage(active);
      setTtsState(active ? state.state : 'idle');
      setVoiceError(active ? state.voiceError : null);
      if (active) {
        setCurrentTime(state.currentTime);
        setDuration(state.duration);
        setRate(state.playbackRate);
      }
    });
  }, [messageId]);

  const handlePlay = useCallback(() => {
    if (isThisMessage && (ttsState === 'playing' || ttsState === 'loading')) {
      ttsEngine.pause();
    } else if (isThisMessage && ttsState === 'paused') {
      ttsEngine.resume();
    } else {
      void ttsEngine.play(messageText, messageId);
    }
  }, [messageId, messageText, isThisMessage, ttsState]);

  const handleCopy = useCallback(async () => {
    try {
      const clean = messageText
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/─\s*\w+$/gm, '')
        .trim();
      await navigator.clipboard.writeText(clean);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = messageText;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [messageText]);

  const isTransport = isThisMessage && (ttsState === 'playing' || ttsState === 'paused' || ttsState === 'loading');
  const voiceNotice = edgeVoiceNotice(voiceError);

  // ── Transport mode: ⏪ ⏸ ⏩ 1x 0:24/1:47 ■ ──
  if (isTransport) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          marginTop: 7,
          paddingTop: 5,
          borderTop: '1px solid var(--t-divider)',
        }}
      >
        {/* Back 10s */}
        <button
          type="button"
          onClick={() => ttsEngine.seekRelative(-10)}
          title="Back 10s"
          aria-label="Back 10 seconds"
          style={{ ...iconBtnBase, color: THEME_ACCENT }}
        >
          <RotateCcw size={13} strokeWidth={1.8} />
        </button>

        {/* Pause / Resume */}
        <button
          type="button"
          onClick={() => {
            if (ttsState === 'playing') ttsEngine.pause();
            else ttsEngine.resume();
          }}
          title={voiceNotice ?? (ttsState === 'playing' ? 'Pause' : 'Resume')}
          aria-label={ttsState === 'playing' ? 'Pause' : 'Resume'}
          style={{
            ...iconBtnBase,
            width: 28,
            height: 28,
            background: THEME_ACCENT_SOFT,
            borderColor: THEME_ACCENT_BORDER,
            color: THEME_ACCENT,
          }}
        >
          {ttsState === 'loading' ? (
            <Volume2 size={14} strokeWidth={1.8} className="spin" />
          ) : ttsState === 'playing' ? (
            <Pause size={14} strokeWidth={2} />
          ) : (
            <Play size={14} strokeWidth={2} />
          )}
        </button>

        {/* Forward 10s */}
        {voiceNotice ? <span role="status" style={{ fontSize: 11, fontWeight: 300, color: 'var(--t-text-secondary)' }}>{voiceNotice}</span> : null}
        <button
          type="button"
          onClick={() => ttsEngine.seekRelative(10)}
          title="Forward 10s"
          aria-label="Forward 10 seconds"
          style={{ ...iconBtnBase, color: THEME_ACCENT }}
        >
          <RotateCw size={13} strokeWidth={1.8} />
        </button>

        {/* Speed */}
        <button
          type="button"
          onClick={() => {
            const nextIdx = (RATES.indexOf(rate) + 1) % RATES.length;
            ttsEngine.setRate(RATES[nextIdx]);
          }}
          title={`Speed: ${rate}x (click to change)`}
          aria-label={`Playback speed ${rate}x`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 'auto',
            height: 26,
            borderRadius: 7,
            border: '1px solid transparent',
            background: 'transparent',
            cursor: 'pointer',
            transition: 'color 140ms ease',
            paddingTop: 0,
            paddingRight: 5,
            paddingBottom: 0,
            paddingLeft: 5,
            fontSize: 10,
            fontWeight: 600,
            fontFamily: 'var(--font-sans-system)',
            color: rate === 1 ? 'var(--t-text-faint)' : THEME_ACCENT,
          }}
        >
          {rate}x
        </button>

        {/* Time */}
        <span style={{
          fontSize: 10,
          fontWeight: 500,
          color: 'var(--t-text-faint)',
          fontFamily: 'SF Mono, ui-monospace, monospace',
          letterSpacing: '-0.02em',
          marginLeft: 2,
          minWidth: 70,
          textAlign: 'center',
        }}>
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>

        {/* Stop */}
        <button
          type="button"
          onClick={() => ttsEngine.stop()}
          title="Stop"
          aria-label="Stop playback"
          style={{
            ...iconBtnBase,
            marginLeft: 'auto',
            color: '#ef4444',
          }}
        >
          <Square size={11} strokeWidth={2} fill="#ef4444" />
        </button>
      </div>
    );
  }

  // ── Default mode: ▶ 📋 🔖 ──
  return (
    <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          marginTop: 7,
          paddingTop: 5,
          borderTop: '1px solid var(--t-divider-subtle)',
        }}
      >
      <button
        type="button"
        onClick={handlePlay}
        title={voiceNotice ?? 'Play'}
        aria-label="Play"
        style={{ ...iconBtnBase }}
      >
        <Play size={14} strokeWidth={1.8} />
      </button>
      {voiceNotice ? <span role="status" style={{ fontSize: 11, fontWeight: 300, color: 'var(--t-text-secondary)' }}>{voiceNotice}</span> : null}

      <button
        type="button"
        onClick={() => void handleCopy()}
        title={copied ? 'Copied!' : 'Copy'}
        aria-label="Copy message"
        style={{
          ...iconBtnBase,
          background: copied ? 'rgba(34, 197, 94, 0.08)' : 'transparent',
          borderColor: copied ? 'rgba(34, 197, 94, 0.15)' : 'transparent',
          color: copied ? '#22c55e' : 'var(--t-text-secondary)',
        }}
      >
        {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.8} />}
      </button>

      {canPinContext ? (
        <button
          type="button"
          onClick={onTogglePinContext}
          title={isPinnedContext ? 'Remove from repo context' : 'Keep in repo context'}
          aria-label={isPinnedContext ? 'Remove from repo context' : 'Keep in repo context'}
          aria-pressed={isPinnedContext}
          style={{
            ...iconBtnBase,
            color: isPinnedContext ? 'var(--yellow)' : 'var(--t-text-secondary)',
          }}
        >
          <Bookmark size={14} strokeWidth={1.8} fill={isPinnedContext ? 'currentColor' : 'none'} />
        </button>
      ) : null}
    </div>
  );
});
