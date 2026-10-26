'use client';

import { ComposerPrimitive, MessagePrimitive, useAuiState, useComposerRuntime, type MessageState } from '@assistant-ui/react';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { RippleChoice, RippleChoiceResolution, RippleDraftScope } from '@/lib/mobile/ripple-contract';
import { discardRippleDraft, rememberRippleResolution, requestRippleResolution } from '@/lib/mobile/ripple-client';
import { MobileMarkdown } from './mobile-markdown';
import { getMessageTextContent, getMessageThinkingBlocks, getMessageToolCalls } from './mobile-assistant-chat-runtime';
import { ttsEngine, type PlaybackState, type TTSEngineState } from '@/lib/tts/engine';
import { edgeVoiceNotice, type EdgeVoiceError } from '@/lib/tts/edge-voice-error';
import { playSendClick } from '@/lib/mobile/sounds';
import { usePressToDictate } from '@/lib/mobile/use-press-to-dictate';
import { MicWaveformIndicator } from '@/components/mobile/orchestrator/parts';
import {
  IconCaretDown,
  IconCaretRight,
  IconChat,
  IconSend,
  IconSpeaker,
  IconStop,
  MobilePalette,
  type MobileChatToolCall,
  mobileCardStyle,
  mobileFontFamily,
  type ModelOption,
} from './mobile-approvals-shared';
import { renderToolPart } from './mobile-tool-cards';
import { MobileRippleOverlay } from './mobile-ripple-overlay';

function StreamingDot({ palette }: { palette: MobilePalette }) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setExpanded((value) => !value);
    }, 720);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <span
      aria-label="Assistant is responding"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        color: palette.subduedText,
        fontSize: 13,
      }}
    >
      <span
        style={{
          width: expanded ? 22 : 8,
          height: 8,
          borderRadius: 999,
          backgroundColor: palette.accent,
          transition: 'width 0.28s ease',
        }}
      />
      Thinking
    </span>
  );
}

function ThinkingBlock({
  text,
  palette,
  isStreaming,
}: {
  text: string;
  palette: MobilePalette;
  isStreaming: boolean;
}) {
  const [collapsed, setCollapsed] = useState(!isStreaming);
  const isCollapsed = isStreaming ? false : collapsed;

  return (
    <div style={{ marginBottom: 10 }}>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setCollapsed((value) => !value);
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          borderRadius: 14,
          border: `1px solid ${palette.cardBorder}`,
          background: palette.cardBackground,
          color: palette.subduedText,
          cursor: 'pointer',
          fontFamily: mobileFontFamily(),
          fontSize: 12,
          fontWeight: 700,
        }}
      >
        {isCollapsed ? <IconCaretRight fill={palette.iconFill} size={14} /> : <IconCaretDown fill={palette.iconFill} size={14} />}
        <span style={{ fontStyle: 'italic' }}>Thinking</span>
        {isStreaming ? (
          <span style={{ color: palette.accent, fontWeight: 600 }}>Live</span>
        ) : null}
      </button>
      {!isCollapsed ? (
        <div
          style={{
            marginTop: 8,
            borderRadius: 16,
            border: `1px solid ${palette.cardBorder}`,
            background: palette.cardBackground,
            color: palette.mutedText,
            padding: '10px 12px',
            fontSize: 13,
            lineHeight: 1.65,
            fontStyle: 'italic',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {text}
        </div>
      ) : null}
    </div>
  );
}

/* ── Tool call card — delegates to specialized renderers in mobile-tool-cards ─ */

function ToolCallCard({
  toolCall,
  palette,
}: {
  toolCall: MobileChatToolCall;
  palette: MobilePalette;
}) {
  const light = palette.rootBackground !== '#111111';
  const status = toolCall.result?.status ?? toolCall.status ?? (toolCall.result ? 'done' : 'running');
  const isPending = status === 'calling' || status === 'running';
  const isError = status === 'error' || status === 'blocked' || toolCall.isError;

  return (
    <div style={{ marginBottom: 8 }}>
      {renderToolPart(toolCall.toolName, {
        toolCallId: toolCall.toolCallId,
        args: toolCall.arguments,
        result: toolCall.result?.output ?? toolCall.result,
        isError: isError || undefined,
        pending: isPending || undefined,
        light,
        palette,
      })}
    </div>
  );
}

