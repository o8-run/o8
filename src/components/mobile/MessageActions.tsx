'use client';

/**
 * MessageActions — tap-to-reveal action bar under each agent message.
 *
 * Hidden by default for clean appearance.
 * Tap message to reveal: ▶ Play, 📋 Copy, ↻ Retry, ··· More.
 */

import { memo, useCallback, useEffect, useState } from 'react';
import { ttsEngine, type PlaybackState } from '@/lib/tts/engine';
import { edgeVoiceNotice, type EdgeVoiceError } from '@/lib/tts/edge-voice-error';
import { useTheme } from './ThemeContext';

interface MessageActionsProps {
  messageId: string;
  messageText: string;
  visible: boolean;
  onRetry?: () => void;
}

export const MessageActions = memo(function MessageActions({
  messageId,
  messageText,
  visible,
  onRetry,
}: MessageActionsProps) {
  const { colors } = useTheme();
  const [copied, setCopied] = useState(false);
  const [ttsState, setTtsState] = useState<PlaybackState>('idle');
  const [isThisMessage, setIsThisMessage] = useState(false);
  const [voiceError, setVoiceError] = useState<EdgeVoiceError | null>(null);

  useEffect(() => {
    return ttsEngine.subscribe((state) => {
      const active = state.activeMessageId === messageId;
      setIsThisMessage(active);
      setTtsState(active ? state.state : 'idle');
      setVoiceError(active ? state.voiceError : null);
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
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [messageText]);

  const playActive = isThisMessage && ttsState !== 'idle';
  const voiceNotice = edgeVoiceNotice(voiceError);

  // Inline SVG icons (no Lucide for Tauri compat)
  const playIcon = ttsState === 'playing'
    ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
    : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>;

  const copyIcon = copied
    ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#30d158" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>;

  const retryIcon = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>;

  const btnStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    borderRadius: 7,
    border: 'none',
    background: 'transparent',
    color: colors.textSecondary,
    cursor: 'pointer',
    padding: 0,
    WebkitTapHighlightColor: 'transparent',
    transition: 'all 120ms cubic-bezier(0.22, 1, 0.36, 1)',
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        marginTop: visible ? 6 : 0,
        maxHeight: visible ? 36 : 0,
        opacity: visible ? 1 : 0,
        overflow: 'hidden',
        transition: 'all 250ms cubic-bezier(0.22, 1, 0.36, 1)',
        pointerEvents: visible ? 'auto' : 'none',
      }}
    >
      <button type="button" aria-label={playActive ? 'Pause spoken playback' : 'Play spoken playback'}
        title={voiceNotice ?? 'Play spoken playback'}
        onClick={handlePlay}
        onTouchEnd={(e) => { e.preventDefault(); e.stopPropagation(); handlePlay(); }}
        style={{
          ...btnStyle,
          color: playActive ? colors.blueAccent : colors.textSecondary,
          touchAction: 'manipulation',
        }}>
        {playIcon}
      </button>
      {voiceNotice ? <span role="status" style={{ fontSize: 11, fontWeight: 300, color: colors.textSecondary }}>{voiceNotice}</span> : null}

      {playActive ? (
        <button type="button" aria-label="Stop playback"
          onClick={() => ttsEngine.stop()}
          onTouchEnd={(e) => { e.preventDefault(); e.stopPropagation(); ttsEngine.stop(); }}
          style={{ ...btnStyle, color: '#ff3b30', touchAction: 'manipulation' }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
        </button>
      ) : null}

      <button type="button" aria-label={copied ? 'Copied message text' : 'Copy message text'}
        onClick={() => void handleCopy()}
        onTouchEnd={(e) => { e.preventDefault(); e.stopPropagation(); void handleCopy(); }}
        style={{
          ...btnStyle,
          color: copied ? colors.green : colors.textSecondary,
          touchAction: 'manipulation',
        }}>
        {copyIcon}
      </button>

      {onRetry ? (
        <button type="button" aria-label="Retry message"
          onClick={onRetry}
          onTouchEnd={(e) => { e.preventDefault(); e.stopPropagation(); onRetry?.(); }}
          style={{ ...btnStyle, touchAction: 'manipulation' }}>
          {retryIcon}
        </button>
      ) : null}
    </div>
  );
});
