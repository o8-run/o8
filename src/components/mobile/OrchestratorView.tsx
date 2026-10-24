'use client';

/**
 * OrchestratorView — mobile Orchestrator tab.
 *
 * Layout (top to bottom):
 *   ┌──────────────────────────────────┐
 *   │ Header: title + connection chip   │
 *   │ Thread strip (horizontal, 92px)   │
 *   ├──────────────────────────────────┤
 *   │ Active thread transcript          │
 *   │ (scroll, fills remaining height)  │
 *   ├──────────────────────────────────┤
 *   │ Composer (fixed bottom)           │
 *   └──────────────────────────────────┘
 *
 * Alpha quality: read-mostly with a single composer. No mission control.
 * No multi-thread compose. No thread deletion. No "create thread" — to
 * start a new thread, dispatch from desktop.
 */

// stable
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type { MobileOrchestratorThread } from '@/lib/mobile/types';
import { useTheme } from './ThemeContext';
import {
  useOrchestratorMobile,
  type MobileOrchestratorConnectionState,
} from './hooks/useOrchestratorMobile';
import {
  ChevronLeftIcon,
  MicWaveformIndicator,
  SendIcon,
  StopIcon,
  ThreadCard,
  TranscriptBubble,
} from './orchestrator/parts';
import { IconCaretUp, IconPlus } from '@/app/mobile/mobile-approvals-shared';
import { usePressToDictate } from '@/lib/mobile/use-press-to-dictate';
import { PullToRefresh } from './PullToRefresh';
import { getMobileWsToken } from '@/lib/mobile/ws-token-client';
import { createMobileOrchestratorThreadFromRepo } from '@/lib/mobile/orchestrator-thread-create';
import { formatModelLabel } from '@/lib/format';
import { resolveEffectiveOrchestratorModel } from '@/lib/orchestrator/effective-model';
import type { OrchestratorBackendSetting } from '@/lib/operator/backend-setting';
import type {
  MobilePalette,
} from '@/app/mobile/mobile-approvals-shared';
import type { MobileRepoOption } from '@/app/mobile/mobile-chat-repos';
import { ConversationPullRequests } from '@/components/conversation-prs/ConversationPullRequests';
import { FirstConversationCard } from './orchestrator/FirstConversationCard';

interface OrchestratorViewProps {
  onBack: () => void;
  hideHeader?: boolean;
  refreshSignal?: number;
  repoOptions?: MobileRepoOption[];
  repoPickerPalette?: MobilePalette;
}

const POLL_INTERVAL_MS = 8_000;

function connectionLabel(state: MobileOrchestratorConnectionState): string {
  if (state === 'connected') return 'Live';
  if (state === 'connecting') return 'Connecting';
  if (state === 'reconnecting') return 'Reconnecting';
  return 'Offline';
}

function compactModelLabel(model: string): string {
  return formatModelLabel(model);
}

function connectionDot(state: MobileOrchestratorConnectionState): string {
  if (state === 'connected') return '#30D158';
  if (state === 'connecting' || state === 'reconnecting') return '#FFD60A';
  return '#A09890';
}

const STRIP_OPEN_KEY = 'o8:mobile:orchestrator-strip-open';
const LOCAL_THREAD_KEY = 'o8:mobile:orchestrator-local-thread';
const ACTIVE_THREAD_KEY = 'o8:mobile:orchestrator-active-thread';

function readStripOpen(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const raw = window.localStorage.getItem(STRIP_OPEN_KEY);
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}

function writeStripOpen(open: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STRIP_OPEN_KEY, open ? '1' : '0');
  } catch {
    // ignore
  }
}

function readLocalThread(): MobileOrchestratorThread | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(LOCAL_THREAD_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as MobileOrchestratorThread;
  } catch {
    return null;
  }
}

function writeLocalThread(thread: MobileOrchestratorThread | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (thread) window.localStorage.setItem(LOCAL_THREAD_KEY, JSON.stringify(thread));
    else window.localStorage.removeItem(LOCAL_THREAD_KEY);
  } catch {
    // ignore
  }
}

function readStoredActiveThreadId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(ACTIVE_THREAD_KEY);
  } catch {
    return null;
  }
}

function writeStoredActiveThreadId(id: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (id) window.localStorage.setItem(ACTIVE_THREAD_KEY, id);
    else window.localStorage.removeItem(ACTIVE_THREAD_KEY);
  } catch {
    // ignore
  }
}