function TtsButton({
  messageId,
  text,
  palette,
}: {
  messageId: string;
  text: string;
  palette: MobilePalette;
}) {
  const [playback, setPlayback] = useState<PlaybackState>('idle');
  const [voiceError, setVoiceError] = useState<EdgeVoiceError | null>(null);
  const voiceNotice = edgeVoiceNotice(voiceError);
  const isPlaying = playback === 'loading' || playback === 'playing';

  useEffect(() => {
    return ttsEngine.subscribe((state: TTSEngineState) => {
      const active = state.activeMessageId === messageId;
      setPlayback(active ? state.state : 'idle');
      setVoiceError(active ? state.voiceError : null);
    });
  }, [messageId]);

  const glassPill: CSSProperties = {
    minHeight: 44,
    borderRadius: 999,
    border: `1px solid ${palette.cardBorder}`,
    paddingLeft: 14,
    paddingRight: 14,
    fontSize: 12,
    fontWeight: 700,
    fontFamily: mobileFontFamily(),
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
  };

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          if (!isPlaying) {
            void ttsEngine.play(text, messageId);
          }
        }}
        disabled={isPlaying}
        title={voiceNotice ?? 'Play'}
        style={{
          ...glassPill,
          background: isPlaying ? palette.cardBackground : palette.panelElevated,
          color: isPlaying ? palette.subduedText : palette.rootText,
          opacity: isPlaying ? 0.4 : 1,
        }}
      >
        <IconSpeaker fill={palette.iconFill} />
        {playback === 'loading' ? 'Loading...' : 'Play'}
      </button>
      {voiceNotice ? <span role="status" style={{ fontSize: 11, fontWeight: 300, color: palette.subduedText }}>{voiceNotice}</span> : null}
      {isPlaying ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            ttsEngine.stop();
          }}
          style={{
            ...glassPill,
            background: `linear-gradient(135deg, ${palette.dangerSoft} 0%, ${palette.panelBackground} 100%)`,
            color: palette.rootText,
          }}
        >
          <IconStop fill={palette.iconFill} />
          Stop
        </button>
      ) : null}
    </div>
  );
}

export function ModelBadge({
  palette,
  selectedModel,
}: {
  palette: MobilePalette;
  selectedModel: ModelOption;
}) {
  const providerLabel = selectedModel.provider === 'google'
    ? 'Google'
    : selectedModel.provider === 'openai'
      ? 'OpenAI'
      : 'Anthropic';

  return (
    <div style={{ padding: '8px 4px 12px' }}>
      <div
        style={mobileCardStyle(palette, {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 12px',
          borderRadius: 16,
          background: palette.panelElevated,
        })}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            backgroundColor: palette.accent,
          }}
        />
        <span style={{ fontSize: 12, fontWeight: 700, color: palette.rootText }}>
          {selectedModel.label}
        </span>
        <span style={{ fontSize: 12, color: palette.subduedText }}>
          {providerLabel}
        </span>
      </div>
    </div>
  );
}

export function EmptyState({
  palette,
  selectedModel,
}: {
  palette: MobilePalette;
  selectedModel: ModelOption;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '58%',
        color: palette.subduedText,
        paddingTop: 40,
      }}
    >
      <IconChat fill={palette.iconFill} style={{ opacity: 0.28 }} />
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4, marginTop: 16, color: palette.rootText }}>
        Chat with {selectedModel.label}
      </div>
      <div style={{ fontSize: 13, textAlign: 'center', padding: '0 32px', lineHeight: 1.6 }}>
        Ask questions, brainstorm, or get help with your projects.
      </div>
    </div>
  );
}

