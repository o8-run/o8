'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FileText } from './lucide-shims';
import { DesktopMediaImage } from './DesktopMediaAttachment';
import { ttsEngine, type TTSEngineState } from '@/lib/tts/engine';
import { userScrolledRecently } from '@/lib/tts/scroll-follow';
import { CommandStripNode } from '@/components/desktop/CommandStripNode';
import { CompactionNode } from '@/components/desktop/CompactionNode';
import { ThoughtBlock } from '@/components/desktop/thoughts/chat-panel/ThoughtBlock';
import { FileEditRowStack } from '@/components/desktop/thoughts/chat-panel/FileEditRow';
import { deriveFileEdits, isFileEditCall } from '@/components/desktop/thoughts/chat-panel/file-edits';
import type {
  MobileTranscriptEntry,
  MobileTranscriptMedia,
} from '@/lib/mobile/types';
import { resolveIsErrorNotice } from '@/lib/transcripts/error-notice';
import { deliveryFailureClientMessageId } from '@/components/desktop/thoughts/use-orchestrator-stream/delivery';
import { renderLLMMarkdown } from './LLMMarkdown';
import { MessageVisualizations } from './visualizations/MessageVisualizations';
import type { VisualizationReference } from '@/lib/visualizations/types';
import { MessageActions } from './MessageActions';
import { usePretextHeight } from '@/lib/pretext';
import { sanitizeTranscriptText } from '@/components/desktop/transcript-sanitize';
import { ToolCallChipCluster, describeToolRollupParts } from '@/components/desktop/thoughts/chat-panel/ToolCallChipCluster';
import { BrainFeedCard } from '@/components/desktop/thoughts/chat-panel/BrainFeedCard';
import { isMeteredBrainFeedCall } from '@/components/desktop/thoughts/brain-feed';
import { useSmoothText } from '@/components/desktop/thoughts/chat-panel/use-smooth-text';
import { parseDesignDrawContext } from '@/components/desktop/thoughts/chat-panel/design-draw-context';
import { DesignDrawContextCard } from '@/components/desktop/thoughts/chat-panel/DesignDrawContextCard';
import { OrchestratorStatusCard } from '@/components/desktop/thoughts/chat-panel/OrchestratorStatusCard';
import { NoGitRepoErrorCure } from '@/components/desktop/thoughts/chat-panel/NoGitRepoErrorCure';
import { detectOrchestratorStatusEvent } from '@/lib/orchestrator/status-events';
import { useOrchestratorEntryEvicted } from '@/components/desktop/orchestrator/context-residency';
import { parseNoGitRepoError } from '@/lib/transcripts/no-git-repo-error';
import {
  hydrateOrchestratorTurnPinEntry,
  persistOrchestratorTurnPin,
  stageOrchestratorTurnPin,
} from '@/lib/orchestrator/store';

interface DesktopAgentMessageProps {
  userDelivery?: ReactNode;
  entry: MobileTranscriptEntry;
  isLast?: boolean;
  /** True only for the in-flight assistant message — drives the smooth
   *  (typewriter) text reveal so bursts of tokens flow in instead of popping. */
  isStreaming?: boolean;
  /** Hidden transcripts skip cosmetic frame-by-frame text reveals. */
  animateStreaming?: boolean;
  /** Release the visibility signal once the final streamed reveal has drained. */
  onRevealSettled?: (messageId: string) => void;
  repoPath?: string | null;
  onApplyToFile?: (code: string, language: string) => void;
  onOpenInCanvas?: (code: string, language: string) => void;
  onRunInTerminal?: (command: string) => void;
  onRetryDelivery?: (clientMessageId: string) => void;
  visualizations?: VisualizationReference[];
}

function mediaHref(path: string) {
  if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('data:')) {
    return path;
  }
  return `/api/mobile/media?path=${encodeURIComponent(path)}`;
}

function isImageMedia(item: MobileTranscriptMedia) {
  return item.kind === 'image';
}