export function OrchestratorView({
  onBack,
  hideHeader = false,
  refreshSignal = 0,
  repoOptions = [],
  repoPickerPalette,
}: OrchestratorViewProps) {
  const { colors } = useTheme();
  const [threads, setThreads] = useState<MobileOrchestratorThread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadIdState] = useState<string | null>(() => readStoredActiveThreadId());
  const [localThread, setLocalThreadState] = useState<MobileOrchestratorThread | null>(() => readLocalThread());
  const [composerDraft, setComposerDraft] = useState('');
  const [stripOpen, setStripOpen] = useState<boolean>(() => readStripOpen());
  const [newConversationRepoPath, setNewConversationRepoPath] = useState<string | null>(null);

  const setActiveThreadId = useCallback((id: string | null | ((prev: string | null) => string | null)) => {
    setActiveThreadIdState((prev) => {
      const next = typeof id === 'function' ? id(prev) : id;
      writeStoredActiveThreadId(next);
      return next;
    });
  }, []);

  const setLocalThread = useCallback((thread: MobileOrchestratorThread | null) => {
    setLocalThreadState(thread);
    writeLocalThread(thread);
  }, []);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  // Visible threads = the locally-minted "fresh" thread (if any) + the
  // server-side threads. The local thread sits at index 0 until the user
  // sends a message; once the server reports a thread with the same id,
  // we drop the local copy.
  const visibleThreads = useMemo<MobileOrchestratorThread[]>(() => {
    if (!localThread) return threads;
    if (threads.some((thread) => thread.id === localThread.id)) {
      return threads;
    }
    return [localThread, ...threads];
  }, [localThread, threads]);

  // Once the server has the local thread, retire the local copy so we
  // don't duplicate it forever.
  useEffect(() => {
    if (!localThread) return;
    if (threads.some((thread) => thread.id === localThread.id)) {
      setLocalThread(null);
    }
  }, [threads, localThread, setLocalThread]);

  // NOTE: we used to swap activeThreadId from the local mint to the first
  // server thread that appeared for the same repoPath. That was wrong —
  // the orchestrator's server-side "thread" file is an append-only
  // assistant-only log, not a per-conversation file. Swapping there meant
  // the user's typed messages vanished on reload because they were never
  // in the orchestrator's file. The mobile-side persistence now writes
  // user + assistant entries under the local mint id (see useOrchestratorMobile),
  // so the local thread is the canonical record. Keep it.

  // Direct PR navigation can target an archived or older conversation outside the recent list.
  useEffect(() => {
    if (!activeThreadId || visibleThreads.some(thread => thread.id === activeThreadId)) return;
    const controller = new AbortController();
    void fetch(`/api/mobile/conversation-pr-context?threadId=${encodeURIComponent(activeThreadId)}`, { signal: controller.signal })
      .then(response => response.json()).then(body => {
        if (!controller.signal.aborted && body.ok && body.result?.thread) setLocalThread(body.result.thread);
      }).catch(() => {});
    return () => controller.abort();
  }, [activeThreadId, visibleThreads, setLocalThread]);

  const activeThread = useMemo(
    () => visibleThreads.find((thread) => thread.id === activeThreadId) ?? null,
    [visibleThreads, activeThreadId],
  );

  const {
    connectionState,
    turnStatus,
    transcript,
    transcriptLoading,
    errorNote,
    sendMessage,
    interrupt,
    retryQueued,
    discardQueued,
  } = useOrchestratorMobile({ activeThread });

  // Pull the orchestrator brain model from operator-defaults so the user
  // can see what the orchestrator and any spawned agents will use.
  const [orchestratorModel, setOrchestratorModel] = useState<string | null>(null);
  const [defaultDispatchRuntime, setDefaultDispatchRuntime] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const wsToken = getMobileWsToken();
    const headers: Record<string, string> = {};
    if (wsToken) headers.Authorization = `Bearer ${wsToken}`;
    Promise.all([
      fetch('/api/panel/operator-defaults', { headers, cache: 'no-store' }),
      fetch('/api/runtime/claude-code-profile', { headers, cache: 'no-store' }),
    ]).then(async ([defaultsResponse, profileResponse]) => {
      if (!defaultsResponse.ok) return;
      const data = await defaultsResponse.json() as {
        values?: {
          orchestratorBackend?: OrchestratorBackendSetting;
          orchestratorModel?: string;
          inAppOrchestratorEnabled?: boolean;
          defaultDispatchRuntime?: string;
        };
      };
      const profile = profileResponse.ok
        ? await profileResponse.json() as {
            profile?: { source?: 'native' | 'openrouter' | 'codex-subscription' };
            effectiveModel?: string | null;
          }
        : null;
      if (cancelled) return;
      setOrchestratorModel(resolveEffectiveOrchestratorModel({
        backend: data.values?.orchestratorBackend,
        configuredModel: data.values?.orchestratorModel,
        inAppOrchestratorEnabled: data.values?.inAppOrchestratorEnabled,
        harnessSource: profile?.profile?.source,
        harnessModel: profile?.effectiveModel,
      }));
      setDefaultDispatchRuntime(data.values?.defaultDispatchRuntime ?? null);
    })
      .catch((error) => console.log('[mobile-orchestrator] operator-defaults fetch failed', error));
    return () => { cancelled = true; };
  }, [refreshSignal]);

  const fetchThreads = useCallback(async () => {
    setThreadsLoading(true);
    try {
      const response = await fetch('/api/mobile/orchestrator/threads', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { threads?: MobileOrchestratorThread[] };
      setThreads(data.threads ?? []);
      setThreadsError(null);
    } catch (error) {
      console.log('[mobile-orchestrator] threads fetch failed', error);
      setThreadsError('Unable to load orchestrator threads.');
    } finally {
      setThreadsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchThreads();
  }, [fetchThreads, refreshSignal]);

  // Polling fallback so the strip stays roughly current even if the user
  // doesn't pull-to-refresh.
  useEffect(() => {
    const handle = window.setInterval(() => { void fetchThreads(); }, POLL_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [fetchThreads]);

  // Auto-pick the most recent thread on first load so the user lands on
  // SOMETHING instead of an empty stage. We pull from visibleThreads so
  // the locally-minted "New conversation" thread takes precedence after
  // a reset.
  useEffect(() => {
    if (activeThreadId) return;
    if (visibleThreads.length === 0) return;
    setActiveThreadId(visibleThreads[0].id);
  }, [activeThreadId, visibleThreads, setActiveThreadId]);

  // Auto-scroll transcript to bottom when entries arrive.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [transcript.length, transcriptLoading]);

  const handleSelectThread = useCallback((id: string) => {
    setActiveThreadId(id);
  }, [setActiveThreadId]);

  const handleNewConversation = useCallback(async () => {
    const repoPath = activeThread?.repoPath ?? newConversationRepoPath;
    const selectedRepo = repoOptions.find((repo) => repo.localPath === repoPath) ?? null;
    const repoName = activeThread?.repoName ?? selectedRepo?.name ?? null;
    console.log('[mobile-orchestrator] new conversation requested', { repoPath });
    try {
      const freshThread = await createMobileOrchestratorThreadFromRepo({
        repoPath: repoPath ?? '',
        repoName,
        repoBranch: activeThread?.repoBranch ?? null,
        backend: activeThread?.backend ?? null,
        agent: activeThread?.agent ?? null,
      }, {
        token: getMobileWsToken(),
      });
      setLocalThread(freshThread);
      setActiveThreadId(freshThread.id);
      setThreadsError(null);
      requestAnimationFrame(() => composerRef.current?.focus());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to reset orchestrator session.';
      console.log('[mobile-orchestrator] reset failed', error);
      setThreadsError(message);
    }
  }, [
    activeThread?.agent,
    activeThread?.backend,
    activeThread?.repoBranch,
    activeThread?.repoName,
    activeThread?.repoPath,
    newConversationRepoPath,
    repoOptions,
    setActiveThreadId,
    setLocalThread,
  ]);

  const handleToggleStrip = useCallback(() => {
    setStripOpen((current) => {
      const next = !current;
      writeStripOpen(next);
      return next;
    });
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = composerDraft.trim();
    if (!trimmed) return;
    sendMessage(trimmed);
    setComposerDraft('');
    // Refocus so power users can keep typing if needed.
    requestAnimationFrame(() => composerRef.current?.focus());
  }, [composerDraft, sendMessage]);

  // ── Voice input (long-press send to dictate) ──────────────────────────────
  const voice = usePressToDictate();
  const draftAtRecordingStartRef = useRef('');
  // Snapshot the draft when recording starts so the transcript appends to
  // what the user already typed instead of replacing it.
  useEffect(() => {
    if (voice.isRecording) draftAtRecordingStartRef.current = composerDraft;
    // composerDraft intentionally omitted: only capture on the rising edge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.isRecording]);

  useEffect(() => {
    if (!voice.transcript) return;
    const base = draftAtRecordingStartRef.current;
    const sep = base && !base.endsWith(' ') ? ' ' : '';
    setComposerDraft(`${base}${sep}${voice.transcript}`);
    requestAnimationFrame(() => composerRef.current?.focus());
  }, [voice.transcript]);

  const handleComposerKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const isEmpty = visibleThreads.length === 0 && !threadsLoading;
  const wsReady = connectionState === 'connected';
  const newConversationTargetRepo = activeThread?.repoPath ?? newConversationRepoPath;
  const canCreateConversation = Boolean(newConversationTargetRepo);
  // Allow sending while offline — sendMessage routes to the offline queue
  // and the user sees a "Queued" bubble that drains on reconnect.
  const canSend =
    Boolean(activeThread?.repoPath)
    && composerDraft.trim().length > 0
    && turnStatus !== 'busy';

  // Styles
  const headerStyle: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 12,
    paddingTop: 14, paddingRight: 18, paddingBottom: 10, paddingLeft: 18,
    color: colors.text,
  };
  const backButtonStyle: CSSProperties = {
    width: 36, height: 36, minWidth: 36, minHeight: 36,
    borderRadius: 999, borderWidth: 1, borderStyle: 'solid',
    borderColor: colors.surfaceBorder, background: colors.surface, color: colors.text,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', flexShrink: 0,
    WebkitTapHighlightColor: 'transparent',
  };
  const titleStackStyle: CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1,
  };
  const connectionPillStyle: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    paddingTop: 4, paddingRight: 10, paddingBottom: 4, paddingLeft: 10,
    borderRadius: 999, borderWidth: 1, borderStyle: 'solid',
    borderColor: colors.surfaceBorder, background: colors.surface, color: colors.textSecondary,
    fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
    flexShrink: 0,
  };
  const stripWrapStyle: CSSProperties = {
    display: 'flex', gap: 10, overflowX: 'auto', overflowY: 'hidden',
    paddingTop: 4, paddingRight: 18, paddingBottom: 12, paddingLeft: 18,
    scrollbarWidth: 'none',
    WebkitOverflowScrolling: 'touch',
  };
  const transcriptFadeGradient = 'linear-gradient(to bottom, transparent 0px, black 24px, black calc(100% - 24px), transparent 100%)';
  const transcriptWrapStyle: CSSProperties = {
    flex: 1, minHeight: 0, overflowY: 'auto',
    paddingTop: 8, paddingRight: 14, paddingBottom: 12, paddingLeft: 14,
    display: 'flex', flexDirection: 'column', gap: 8,
    background: 'transparent',
    WebkitOverflowScrolling: 'touch',
    // Top fades behind the thread strip above (~92px reserve); bottom fades
    // behind the composer so messages don't cleanly cut off there.
    maskImage: transcriptFadeGradient,
    WebkitMaskImage: transcriptFadeGradient,
  };
  const composerWrapStyle: CSSProperties = {
    paddingTop: 10, paddingRight: 12,
    paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)',
    paddingLeft: 12,
    borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: colors.surfaceBorder,
    background: colors.frostBg,
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    flexShrink: 0,
  };
  const composerInputRowStyle: CSSProperties = {
    display: 'flex', alignItems: 'flex-end', gap: 8,
    borderRadius: 14, borderWidth: 1, borderStyle: 'solid',
    borderColor: colors.surfaceBorder, background: colors.composeBg,
    paddingTop: 8, paddingRight: 8, paddingBottom: 8, paddingLeft: 12,
  };
  const composerTextareaStyle: CSSProperties = {
    flex: 1, minHeight: 36, maxHeight: 140,
    borderWidth: 0, background: 'transparent', color: colors.text,
    fontSize: 14, lineHeight: 1.45, resize: 'none', outline: 'none',
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
  };
  const sendButtonStyle: CSSProperties = {
    width: 36, height: 36, minWidth: 36, minHeight: 36,
    borderRadius: 999, borderWidth: 0,
    background: canSend ? colors.accent : colors.blueGlass,
    color: canSend ? '#FFFFFF' : colors.textTertiary,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    cursor: canSend ? 'pointer' : 'default', flexShrink: 0,
    WebkitTapHighlightColor: 'transparent',
    transition: 'background 180ms cubic-bezier(0.22, 1, 0.36, 1), color 180ms cubic-bezier(0.22, 1, 0.36, 1)',
  };
  const stopButtonStyle: CSSProperties = {
    ...sendButtonStyle,
    background: 'rgba(255,69,58,0.18)', color: '#FF453A', cursor: 'pointer',
  };
  const noteStyle: CSSProperties = {
    margin: 0,
    paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 12,
    borderRadius: 10, borderWidth: 1, borderStyle: 'solid',
    borderColor: 'rgba(255,69,58,0.30)', background: 'rgba(255,69,58,0.10)', color: '#FF8A80',
    fontSize: 12, lineHeight: 1.45,
  };

  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column',
        minHeight: hideHeader ? '100%' : '100vh',
        height: hideHeader ? '100%' : undefined,
        background: colors.bg, color: colors.text,
      }}
    >
      {hideHeader ? (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            paddingTop: 8, paddingRight: 14, paddingBottom: 6, paddingLeft: 14,
          }}
        >
          <span
            style={{
              fontSize: 12, color: colors.textSecondary, fontWeight: 500,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0,
            }}
          >
            {activeThread ? activeThread.title : isEmpty ? 'No active threads' : 'Pick a thread'}
          </span>
          {orchestratorModel ? (
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                paddingTop: 4, paddingRight: 8, paddingBottom: 4, paddingLeft: 8,
                borderRadius: 999, borderWidth: 1, borderStyle: 'solid',
                borderColor: colors.surfaceBorder, background: colors.frostStrong,
                color: colors.textSecondary,
                fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
                flexShrink: 0,
              }}
              title={`Orchestrator brain: ${orchestratorModel}${defaultDispatchRuntime ? ` · spawns ${defaultDispatchRuntime}` : ''}`}
            >
              {compactModelLabel(orchestratorModel)}
            </span>
          ) : null}
          <div style={connectionPillStyle}>
            <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: connectionDot(connectionState) }} />
            {connectionLabel(connectionState)}
          </div>
          <button
            type="button"
            onClick={handleToggleStrip}
            aria-label={stripOpen ? 'Collapse threads' : 'Expand threads'}
            title={stripOpen ? 'Collapse threads' : 'Expand threads'}
            style={{
              width: 32, height: 32, minWidth: 32, minHeight: 32,
              borderRadius: 999, borderWidth: 1, borderStyle: 'solid',
              borderColor: colors.surfaceBorder, background: colors.frostStrong,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', flexShrink: 0,
              WebkitTapHighlightColor: 'transparent',
              transition: 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1)',
              transform: stripOpen ? 'rotate(0deg)' : 'rotate(180deg)',
              padding: 0,
            }}
          >
            <IconCaretUp fill={colors.text} size={14} />
          </button>
          <button
            type="button"
            onClick={() => { void handleNewConversation(); }}
            aria-label="New conversation"
            title="New conversation"
            disabled={!canCreateConversation}
            style={{
              width: 44, height: 44, minWidth: 44, minHeight: 44,
              borderRadius: 999, borderWidth: 1, borderStyle: 'solid',
              borderColor: canCreateConversation ? colors.accent : colors.surfaceBorder,
              background: canCreateConversation ? colors.blueGlass : colors.frostStrong,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              cursor: canCreateConversation ? 'pointer' : 'default', flexShrink: 0,
              WebkitTapHighlightColor: 'transparent',
              padding: 0,
            }}
          >
            <IconPlus fill={canCreateConversation ? colors.accent : colors.textTertiary} size={16} />
          </button>
        </div>
      ) : (
        <div style={headerStyle}>
          <button type="button" aria-label="Back" onClick={onBack} style={backButtonStyle}>
            <ChevronLeftIcon size={16} />
          </button>
          <div style={titleStackStyle}>
            <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em', color: colors.text }}>
              Orchestrator
            </span>
            <span
              style={{
                fontSize: 11, color: colors.textSecondary, fontWeight: 500,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {activeThread ? activeThread.title : isEmpty ? 'No active threads' : 'Pick a thread'}
            </span>
          </div>
          <div style={connectionPillStyle}>
            <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: connectionDot(connectionState) }} />
            {connectionLabel(connectionState)}
          </div>
        </div>
      )}

      <PullToRefresh onRefresh={fetchThreads} enabled={stripOpen}>
        <div
          style={{
            maxHeight: stripOpen ? 132 : 0,
            overflow: 'hidden',
            transition: 'max-height 220ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
          aria-hidden={!stripOpen}
        >
          <div style={stripWrapStyle}>
            {visibleThreads.map((thread) => (
              <ThreadCard
                key={thread.id}
                thread={thread}
                active={thread.id === activeThreadId}
                onSelect={handleSelectThread}
              />
            ))}
            {threadsLoading && visibleThreads.length === 0 ? (
              <div style={{ flex: '0 0 auto', width: 200, height: 80, borderRadius: 14, background: colors.elevatedSurface }} />
            ) : null}
          </div>
        </div>
      </PullToRefresh>

      {threadsError ? (
        <div style={{ paddingTop: 0, paddingRight: 18, paddingBottom: 8, paddingLeft: 18 }}>
          <p style={noteStyle}>{threadsError}</p>
        </div>
      ) : null}

      <div ref={transcriptRef} style={transcriptWrapStyle}>
        {!activeThread && isEmpty ? (
          <FirstConversationCard
            repoOptions={repoOptions}
            repoPickerPalette={repoPickerPalette}
            selectedRepoPath={newConversationRepoPath}
            onSelectRepoPath={setNewConversationRepoPath}
            onCreate={() => { void handleNewConversation(); }}
          />
        ) : null}

        {transcriptLoading && transcript.length === 0 ? (
          <div style={{ alignSelf: 'flex-start', fontSize: 12, color: colors.textTertiary, fontStyle: 'italic' }}>
            Loading transcript…
          </div>
        ) : null}

        {transcript.map((entry) => (
          <TranscriptBubble
            key={entry.id}
            entry={entry}
            onRetryQueued={retryQueued}
            onDiscardQueued={discardQueued}
          />
        ))}

        {turnStatus === 'busy' ? (
          <div
            style={{
              alignSelf: 'flex-start',
              paddingTop: 6, paddingRight: 12, paddingBottom: 6, paddingLeft: 12,
              borderRadius: 12, background: colors.cardBg,
              color: colors.textSecondary, fontSize: 12, fontWeight: 600, letterSpacing: '0.02em',
              animation: 'mobile-orchestrator-pulse 1.4s ease-in-out infinite',
            }}
          >
            Thinking…
          </div>
        ) : null}

        {errorNote ? <p style={noteStyle}>{errorNote}</p> : null}
      </div>

      {activeThread ? <ConversationPullRequests threadId={activeThread.id} readOnly /> : null}
      {activeThread ? (
        <div style={composerWrapStyle}>
          <div style={composerInputRowStyle}>
            <textarea
              ref={composerRef}
              value={composerDraft}
              onChange={(event) => setComposerDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder={
                !activeThread.repoPath
                  ? 'This thread has no repo — open it on desktop to reply.'
                  : !wsReady
                    ? 'Offline — messages will queue and send on reconnect…'
                    : 'Reply to the orchestrator…'
              }
              rows={1}
              disabled={!activeThread.repoPath}
              style={composerTextareaStyle}
            />
            {turnStatus === 'busy' ? (
              <button type="button" aria-label="Stop" onClick={interrupt} style={stopButtonStyle}>
                <StopIcon size={14} />
              </button>
            ) : (
              <div style={{ position: 'relative', flexShrink: 0 }}>
                <button
                  type="button"
                  aria-label={voice.isRecording ? 'Recording — release to stop' : 'Send (hold to dictate)'}
                  title={voice.supported ? 'Tap to send · hold to dictate' : 'Voice not supported on this device'}
                  {...voice.pointerHandlers}
                  onContextMenu={(event) => event.preventDefault()}
                  onClick={(event) => {
                    if (voice.claimSuppressedClick()) {
                      event.preventDefault();
                      event.stopPropagation();
                      return;
                    }
                    if (!canSend) {
                      if (!voice.supported) voice.flashTooltip('Voice not supported on this device');
                      return;
                    }
                    handleSend();
                  }}
                  // NOTE: never `disabled` — disabled buttons swallow
                  // pointerdown on iOS so long-press can't start from an
                  // empty composer (the primary dictation use case).
                  style={{
                    ...sendButtonStyle,
                    background: voice.isRecording ? 'rgba(255,69,58,0.18)' : sendButtonStyle.background,
                    cursor: voice.isRecording || canSend ? 'pointer' : sendButtonStyle.cursor,
                    WebkitUserSelect: 'none',
                    userSelect: 'none',
                    WebkitTouchCallout: 'none',
                    touchAction: 'manipulation',
                    padding: 0,
                  }}
                >
                  {voice.isRecording ? (
                    <MicWaveformIndicator size={18} color="#FF453A" />
                  ) : (
                    <SendIcon size={16} />
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
          </div>
        </div>
      ) : null}

      <style>{`
        @keyframes mobile-orchestrator-pulse {
          0%, 100% { opacity: 0.5; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