export function ComposerBar({
  palette,
  selectedModel,
  repoPath,
  threadId,
}: {
  palette: MobilePalette;
  selectedModel: ModelOption;
  repoPath: string | null;
  threadId: string;
}) {
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const isLoading = useAuiState((state) => state.thread.isLoading);
  const isComposerEmpty = useAuiState((state) => state.thread.composer.isEmpty);
  const composerRuntime = useComposerRuntime();
  const composerText = useAuiState((state) => state.thread.composer.text);

  const voice = usePressToDictate();
  const baseTextAtRecordingStartRef = useRef('');
  const rippleRequestIdRef = useRef(0);
  const draftRef = useRef<(RippleDraftScope & { utterance: string; confirmed: boolean }) | null>(null);
  const consumedTranscriptRef = useRef('');
  const scopeRef = useRef({ threadId, repoPath });
  scopeRef.current = { threadId, repoPath };
  const [rippleResolution, setRippleResolution] = useState<RippleChoiceResolution | null>(null);
  const [rippleUtterance, setRippleUtterance] = useState('');
  const [rippleStartedAt, setRippleStartedAt] = useState(0);
  const invalidateDraft = useCallback(() => {
    if (draftRef.current) discardRippleDraft(draftRef.current.draftId);
    draftRef.current = null;
    rippleRequestIdRef.current += 1;
    setRippleResolution(null);
    setRippleUtterance('');
  }, []);
  useEffect(() => {
    invalidateDraft();
    return invalidateDraft;
  }, [threadId, repoPath, invalidateDraft]);
  useEffect(() => composerRuntime.subscribe(() => {
    const text = composerRuntime.getState().text;
    if (draftRef.current && draftRef.current.utterance !== text) invalidateDraft();
  }), [composerRuntime, invalidateDraft]);
  // Snapshot composer text on the rising edge of recording so the
  // transcript appends to whatever the user already typed.
  useEffect(() => {
    if (voice.isRecording) baseTextAtRecordingStartRef.current = composerText ?? '';
    // composerText intentionally omitted — only sample on rising edge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.isRecording]);

  // Append final transcript into the composer when it lands. Don't
  // auto-submit (packet acceptance #3 — user must tap to send). Ripple
  // asynchronously checks only the final voice draft and never blocks send.
  useEffect(() => {
    if (!voice.transcript) { consumedTranscriptRef.current = ''; return; }
    if (consumedTranscriptRef.current === voice.transcript) return;
    consumedTranscriptRef.current = voice.transcript;
    invalidateDraft();
    const base = baseTextAtRecordingStartRef.current;
    const sep = base && !base.endsWith(' ') ? ' ' : '';
    const nextText = `${base}${sep}${voice.transcript}`;
    composerRuntime.setText(nextText);
    const scope = { ...scopeRef.current, draftId: crypto.randomUUID() };
    draftRef.current = { ...scope, utterance: nextText, confirmed: false };

    const requestId = rippleRequestIdRef.current + 1;
    rippleRequestIdRef.current = requestId;
    setRippleResolution(null);
    setRippleUtterance(nextText);
    const startedAt = Date.now();
    setRippleStartedAt(startedAt);

    const repoName = repoPath?.split(/[\\/]/).filter(Boolean).at(-1);
    void requestRippleResolution({ utterance: nextText, repoName }).then((result) => {
      if (rippleRequestIdRef.current !== requestId) return;
      if (composerRuntime.getState().text !== nextText) return;
      if (scopeRef.current.threadId !== scope.threadId || scopeRef.current.repoPath !== scope.repoPath) return;
      if (result.kind === 'choice') {
        setRippleResolution(result);
      }
    });
  }, [voice.transcript, composerRuntime, repoPath, invalidateDraft]);

  const resolveRipple = (choice: RippleChoice) => {
    if (!rippleResolution || !rippleUtterance) return;
    const draft = draftRef.current;
    if (!draft || draft.threadId !== threadId || draft.repoPath !== repoPath || composerRuntime.getState().text !== draft.utterance) return;
    rememberRippleResolution({
      utterance: rippleUtterance,
      resolution: rippleResolution,
      choice,
      resolutionMs: Math.max(0, Date.now() - rippleStartedAt),
      scope: { draftId: draft.draftId, threadId, repoPath },
    });
    draft.confirmed = true;
    setRippleResolution(null);
    setRippleUtterance('');
  };

  return (
    <>
      {rippleResolution ? (
        <MobileRippleOverlay
          palette={palette}
          resolution={rippleResolution}
          onResolve={resolveRipple}
          onDismiss={invalidateDraft}
        />
      ) : null}
      <ComposerPrimitive.Root
      onSubmit={() => {
        const draft = draftRef.current;
        const state = composerRuntime.getState();
        const custom = { ...state.runConfig.custom };
        delete custom.rippleDraftId;
        const confirmed = draft?.confirmed && draft.threadId === threadId && draft.repoPath === repoPath && draft.utterance === state.text;
        composerRuntime.setRunConfig({ ...state.runConfig, custom: {
          ...custom, ...(confirmed ? { rippleDraftId: draft.draftId } : {}),
        } });
        // The model consumes the submitted token. Composer clearing must not
        // discard it while assistant-ui awaits attachments before dispatch.
        if (confirmed) draftRef.current = null;
        invalidateDraft();
        if (!isRunning && !isComposerEmpty) {
          playSendClick();
        }
      }}
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 10,
        paddingTop: 10,
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 8px)',
        paddingLeft: 4,
        paddingRight: 4,
      }}
    >
      <div
        style={{
          flex: 1,
          minHeight: 48,
          borderRadius: 22,
          border: `1px solid ${palette.inputBorder}`,
          background: palette.inputBackground,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 16,
          paddingRight: 12,
          paddingTop: 10,
          paddingBottom: 10,
        }}
      >
        <ComposerPrimitive.Input
          onChange={() => invalidateDraft()}
          placeholder={`Message ${selectedModel.label}...`}
          submitMode="enter"
          minRows={1}
          maxRows={5}
          disabled={isLoading}
          style={{
            flex: 1,
            border: 'none',
            backgroundColor: 'transparent',
            color: palette.rootText,
            fontSize: 16,
            outline: 'none',
            fontFamily: mobileFontFamily(),
            lineHeight: 1.45,
            resize: 'none',
            padding: 0,
          }}
        />
      </div>
      {isRunning ? (
        <ComposerPrimitive.Cancel
          aria-label="Stop"
          style={{
            width: 44,
            height: 44,
            minWidth: 44,
            minHeight: 44,
            borderRadius: 22,
            border: 'none',
            backgroundColor: palette.dangerSoft,
            color: palette.rootText,
            cursor: 'pointer',
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            touchAction: 'manipulation',
            WebkitTapHighlightColor: 'transparent',
            padding: 0,
          }}
        >
          <IconStop fill={palette.iconFill} size={16} />
        </ComposerPrimitive.Cancel>
      ) : (
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            type="submit"
            aria-label={voice.isRecording ? 'Recording — release to stop' : 'Send (hold to dictate)'}
            title={voice.supported ? 'Tap to send · hold to dictate' : 'Voice not supported on this device'}
            // NOTE: never `disabled` on iOS — disabled buttons swallow
            // pointerdown so long-press can't start from an empty composer
            // (the primary dictation use case). We gate submit in onClick.
            {...voice.pointerHandlers}
            onContextMenu={(event) => event.preventDefault()}
            onClick={(event) => {
              if (voice.claimSuppressedClick()) {
                event.preventDefault();
                event.stopPropagation();
                return;
              }
              if (isComposerEmpty || isLoading) {
                event.preventDefault();
                event.stopPropagation();
                if (!voice.supported && isComposerEmpty) {
                  voice.flashTooltip('Voice not supported on this device');
                }
              }
            }}
            style={{
              width: 44,
              height: 44,
              minWidth: 44,
              minHeight: 44,
              borderRadius: 22,
              border: 'none',
              backgroundColor: voice.isRecording
                ? 'rgba(255,69,58,0.18)'
                : (!isComposerEmpty && !isLoading ? palette.accent : palette.cardBackground),
              color: palette.rootText,
              cursor: voice.isRecording || (!isComposerEmpty && !isLoading) ? 'pointer' : 'default',
              opacity: voice.isRecording || (!isComposerEmpty && !isLoading) ? 1 : 0.58,
              flexShrink: 0,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              touchAction: 'manipulation',
              WebkitTapHighlightColor: 'transparent',
              WebkitUserSelect: 'none',
              userSelect: 'none',
              WebkitTouchCallout: 'none',
              padding: 0,
            }}
          >
            {voice.isRecording ? (
              <MicWaveformIndicator size={20} color="#FF453A" />
            ) : (
              <IconSend fill={palette.iconFill} />
            )}
          </button>
          {voice.tooltip ? (
            <div
              role="status"
              style={{
                position: 'absolute',
                bottom: 'calc(100% + 6px)',
                right: 0,
                whiteSpace: 'nowrap',
                paddingTop: 4, paddingBottom: 4, paddingLeft: 8, paddingRight: 8,
                borderRadius: 8,
                background: 'rgba(28,28,30,0.92)',
                color: '#FFFFFF',
                fontSize: 11, fontWeight: 600,
                pointerEvents: 'none',
              }}
            >
              {voice.tooltip}
            </div>
          ) : null}
        </div>
      )}
      </ComposerPrimitive.Root>
    </>
  );
}

