'use client';

import { Fragment, forwardRef, memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { DesktopAgentMessage } from '../../DesktopAgentMessage';
import { ComposerEntryDelivery, ComposerQueuedMessages, type ComposerTranscriptQueue } from './ComposerQueuedMessages';
import { SuggestedReplies } from '../SuggestedReplies';
import { TurnSummaryCard, type TurnSummary } from './TurnSummaryCard';
import { ShimmerLine } from './turn-line';
import { mergeAdjacentToolOnlyEntries } from './ToolCallChipCluster';
import { CollideProposalCard } from './CollideProposalCard';
import { MissionCompleteGroupCard } from './MissionCompleteGroupCard';
import { HandoffTranscriptCard } from './HandoffTranscriptCard';
import { TaskArtifactCard, type TaskArtifactDeliverInput } from './TaskArtifactCard';
import type { TaskArtifactView } from '@/lib/task-artifacts/types';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { noteUserScroll } from '@/lib/tts/scroll-follow';
import { useTranscriptVisualizations } from '@/components/desktop/visualizations/useTranscriptVisualizations';
import { VisualizationFrame } from '@/components/desktop/visualizations/VisualizationFrame';
import { placeTranscriptVisualizations } from '@/lib/visualizations/transcript';
import type { VisualizationReference } from '@/lib/visualizations/types';

import { TranscriptTurns } from '../../transcript/TranscriptTurns';
import { TranscriptNavigator } from '../../transcript/TranscriptNavigator';

// A run of ≥2 consecutive mission-complete cards collapses into ONE aggregate
// (MissionCompleteGroupCard); everything else renders as its own message. Keys
// on the structured statusEvent, so grouping survives a thread reload.
type MissionRenderItem =
  | { kind: 'msg'; msg: MobileTranscriptEntry; index: number }
  | { kind: 'mission-group'; entries: MobileTranscriptEntry[]; lastIndex: number };

function isPacketTerminalEntry(m: MobileTranscriptEntry): boolean {
  return m.statusEvent?.kind === 'mission-complete' || m.statusEvent?.kind === 'merge';
}

function placeTaskArtifacts(artifacts: TaskArtifactView[], messages: MobileTranscriptEntry[]): Map<number, TaskArtifactView[]> {
  const buckets = new Map<number, TaskArtifactView[]>();
  if (artifacts.length === 0) return buckets;
  const sorted = [...artifacts].sort((a, b) => Date.parse(a.artifact.createdAt) - Date.parse(b.artifact.createdAt));
  for (const entry of sorted) {
    const createdAt = Date.parse(entry.artifact.createdAt);
    let index = -1;
    for (let i = 0; i < messages.length; i += 1) {
      const ts = messages[i].timestamp ?? 0;
      if (ts <= createdAt) index = i;
      else break;
    }
    if (index === -1 && messages.length > 0) index = 0;
    const bucket = buckets.get(index) ?? [];
    bucket.push(entry);
    buckets.set(index, bucket);
  }
  return buckets;
}

export function buildMissionRenderItems(messages: MobileTranscriptEntry[]): MissionRenderItem[] {
  const items: MissionRenderItem[] = [];
  let i = 0;
  while (i < messages.length) {
    if (isPacketTerminalEntry(messages[i])) {
      let j = i;
      while (j < messages.length && isPacketTerminalEntry(messages[j])) j += 1;
      if (j - i >= 2) {
        items.push({ kind: 'mission-group', entries: messages.slice(i, j), lastIndex: j - 1 });
      } else {
        items.push({ kind: 'msg', msg: messages[i], index: i });
      }
      i = j;
    } else {
      items.push({ kind: 'msg', msg: messages[i], index: i });
      i += 1;
    }
  }
  return items;
}

interface ChatMessageListProps {
  composerQueue?: ComposerTranscriptQueue;
  logLabel?: string;
  displayMessages: MobileTranscriptEntry[];
  threadId?: string | null;
  active?: boolean;
  displayWaiting: boolean;
  liveCompaction?: boolean;
  repoPath?: string | null;
  activeTargetLabel: string;
  activeTargetColor: string;
  thoughtsMutedGlass: string;
  thoughtsElevatedBorder: string;
  thoughtsElevatedShadow: string;
  emptyStateOverride?: React.ReactNode;
  emptyStateFallback: React.ReactNode;
  composeFirst?: boolean;
  topContent?: React.ReactNode;
  /** Rendered at the live edge of the transcript — after the last message,
   *  before the thinking indicator. Used for the inline swarm crew card. */
  bottomContent?: React.ReactNode;
  /** Stable transcript-turn slots, keyed by the original turn-start entry. */
  turnContent?: ReadonlyMap<string, React.ReactNode>;
  // Orchestrator has its own sticky ComposerStatusBar above the textarea
  // that already surfaces "working" state + elapsed time + running tools.
  // Duplicating the inline "is thinking…" bubble here makes the chat feel
  // noisy during tool-heavy turns. CLI lane panels still need the bubble.
  isOrchestratorMode?: boolean;
  // Suggested-reply chips (#771). The parent owns the cache + Gemini fetch and
  // hands us the chip strings for the last assistant message. We render them
  // under that message; click → onSelectSuggestion(text); X → onDismissSuggestions.
  suggestedReplyMessageId?: string | null;
  suggestedReplies?: string[];
  onSelectSuggestion?: (chip: string) => void;
  onDismissSuggestions?: () => void;
  suggestedRepliesCollapsed?: boolean;
  onRestoreSuggestions?: () => void;
  // Phase 4 — when true, render a [•••] placeholder under the last assistant
  // message even if `suggestedReplies` is empty. Indicates a fetch is in
  // flight or just failed, so the user knows chips were attempted.
  suggestedRepliesPending?: boolean;
  // #1095/#1096 — when the orchestrator finishes a turn that touched files or
  // ran tools, the parent passes a TurnSummary anchored to the closing
  // assistant message. The card renders inline directly after that message.
  turnSummary?: TurnSummary | null;
  onScroll?: (event: React.UIEvent<HTMLDivElement>) => void;
  onRetryDelivery?: (clientMessageId: string) => void;
  /** Interactive task artifacts attached to this thread (#1699), oldest first. */
  taskArtifacts?: TaskArtifactView[];
  taskArtifactThreadBusy?: boolean;
  onTaskArtifactDeliver?: (input: TaskArtifactDeliverInput) => boolean;
}

// Inactive can also mean a visible, unfocused split pane. Defer presentation
// only after the actual retained surface reports zero width; its owner keeps
// receiving every stream delta and supplies the latest snapshot on reveal.
export const ChatMessageList = memo(forwardRef<HTMLDivElement, ChatMessageListProps>(function ChatMessageList(props, chatEndRef) {
  const visibilityRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const [presented, setPresented] = useState(props);
  const presenting = props.active !== false || visible
    || props.threadId !== presented.threadId || props.repoPath !== presented.repoPath;
  useEffect(() => {
    const container = visibilityRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) if (entry.target === container) setVisible(entry.contentRect.width > 0);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  // Retain one committed presentation, not a growing cache of stream snapshots.
  // React restarts this small wrapper before reconciling the presentation.
  if (presenting && presented !== props) setPresented(props);
  return <ChatMessageListPresentation {...(presenting ? props : presented)} visibilityRef={visibilityRef} ref={chatEndRef} />;
}));

interface ChatMessageListPresentationProps extends ChatMessageListProps {
  visibilityRef: RefObject<HTMLDivElement | null>;
}

const ChatMessageListPresentation = memo(forwardRef<HTMLDivElement, ChatMessageListPresentationProps>(function ChatMessageListPresentation({
  visibilityRef,
  displayMessages: rawDisplayMessages,
  logLabel,
  displayWaiting,
  liveCompaction = false,
  threadId,
  active = false,
  repoPath,
  activeTargetLabel,
  activeTargetColor,
  thoughtsMutedGlass,
  thoughtsElevatedBorder,
  thoughtsElevatedShadow,
  emptyStateOverride,
  emptyStateFallback,
  composeFirst = false,
  topContent,
  bottomContent,
  composerQueue,
  turnContent,
  isOrchestratorMode = false,
  suggestedReplyMessageId,
  suggestedReplies,
  onSelectSuggestion,
  onDismissSuggestions,
  suggestedRepliesCollapsed = false,
  onRestoreSuggestions,
  suggestedRepliesPending = false,
  turnSummary = null,
  onScroll,
  onRetryDelivery,
  taskArtifacts,
  taskArtifactThreadBusy = false,
  onTaskArtifactDeliver,
}, chatEndRef) {
  // Parallel tool work emitted as separate tool-only assistant messages
  // renders as ONE merged cluster (a single counted "Running N commands"
  // line) instead of a stack of shimmer rows. Render-time derivation — the
  // underlying message state is untouched.
  const scrollRef = useRef<HTMLDivElement>(null);
  const displayMessages = useMemo(() => mergeAdjacentToolOnlyEntries(rawDisplayMessages), [rawDisplayMessages]);
  const items = useMemo(() => buildMissionRenderItems(displayMessages), [displayMessages]);
  const visualizations = useTranscriptVisualizations({ repoPath, threadId, active, length: rawDisplayMessages.length });
  const visualsByIndex = useMemo(() => placeTranscriptVisualizations(visualizations, displayMessages), [visualizations, displayMessages]);
  const renderVisualizations = (index: number) => (visualsByIndex.get(index) ?? []).map(reference => (
    <VisualizationFrame key={reference.id} reference={reference} />
  ));
  // Each artifact renders after the last transcript entry that precedes its
  // creation; anything newer than the transcript lands at the end. Key -1 is
  // the "no entries yet" bucket.
  const taskArtifactsByIndex = useMemo(() => placeTaskArtifacts(taskArtifacts ?? [], displayMessages), [taskArtifacts, displayMessages]);
  const renderTaskArtifacts = (index: number) => {
    const bucket = taskArtifactsByIndex.get(index);
    if (!bucket || !onTaskArtifactDeliver) return null;
    return bucket.map((entry) => (
      <TaskArtifactCard
        key={entry.artifact.id}
        artifactId={entry.artifact.id}
        threadBusy={taskArtifactThreadBusy}
        onDeliverToThread={onTaskArtifactDeliver}
      />
    ));
  };
  // Phase 4 — chips strip renders when EITHER chips arrived OR a fetch is in
  // flight / just failed (placeholder). Both share the same anchor under the
  // last assistant message. Without the placeholder branch the strip would
  // silently render nothing during transient failures.
  const hasSuggestedReplies = Boolean(
    suggestedReplyMessageId
    && (
      (suggestedReplies && suggestedReplies.length > 0)
      || suggestedRepliesPending
      || (suggestedRepliesCollapsed && onRestoreSuggestions)
    )
    && onSelectSuggestion
    && onDismissSuggestions,
  );
  // #845 — chips must render directly under the assistant message they belong
  // to (not at the list tail). Find the index of the LAST assistant entry; the
  // map below renders the chip row right after that bubble.
  let lastAssistantIndex = -1;
  for (let i = displayMessages.length - 1; i >= 0; i -= 1) {
    if (displayMessages[i]?.role === 'assistant' && !displayMessages[i]?.voice) {
      lastAssistantIndex = i;
      break;
    }
  }
  const latestAssistantId = displayMessages[lastAssistantIndex]?.id ?? null;
  const [animatingTailId, setAnimatingTailId] = useState<string | null>(() => displayWaiting ? latestAssistantId : null);
  if (displayWaiting && animatingTailId !== latestAssistantId) setAnimatingTailId(latestAssistantId);
  const settleTail = useCallback((messageId: string) => {
    setAnimatingTailId(previous => previous === messageId ? null : previous);
  }, []);
  // Completed histories have no visibility-dependent row props. A streamed
  // answer keeps that signal until its visible post-stream tail has drained.
  const animateLatestAssistant = active && (displayWaiting || animatingTailId === latestAssistantId);
  const turnEntries = useMemo(() => items.map(item => item.kind === 'msg' ? item.msg : item.entries[0]), [items]);
  const turnNodes = useMemo(() => items.map(item => {
    const msg = item.kind === 'msg' ? item.msg : item.entries[0];
    const index = item.kind === 'msg' ? item.index : item.lastIndex;
    return <ChatMessageItem key={msg.id} msg={msg}
      missionEntries={item.kind === 'mission-group' ? item.entries : undefined}
      isLast={index === displayMessages.length - 1 && !displayWaiting}
      isStreaming={index === lastAssistantIndex && displayWaiting}
      animateStreaming={animateLatestAssistant && index === lastAssistantIndex}
      onRevealSettled={index === lastAssistantIndex ? settleTail : undefined}
      repoPath={repoPath} onRetryDelivery={onRetryDelivery} composerQueue={composerQueue}
      visualizations={visualsByIndex.get(index)} artifacts={taskArtifactsByIndex.get(index)}
      taskArtifactThreadBusy={taskArtifactsByIndex.has(index) && taskArtifactThreadBusy} onTaskArtifactDeliver={onTaskArtifactDeliver}
      showChips={Boolean(index === lastAssistantIndex && hasSuggestedReplies && msg.id === suggestedReplyMessageId)}
      displayWaiting={index === lastAssistantIndex && displayWaiting} suggestedReplies={suggestedReplies}
      onSelectSuggestion={onSelectSuggestion} onDismissSuggestions={onDismissSuggestions}
      suggestedRepliesCollapsed={suggestedRepliesCollapsed} onRestoreSuggestions={onRestoreSuggestions}
      suggestedRepliesPending={suggestedRepliesPending} />;
  }), [items, displayMessages.length, displayWaiting, lastAssistantIndex, animateLatestAssistant, settleTail,
    repoPath, onRetryDelivery, composerQueue, visualsByIndex, taskArtifactsByIndex, taskArtifactThreadBusy,
    onTaskArtifactDeliver, hasSuggestedReplies, suggestedReplyMessageId, suggestedReplies,
    onSelectSuggestion, onDismissSuggestions, suggestedRepliesCollapsed, onRestoreSuggestions, suggestedRepliesPending]);
  const showEmptyWithOverride = displayMessages.length === 0 && !displayWaiting && emptyStateOverride;
  const showEmptyWithFallback = displayMessages.length === 0 && !displayWaiting && !emptyStateOverride;

  return (
    <div ref={visibilityRef} style={{ position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0, flex: composeFirst ? '0 1 auto' : 1 }}>
    <TranscriptNavigator entries={displayMessages} scrollRef={scrollRef} />
    <div ref={scrollRef}
      role={logLabel ? 'log' : undefined}
      aria-label={logLabel}
      data-o8-chat-thread={threadId || undefined}
      data-o8-active-chat={active && threadId ? 'true' : undefined}
      className="thoughts-scroll cortex-scroll-fade-y cortex-themed-scroll"
      // Voice-playback scroll-follow yields to a manual scroll gesture here.
      onWheel={noteUserScroll}
      onTouchMove={noteUserScroll}
      onScroll={onScroll}
      style={{
      flex: composeFirst ? '0 1 auto' : 1,
      overflowY: 'auto',
      // THE body-scroll trigger (hunted since 0.1.608, closed 2026-07-16 via
      // frame-by-frame video forensics): without containment, trackpad
      // momentum at this scroller's boundary CHAINS to the document — and at
      // non-100% UI zoom the inverse-sized root has real scroll range, so the
      // whole shell displaces until the dashboard guard snaps it back (the
      // rubber-band jumping + WKWebView banding in Q's clip). Contain kills
      // the chain at the source; the shell guard stays as the invariant net.
      overscrollBehaviorY: 'contain',
      paddingTop: 14,
      paddingRight: 'var(--cortex-chat-gutter)',
      // Breathing room before the composer, sized to CLEAR the 30px bottom-fade
      // mask below — so scrolled all the way down, the last item (e.g. the
      // Mission complete card) sits fully in the sharp region above the fade and
      // never dissolves; only the empty padding fades into the composer.
      paddingBottom: composeFirst ? 12 : 36,
      paddingLeft: 'var(--cortex-chat-gutter)',
      display: 'flex',
      flexDirection: 'column',
      background: 'transparent',
      minHeight: 0,
    }}>
      <div style={{
        width: '100%',
        maxWidth: 'var(--cortex-chat-column-max)',
        minHeight: composeFirst ? 'auto' : '100%',
        marginRight: 'auto',
        marginLeft: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
      }}>
        {showEmptyWithOverride ? (
          <div style={{
            display: 'flex',
            flex: composeFirst ? 'none' : 1,
            minHeight: 0,
          }}>
            {emptyStateOverride}
          </div>
        ) : null}
        {showEmptyWithFallback ? emptyStateFallback : null}

        {topContent}
        {renderVisualizations(-1)}

        <TranscriptTurns busy={displayWaiting} repoPath={repoPath} summary={turnSummary} turnContent={turnContent}
          entries={turnEntries} nodes={turnNodes} />

        {renderTaskArtifacts(-1)}
        {bottomContent}
        {composerQueue ? <ComposerQueuedMessages queue={composerQueue} messages={displayMessages} /> : null}

        {liveCompaction && isOrchestratorMode ? (
          <div role="status" style={{ alignSelf: 'stretch', paddingTop: 10, paddingRight: 14, paddingBottom: 10, paddingLeft: 14, borderRadius: 12,
            background: 'var(--t-hover)', border: '1px solid var(--t-divider-subtle)' }}>
            <div style={{ fontSize: 12, fontWeight: 400, color: 'var(--t-text)' }}>Compaction in progress</div>
            <div style={{ fontSize: 11, fontWeight: 300, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>
              Context is being compressed. Messages sent now will be queued and delivered after compaction completes.
            </div>
          </div>
        ) : null}

        {displayWaiting && !liveCompaction && isOrchestratorMode && displayMessages.length > 0 ? (
          // Cursor's trailing anchor (vid2 study): while the turn is live, a
          // shimmering status line sits at the bottom of the process block and
          // is pushed down as new lines land above it. Text, never a bubble.
          <ShimmerLine style={{ alignSelf: 'flex-start', flexShrink: 0 }}>Planning next moves</ShimmerLine>
        ) : null}

        {displayWaiting && !isOrchestratorMode ? (
          <div style={{
            alignSelf: 'flex-start',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 14px',
            borderRadius: 16,
            background: thoughtsMutedGlass,
            border: thoughtsElevatedBorder,
            boxShadow: thoughtsElevatedShadow,
          }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: activeTargetColor, boxShadow: `0 0 0 4px ${activeTargetColor}14`, flexShrink: 0 }} />
            {[0, 1, 2].map((index) => (
              <div key={index} style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--t-text-secondary)', animation: `llmDot 1.2s ease-in-out ${index * 0.18}s infinite` }} />
            ))}
            <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--t-text-secondary)', letterSpacing: '-0.1px' }}>
              {activeTargetLabel} is thinking…
            </span>
          </div>
        ) : null}

        <div ref={chatEndRef} />
      </div>
    </div></div>
  );
}));

interface ChatMessageItemProps extends Pick<ChatMessageListProps,
  'repoPath' | 'onRetryDelivery' | 'composerQueue' | 'taskArtifactThreadBusy' | 'onTaskArtifactDeliver'
  | 'suggestedReplies' | 'onSelectSuggestion' | 'onDismissSuggestions' | 'suggestedRepliesCollapsed'
  | 'onRestoreSuggestions' | 'suggestedRepliesPending'> {
  msg: MobileTranscriptEntry;
  missionEntries?: MobileTranscriptEntry[];
  isLast: boolean;
  isStreaming: boolean;
  animateStreaming: boolean;
  onRevealSettled?: (messageId: string) => void;
  visualizations?: VisualizationReference[];
  artifacts?: TaskArtifactView[];
  showChips: boolean;
  displayWaiting: boolean;
}

function ChatMessageItem({ msg, missionEntries, isLast, isStreaming, animateStreaming, onRevealSettled, repoPath, onRetryDelivery, composerQueue,
  visualizations, artifacts, taskArtifactThreadBusy, onTaskArtifactDeliver, showChips, displayWaiting,
  suggestedReplies, onSelectSuggestion, onDismissSuggestions, suggestedRepliesCollapsed,
  onRestoreSuggestions, suggestedRepliesPending,
}: ChatMessageItemProps) {
  if (missionEntries) return <MissionCompleteGroupCard
    entries={missionEntries.map(entry => ({ key: entry.id, event: entry.statusEvent!, timestampLabel: entry.timestampLabel }))}
    isLast={isLast} />;
  if (msg.collide) return <CollideProposalCard collide={msg.collide} />;
  if (msg.type === 'handoff' && msg.handoff) return <HandoffTranscriptCard handoff={msg.handoff} timestampLabel={msg.timestampLabel} />;
  return <Fragment>
    {msg.role === 'assistant' && msg.receipt ? <TurnSummaryCard persistedEntry={msg} /> : null}
    <div data-o8-message-id={msg.id} style={{ minWidth: 0 }}>
      <DesktopAgentMessage entry={msg} isLast={isLast} isStreaming={isStreaming} animateStreaming={animateStreaming}
        onRevealSettled={onRevealSettled}
        repoPath={repoPath} onRetryDelivery={onRetryDelivery}
        visualizations={msg.role === 'assistant' ? visualizations : undefined}
        userDelivery={<ComposerEntryDelivery id={msg.id} queue={composerQueue} />} />
    </div>
    {onTaskArtifactDeliver ? artifacts?.map(entry => <TaskArtifactCard key={entry.artifact.id}
      artifactId={entry.artifact.id} threadBusy={taskArtifactThreadBusy ?? false} onDeliverToThread={onTaskArtifactDeliver} />) : null}
    {msg.role !== 'assistant' ? visualizations?.map(reference => <VisualizationFrame key={reference.id} reference={reference} />) : null}
    {showChips && onSelectSuggestion && onDismissSuggestions ? <SuggestedReplies
      chips={suggestedReplies ?? []} disabled={displayWaiting} onSelect={onSelectSuggestion} onDismiss={onDismissSuggestions}
      collapsed={suggestedRepliesCollapsed} onRestore={onRestoreSuggestions} isPlaceholder={suggestedRepliesPending} /> : null}
  </Fragment>;
}