const MediaGrid = memo(function MediaGrid({
  media,
  tint,
}: {
  media: MobileTranscriptMedia[];
  tint: 'user' | 'assistant';
}) {
  const images = media.filter(isImageMedia);
  const files = media.filter((item) => !isImageMedia(item));

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      width: '100%',
      maxWidth: tint === 'user' ? '100%' : '92%',
    }}>
      {images.length > 0 ? (
        <div style={{
          display: 'grid',
          gridTemplateColumns: images.length === 1 ? '1fr' : '1fr 1fr',
          gap: 8,
        }}>
          {images.map((item, index) => (
            <div
              key={`${item.path}-${index}`}
              style={{
                display: 'block',
                overflow: 'hidden',
                borderRadius: 14,
                border: '1px solid var(--t-divider)',
                background: 'var(--t-bg-card, rgba(148, 163, 184, 0.06))',
                boxShadow: 'var(--t-panel-shadow)',
              }}
            >
              <DesktopMediaImage path={item.path} name={item.name} maxHeight={images.length === 1 ? 280 : 180} />
            </div>
          ))}
        </div>
      ) : null}

      {files.map((item, index) => (
        <div
          key={`${item.path}-${index}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            borderRadius: 12,
            border: '1px solid var(--t-divider)',
            background: 'var(--t-bg-card, rgba(148, 163, 184, 0.06))',
            color: 'var(--t-text)',
          }}
        >
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            borderRadius: 10,
            background: 'var(--t-accent-soft)',
            color: 'var(--t-accent)',
            flexShrink: 0,
          }}>
            <FileText size={16} strokeWidth={2} />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '-0.01em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {item.name}
            </div>
            <div style={{
              fontSize: 10,
              color: 'var(--t-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}>
              {item.kind}
            </div>
          </div>
          <a
            href={mediaHref(item.path)}
            target="_blank"
            rel="noreferrer"
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--t-accent)',
              textDecoration: 'none',
            }}
          >
            Open
          </a>
        </div>
      ))}
    </div>
  );
});

export const DesktopAgentMessage = memo(function DesktopAgentMessage({
  entry,
  isLast = false,
  isStreaming = false,
  repoPath,
  onApplyToFile,
  onOpenInCanvas,
  onRunInTerminal,
  onRetryDelivery,
  visualizations,
  userDelivery, animateStreaming = true, onRevealSettled,
}: DesktopAgentMessageProps) {
  const isUser = entry.role === 'user';
  // Sanitize regex chain runs on every render unless memoized — heavy on
  // long transcripts where entry text is stable but parent re-renders fire.
  const displayText = useMemo(() => sanitizeTranscriptText(entry.text), [entry.text]);
  // Error notices are system entries that reported a broken turn — tinted so
  // they don't read as ordinary system news. Everything else stays neutral.
  const isErrorNotice = entry.role === 'system' && resolveIsErrorNotice(entry);
  const noGitRepoError = useMemo(
    () => isErrorNotice ? parseNoGitRepoError(displayText) : null,
    [displayText, isErrorNotice],
  );
  const deliveryRetryId = onRetryDelivery ? deliveryFailureClientMessageId(entry.id) : null;
  // Smooth (typewriter) reveal for the in-flight assistant reply — paces out
  // bursty deltas so words flow in. No-op (returns full text) for user/history.
  const revealedText = useSmoothText(displayText, entry.role === 'assistant' && isStreaming, animateStreaming);
  // Markdown parsing is O(reply length). It used to be keyed on the per-FRAME
  // reveal string, so renderLLMMarkdown re-ran ~60×/sec for the ENTIRE stream —
  // pinning the WKWebView main thread so sidebar clicks / "New session" / any
  // nav couldn't be serviced until the turn ended (Chris + Q video, 2026-07-15:
  // "can't spawn a new orchestrator while one is working"). Fix: parse markdown
  // ONCE, only after the turn settles; render cheap plain text during the
  // streaming reveal (and the post-stream drain) so nothing parses per frame.
  const isAssistantStreaming = entry.role === 'assistant' && isStreaming;
  const revealSettled = revealedText.length >= displayText.length;
  useEffect(() => {
    if (!isStreaming && revealSettled) onRevealSettled?.(entry.id);
  }, [entry.id, isStreaming, onRevealSettled, revealSettled]);
  const showMarkdown = !isAssistantStreaming && revealSettled;
  const sanitizedThinking = useMemo(
    () => entry.thinking ? sanitizeTranscriptText(entry.thinking) : '',
    [entry.thinking],
  );
  // Design Mode draw turns embed the machine context (region/elements/shot
  // paths) inline in the text for the model — the transcript renders just the
  // prompt plus a compact expandable strip instead of the raw dump.
  const designDrawContext = useMemo(
    () => (isUser ? parseDesignDrawContext(displayText) : null),
    [isUser, displayText],
  );
  const userPromptText = designDrawContext ? designDrawContext.prompt : displayText;
  const hasText = Boolean(displayText.trim());
  const hasMedia = Boolean(entry.media?.length);
  const hasToolCalls = Boolean(entry.toolCalls?.length);
  // Brain→Fable transparency: cortex_ask calls made on a METERED backend
  // (fable) render as expandable BrainFeedCards instead of plain chips —
  // the operator sees what the Brain fed the orchestrator, cited. Calls on
  // subscription backends (or without a parsed result) stay in the cluster.
  const brainFeedCalls = useMemo(
    () => (entry.toolCalls ?? []).filter(isMeteredBrainFeedCall),
    [entry.toolCalls],
  );
  // Turn-grammar deliverable 2: write/edit tool calls with a real file path
  // render as live FileEditRows (Editing → Edited +A −D), so they leave the
  // generic chip cluster and stack as their own dense rows.
  const fileEdits = useMemo(() => deriveFileEdits(entry.toolCalls), [entry.toolCalls]);
  const clusterToolCalls = useMemo(
    () => (entry.toolCalls ?? []).filter(
      (toolCall) => !isMeteredBrainFeedCall(toolCall) && !isFileEditCall(toolCall),
    ),
    [entry.toolCalls],
  );
  // Cursor's settled aggregate merges the turn's tool work into the edit line:
  // "Edited 12 files, ran 1 command, explored 2 files +903 −3". When the entry
  // has file edits, the cluster's summary folds into the FileEditRowStack
  // header and the standalone rollup line is suppressed (errors never fold).
  const rollupExtras = useMemo(
    () => describeToolRollupParts(clusterToolCalls, 'fold'),
    [clusterToolCalls],
  );
  const isCompaction = entry.type === 'compaction'
    || (entry.role === 'system' && entry.text.toLowerCase().includes('compaction'));
  const isEvicted = useOrchestratorEntryEvicted(entry.id);
  const canPin = Boolean(repoPath?.trim()) && entry.type !== 'compaction' && entry.type !== 'command';
  const [isPinned, setIsPinned] = useState(() => canPin ? hydrateOrchestratorTurnPinEntry(repoPath, entry) : entry.pinned === true);
  const evictedEyebrow = isEvicted ? (
    <span
      style={{
        fontSize: 9.5,
        fontWeight: 600,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--t-text-faint)',
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      (evicted from context)
    </span>
  ) : null;
  const evictedOpacity = isEvicted ? 0.55 : 1;

  useEffect(() => {
    const nextPinned = canPin ? hydrateOrchestratorTurnPinEntry(repoPath, entry) : entry.pinned === true;
    setIsPinned(nextPinned);
  }, [canPin, entry, repoPath]);

  // Pretext: pre-calculate user message height (plain text, pre-wrap).
  // The orchestrator chat tile is render-hot during streaming — avoiding
  // reflows on every token matters. The user row is full-column-width now, so
  // estimate against a conservative wide measure — an UNDER-estimate of height
  // is safe (content grows), an over-estimate leaves blank space.
  const userTextHeight = usePretextHeight(
    isUser ? userPromptText : '',
    'small', // 13px matches user row fontSize
    640 - 28, // conservative column width minus card padding
    1.55,
    'pre-wrap',
  );

  const handleApplyDiff = useCallback(async (diffText: string) => {
    const trimmedRepoPath = repoPath?.trim();
    if (!trimmedRepoPath) {
      console.error('[diff-card] Failed to apply diff:', new Error('No active repository selected.'));
      return;
    }

    try {
      const response = await fetch('/api/lanes/apply-diff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diffText, repoPath: trimmedRepoPath }),
      });
      const result = await response.json().catch(() => null) as { laneId?: string; error?: string; note?: string } | null;
      if (!response.ok || !result?.laneId) {
        throw new Error(result?.error || result?.note || 'Apply failed');
      }
      window.dispatchEvent(new CustomEvent('o8:lane-lifecycle'));
    } catch (error) {
      console.error('[diff-card] Failed to apply diff:', error);
    }
  }, [repoPath]);

  // Voice-playback line highlighting: track the source span of the block being
  // read aloud, but only while THIS message is the one playing. Mirrors the
  // ttsEngine.subscribe wiring in MessageActions.
  const rootRef = useRef<HTMLDivElement>(null);
  const [activeRange, setActiveRange] = useState<[number, number] | null>(null);
  useEffect(() => {
    return ttsEngine.subscribe((state: TTSEngineState) => {
      const chunk = state.activeChunk;
      if (chunk && chunk.messageId === entry.id) {
        setActiveRange((prev) =>
          prev && prev[0] === chunk.srcStart && prev[1] === chunk.srcEnd
            ? prev
            : [chunk.srcStart, chunk.srcEnd],
        );
      } else {
        setActiveRange((prev) => (prev === null ? prev : null));
      }
    });
  }, [entry.id]);

  // Scroll-follow: keep the spoken block in view as it advances, unless the user
  // just scrolled away to read elsewhere.
  useEffect(() => {
    if (!activeRange) return;
    const root = rootRef.current;
    if (!root) return;
    const activeEl = root.querySelector('[data-tts-active="true"]');
    if (!activeEl || userScrolledRecently()) return;
    activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeRange]);

  // renderLLMMarkdown does heavy line-by-line parsing + regex matching to
  // produce React nodes. Memoize per (text + handler identity) so renders
  // triggered by sibling state (e.g. hover on meta row) skip re-parsing.
  // Hook must live before any early returns to keep call order stable.
  // Parse the FULL settled text (displayText), NOT the per-frame reveal string,
  // and only once showMarkdown is true — during streaming this returns null
  // cheaply, so renderLLMMarkdown never runs on the animation-frame hot path.
  const renderedMarkdown = useMemo(
    () => (hasText && showMarkdown) ? renderLLMMarkdown(displayText, {
      onApplyToFile,
      onApplyDiff: repoPath ? handleApplyDiff : undefined,
      onOpenInCanvas,
      onRunInTerminal,
      activeHighlightRange: activeRange ?? undefined,
    }) : null,
    [hasText, showMarkdown, displayText, onApplyToFile, onOpenInCanvas, onRunInTerminal, repoPath, handleApplyDiff, activeRange],
  );

  const handlePinToggle = useCallback(() => {
    const trimmedRepoPath = repoPath?.trim();
    if (!canPin || !trimmedRepoPath) return;
    const nextPinned = !isPinned;
    entry.pinned = nextPinned;
    setIsPinned(nextPinned);
    stageOrchestratorTurnPin(trimmedRepoPath, entry.id, nextPinned);
    void persistOrchestratorTurnPin({ repoPath: trimmedRepoPath, entryId: entry.id, pinned: nextPinned });
  }, [canPin, entry, isPinned, repoPath]);

  const renderMetaRow = useCallback((align: 'flex-start' | 'flex-end') => {
    if (!entry.timestampLabel) return null;
    return (
      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        alignSelf: align,
        paddingLeft: align === 'flex-start' ? 2 : 0,
        paddingRight: align === 'flex-end' ? 4 : 0,
      }}>
        <span style={{ fontSize: 10, color: 'var(--t-text-faint)' }}>
          {entry.voice ? `${entry.voice.direction === 'output' ? 'Voice reply' : 'Voice'} · ` : ''}{entry.timestampLabel}
        </span>
      </div>
    );
  }, [entry.timestampLabel, entry.voice]);

  if (isCompaction) {
    return (
      <CompactionNode
        summary={entry.compaction?.summary}
        trigger={entry.compaction?.trigger}
        tokensBefore={entry.compaction?.tokensBefore}
        tokensAfter={entry.compaction?.tokensAfter}
        timestampLabel={entry.timestampLabel}
      />
    );
  }

  if (entry.type === 'command' && entry.command) {
    return <CommandStripNode command={entry.command} timestampLabel={entry.timestampLabel} />;
  }

  if (isUser) {
    // User row: a full-width neutral card (no accent bubble) so
    // operator prompts read as part of the document flow, not chat balloons.
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 8,
        opacity: evictedOpacity,
        transition: 'opacity 180ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}>
        {evictedEyebrow}
        {hasMedia ? <MediaGrid media={entry.media ?? []} tint="user" /> : null}
        {hasText && userPromptText.trim() ? (
          <div style={{
            width: '100%',
            paddingTop: 10,
            paddingRight: 14,
            paddingBottom: 10,
            paddingLeft: 14,
            borderRadius: 10,
            background: 'var(--t-chat-user-bg)',
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider)',
            color: 'var(--t-text)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: 13,
            fontWeight: 380,
            lineHeight: 1.5,
            letterSpacing: '-0.005em',
            // Pretext: explicit minHeight eliminates reflow in z-9999 stacking context
            ...(userTextHeight > 0 ? { minHeight: userTextHeight } : {}),
          }}>
            {userPromptText}
          </div>
        ) : null}
        {designDrawContext ? <DesignDrawContextCard context={designDrawContext} /> : null}
        {userDelivery}
        {renderMetaRow('flex-end')}
      </div>
    );
  }

  // Orchestrator lifecycle events (e.g. mission complete) arrive as system
  // entries. Upgrade them from a plain gray bubble into a themed, animated
  // status card — and suppress the legacy "(NEW THREAD · READY)" marker. This
  // also tidies old threads in place (detection is by text, no migration).
  if (entry.role === 'system') {
    const statusEvent = entry.statusEvent ?? detectOrchestratorStatusEvent(displayText);
    if (statusEvent) {
      if (statusEvent.kind === 'suppress') return null;
      return (
        <OrchestratorStatusCard
          event={statusEvent}
          timestampLabel={entry.timestampLabel}
          isLast={isLast}
        />
      );
    }
  }

  const hasThinking = Boolean(entry.thinking?.trim());
  // Any reasoning signal renders the thought line: streamed reasoning text,
  // a frozen duration, or the live `thinkingActive` marker (Claude 5-family
  // thinking is signature-redacted, so the marker/duration are the only
  // evidence reasoning happened — see ThoughtBlock).
  const hasThinkingSignal = hasThinking
    || typeof entry.thinkingDurationMs === 'number'
    || entry.thinkingActive === true;
  // ThoughtBlock is "live" (shimmering) only during the pure reasoning phase:
  // the turn is still streaming AND no answer text or tool call has landed yet.
  // The first token or first tool ends reasoning → it collapses to the
  // "Thought for Ns" line.
  const thinkingLive = (isStreaming && !hasText && !hasToolCalls)
    || (entry.thinkingActive === true && !hasText && !hasToolCalls);

  return (
    <div ref={rootRef} style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: 8,
      animation: isLast ? 'llmFadeIn 180ms ease-out' : undefined,
      opacity: evictedOpacity,
      transition: 'opacity 180ms cubic-bezier(0.22, 1, 0.36, 1)',
    }}>
      {evictedEyebrow}
      {hasThinkingSignal ? (
        <ThoughtBlock
          thinking={sanitizedThinking}
          live={thinkingLive}
          durationMs={entry.thinkingDurationMs ?? null}
          style={{ maxWidth: '100%' }}
        />
      ) : null}

      {hasText ? (
        <div
          role={deliveryRetryId ? 'button' : undefined}
          tabIndex={deliveryRetryId ? 0 : undefined}
          onClick={deliveryRetryId ? () => onRetryDelivery?.(deliveryRetryId) : undefined}
          onKeyDown={deliveryRetryId ? (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onRetryDelivery?.(deliveryRetryId);
            }
          } : undefined}
          style={{
          maxWidth: '90%',
          color: entry.role === 'system' ? 'var(--t-text-secondary)' : 'var(--t-text)',
          fontSize: 13,
          fontWeight: 360,
          lineHeight: 1.55,
          letterSpacing: '-0.005em',
          wordBreak: 'break-word',
          fontFamily: 'var(--font-sans-system)',
          paddingTop: entry.role === 'system' ? 10 : 8,
          paddingBottom: entry.role === 'system' ? 10 : 8,
          paddingLeft: entry.role === 'system' ? 12 : 0,
          paddingRight: entry.role === 'system' ? 12 : 0,
          borderRadius: entry.role === 'system' ? 12 : 0,
          background: isErrorNotice
            ? 'var(--t-chat-error-bg)'
            : entry.role === 'system' ? 'var(--t-bg-card, rgba(148, 163, 184, 0.06))' : 'transparent',
          border: isErrorNotice
            ? '1px solid var(--t-chat-error-border)'
            : entry.role === 'system' ? '1px solid var(--t-divider)' : 'none',
          // Flat: the panel shadow read as a stuck hover state against the
          // transcript's flat agent text.
          boxShadow: 'none',
          cursor: deliveryRetryId ? 'pointer' : undefined,
        }}>
          {showMarkdown
            ? renderedMarkdown
            : <div style={{ whiteSpace: 'pre-wrap' }}>{revealedText}</div>}
          {noGitRepoError ? <NoGitRepoErrorCure repoPath={noGitRepoError.repoPath} /> : null}
        </div>
      ) : null}

      {hasMedia ? <MediaGrid media={entry.media ?? []} tint="assistant" /> : null}
      {fileEdits.length > 0 ? <FileEditRowStack edits={fileEdits} repoPath={repoPath} extras={rollupExtras} /> : null}
      {clusterToolCalls.length > 0 ? (
        <ToolCallChipCluster toolCalls={clusterToolCalls} suppressSettledRollup={fileEdits.length > 0} />
      ) : null}
      {brainFeedCalls.map((toolCall, index) => (
        <BrainFeedCard key={toolCall.id ?? `brain-feed-${index}`} toolCall={toolCall} />
      ))}
      <MessageVisualizations toolCalls={entry.toolCalls} references={visualizations} />

      {entry.role === 'assistant' && hasText ? (
        <div style={{ width: '100%' }}>
          <MessageActions
            messageId={entry.id}
            messageText={displayText}
            canPinContext={canPin}
            isPinnedContext={isPinned}
            onTogglePinContext={handlePinToggle}
          />
        </div>
      ) : null}

      {renderMetaRow('flex-start')}
    </div>
  );
});