export function ChatMessageRow({
  message,
  palette,
  isThreadRunning,
  activeMessageId,
  onToggleActions,
  copiedMessageId,
  onCopy,
}: {
  message: MessageState;
  palette: MobilePalette;
  isThreadRunning: boolean;
  activeMessageId: string | null;
  onToggleActions: (messageId: string | null) => void;
  copiedMessageId: string | null;
  onCopy: (messageId: string, content: string) => void;
}) {
  const textContent = getMessageTextContent(message.content);
  const thinkingBlocks = message.role === 'assistant' ? getMessageThinkingBlocks(message.content) : [];
  const toolCalls = message.role === 'assistant' ? getMessageToolCalls(message.content) : [];
  const isAssistantStreaming = message.role === 'assistant' && message.status.type === 'running';
  const hideCancelledPlaceholder = message.role === 'assistant'
    && message.status.type === 'incomplete'
    && message.status.reason === 'cancelled'
    && !textContent.trim()
    && thinkingBlocks.length === 0
    && toolCalls.length === 0;

  if (hideCancelledPlaceholder) {
    return null;
  }

  const canRevealActions = !isThreadRunning && textContent.trim().length > 0;
  const showActions = activeMessageId === message.id && canRevealActions;
  const isCopied = copiedMessageId === message.id;

  return (
    <MessagePrimitive.Root
      onClick={() => {
        if (!canRevealActions) return;
        onToggleActions(activeMessageId === message.id ? null : message.id);
      }}
      style={{
        marginBottom: message.role === 'user' ? 14 : 20,
        display: 'flex',
        flexDirection: 'column',
        alignItems: message.role === 'user' ? 'flex-end' : 'flex-start',
        cursor: canRevealActions ? 'pointer' : 'default',
      }}
    >
      {message.role === 'user' ? (
        <div
          style={{
            maxWidth: '82%',
            padding: '10px 14px',
            borderRadius: 18,
            borderBottomRightRadius: 8,
            background: palette.userBubble,
            color: palette.rootText,
            border: `1px solid ${palette.cardBorder}`,
            fontSize: 14,
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {textContent}
        </div>
      ) : (
        <div style={{ width: '100%', paddingTop: 2, paddingRight: 18 }}>
          {thinkingBlocks.map((block, index) => (
            <ThinkingBlock
              key={`${message.id}-thinking-${index}`}
              text={block}
              palette={palette}
              isStreaming={isAssistantStreaming}
            />
          ))}
          {toolCalls.map((toolCall) => (
            <ToolCallCard key={toolCall.toolCallId} toolCall={toolCall} palette={palette} />
          ))}
          {textContent ? (
            <MobileMarkdown content={textContent} textColor={palette.rootText} light={palette.rootBackground !== '#111111'} />
          ) : isAssistantStreaming && toolCalls.length === 0 ? (
            <StreamingDot palette={palette} />
          ) : null}
        </div>
      )}

      {showActions ? (
        <div
          style={{
            display: 'flex',
            gap: 6,
            marginTop: 6,
            alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
            flexWrap: 'wrap',
          }}
        >
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onCopy(message.id, textContent);
            }}
            aria-label={isCopied ? 'Copied' : 'Copy message'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              minHeight: 44,
              paddingLeft: 14,
              paddingRight: 14,
              paddingTop: 0,
              paddingBottom: 0,
              borderRadius: 14,
              border: `1px solid ${palette.cardBorder}`,
              background: isCopied ? palette.successSoft : palette.cardBackground,
              color: isCopied ? palette.success : palette.mutedText,
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: mobileFontFamily(),
              touchAction: 'manipulation',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            {isCopied ? 'Copied' : 'Copy'}
          </button>
          {message.role === 'assistant' ? (
            <TtsButton messageId={message.id} text={textContent} palette={palette} />
          ) : null}
        </div>
      ) : null}
    </MessagePrimitive.Root>
  );
}
