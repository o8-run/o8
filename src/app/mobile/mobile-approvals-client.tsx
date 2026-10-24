'use client';

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import { useTheme } from '@/lib/theme/context';
import { ThemeProvider as MobileThemeProvider } from '@/components/mobile/ThemeContext';
import { compactLine as mobileCompactLine } from '@/components/mobile/utils';
import { MobileAuroraBg } from './mobile-aurora-bg';
import { AssistantChatView } from './mobile-assistant-chat-view';
import { ApprovalsView } from './mobile-approvals-approvals-view';
import { ChatListView } from './mobile-approvals-chat-list-view';
import { Sidebar } from './mobile-approvals-sidebar';
import {
  DEFAULT_MOBILE_CHAT_MODEL,
  MOBILE_BODY_TRACKING,
  MOBILE_CARD_RADIUS,
  IconArrowLeft,
  IconHamburger,
  IconRefresh,
  IconSearch,
  POLL_INTERVAL,
  generateChatTabId,
  getMobilePalette,
  getModelOption,
  glassButtonStyle,
  mobileFontFamily,
  mobileScrollFadeStyle,
  normalizeHistoryList,
  readStoredMobileModel,
  type ApprovalItem,
  type ChatHistoryRecord,
  type MobileView,
} from './mobile-approvals-shared';
import { MobileSettingsSheet } from '@/components/mobile/MobileSettingsSheet';
import { useMobileSearchNavigation } from '@/components/mobile/useMobileSearchNavigation';
import { MobileSearchSheet, useMobileSearchHotkey } from '@/components/mobile/MobileSearchSheet';
import {
  getMobileRepoLabel,
  normalizeMobileRepoList,
  readStoredMobileRepoPath,
  writeStoredMobileRepoPath,
  type MobileRepoOption,
} from './mobile-chat-repos';
import { getBrowserWsPort } from '@/lib/panel/ws-port-client';
import { triggerHaptic } from '@/lib/mobile/haptic';
import { getMobileWsToken } from '@/lib/mobile/ws-token-client';

const FleetView = lazy(async () => ({
  default: (await import('@/components/mobile/FleetView')).FleetView,
}));
const IssuesPage = lazy(async () => ({
  default: (await import('@/components/mobile/IssuesPage')).default,
}));
const ActivityFeed = lazy(async () => ({
  default: (await import('@/components/mobile/ActivityFeed')).ActivityFeed,
}));
const CostsDashboard = lazy(async () => ({
  default: (await import('@/components/mobile/CostsDashboard')).CostsDashboard,
}));
const OrchestratorView = lazy(async () => ({
  default: (await import('@/components/mobile/OrchestratorView')).OrchestratorView,
}));
const AgentTranscriptSheet = lazy(async () => ({
  default: (await import('@/components/mobile/AgentTranscriptSheet')).AgentTranscriptSheet,
}));

const NEW_VIEWS: ReadonlySet<MobileView> = new Set(['agents', 'issues', 'activity', 'costs', 'orchestrator']);
const SNAPSHOT_VIEWS: ReadonlySet<MobileView> = new Set(['agents', 'activity', 'costs']);

function MobileViewShell({ children, themeId }: { children: ReactNode; themeId: string }) {
  // Forward the desktop themeId (resolved from cortex-theme localStorage in
  // the parent's useTheme hook) so the legacy mobile ThemeProvider stays in
  // lock-step on same-tab theme changes — storage events fire only across
  // tabs. Without this, switching to Light flipped the topbar but left the
  // 5 wired tabs (Agents/Issues/Activity/Costs/Orchestrator) on dark colors.
  return <MobileThemeProvider themeId={themeId}>{children}</MobileThemeProvider>;
}

function getWsToken() {
  return getMobileWsToken() || null;
}

function getWsBridgeUrl(token: string) {
  if (typeof window === 'undefined') return null;

  const isTauri = window.location.protocol === 'tauri:' || Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  if (isTauri) {
    return `ws://127.0.0.1:${getBrowserWsPort()}/ws?token=${encodeURIComponent(token)}`;
  }

  // [mobile-lan] Connect to the ws-server port on the same host as the page.
  // We used to attempt the same-port `/ws` rewrite for LAN/Tailscale hosts,
  // but Next.js's standalone server does NOT proxy WebSocket upgrades through
  // rewrites. ws-server already binds 0.0.0.0:<wsPort>, so direct host:wsPort
  // works on LAN; the token query param is verified before upgrade completes.
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.hostname}:${getBrowserWsPort()}/ws?token=${encodeURIComponent(token)}`;
}

const WS_RECONNECT_BASE_DELAY_MS = 1_000;
const WS_RECONNECT_MAX_DELAY_MS = 8_000;

function getReconnectDelayMs(attempt: number) {
  return Math.min(WS_RECONNECT_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1)), WS_RECONNECT_MAX_DELAY_MS);
}

export function MobileApprovalsClient({
  initialApprovals,
  appVersion,
  hostnameLabel = 'this device',
  initialView = 'chat',
}: {
  initialApprovals: ApprovalItem[];
  appVersion: string;
  hostnameLabel?: string;
  initialView?: MobileView;
}) {
  const { themeId, setTheme } = useTheme();
  const palette = useMemo(() => getMobilePalette(themeId), [themeId]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsSheetOpen, setSettingsSheetOpen] = useState(false);
  const [searchSheetOpen, setSearchSheetOpen] = useState(false);
  const [activeView, setActiveView] = useState<MobileView>(initialView);
  const [approvals, setApprovals] = useState<ApprovalItem[]>(initialApprovals);
  const [resolving, setResolving] = useState<{ id: string; action: 'approve' | 'reject' } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentTabId, setCurrentTabId] = useState<string | null>(null);
  const [recentConversations, setRecentConversations] = useState<ChatHistoryRecord[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);
  const [agentTranscriptSheet, setAgentTranscriptSheet] = useState<{
    sessionKey: string;
    name: string;
    runtime: string;
    status: string;
    workspace?: string;
  } | null>(null);
  const [selectedModelId] = useState(readStoredMobileModel);
  const [repoOptions, setRepoOptions] = useState<MobileRepoOption[]>([]);
  const [selectedRepoPath, setSelectedRepoPath] = useState<string | null>(readStoredMobileRepoPath);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected'>('disconnected');
  const [inboxSnapshot, setInboxSnapshot] = useState<MobileInboxSnapshot | null>(null);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const reconnectAttemptRef = useRef(0);

  const selectedModel = useMemo(
    () => getModelOption(selectedModelId) ?? getModelOption(DEFAULT_MOBILE_CHAT_MODEL)!,
    [selectedModelId],
  );
  const selectedRepoLabel = useMemo(
    () => getMobileRepoLabel(selectedRepoPath, repoOptions),
    [repoOptions, selectedRepoPath],
  );

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/panel/approvals?status=pending', { cache: 'no-store' });
      if (response.ok) {
        const data = await response.json() as { approvals?: ApprovalItem[] };
        setApprovals(data.approvals ?? []);
        setError(null);
      }
    } catch {
      setError('Unable to reach server');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [refresh]);

  // Buzz the device when an error toast appears so the user notices.
  // Only fires on transitions into a non-null error string.
  useEffect(() => {
    if (error) triggerHaptic('error');
  }, [error]);

  const loadRecentConversations = useCallback(async () => {
    setRecentLoading(true);
    try {
      // surface=mobile-assistant filters out desktop LLM tabs (llm-*),
      // orchestrator threads (thoughts-*), legacy mobile-orchestrator-*,
      // and o8-operator-modeled chats so the Assistant tab only shows
      // real mobile-side LLM conversations.
      const response = await fetch('/api/v2/chat-history/list?surface=mobile-assistant', { cache: 'no-store' });
      if (!response.ok) throw new Error('Failed to load conversations');
      const data = await response.json();
      setRecentConversations(normalizeHistoryList(data));
    } catch {
      setRecentConversations([]);
    } finally {
      setRecentLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeView === 'chat' && !currentTabId) {
      void loadRecentConversations();
    }
  }, [activeView, currentTabId, loadRecentConversations]);

  const loadInboxSnapshot = useCallback(async () => {
    try {
      const response = await fetch('/api/mobile/inbox', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as MobileInboxSnapshot;
      setInboxSnapshot(data);
      setInboxError(null);
    } catch (error) {
      console.log('[mobile-nav] inbox snapshot fetch failed', error);
      setInboxError('Unable to load fleet snapshot');
    }
  }, []);

  useEffect(() => {
    if (!SNAPSHOT_VIEWS.has(activeView)) return;
    void loadInboxSnapshot();
    const timer = setInterval(loadInboxSnapshot, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [activeView, loadInboxSnapshot]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch('/api/v2/repos', { cache: 'no-store' });
        if (!response.ok) throw new Error('Failed to load repositories');
        const data = await response.json();
        const nextRepos = normalizeMobileRepoList(data);
        if (cancelled) return;

        setRepoOptions(nextRepos);
        setSelectedRepoPath((current) => {
          if (!current) return current;
          return nextRepos.some((repo) => repo.localPath === current) ? current : null;
        });
      } catch {
        if (!cancelled) {
          setRepoOptions([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    writeStoredMobileRepoPath(selectedRepoPath);
  }, [selectedRepoPath]);

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket | null = null;
    let cancelled = false;

    const token = getWsToken();
    const url = token ? getWsBridgeUrl(token) : null;

    if (!url) {
      setConnectionStatus('disconnected');
      return undefined;
    }

    const connect = () => {
      if (cancelled) return;
      socket = new WebSocket(url);

      socket.onopen = () => {
        if (cancelled) return;
        const shouldRefreshApprovals = reconnectAttemptRef.current > 0;
        if (shouldRefreshApprovals) {
          console.info(`[mobile-ws] Reconnected after ${reconnectAttemptRef.current} attempt${reconnectAttemptRef.current === 1 ? '' : 's'}; polling approvals immediately`);
        }
        reconnectAttemptRef.current = 0;
        setConnectionStatus('connected');
        if (shouldRefreshApprovals) {
          void refresh();
        }
      };

      socket.onerror = () => {
        if (!cancelled) {
          setConnectionStatus('disconnected');
        }
      };

      socket.onclose = () => {
        if (cancelled) return;
        setConnectionStatus('disconnected');
        reconnectAttemptRef.current += 1;
        const reconnectDelayMs = getReconnectDelayMs(reconnectAttemptRef.current);
        console.info(`[mobile-ws] Connection closed; retry ${reconnectAttemptRef.current} in ${reconnectDelayMs}ms`);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, reconnectDelayMs);
      };
    };

    connect();

    return () => {
      cancelled = true;
      reconnectAttemptRef.current = 0;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [refresh]);

  // [push] Register sw-push.js + handle notification deep-links. Issue #639.
  useEffect(() => {
    let detach: (() => void) | null = null;
    void import('@/lib/mobile/push-client').then((mod) => {
      detach = mod.attachPushHandlers((url) => {
        const view = mod.parsePushDeepLinkView(url) as MobileView | null;
        if (view) setActiveView(view);
      });
    });
    return () => { if (detach) detach(); };
  }, []);

  const handleResolve = useCallback(async (id: string, action: 'approve' | 'reject', strategy?: string, via?: 'chip') => {
    setResolving({ id, action });
    triggerHaptic(action === 'approve' ? 'success' : 'warn');
    try {
      const payload: Record<string, string> = { action, id };
      if (strategy) payload.strategy = strategy;
      if (via) payload.via = via;
      const response = await fetch('/api/panel/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        setApprovals((previous) => previous.filter((approval) => approval.id !== id));
        setError(null);
      } else {
        const data = await response.json().catch(() => ({})) as { error?: string };
        setError(data.error ?? 'Failed to resolve approval');
      }
    } catch {
      setError('Unable to reach server');
    }
    setResolving(null);
  }, []);

  const handleNavigate = useCallback((view: MobileView) => {
    if (view === 'settings') {
      // Settings now opens as a sheet from the profile button — divert any
      // stale dispatcher (e.g. saved nav state) to the chat surface and pop
      // the sheet instead.
      setActiveView('chat');
      setCurrentTabId(null);
      setSettingsSheetOpen(true);
      return;
    }
    setActiveView(view);
    if (view === 'chat') {
      setCurrentTabId(null);
    }
  }, []);

  const handleThemeChange = useCallback((nextTheme: 'light' | 'dark') => {
    setTheme(nextTheme);
  }, [setTheme]);

  const handleRepoChange = useCallback((repoPath: string | null) => {
    setSelectedRepoPath(repoPath);
  }, []);

  const pendingCount = useMemo(
    () => approvals.filter((a) => {
      if (a.status !== 'pending') return false;
      if (a.source === 'runtime' || a.continuation?.kind === 'runtime') return false;
      if (a.source === 'llm-chat' && a.risk === 'low') return false;
      return true;
    }).length,
    [approvals],
  );
  const inConversation = activeView === 'chat' && currentTabId !== null;
  const isFullScreenView = NEW_VIEWS.has(activeView);
  const newViewTitle: Record<string, string> = {
    agents: 'Agents',
    issues: 'Issues',
    activity: 'Activity',
    costs: 'Costs',
    orchestrator: 'Orchestrator',
  };
  const viewTitle = activeView === 'settings'
    ? 'Settings'
    : activeView === 'approvals'
      ? 'Approvals'
      : isFullScreenView
        ? newViewTitle[activeView] ?? ''
        : inConversation
          ? recentConversations.find((conversation) => conversation.tabId === currentTabId)?.title ?? 'Chat'
          : 'Assistant';
  const [issuesRefreshSignal, setIssuesRefreshSignal] = useState(0);
  const [orchRefreshSignal, setOrchRefreshSignal] = useState(0);

  const handleFullScreenRefresh = useCallback(() => {
    if (activeView === 'agents' || activeView === 'activity' || activeView === 'costs') {
      void loadInboxSnapshot();
      return;
    }
    if (activeView === 'issues') {
      setIssuesRefreshSignal((value) => value + 1);
      return;
    }
    if (activeView === 'orchestrator') {
      setOrchRefreshSignal((value) => value + 1);
    }
  }, [activeView, loadInboxSnapshot]);

  const handleBackToChats = useCallback(() => {
    setActiveView('chat');
    setCurrentTabId(null);
  }, []);

  const handleSearchSelect = useMobileSearchNavigation(setActiveView, setCurrentTabId);

  // Global "/" hardware-keyboard shortcut to open search.
  const openSearchSheet = useCallback(() => setSearchSheetOpen(true), []);
  useMobileSearchHotkey(openSearchSheet);

  const handleSnapshotApprove = useCallback((approvalId?: string, via?: 'chip') => {
    if (!approvalId) return;
    void handleResolve(approvalId, 'approve', undefined, via);
  }, [handleResolve]);

  const handleSnapshotDeny = useCallback((approvalId?: string) => {
    if (!approvalId) return;
    void handleResolve(approvalId, 'reject');
  }, [handleResolve]);

  const renderSnapshotPlaceholder = useCallback((message: string) => (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        color: palette.subduedText,
        fontSize: 14,
        textAlign: 'center',
      }}
    >
      {message}
    </div>
  ), [palette.subduedText]);

  return (
    <div
      style={{
        position: 'relative',
        height: '100dvh',
        minHeight: '100dvh',
        maxHeight: '100dvh',
        overflow: 'hidden',
        backgroundColor: palette.rootBackground,
        color: palette.rootText,
        fontFamily: mobileFontFamily(),
        letterSpacing: MOBILE_BODY_TRACKING,
        WebkitFontSmoothing: 'antialiased',
      } as CSSProperties}
    >
      {palette.isDark ? <MobileAuroraBg /> : null}

      <div
        style={{
          position: 'relative',
          zIndex: 1,
          height: '100%',
          padding: isFullScreenView ? 0 : '0 16px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Sidebar
          open={sidebarOpen}
          activeView={activeView}
          approvalCount={pendingCount}
          selectedModelLabel={selectedModel.label}
          connectionStatus={connectionStatus}
          hostnameLabel={hostnameLabel}
          onNavigate={handleNavigate}
          onClose={() => setSidebarOpen(false)}
          onOpenSettings={() => setSettingsSheetOpen(true)}
          palette={palette}
        />

        <MobileSettingsSheet
          open={settingsSheetOpen}
          onClose={() => setSettingsSheetOpen(false)}
          themeId={themeId}
          onThemeChange={handleThemeChange}
          appVersion={appVersion}
          hostnameLabel={hostnameLabel}
          palette={palette}
        />

        <MobileSearchSheet
          open={searchSheetOpen}
          onClose={() => setSearchSheetOpen(false)}
          onResultSelect={handleSearchSelect}
          palette={palette}
        />

        <div
          style={{
            paddingTop: 'max(env(safe-area-inset-top, 0px), 16px)',
            paddingBottom: 12,
            paddingLeft: isFullScreenView ? 16 : 0,
            paddingRight: isFullScreenView ? 16 : 0,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            position: 'relative',
            zIndex: 5,
            flexShrink: 0,
            background: palette.rootBackground,
          } as CSSProperties}
        >
          {inConversation ? (
            <button
              onClick={() => { triggerHaptic('tap'); setCurrentTabId(null); }}
              style={{ ...glassButtonStyle(44, 'neutral', true, palette), borderRadius: MOBILE_CARD_RADIUS }}
              aria-label="Back to chats"
            >
              <IconArrowLeft fill={palette.iconFill} />
            </button>
          ) : (
            <button
              onClick={() => { triggerHaptic('tap'); setSidebarOpen(true); }}
              style={{ ...glassButtonStyle(44, 'neutral', true, palette), borderRadius: MOBILE_CARD_RADIUS, position: 'relative' }}
              aria-label="Menu"
            >
              <IconHamburger fill={palette.iconFill} />
              {pendingCount > 0 && activeView !== 'approvals' ? (
                <span
                  style={{
                    position: 'absolute',
                    top: 5,
                    right: 5,
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    backgroundColor: palette.danger,
                  }}
                />
              ) : null}
            </button>
          )}

          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 2,
            }}
          >
            <div
              style={{
                fontSize: 18,
                fontWeight: 800,
                letterSpacing: '-0.02em',
                maxWidth: '100%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                textAlign: 'center',
                color: palette.rootText,
              }}
            >
              {viewTitle}
            </div>
            {inConversation ? (
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.01em',
                  maxWidth: '100%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: palette.subduedText,
                }}
              >
                {selectedRepoLabel}
              </div>
            ) : null}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <button
              onClick={() => { triggerHaptic('tap'); setSearchSheetOpen(true); }}
              style={{ ...glassButtonStyle(44, 'neutral', true, palette), borderRadius: MOBILE_CARD_RADIUS }}
              aria-label="Search"
            >
              <IconSearch fill={palette.iconFill} />
            </button>
            {activeView === 'approvals' ? (
              <button
                onClick={() => { triggerHaptic('tap'); void refresh(); }}
                style={{ ...glassButtonStyle(44, 'neutral', true, palette), borderRadius: MOBILE_CARD_RADIUS }}
                aria-label="Refresh approvals"
              >
                <IconRefresh fill={palette.iconFill} />
              </button>
            ) : activeView === 'chat' && !inConversation ? (
              <button
                onClick={() => { triggerHaptic('tap'); void loadRecentConversations(); }}
                style={{ ...glassButtonStyle(44, 'neutral', true, palette), borderRadius: MOBILE_CARD_RADIUS }}
                aria-label="Refresh conversations"
              >
                <IconRefresh fill={palette.iconFill} />
              </button>
            ) : isFullScreenView ? (
              <button
                onClick={() => { triggerHaptic('tap'); handleFullScreenRefresh(); }}
                style={{ ...glassButtonStyle(44, 'neutral', true, palette), borderRadius: MOBILE_CARD_RADIUS }}
                aria-label={`Refresh ${viewTitle.toLowerCase()}`}
              >
                <IconRefresh fill={palette.iconFill} />
              </button>
            ) : null}
          </div>
        </div>

        {!isFullScreenView && error ? (
          <div
            style={{
              backgroundColor: palette.dangerSoft,
              border: `1px solid ${palette.dangerBorder}`,
              borderRadius: MOBILE_CARD_RADIUS,
              padding: '10px 12px',
              marginBottom: 12,
              fontSize: 13,
              color: palette.rootText,
            }}
          >
            {error}
          </div>
        ) : null}

        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: isFullScreenView ? 'auto' : 'hidden',
            WebkitOverflowScrolling: 'touch',
            // Contain overscroll on the full-screen scroller so pull-to-refresh
            // attached to the child views fires only from the top of THIS list,
            // not the page chrome above it.
            overscrollBehavior: isFullScreenView ? 'contain' : undefined,
            // For full-screen views (Agents/Issues/Activity/Costs/Orchestrator)
            // the standard 44px topbar sits above; the component below renders
            // its own filter chrome at the top. Fade content behind the bottom
            // edge so long lists don't cleanly cut off at the safe-area inset.
            ...(isFullScreenView
              ? mobileScrollFadeStyle({ top: 0, bottom: 24 })
              : {}),
          } as CSSProperties}
        >
          {activeView === 'approvals' ? (
            <ApprovalsView
              approvals={approvals}
              onResolve={handleResolve}
              resolving={resolving}
              palette={palette}
              onRefresh={refresh}
            />
          ) : null}

          {activeView === 'chat' && !currentTabId ? (
            <ChatListView
              conversations={recentConversations}
              loading={recentLoading}
              onSelect={setCurrentTabId}
              onNewChat={() => {
                setCurrentTabId(generateChatTabId());
              }}
              onRefresh={loadRecentConversations}
              palette={palette}
            />
          ) : null}

          {activeView === 'chat' && currentTabId ? (
            <AssistantChatView
              currentTabId={currentTabId}
              onTabIdChange={setCurrentTabId}
              onConversationSaved={() => {
                void loadRecentConversations();
              }}
              selectedModel={selectedModel}
              repoPath={selectedRepoPath}
              repoOptions={repoOptions}
              onRepoPathChange={handleRepoChange}
              onRepoPathLoaded={handleRepoChange}
              palette={palette}
            />
          ) : null}

          {activeView === 'agents' ? (
            <MobileViewShell themeId={themeId}>
              <Suspense fallback={renderSnapshotPlaceholder('Loading sessions…')}>
                {inboxSnapshot ? (
                  <FleetView
                    sessions={inboxSnapshot.sessions}
                    onAgentSelect={(sessionKey) => {
                      // v1 mobile model: agent transcripts are read-only.
                      // Tap an agent → open the transcript sheet. Steering
                      // happens from the desktop orchestrator.
                      const session = inboxSnapshot.sessions.find((s) => s.sessionKey === sessionKey);
                      if (!session) return;
                      setAgentTranscriptSheet({
                        sessionKey: session.sessionKey,
                        name: session.name?.trim() || session.surfaceLabel?.trim() || 'Untitled session',
                        runtime: session.runtime,
                        status: session.status,
                        workspace: session.workspace,
                      });
                    }}
                    onBack={handleBackToChats}
                    onLaunch={() => {
                      // Launching new agents happens via Orchestrator
                      // dispatch — surface that path instead of dropping
                      // the user on the Assistant.
                      setActiveView('orchestrator');
                    }}
                    hideHeader
                  />
                ) : inboxError ? (
                  renderSnapshotPlaceholder(inboxError)
                ) : (
                  renderSnapshotPlaceholder('Loading sessions…')
                )}
              </Suspense>
            </MobileViewShell>
          ) : null}

          {agentTranscriptSheet ? (
            <Suspense fallback={null}>
              <AgentTranscriptSheet
                open
                onClose={() => setAgentTranscriptSheet(null)}
                sessionKey={agentTranscriptSheet.sessionKey}
                agentName={agentTranscriptSheet.name}
                runtime={agentTranscriptSheet.runtime}
                status={agentTranscriptSheet.status}
                workspace={agentTranscriptSheet.workspace}
              />
            </Suspense>
          ) : null}

          {activeView === 'issues' ? (
            <MobileViewShell themeId={themeId}>
              <Suspense fallback={renderSnapshotPlaceholder('Loading issues…')}>
                <IssuesPage onBack={handleBackToChats} hideHeader refreshSignal={issuesRefreshSignal} />
              </Suspense>
            </MobileViewShell>
          ) : null}

          {activeView === 'activity' ? (
            <MobileViewShell themeId={themeId}>
              <Suspense fallback={renderSnapshotPlaceholder('Loading activity…')}>
                {inboxSnapshot ? (
                  <ActivityFeed
                    snapshot={inboxSnapshot}
                    onBack={handleBackToChats}
                    onAgentSelect={() => {
                      handleBackToChats();
                    }}
                    onApprove={(item) => handleSnapshotApprove(item.approvalId, item.refereeChips?.length ? 'chip' : undefined)}
                    onDeny={(item) => handleSnapshotDeny(item.approvalId)}
                    onRefresh={loadInboxSnapshot}
                    hideHeader
                  />
                ) : inboxError ? (
                  renderSnapshotPlaceholder(inboxError)
                ) : (
                  renderSnapshotPlaceholder('Loading activity…')
                )}
              </Suspense>
            </MobileViewShell>
          ) : null}

          {activeView === 'costs' ? (
            <MobileViewShell themeId={themeId}>
              <Suspense fallback={renderSnapshotPlaceholder('Loading costs…')}>
                {inboxSnapshot ? (
                  <CostsDashboard
                    snapshot={inboxSnapshot}
                    onBack={handleBackToChats}
                    onSessionSelect={() => {
                      handleBackToChats();
                    }}
                    compactLine={mobileCompactLine}
                    onRefresh={loadInboxSnapshot}
                    hideHeader
                  />
                ) : inboxError ? (
                  renderSnapshotPlaceholder(inboxError)
                ) : (
                  renderSnapshotPlaceholder('Loading costs…')
                )}
              </Suspense>
            </MobileViewShell>
          ) : null}

          {activeView === 'orchestrator' ? (
            <MobileViewShell themeId={themeId}>
              <Suspense fallback={renderSnapshotPlaceholder('Loading orchestrator…')}>
                <OrchestratorView onBack={handleBackToChats} hideHeader refreshSignal={orchRefreshSignal} repoOptions={repoOptions} repoPickerPalette={palette} />
              </Suspense>
            </MobileViewShell>
          ) : null}
        </div>
      </div>
    </div>
  );
}
