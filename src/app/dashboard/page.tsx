'use client';
/* eslint-disable @typescript-eslint/no-unused-vars -- dashboard shell is mid-refactor and keeps dormant wiring for upcoming panels */

import { Suspense, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { WorkspaceHeaderTab } from '@/components/desktop/shell/workspace-header-strip-types';
import { usePaletteFileSelection } from './hooks/usePaletteFileSelection';
import { isTauri, canUseTauriEvents, browserViewHide } from '@/lib/tauri/bridge';
import { isNonMacShell } from '@/lib/desktop/host-platform';
import { subscribeTauriEvent } from '@/lib/tauri/events';
import { track } from '@/lib/analytics/track';
import { AnimatePresence, motion } from 'framer-motion';
import { DashboardFrame as SmoothCorners } from './DashboardFrame';
import { ChatListCard } from './ChatListCard';
import { WORKSPACE_RAIL_CORNER_RADIUS } from '@/components/desktop/branch-rail-geometry';
import { DesktopWebSocketProvider, useSharedDesktopWs, useWsConnectionState } from '@/components/desktop/hooks/DesktopWebSocketContext';
import { bootstrapTranscripts } from '@/lib/transcripts/bootstrap';
import { buildTranscriptWsCallbacks } from '@/lib/transcripts/wireWsBridge';
import { HISTORY_NAVIGATION_SUPERSEDED_EVENT, mergeTranscriptEntries, WORKSPACE_THREAD_ID_EVENT } from '@/components/desktop/workspace-terminal/utils';
import { readAnyXtermSelection } from '@/components/desktop/workspace-terminal/xterm-selection-registry';
import { ReactiveQueryProvider } from '@/lib/query/provider';
import { useReactiveQuery } from '@/lib/query/use-reactive-query';
import { FeedbackSettingsEntry } from '@/components/desktop/FeedbackSheet';
import { AgentPanel } from '@/components/desktop/AgentPanel';
import { CompactNavigationRail } from '@/components/desktop/shell/CompactNavigationRail';
import { ChatListColumn, NAVIGATION_RAIL_WIDTH } from '@/components/desktop/shell/ChatListColumn';
import { DARK_FRAME_GLASS_TINT } from '@/lib/theme/glass-material';
import { SHELL_EDGE_INSET, SHELL_HEADER_HEIGHT, workspaceFrameCorners } from '@/components/desktop/shell/shell-geometry';
import { RightPanelResizeEdge } from '@/components/desktop/shell/RightPanelResizeEdge';
import { useColumnResize, RIGHT_COLUMN_CHROME, WORKSPACE_RESERVE } from '@/components/desktop/hooks/useColumnResize';
import { ChatListResizeEdge } from '@/components/desktop/shell/ChatListResizeEdge';
import { WorkspaceUtilityProvider } from '@/components/desktop/canvas/WorkspaceUtilityContext';
import { isWorkspaceUtilityKind, workspaceUtilityTab, type WorkspaceUtilityKind } from '@/components/desktop/canvas/workspace-utility-navigation';
// AgentPanelChat retired — orchestrator/chat tabs handle chat surfaces now.
import { useLeftPanelProjectFocus } from '@/components/desktop/repo-focus/useLeftPanelProjectFocus';
import {
  isLatestHistoryOpenRequest,
  resolveRailActiveSessionKey,
  supersedeHistoryOpenRequest,
} from '@/components/desktop/repo-focus/tabs/chats/helpers';
import type { CanvasTab } from '@/components/desktop/Canvas';
import { useVisualizationWorkspaceEvents } from '@/components/desktop/visualizations/useVisualizationWorkspaceEvents';
import type { SettingsTab } from '@/components/desktop/SettingsPage';
import { AlertProvider, useAlerts } from '@/lib/alerts/context';
import { AccountAuthorizationSync } from '@/lib/entitlement/AccountAuthorizationSync';
// ConnectionBanner retired — ConnectionPill in AgentPanel surfaces WS state.
import { ThemeProvider, useTheme } from '@/lib/theme/context';
import { AlertToast } from '@/components/shared/AlertToast';
import { ConfirmToastHost, toast } from '@/components/shared/ConfirmToastHost';
import type { ContextualPanelHandle } from '@/components/desktop/ContextualPanel';
import { LeftHeaderStrip } from '@/components/desktop/shell/LeftHeaderStrip';
import { WorkspaceHeaderStrip } from '@/components/desktop/shell/WorkspaceHeaderStrip';
import { requestTerminalModeToggle } from '@/components/desktop/shell/TerminalModePill';
import { PanelHeaderStrip } from '@/components/desktop/shell/PanelHeaderStrip';
import { useRightPanelMaximize } from '@/components/desktop/shell/useRightPanelMaximize';
import { RightPrTabs } from '@/components/desktop/pr-panel/RightPrTabs';
import { rightPrTabId, useRightPrTabs, type RightPrTab } from '@/components/desktop/pr-panel/useRightPrTabs';
import { DesktopCloseCoordinator } from '@/components/desktop/DesktopCloseCoordinator';
import { TerminalCloseDialog } from '@/components/desktop/workspace-terminal/TerminalCloseDialog';
import { readThreadPages } from '@/components/desktop/o8-panel/readThreadPages';
import { useThreadWorkspaceNavigation } from '@/components/desktop/o8-panel/useThreadNavigation';
import { threadPanelAvailability } from '@/components/desktop/o8-panel/thread-navigation';
import { resolveThreadProject } from '@/components/desktop/o8-panel/threads-model';
import { useProjects, type ProjectRecord } from '@/components/desktop/repo-registry/useProjects';
import { AddRepoFlowHost } from '@/components/desktop/repo-registry/AddRepoFlowHost';
import type { CommandPaletteActionItem } from '@/components/desktop/CommandPalette';
import { useCommandPaletteHotkey } from '@/components/desktop/use-command-palette-hotkey';
import { DictationHost } from '@/components/desktop/dictation/DictationHost';
import { BrowserPipCard, BROWSER_PIP_EVENT } from '@/components/desktop/BrowserPipCard';
import { O8SpecPipCard, O8_SPEC_PIP_EVENT } from '@/components/desktop/O8SpecPipCard';
import { ThreadDragGhost } from '@/components/desktop/ThreadDragGhost';
import { WorkspaceBootLoaderHost } from '@/components/desktop/workspace-terminal/workspace-boot-loader-claim';
import { SpawnErrorToast } from '@/components/desktop/SpawnErrorToast';
import { captureAnomaly } from '@/lib/telemetry/sentry-browser';
import { recordSpawnEvent } from '@/lib/feedback/workspace-introspect';
import { RealtimeVoiceHost } from '@/components/desktop/dictation/RealtimeVoiceHost';
import { SymonTextBridgeHost } from '@/components/desktop/dictation/SymonTextBridgeHost';
import { VisualInstructionHost } from '@/components/desktop/visual-instructions/VisualInstructionHost';
import { NarrationSpeakerHost } from '@/components/desktop/dictation/NarrationSpeakerHost';
import { FileOpenBridge } from '@/components/desktop/FileOpenBridge';
import { AttendanceHeartbeat } from '@/components/desktop/AttendanceHeartbeat';
import { TelemetryCrashCapture } from '@/components/desktop/TelemetryCrashCapture';
import { SentryBrowserInit } from '@/components/desktop/SentryBrowserInit';
import { UiZoomLayer } from '@/components/desktop/UiZoomLayer';
import { ReportIssueHost } from '@/components/desktop/ReportIssueHost';
import {
  FOCUS_REPO_WORKSPACE_TAB_EVENT,
  OPEN_MOBILE_PAIRING_EVENT,
  OPEN_SETTINGS_TAB_EVENT,
  OPEN_KEYBOARD_SHORTCUTS_EVENT,
  type OpenSettingsTabDetail,
} from '@/lib/desktop/events';
// ApprovalQueuePanel retired — was only consumed by the dead workspace-side-panel ReviewTab.
// AnalyticsPage lazy-loaded below
import type { WorkspaceSidePanelRepo } from './types';
import { canonicalPanelTab, normalizePanelTab as normalizeO8ActiveTab, type O8Tab } from '@/components/desktop/o8-panel/types';
import {
  logDashboardBootTiming,
  markDashboardScriptStart,
  markDashboardFirstRender,
  markDashboardInteractive,
} from '@/lib/perf/dashboard-marks';
import { startWebVitalsObserver } from '@/lib/perf/web-vitals';
import {
  subscribeO8PanelFocus,
} from '@/lib/events/o8-panel-focus';
import { fetchOnce, fetchSWRJson } from '@/lib/panel/fetch-cache';
import { safeCancelIdleCallback, safeRequestIdleCallback } from '@/lib/util/webview-safe';
import { prefetchConnectedAutomations } from '@/components/desktop/automations-page/connected-cache';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { WorktreeInfo } from '@/lib/worktree/types';
import type { MobileInboxSnapshot, MobileOrchestratorThread } from '@/lib/mobile/types';
import type { AgentSummary } from '@/lib/fleet/types';
import type {
  OrchestratorLaneBinding,
  OrchestratorLaneSnapshot,
  OrchestratorPacket,
  OrchestratorRuntime,
  OrchestratorRuntimeTruth,
  WorkspaceLaneState,
  WorkspaceOrchestrationPacketBadge,
} from '@/lib/orchestrator/types';
import {
  reconcileOrchestratorMissionState,
  updateOrchestratorMissionState,
  type DomainLaneSummary,
} from '@/lib/orchestrator/store';
import { agentDisplayLabel } from '@/lib/orchestrator/display';
import { deriveParkedLanes, type ParkedLane } from '@/components/desktop/merge-beacon/derive';
import type { WorkspaceLifecycleRecordView, WorkspaceLifecycleSummaryView } from '@/lib/workspace/lifecycle-types';
import type {
  CanvasTileState,
  PaletteAgentSummary,
  WorkspaceChatTargetOption,
} from './types';
import {
  FTUX_SPRING_TRANSITION,
  GuidedDiscoveryCoachmark,
  GuidedDiscoveryHalo,
  type GuidedDiscoveryAction,
} from './ftux';
import {
  PARKED_LANES_HEARTBEAT_MS,
  PARKED_LANES_RUN_ID,
  type ParkedLanesStatusPayload,
} from '@/lib/presentation/parked-lanes-snapshot';
import { watchQuietMode } from '@/lib/presentation/quiet-mode-client';
import {
  buildOrchestrationPacketBadge,
  buildOrchestrationPacketDraft,
  buildWorkspaceChatTargetOptions,
  clearRepoScopeFromTileLayout,
  collectRepoScopedTileIds,
  collectTerminalLeafIds,
  findCanvasLeafByRepoPath,
  findTerminalLeafByRepoPath,
  findUnscopedCanvasLeaf,
  findUnscopedTerminalLeaf,
  openedLaneSessionsCache,
  packetStatusFromLaneStatus,
  parseIssueNumber,
  pathBelongsToRepoScope,
  repoSlugFromAgent,
  repoSlugFromRemote,
  sessionBelongsToRepoScope,
  summarizeLifecycleRecords,
} from './utils';
import { useFtuxMilestones } from './hooks/useFtuxMilestones';
import { useGlobalRepoState } from './hooks/useGlobalRepoState';
import { useLaneArchivedView } from './hooks/useLaneArchivedSet';
import { useOrchestratorMission } from './hooks/useOrchestratorMission';
import { useSessionState } from './hooks/useSessionState';
import { useSettingsOverlayDismiss } from './hooks/useSettingsOverlayDismiss';
import { shouldPresentWorkerInSplit } from '@/lib/orchestrator/worker-launch-context';
import { useSetupWizard } from './hooks/useSetupWizard';
import { useRightPanelPersistence } from './hooks/useRightPanelPersistence';
import { useBrowserOpenRequests } from './hooks/useBrowserOpenRequests';
import {
  MAX_O8_PANEL_WIDTH,
  MAX_RIGHT_PANEL_WIDTH,
  MIN_O8_PANEL_WIDTH,
  MIN_RIGHT_PANEL_WIDTH,
  useRightPanelWidths,
} from '@/components/desktop/hooks/useRightPanelWidths';
import { useTileLayout } from './hooks/useTileLayout';
import { useUIChrome } from './hooks/useUIChrome';
import { useWorkspaceTerminal } from './hooks/useWorkspaceTerminal';
import { isOrchestratorRuntime, runtimeFromSessionKeyId } from '@/lib/orchestrator/runtime-capabilities';
import { resolveFocusableLaneBinding } from './hooks/focusOrchestrationPacketLane';
import { handleRepoWorkspaceFocusEvent } from './hooks/focusRepoWorkspace';
import { useDesignMode } from '@/hooks/useDesignMode';
import type { GrabbedElement } from '@/lib/browser/grab';
import { cropRegionBase64 } from '@/lib/browser/region-crop';
import { routeUiLoopEdit, showUiLoopProof } from '@/components/desktop/design-mode/ui-loop-edit';
import { createTileRegistry } from './tileRegistry';
import type { TerminalTabHandle } from '@/components/desktop/workspace-terminal/types';
import type { SavedChatRepoContext } from '@/lib/llm/chat-history';
import { retryingLazy } from '@/lib/react/retrying-lazy';
import { createDashboardChromeKeydownHandler } from './dashboard-chrome-shortcuts';
import { openMainTerminal } from '@/app/dashboard/open-main-terminal';

// Mark the dashboard module load as early as possible. Runs once when the
// bundle is first parsed, before the React component is even invoked, so
// the "script-start" anchor really does represent the moment the JS bundle
// is parsed. Subsequent calls are no-ops.
markDashboardScriptStart();

/* ── Lazy-loaded heavy components (code-split for faster initial paint) ──
   Anything below is *not* on the critical bootstrap path — the user has to
   open a panel, hit Cmd+K, or trigger design mode before its chunk needs to
   load. Keeping these out of the main dashboard chunk shaves real ms off
   first-render on cold launch. */
const LazySettingsPage = retryingLazy(() => import('@/components/desktop/SettingsPage').then(m => ({ default: m.SettingsPage })), { label: 'Settings' });
const LazyProjectsPage = retryingLazy(() => import('@/components/desktop/ProjectsPage').then(m => ({ default: m.ProjectsPage })), { label: 'Projects' });
// LazyAnalyticsPage full-page mount retired — Settings → Analytics tab is
// the live entry point. AnalyticsPage is still consumed via that tab.
const LazyOnboarding = retryingLazy(() => import('@/components/desktop/Onboarding').then(m => ({ default: m.Onboarding })), { label: 'Onboarding' });
const LazyTelemetryConsentCard = retryingLazy(() => import('@/components/desktop/TelemetryConsentCard').then(m => ({ default: m.TelemetryConsentCard })), { label: 'Telemetry consent' });
const LazyCommandPalette = retryingLazy(() => import('@/components/desktop/CommandPalette').then(m => ({ default: m.CommandPalette })), { label: 'Command palette' });
const LazyKeyboardShortcutsOverlay = retryingLazy(() => import('@/components/desktop/KeyboardShortcutsOverlay').then(m => ({ default: m.KeyboardShortcutsOverlay })), { label: 'Keyboard shortcuts' });
const LazyDesignModeOverlay = retryingLazy(() => import('@/components/desktop/DesignModeOverlay').then(m => ({ default: m.DesignModeOverlay })), { label: 'Design mode' });
const LazyO8ElementPanel = retryingLazy(() => import('@/components/desktop/O8ElementPanel').then(m => ({ default: m.O8ElementPanel })), { label: 'Element panel' });
const LazyO8Panel = retryingLazy(() => import('@/components/desktop/O8Panel').then(m => ({ default: m.O8Panel })), { label: 'o8 panel' });
const LazyThemeLab = retryingLazy(() => import('@/components/desktop/dev/ThemeLab').then(m => ({ default: m.ThemeLab })), { label: 'Theme lab' });
// #888/#895 — packet-mode right panel (Spec / Agent Overview / Changes).
import { OrchestratorDataProvider } from '@/components/desktop/orchestrator-data-context';
import { useMissionCompleteDetector } from '@/components/desktop/thoughts/mission-complete-detector';
const LazyReviewPanel = retryingLazy(() => import('@/components/desktop/review/ReviewPanel').then(m => ({ default: m.ReviewPanel })), { label: 'Review panel' });
import { TileContainer } from '@/components/desktop/TileContainer';
import { useWorkspacePageLayouts } from './hooks/useWorkspacePageLayouts';
import { waitForWorkspaceTerminalHandle } from './hooks/workspace-terminal-readiness';
import { createOnboardingCompletionHandler } from './hooks/onboarding-completion';
import { DashboardHydrationMarker } from './DashboardHydrationMarker';
import {
  selectRepoOrchestratorConversation,
  type AgentPanelChatInjectionPayload,
} from '@/lib/chat/injection';
import {
  type DetectedLocalhostPreview,
  formatPreviewSelectionContext,
  type PreviewSelectionPayload,
} from '@/lib/panel/preview';
import {
  closeTile,
  collectLeafNodes,
  createDefaultTileLayout,
  createTileContent,
  deserializeTileLayout,
  findLeafByContentKind,
  findSiblingLeaf,
  findTile,
  getFirstLeaf,
  replaceTileContent,
  resizeTile,
  serializeTileLayout,
  countLeaves,
  splitTile,
  wrapRootWithSplit,
} from '@/lib/tiles/operations';
import type { TileContentKind, TileLayout, TileLeafNode } from '@/lib/tiles/types';

const FOCUS_LEFT_PANEL_WIDTH = 320;
const CONTROL_ROOM_WIDTH = 760; // wide "control-room mode" — Control tab opens the left panel wide for the two-column layout
const RESPONSIVE_RIGHT_PANEL_COLLAPSE_WIDTH = 1180;
// Fold to the existing rail before a four-worker split loses readable width.
const RESPONSIVE_LEFT_PANEL_COLLAPSE_WIDTH = 1280;
const RESPONSIVE_COMPACT_SHELL_WIDTH = 420;
const O8_ACTIVE_TAB_STORAGE_KEY = 'o8ActiveTab';
// The right panel opens on Browser — a calm launcher ("get to anything") rather
// than the dense Activity feed, which read as overwhelming (operator 2026-07-14).
// Whatever the user switches to persists + restores; this is only the first-run
// default. LEGACY was 'activity' — the one-time migration below moves users off
// the auto-persisted old default without clobbering a genuine explicit choice.
const DEFAULT_O8_ACTIVE_TAB: O8Tab = 'browser';
const LEGACY_DEFAULT_O8_ACTIVE_TAB: O8Tab = 'activity';
const O8_ACTIVE_TAB_PREF_VERSION = '2';

/** Image extensions that open in the ImagePreview inspector ('image' tab kind)
 *  instead of the Monaco FileViewer — so a Finder-opened PNG renders instead of
 *  falling to the "Could not load file content" text fallback. Everything else
 *  (source, config, docs, svg) opens in the 'file' viewer, which itself routes
 *  .html/.htm to HtmlPreview. */
const WORKSPACE_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);

function historyRepoContextFromMobileThread(thread: MobileOrchestratorThread): SavedChatRepoContext | null {
  if (!thread.repoPath) return null;
  return {
    name: thread.repoName ?? undefined,
    localPath: thread.repoPath,
    branch: thread.repoBranch ?? null,
    remoteUrl: null,
  };
}

/** One line per element sampled under a Design Mode stroke — leads with the
 *  React component name (Cursor parity) when discovered, e.g.
 *  `- <AgentSwarm> section.swarm — "Agent Swarm"`; falls back to the raw tag. */
function formatDrawElement(e: { selector: string; tag: string; text: string; component?: string | null }): string {
  const head = e.component ? `<${e.component}>` : `<${e.tag}>`;
  const body = e.text ? ` — "${e.text}"` : '';
  return `- ${head} ${e.selector}${body}`;
}

export default function DashboardPage() {
  return (
    <ThemeProvider>
      <FeedbackSettingsEntry nativeMenu />
      <AlertProvider>
        <AccountAuthorizationSync>
          <ReactiveQueryProvider>
            <DesktopWebSocketProvider>
              <DashboardInner />
            </DesktopWebSocketProvider>
          </ReactiveQueryProvider>
        </AccountAuthorizationSync>
      </AlertProvider>
    </ThemeProvider>
  );
}

function DashboardInner() {
  // Perf mark — capture the moment the dashboard component begins its first
  // render. Pairs with markDashboardScriptStart() (called at module load)
  // and markDashboardInteractive() (scheduled below on the next idle tick)
  // to produce the [perf] bootstrap log.
  markDashboardFirstRender();


  // Glass vs solid axis for the left AgentPanel card. This is the SAME
  // resolved surface that ThemeProvider writes to <html data-surface>, so the
  // JS signal and the CSS chrome flip stay in lockstep (no desync). In glass
  // mode the card paints --t-bg and lets the chrome flip own transparency +
  // light ink (matches the right O8Panel); in solid mode it keeps the opaque
  // --t-panel-solid paper + floating shadow with the normal base-token ink.
  const { paletteId, surface: themeSurface, setPalette, setReduceTransparency, workspaceGlass, setWorkspaceGlass } = useTheme();
  const isGlassSurface = themeSurface === 'glass';
  // Mount gate for surface-dependent INLINE styles. SSR can't read the client's
  // localStorage surface preference, so it always renders the 'solid' default;
  // a client that has 'glass' stored would otherwise paint a different
  // background/boxShadow on the first render → hydration mismatch (the chrome
  // card below). Match SSR for the first client paint, then flip after mount —
  // one invisible frame on chrome.
  const [chromeMounted, setChromeMounted] = useState(false);
  useEffect(() => { setChromeMounted(true); }, []);
  const effectiveGlassSurface = chromeMounted && isGlassSurface;

  const [inTauri, setInTauri] = useState(false);
  useEffect(() => {
    logDashboardBootTiming();
    startWebVitalsObserver();
    setInTauri(isTauri());
    // Coarse DAU signal (analytics epic #1249). Fire-and-forget, opt-out-aware.
    track('app.opened');
    // tauri-plugin-mcp no longer needs JS-side init — the eval_and_await
    // protocol shipped in #932 phase 2 invokes JS from Rust per call.
    // Schedule the "interactive" mark after React has flushed the initial
    // render and the browser has finished its first layout/paint pass.
    const handle = safeRequestIdleCallback(() => markDashboardInteractive(), { timeout: 1500 });
    return () => safeCancelIdleCallback(handle);
  }, []);
  const initialTileLayout = useMemo(() => createDefaultTileLayout(), []);
  const [tileLayout, setTileLayout] = useState<TileLayout>(initialTileLayout);
  const [activeTileId, setActiveTileId] = useState<string | null>(getFirstLeaf(initialTileLayout.root).id);
  const designMode = useDesignMode();
  // The element grabbed by Design Mode (Cmd+Shift+D click) — shown in a
  // floating O8ElementPanel until dismissed or sent to the agent.
  const [grabbedElement, setGrabbedElement] = useState<GrabbedElement | null>(null);

  // ── Grouped state hooks ──
  const uiChrome = useUIChrome();
  const [projectLibraryRequest, setProjectLibraryRequest] = useState<{ projectId: string | null; revision: number }>({ projectId: null, revision: 0 });
  const {
    activeNavSection, setActiveNavSection,
    settingsInitialTab,
    sidebarVisible, setSidebarVisible,
    sidebarWidth: leftWidth, setSidebarWidth: setLeftWidth, sidebarManualIntentRef,
    desktopDraftInjection, setDesktopDraftInjection,
    thoughtsDraftInjection, setThoughtsDraftInjection,
    thoughtsImageInjection, setThoughtsImageInjection,
    mobileRemoteHref,
    handleOpenSettingsTab,
  } = uiChrome;

  // Native browser-view janitor (deep audit, operator 2026-07-06 — "a little
  // too persistent"). Two holes in the occlusion machinery:
  // 1. RELOAD ORPHAN — the browser view is a separate always-on-top OS window;
  //    a webview reload kills every JS owner, so nothing hides it and it
  //    floats over the boot splash forever. Hide once on dashboard mount; the
  //    Browser tab re-adopts it when its placeholder mounts.
  useEffect(() => {
    if (!isTauri()) return;
    void browserViewHide();
  }, []);
  // 2. FULL-SURFACE OVERLAYS — Settings/Automations cover the workspace, but
  //    the geometric occlusion sampler only samples the placeholder rect, so a
  //    drifted or larger native window can still paint over them. Force-occlude
  //    (existing event; the visible NativeBrowserSurface hides + snapshots)
  //    while any nav overlay is open.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const overlayOpen = activeNavSection === 'settings' || activeNavSection === 'automations';
    window.dispatchEvent(new CustomEvent('o8:native-browser-occlude', { detail: { occlude: overlayOpen } }));
  }, [activeNavSection]);

  const session = useSessionState();
  const {
    activeSessionKey, setActiveSessionKey,
    agentsJson, setAgentsJson,
    activeWorkspace, setActiveWorkspace,
    wsStatus,
    approvals,
    approvalCount,
    resolvedApprovalCount,
    parsedAgents,
    orchestratorRuntimeTruth,
  } = session;

  // True while the operator is actively dragging any panel-resize handle.
  // Panel widths are framer-animated for open/close/focus transitions, but a
  // live drag must apply instantly — routing per-mousemove targets through an
  // eased (or even 1ms) animation makes framer's rAF loop chase the cursor
  // and visibly oscillate between stale and current widths (Q's jitter
  // recording, 2026-07-10).
  const [panelDragActive, setPanelDragActive] = useState(false);

  // PANEL-DIVIDER DRAG → occlude the native browser. The native browser is a
  // separate OS window that composites ABOVE o8's web content, so the DOM
  // drag-shield below can't cover it; a divider drag whose cursor crosses the
  // native rect gets swallowed by that window and the drag sticks (report
  // 0.1.575). Hide the native window for the duration of the drag; the
  // geometric occlusion poll (~500ms) re-asserts any legitimately-open overlay
  // after release.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!panelDragActive) return;
    window.dispatchEvent(new CustomEvent('o8:native-browser-occlude', { detail: { occlude: true } }));
    return () => {
      window.dispatchEvent(new CustomEvent('o8:native-browser-occlude', { detail: { occlude: false } }));
    };
  }, [panelDragActive]);

  // Active-workspace map — each WorkspaceTerminalRoot broadcasts via
  // 'o8:workspace-active-label' with its stable workspaceId. We track
  // them all here so splits don't overwrite each other. The top header
  // label only renders when there's exactly one active workspace; with
  // multiple, each split's own lower TabBar carries its own title.
  type WorkspaceTabSummary = WorkspaceHeaderTab;
  type WorkspaceActivePayload = {
    workspaceId: string | null;
    tileId: string | null;
    label: string | null;
    tabId: string | null;
    kind: string | null;
    tabs: WorkspaceTabSummary[];
    finishedTabCount: number;
    contextRailAvailable: boolean;
    contextRailVisible: boolean;
    terminalModeActive: boolean;
    activeWorkspaceSurface: boolean;
  };
  const [workspaceActiveMap, setWorkspaceActiveMap] = useState<Map<string, WorkspaceActivePayload>>(() => new Map());
  const [pendingHistoryRailSessionKey, setPendingHistoryRailSessionKey] = useState<string | null>(null);
  const historyOpenRequestRef = useRef(0);
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{
        workspaceId?: string;
        tileId?: string | null;
        label?: string | null;
        tabId?: string | null;
        kind?: string | null;
        tabs?: WorkspaceTabSummary[];
        finishedTabCount?: number;
        contextRailAvailable?: boolean;
        contextRailVisible?: boolean;
        terminalModeActive?: boolean;
        activeWorkspaceSurface?: boolean;
        removed?: boolean;
      }>).detail;
      const id = detail?.workspaceId;
      if (!id) return;
      setWorkspaceActiveMap((current) => {
        if (detail?.removed) {
          if (!current.has(id)) return current;
          const next = new Map(current);
          next.delete(id);
          return next;
        }
        const payload: WorkspaceActivePayload = {
          workspaceId: id,
          tileId: detail?.tileId ?? null,
          label: detail?.label ?? null,
          tabId: detail?.tabId ?? null,
          kind: detail?.kind ?? null,
          tabs: Array.isArray(detail?.tabs) ? detail.tabs : [],
          finishedTabCount: typeof detail?.finishedTabCount === 'number' ? detail.finishedTabCount : 0,
          contextRailAvailable: Boolean(detail?.contextRailAvailable),
          contextRailVisible: detail?.contextRailVisible !== false,
          terminalModeActive: Boolean(detail?.terminalModeActive),
          activeWorkspaceSurface: Boolean(detail?.activeWorkspaceSurface),
        };
        const previous = current.get(id);
        const sameTabs = previous?.tabs.length === payload.tabs.length
          && previous.tabs.every((tab, index) => {
            const next = payload.tabs[index];
            return tab.id === next?.id && tab.label === next.label && tab.kind === next.kind
              && tab.runtime === next.runtime && tab.packetStatus === next.packetStatus
              && tab.orchestratorThreadId === next.orchestratorThreadId && tab.repoPath === next.repoPath
              && tab.labelSource === next.labelSource && tab.llmSummary === next.llmSummary
              && tab.orchestrationPacket?.title === next.orchestrationPacket?.title
              && tab.orchestrationPacket?.branchTarget === next.orchestrationPacket?.branchTarget;
          });
        if (previous && previous.tileId === payload.tileId && previous.label === payload.label && previous.tabId === payload.tabId
          && previous.kind === payload.kind && previous.finishedTabCount === payload.finishedTabCount
          && previous.contextRailAvailable === payload.contextRailAvailable
          && previous.contextRailVisible === payload.contextRailVisible
          && previous.terminalModeActive === payload.terminalModeActive
          && previous.activeWorkspaceSurface === payload.activeWorkspaceSurface && sameTabs) return current;
        const next = new Map(current);
        next.set(id, payload);
        return next;
      });
    };
    window.addEventListener('o8:workspace-active-label', handler as EventListener);
    return () => window.removeEventListener('o8:workspace-active-label', handler as EventListener);
  }, []);

  const workspaceLeaves = collectLeafNodes(tileLayout.root);
  const workspaceGridAvailable = workspaceLeaves.length > 1 && workspaceLeaves.every((leaf) => leaf.content.kind === 'terminal');
  const multiTerminalPaneLayout = workspaceGridAvailable;
  const workspacePaneLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const payload of workspaceActiveMap.values()) {
      if (!payload.tileId) continue;
      const activeTab = payload.tabs.find((tab) => tab.id === payload.tabId);
      labels.set(payload.tileId, activeTab?.label ?? payload.label ?? 'New session');
    }
    return labels;
  }, [workspaceActiveMap]);
  const primaryWorkspace = Array.from(workspaceActiveMap.values()).find((workspace) => workspace.tileId === 'tile-root') ?? null;
  const workspaceHeaderActive = useMemo<WorkspaceActivePayload>(() => {
    const workspaces = Array.from(workspaceActiveMap.values());
    return workspaces.find((workspace) => workspace.tileId === activeTileId)
      ?? workspaces.find((workspace) => workspace.activeWorkspaceSurface)
      ?? workspaces[0]
      ?? { workspaceId: null, tileId: null, label: null, tabId: null, kind: null, tabs: [], finishedTabCount: 0, contextRailAvailable: false, contextRailVisible: false, terminalModeActive: false, activeWorkspaceSurface: false };
  }, [activeTileId, workspaceActiveMap]);
  const workspaceAddTargetId = workspaceHeaderActive.workspaceId
    ?? Array.from(workspaceActiveMap.values()).find((workspace) => workspace.activeWorkspaceSurface)?.workspaceId
    ?? workspaceActiveMap.values().next().value?.workspaceId
    ?? null;
  const toggleActiveTerminalMode = useCallback(() => {
    const workspaces = Array.from(workspaceActiveMap.values());
    const target = workspaces.find((workspace) => workspace.activeWorkspaceSurface)
      ?? (workspaces.length === 1 ? workspaces[0] : null);
    if (target?.workspaceId) requestTerminalModeToggle(target.workspaceId);
  }, [workspaceActiveMap]);
  const activeWorkspaceTabIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const ids = new Set<string>();
    for (const payload of workspaceActiveMap.values()) {
      if (payload.tabId) ids.add(payload.tabId);
    }
    activeWorkspaceTabIdsRef.current = ids;
  }, [workspaceActiveMap]);

  // Workspace tab id → chat-history thread id map. OrchestratorTab
  // broadcasts 'o8:workspace-thread-id' whenever its loaded thread
  // changes; we use the map to PATCH the canonical chat-history file
  // (issue #1100). Workspace tab id ≠ chat-history thread id — without
  // this lookup the PATCH writes to the wrong file.
  const threadIdByTabRef = useRef<Map<string, string | null>>(new Map());
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string; threadId?: string | null }>).detail;
      if (!detail?.tabId) return;
      threadIdByTabRef.current.set(detail.tabId, detail.threadId ?? null);
      // Sidebar shimmer should follow the active workspace tab. Clicking
      // a workspace tab pill activates that tab → its OrchestratorTab
      // fires this event when its loaded thread settles → we sync
      // activeSessionKey so the matching sidebar row shimmers + sits
      // highlighted. Without this the shimmer is pinned to the last
      // SIDEBAR click and diverges from the actually-displayed thread.
      // (The auto-fallback effect upstream guards `llm-chat:` keys so
      // this update isn't overwritten on the next render.)
      const activeWorkspaceTabIds = activeWorkspaceTabIdsRef.current;
      if (detail.threadId && (activeWorkspaceTabIds.size === 0 || (detail.tabId ? activeWorkspaceTabIds.has(detail.tabId) : false))) {
        setActiveSessionKey(`llm-chat:${detail.threadId}`);
      }
    };
    window.addEventListener(WORKSPACE_THREAD_ID_EVENT, handler as EventListener);
    return () => window.removeEventListener(WORKSPACE_THREAD_ID_EVENT, handler as EventListener);
  }, [setActiveSessionKey]);

  // Bottom DesktopStatusBar pill — branch + lane state.
  //
  // The pill defaults to the project's HEAD branch (globalRepo readiness),
  // but each OrchestratorTab's empty-state lets the operator pick a
  // worktree mode + branch. When an orchestrator tab is active and has
  // surfaced a selection, mirror that branch in the pill so MergeAction
  // Cluster's PR lookup + ready/push/merge state badge follows the
  // operator's worktree pick instead of the repo HEAD.
  //
  // Set on `o8:orchestrator-worktree-selection`, cleared on
  // `o8:orchestrator-worktree-selection-clear` (the broadcasting tab
  // dispatches the clear when it loses focus). When no orchestrator tab
  // is active, this is null and the pill falls back to project state.
  const [orchestratorWorktreeSelection, setOrchestratorWorktreeSelection] = useState<{
    tabId: string;
    repoPath: string | null;
    branch: string;
    worktreeMode: 'local' | 'new-worktree';
  } | null>(null);
  useEffect(() => {
    const handleSelection = (event: Event) => {
      const detail = (event as CustomEvent<{
        tabId?: string;
        repoPath?: string | null;
        branch?: string;
        worktreeMode?: 'local' | 'new-worktree';
      }>).detail;
      if (!detail?.tabId || !detail.branch || !detail.worktreeMode) return;
      setOrchestratorWorktreeSelection({
        tabId: detail.tabId,
        repoPath: detail.repoPath ?? null,
        branch: detail.branch,
        worktreeMode: detail.worktreeMode,
      });
    };
    const handleClear = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail;
      if (!detail?.tabId) return;
      setOrchestratorWorktreeSelection((current) => (
        current && current.tabId === detail.tabId ? null : current
      ));
    };
    window.addEventListener('o8:orchestrator-worktree-selection', handleSelection as EventListener);
    window.addEventListener('o8:orchestrator-worktree-selection-clear', handleClear as EventListener);
    return () => {
      window.removeEventListener('o8:orchestrator-worktree-selection', handleSelection as EventListener);
      window.removeEventListener('o8:orchestrator-worktree-selection-clear', handleClear as EventListener);
    };
  }, []);

  // Single-workspace spawn shortcut. Dispatches a window event the
  // (only) WorkspaceTerminalRoot listens for to call its spawn handlers.
  // Only meaningful when there's a single workspace; with splits each
  // pane's own lower TabBar carries the play button.
  const isSingleWorkspace = workspaceActiveMap.size === 1;
  const dispatchSpawn = useCallback((kind: 'orchestrator' | 'chat' | 'terminal') => {
    window.dispatchEvent(new CustomEvent('o8:request-spawn-tab', { detail: { kind } }));
  }, []);
  const handleSpawnOrchestrator = useCallback(() => dispatchSpawn('orchestrator'), [dispatchSpawn]);
  const handleSpawnChat = useCallback(() => dispatchSpawn('chat'), [dispatchSpawn]);
  const handleSpawnTerminal = useCallback(() => dispatchSpawn('terminal'), [dispatchSpawn]);


  const contextualPanelHandlesRef = useRef<Map<string, ContextualPanelHandle>>(new Map());
  const settingsPanelRef = useRef<HTMLDivElement>(null);
  const workspaceSurfaceRef = useRef<HTMLDivElement>(null);
  const settingsWasOpenRef = useRef(false);
  const [workspaceLifecycleRecords, setWorkspaceLifecycleRecords] = useState<WorkspaceLifecycleRecordView[]>([]);
  const [workspaceLifecycleSummary, setWorkspaceLifecycleSummary] = useState<WorkspaceLifecycleSummaryView>({
    unreadCount: 0,
    archivedCount: 0,
    nextAttentionWorkspaceId: null,
  });
  const {
    handleThoughtsMissionStateChange,
    scheduleThoughtsMissionPersist,
    setThoughtsMissionState,
    thoughtsMissionState,
  } = useOrchestratorMission();
  // Always-mounted Mission-complete detector — records the card from durable
  // lane-lifecycle signals regardless of which tab is focused, so a dispatched
  // mission's completion card survives the orchestrator tab's active/mode
  // flapping. The orchestrator feed drains the recorded card on view.
  useMissionCompleteDetector(thoughtsMissionState);
  // ── Right panel + workspace side panel state (tightly coupled to callbacks, kept inline) ──
  // SSR-safe defaults; hydrate from localStorage in an effect so the
  // visibility/kind survives a reload but server and first client render
  // match (no hydration mismatch).
  const [responsiveAutoCollapsed, setResponsiveAutoCollapsed] = useState({ left: false });
  const [chatVisible, setChatVisible] = useState(false);
  const [rightPanelKind, setRightPanelKind] = useState<'review' | 'o8'>('o8');
  useRightPanelPersistence({
    chatVisible,
    rightPanelKind,
    setChatVisible,
    setRightPanelKind,
  });
  // Keep each expensive panel instance alive after its first visit. Presentation
  // can collapse or crossfade, but reopening must not repay its chunk, queries,
  // observers, or local tab state.
  const [mountedRightPanels, setMountedRightPanels] = useState({ o8: false, review: false });
  useEffect(() => {
    if (!chatVisible) return;
    setMountedRightPanels((current) => current[rightPanelKind]
      ? current
      : { ...current, [rightPanelKind]: true });
  }, [chatVisible, rightPanelKind]);
  // Resize perf: never store the raw window width in state — a live drag-resize
  // fires per-frame and a changing number re-renders this entire page tree every
  // frame (the top-chrome "lags then snaps" jank, 2026-07-15). Only the derived
  // threshold BANDS live in state; the functional setState returns the previous
  // object between crossings so React bails out of the render entirely. The raw
  // number lives in viewportWidthRef for imperative reads.
  const [viewportBands, setViewportBands] = useState<{ compact: boolean; belowLeftCollapse: boolean; belowRightCollapse: boolean } | null>(null);
  const viewportWidthRef = useRef<number | null>(null);
  const responsiveManualOpenRef = useRef({ left: false });
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const update = () => {
      const next = window.innerWidth;
      viewportWidthRef.current = next;
      const compact = next < RESPONSIVE_COMPACT_SHELL_WIDTH;
      const belowLeftCollapse = next < RESPONSIVE_LEFT_PANEL_COLLAPSE_WIDTH;
      const belowRightCollapse = next < RESPONSIVE_RIGHT_PANEL_COLLAPSE_WIDTH;
      setViewportBands((current) => (
        current !== null
          && current.compact === compact
          && current.belowLeftCollapse === belowLeftCollapse
          && current.belowRightCollapse === belowRightCollapse
          ? current
          : { compact, belowLeftCollapse, belowRightCollapse }
      ));
    };
    update();
    // rAF-throttle: coalesce a burst of resize events into one state update per
    // frame. The frame reads the latest window.innerWidth, so the settled width
    // is identical to updating on every event.
    let frame = 0;
    const onResize = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  // ── Body-scroll guard ──
  // The dashboard is a fixed-viewport shell — the BODY must never scroll. But
  // globals.css only hides overflow-X, and during boot the launch clamps
  // resize the window mid-hydration, so a transcript scrollIntoView can scroll
  // the momentarily-overflowing BODY instead of the chat container. That
  // offset then STICKS: the whole app sat 491px above the window top with the
  // wallpaper showing through the transparent bottom half (live-hit on the
  // 0.1.605 + 0.1.607 update relaunches, 2026-07-15 — looked like the webview
  // under-filling the window). Capture-phase listener: scroll events don't
  // bubble, so document-level capture is the only single hook that sees the
  // body's own scrolls. Reset is two property reads unless drift happened.
  const bodyScrollAnomalyReportedRef = useRef(false);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const resetBodyScroll = () => {
      const drift = Math.max(document.body.scrollTop, document.documentElement.scrollTop);
      if (drift === 0) return;
      // The guard curing it silently would hide how often this fires in the
      // field — phone home ONCE per session (Sentry anomaly + ring buffer, so
      // it also rides any later bug report from this machine).
      if (!bodyScrollAnomalyReportedRef.current) {
        bodyScrollAnomalyReportedRef.current = true;
        console.error(`[shell-guard] body scroll corrected: ${drift}px (the app shell must never body-scroll)`);
        captureAnomaly('shell-guard: body scroll corrected', { driftPx: drift });
      }
      if (document.body.scrollTop !== 0) document.body.scrollTop = 0;
      if (document.documentElement.scrollTop !== 0) document.documentElement.scrollTop = 0;
    };
    resetBodyScroll();
    document.addEventListener('scroll', resetBodyScroll, true);
    return () => document.removeEventListener('scroll', resetBodyScroll, true);
  }, []);
  const compactShell = viewportBands?.compact ?? false;
  const joinedWorkspaceFrame = !compactShell && !effectiveGlassSurface;
  const rightColumnChrome = joinedWorkspaceFrame ? 1 : RIGHT_COLUMN_CHROME;
  const getResponsiveViewportWidth = useCallback(() => (
    viewportWidthRef.current ?? (typeof window !== 'undefined' ? window.innerWidth : Number.POSITIVE_INFINITY)
  ), []);
  const noteSidebarManualIntent = useCallback((nextVisible: boolean) => {
    sidebarManualIntentRef.current = true;
    responsiveManualOpenRef.current.left = nextVisible
      && getResponsiveViewportWidth() < RESPONSIVE_LEFT_PANEL_COLLAPSE_WIDTH;
    setResponsiveAutoCollapsed((current) => (
      current.left ? { ...current, left: false } : current
    ));
  }, [getResponsiveViewportWidth, sidebarManualIntentRef]);
  const toggleSidebarFromChrome = useCallback(() => {
    const nextVisible = !sidebarVisible || responsiveAutoCollapsed.left;
    noteSidebarManualIntent(nextVisible);
    setSidebarVisible(nextVisible);
  }, [noteSidebarManualIntent, responsiveAutoCollapsed.left, setSidebarVisible, sidebarVisible]);
  const openRightPanelFromUser = useCallback(() => {
    if (getResponsiveViewportWidth() < RESPONSIVE_RIGHT_PANEL_COLLAPSE_WIDTH) return;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(BROWSER_PIP_EVENT, { detail: { open: false } }));
      window.dispatchEvent(new CustomEvent(O8_SPEC_PIP_EVENT, { detail: { open: false } }));
    }
    setChatVisible(true);
  }, [getResponsiveViewportWidth]);
  const closeRightPanelFromUser = useCallback(() => {
    setChatVisible(false);
  }, []);
  // Responsive presentation never overwrites the operator's saved list preference.
  useEffect(() => {
    if (viewportBands === null) return;
    if (viewportBands.belowRightCollapse && chatVisible) setChatVisible(false);
    if (!viewportBands.belowLeftCollapse) responsiveManualOpenRef.current.left = false;
    const autoCollapsed = viewportBands.belowLeftCollapse && !responsiveManualOpenRef.current.left;
    setResponsiveAutoCollapsed((current) => current.left === autoCollapsed ? current : { left: autoCollapsed });
  }, [chatVisible, viewportBands]);
  const [o8ActiveTab, setO8ActiveTab] = useState<O8Tab>(DEFAULT_O8_ACTIVE_TAB);
  const [o8ActiveTabHydrated, setO8ActiveTabHydrated] = useState(false);
  const { tabs: rightPrTabs, open: rememberRightPr, close: forgetRightPr } = useRightPrTabs();
  const [o8SplitEnabled, setO8SplitEnabled] = useState(false);
  const [o8SecondaryTab, setO8SecondaryTab] = useState<O8Tab>('spec');
  const [o8SplitPrefsHydrated, setO8SplitPrefsHydrated] = useState(false);
  useEffect(() => {
    try {
      setO8SplitEnabled(window.localStorage.getItem('o8:right-panel:split') === 'true');
      const savedTab = normalizeO8ActiveTab(window.localStorage.getItem('o8:right-panel:secondary-tab'));
      if (savedTab) setO8SecondaryTab(savedTab);
    } catch { /* ignore */ }
    setO8SplitPrefsHydrated(true);
  }, []);
  useEffect(() => {
    if (!o8SplitPrefsHydrated) return;
    try {
      window.localStorage.setItem('o8:right-panel:split', String(o8SplitEnabled));
      window.localStorage.setItem('o8:right-panel:secondary-tab', o8SecondaryTab);
    } catch { /* ignore */ }
  }, [o8SplitEnabled, o8SecondaryTab, o8SplitPrefsHydrated]);
  const visibleSecondaryTab = o8SplitEnabled
    ? (canonicalPanelTab(o8SecondaryTab) === canonicalPanelTab(o8ActiveTab) ? (o8ActiveTab === 'browser' ? 'spec' : 'browser') : o8SecondaryTab)
    : null;
  const { rightWidth, setRightWidth, o8Width, setO8Width } = useRightPanelWidths(o8ActiveTab, visibleSecondaryTab);
  const { maximized: rightPanelMaximized, toggleMaximized: toggleRightPanelMaximized } = useRightPanelMaximize(chatVisible && !compactShell && !viewportBands?.belowRightCollapse);
  const [o8ReviewLaneId, setO8ReviewLaneId] = useState<string | null>(null);
  const handleO8TabChange = useCallback((tab: O8Tab) => {
    if (tab !== 'review') setO8ReviewLaneId(null);
    setO8ActiveTab(tab);
  }, []);
  const handlePrimaryPanelTabChange = useCallback((tab: O8Tab) => {
    if (o8SplitEnabled && tab === visibleSecondaryTab) setO8SecondaryTab(o8ActiveTab);
    handleO8TabChange(tab);
  }, [handleO8TabChange, o8ActiveTab, o8SplitEnabled, visibleSecondaryTab]);
  const handleSecondaryPanelTabChange = useCallback((tab: O8Tab) => {
    if (tab === o8ActiveTab) {
      setO8SecondaryTab(o8ActiveTab);
      handleO8TabChange(visibleSecondaryTab ?? (o8ActiveTab === 'browser' ? 'spec' : 'browser'));
      return;
    }
    setO8SecondaryTab(tab);
  }, [handleO8TabChange, o8ActiveTab, visibleSecondaryTab]);
  const toggleO8PanelSplit = useCallback(() => {
    if (!o8SplitEnabled && o8SecondaryTab === o8ActiveTab) {
      setO8SecondaryTab(o8ActiveTab === 'browser' ? 'spec' : 'browser');
    }
    setO8SplitEnabled((enabled) => !enabled);
  }, [o8ActiveTab, o8SecondaryTab, o8SplitEnabled]);
  const [o8PrNumber, setO8PrNumber] = useState<number | null>(null);
  const [o8PrRepo, setO8PrRepo] = useState<string | null>(null);
  const [o8BrowserUrl, setO8BrowserUrl] = useState<string | null>(null);
  // Mirrors the wide O8 panel BrowserPane's active URL so the TitleBar can
  // hover-preview it. Distinct from o8BrowserUrl (which is a one-shot
  // navigation request from the port popover etc.) — this is the live
  // current URL of whichever tab is selected inside the pane.
  const [o8BrowserHoverUrl, setO8BrowserHoverUrl] = useState<string | null>(null);
  // Shared top-header target for right-panel utility tabs and browser pages.
  const [panelHeaderTabSlot, setPanelHeaderTabSlot] = useState<HTMLElement | null>(null);
  const [o8SelectedFile, setO8SelectedFile] = useState<string | null>(null);
  const [o8SelectedFileRepoPath, setO8SelectedFileRepoPath] = useState<string | null>(null);
  const [o8RepoPathOverride, setO8RepoPathOverride] = useState<string | null>(null);
  // Right-panel repo scope: true = "All repos" aggregate across the active
  // project, false = focused on currentO8RepoPath. Shared by the Workspace +
  // Activity selectors and driven by the left switcher (project pick → all,
  // repo pick → that repo).
  const [o8AllRepos, setO8AllRepos] = useState(false);
  const [o8CommitSha, setO8CommitSha] = useState<string | null>(null);
  const [o8CommitRepoPath, setO8CommitRepoPath] = useState<string | null>(null);
  const [o8CommitRepoSlug, setO8CommitRepoSlug] = useState<string | null>(null);
  const rightPanelMode = 'workspace' as const;
  const setRightPanelMode = (_mode: 'chat' | 'workspace') => { /* v1: right panel is always workspace */ };
  const [workspaceChatTargetKeyByRepoPath, setWorkspaceChatTargetKeyByRepoPath] = useState<Record<string, string>>({});

  // (Removed per operator request, 2026-06-18) The o8.md / spec tab used to
  // auto-collapse the left panel for reading room. The left panel now stays put
  // when any o8-panel tab (including o8.md) opens — it's resizable and
  // hover-revealable, so the operator collapses it manually when they want the
  // extra space. Both panels can be open at once.

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(O8_ACTIVE_TAB_STORAGE_KEY);
      // One-time migration to the Browser default: existing users carry an
      // auto-persisted value from the old 'activity' default that nobody
      // explicitly chose. Bump the pref version once — if the saved tab is the
      // legacy default (or absent), adopt the new default; a genuine non-default
      // choice (e.g. workspace) is preserved. After this, normal persistence.
      const versionKey = `${O8_ACTIVE_TAB_STORAGE_KEY}:v`;
      if (window.localStorage.getItem(versionKey) !== O8_ACTIVE_TAB_PREF_VERSION) {
        window.localStorage.setItem(versionKey, O8_ACTIVE_TAB_PREF_VERSION);
        if (!raw || normalizeO8ActiveTab(raw) === LEGACY_DEFAULT_O8_ACTIVE_TAB) {
          window.localStorage.removeItem(O8_ACTIVE_TAB_STORAGE_KEY);
          return; // keep state at the new DEFAULT_O8_ACTIVE_TAB (browser)
        }
      }
      const migrated = normalizeO8ActiveTab(raw);
      if (migrated) setO8ActiveTab(migrated);
      if (raw && migrated && raw !== migrated) {
        window.localStorage.setItem(O8_ACTIVE_TAB_STORAGE_KEY, migrated);
      }
    } catch { /* ignore */ }
    finally { setO8ActiveTabHydrated(true); }
  }, []);
  useEffect(() => {
    if (!o8ActiveTabHydrated) return;
    try { window.localStorage.setItem(O8_ACTIVE_TAB_STORAGE_KEY, o8ActiveTab); } catch { /* ignore */ }
  }, [o8ActiveTab, o8ActiveTabHydrated]);

  const [latestDispatchedTabId, setLatestDispatchedTabId] = useState<string | null>(null);
  const [latestDispatchedAt, setLatestDispatchedAt] = useState<number | null>(null);
  // Persist the latest-dispatch marker so a reload during an active
  // dispatch (common during dev-bridge hot-reloads) keeps the orange
  // highlight on the right tab. Treat anything older than 60min as stale
  // so old dispatches don't keep highlighting after the work is done.
  const LATEST_DISPATCH_TTL_MS = 60 * 60 * 1000;
  useEffect(() => {
    try {
      const tabRaw = window.localStorage.getItem('o8:latest-dispatch:tab-id');
      const atRaw = window.localStorage.getItem('o8:latest-dispatch:at');
      const at = atRaw ? parseInt(atRaw, 10) : NaN;
      if (tabRaw && Number.isFinite(at) && Date.now() - at < LATEST_DISPATCH_TTL_MS) {
        setLatestDispatchedTabId(tabRaw);
        setLatestDispatchedAt(at);
      }
    } catch { /* ignore */ }
  }, [LATEST_DISPATCH_TTL_MS]);
  // Latest-dispatch marker derives from mission state: whenever a packet
  // is launching/running/awaiting_review and lane.sessionKey is bound,
  // promote it to the orange marker. Re-runs on every mission update so
  // newer dispatches take over from older ones. CLI-runtime tabs use
  // sessionKey as the tab id (see openCliChatSession), so this same key
  // doubles as the highlight target.
  //
  // Previously this was a back-fill that only fired when the marker was
  // null, which meant if the in-process setLatestDispatchedTabId call
  // missed the race in handleSupervisorUpdate (the most common path for
  // MCP-dispatched packets, since lane.sessionKey lands milliseconds after
  // the supervisor "launched" event), the marker stayed null forever
  // until a manual reload + back-fill from localStorage picked it up.
  useEffect(() => {
    const packets = thoughtsMissionState.packets;
    if (!packets.length) return;
    const candidates = packets
      .filter((p) => p.lane?.sessionKey && (p.status === 'launching' || p.status === 'running' || p.status === 'awaiting_review'))
      .map((p) => ({ sessionKey: p.lane!.sessionKey!, at: p.lane?.lastEventAt ? new Date(p.lane.lastEventAt).getTime() : Date.now() }))
      .filter((c) => Number.isFinite(c.at) && c.at > 0 && Date.now() - c.at < LATEST_DISPATCH_TTL_MS);
    if (candidates.length === 0) return;
    candidates.sort((a, b) => b.at - a.at);
    const winner = candidates[0];
    if (winner.sessionKey === latestDispatchedTabId) return;
    setLatestDispatchedTabId(winner.sessionKey);
    setLatestDispatchedAt(winner.at);
  }, [LATEST_DISPATCH_TTL_MS, latestDispatchedTabId, thoughtsMissionState.packets]);
  useEffect(() => {
    try {
      if (latestDispatchedTabId) window.localStorage.setItem('o8:latest-dispatch:tab-id', latestDispatchedTabId);
      else window.localStorage.removeItem('o8:latest-dispatch:tab-id');
      if (latestDispatchedAt) window.localStorage.setItem('o8:latest-dispatch:at', String(latestDispatchedAt));
      else window.localStorage.removeItem('o8:latest-dispatch:at');
    } catch { /* ignore */ }
  }, [latestDispatchedTabId, latestDispatchedAt]);
  // Stable ref so the auto-spawn callback can look up the matching packet
  // by sessionKey without re-binding on every mission-state delta.
  const thoughtsMissionStateRef = useRef(thoughtsMissionState);
  useEffect(() => { thoughtsMissionStateRef.current = thoughtsMissionState; }, [thoughtsMissionState]);
  // #888/#895 — packet selection lifted from ThoughtsMissionPanel so the
  // right-side workspace panel can flip into packet mode (Spec / Agent
  // Overview) when one is expanded. See `src/lib/panel/mode.ts`.
  const [selectedPacketId, setSelectedPacketId] = useState<string | null>(null);
  const lastMarkedWorkspaceReadRef = useRef<string>('');

  // ── Cmd+K command palette (#661) — full-screen overlay search across
  // issues, files, agents, with localStorage LRU recents. The keydown
  // listener below yields only to terminal surfaces; composer focus still
  // opens the palette.
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  useCommandPaletteHotkey(setCommandPaletteOpen);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const dashboardProjects = useProjects();

  const {
    activeFtuxMilestone,
    dismissFtuxMilestone,
    enqueueFtuxMilestone,
    ftuxDormant,
    ftuxFirstChangedFile,
    ftuxMilestones,
    setFtuxFirstChangedFile,
  } = useFtuxMilestones({
    sidebarVisible,
    setLeftWidth,
    setSidebarVisible,
    sidebarManualIntentRef,
  });

  // ── Prefetch heavy lazy chunks on idle so Suspense fallbacks are never visible ──
  // Workspace + side-panel chunks are deferred off the critical path so the
  // initial render is small. We then warm them on the first idle frame so
  // when the user actually clicks (or the right rail mounts), the chunk is
  // already parsed.
  useEffect(() => {
    const prefetch = () => {
      import('@/components/desktop/WorkspaceTerminal');
      import('@/components/desktop/Canvas');
      import('@/components/desktop/workspace-terminal/OrchestratorTab');
      import('@/components/desktop/O8Panel');
      import('@/components/desktop/AutomationsPage');
      prefetchConnectedAutomations();
    };
    const id = safeRequestIdleCallback(prefetch, { fallbackDelayMs: 100 });
    return () => safeCancelIdleCallback(id);
  }, []);

  const { handleSetupComplete, setSetupWizardOpen, setupCheckComplete, setupCompleteError, setupWizardOpen } = useSetupWizard();

  const refreshWorkspaceLifecycle = useCallback(async () => {
    try {
      const response = await fetchOnce('/api/panel/workspaces', {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      });
      if (!response.ok) return;
      const payload = await response.json() as {
        lifecycle?: {
          records?: WorkspaceLifecycleRecordView[];
          summary?: WorkspaceLifecycleSummaryView;
        };
      };
      setWorkspaceLifecycleRecords(payload.lifecycle?.records ?? []);
      setWorkspaceLifecycleSummary(payload.lifecycle?.summary ?? {
        unreadCount: 0,
        archivedCount: 0,
        nextAttentionWorkspaceId: null,
      });
    } catch {
      // Keep the last truthful lifecycle snapshot if refresh fails.
    }
  }, []);

  const mutateWorkspaceLifecycle = useCallback(async (
    action: 'archive' | 'restore' | 'mark_read',
    workspaceId: string,
  ) => {
    const response = await fetch('/api/panel/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, workspaceId }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(payload?.error || 'Unable to update workspace lifecycle.');
    }
    await refreshWorkspaceLifecycle();
  }, [refreshWorkspaceLifecycle]);

  const {
    allRepoWorktrees,
    bumpRepoInventoryGeneration,
    globalRepo,
    globalRepoBranch,
    globalRepoEntries,
    globalRepoEntry,
    globalRepoId,
    handleFocusCurrentRepoSetup,
    handleOpenFolder,
    handleOpenRepoInDesktop,
    handleSelectRegisteredRepo,
    loadRegisteredRepos,
    loadRepoWorktrees,
    openRepoWorkspaceModal,
    orchestratorWorkspaceTargets,
    refreshRestoredRepoState,
    repoInventoryRevision,
    focusRepoSetup,
    selectedRepoWorktrees,
    selectedRepoWorktreesLoading,
    setAllRepoWorktrees,
    setGlobalRepoBranch,
    setGlobalRepoEntries,
    setGlobalRepoId,
    setSelectedRepoWorktreeRefreshNonce,
    setSelectedRepoWorktrees,
    staleSelectedRepoWorktrees,
    workspaceScopeEntries,
    workspaceTerminalPreferredRepo,
  } = useGlobalRepoState({
    activeWorkspace,
    setActiveNavSection,
    setSidebarVisible,
    sidebarVisible,
  });
  const currentO8RepoPath = o8CommitRepoPath ?? o8RepoPathOverride ?? globalRepoEntry?.localPath ?? null;
  // Mirror for the project-switch guard effect — lets it read the focused repo
  // without re-subscribing (and without clobbering an explicit repo pick).
  const currentO8RepoPathRef = useRef<string | null>(null);
  currentO8RepoPathRef.current = currentO8RepoPath;
  const scopedO8SelectedFile = o8SelectedFileRepoPath === currentO8RepoPath ? o8SelectedFile : null;

  // Scope the right-panel surfaces (Activity / PRs / GitHub) to the ACTIVE
  // project's repos rather than the global pool, so repos that aren't in the
  // project (old ones, ones moved out) don't keep showing in the control room.
  // Falls back to the global list if scoping would empty it.
  const activeProjectRepoEntries = useMemo(() => {
    const ledger = dashboardProjects.ledger;
    if (!ledger?.projects?.length) return globalRepoEntries;
    const active = ledger.projects.find((p) => p.id === ledger.activeProjectId) ?? ledger.projects[0];
    const paths = new Set((active?.repoPaths ?? []).map((p) => p.replace(/\/+$/, '')));
    if (paths.size === 0) return globalRepoEntries;
    const scoped = globalRepoEntries.filter((repo) => paths.has(repo.localPath.replace(/\/+$/, '')));
    return scoped.length > 0 ? scoped : globalRepoEntries;
  }, [dashboardProjects.ledger, globalRepoEntries]);

  // When the active PROJECT changes, keep the right panel coherent. Repo
  // membership is exclusive to one project, so after a project switch the
  // previously-focused repo no longer belongs here. A pure project pick →
  // default to the project's primary repo (so a freshly spawned orchestrator +
  // commit surfaces have a valid target) AND show the "All repos" aggregate.
  // If a specific repo was just picked on the left (focused repo IS in the new
  // project, set synchronously before this fires) → keep it, no All-repos.
  const lastActiveProjectRef = useRef<string | null>(null);
  useEffect(() => {
    const ledger = dashboardProjects.ledger;
    const activeId = ledger?.activeProjectId ?? null;
    if (!activeId || activeId === lastActiveProjectRef.current) return;
    const isFirst = lastActiveProjectRef.current === null;
    lastActiveProjectRef.current = activeId;
    if (isFirst) return; // don't override the repo chosen on initial load
    const project = ledger?.projects.find((p) => p.id === activeId);
    const projectPaths = new Set((project?.repoPaths ?? []).map((p) => p.replace(/\/+$/, '')));
    const focused = currentO8RepoPathRef.current?.replace(/\/+$/, '') ?? null;
    if (focused && projectPaths.has(focused)) return; // explicit repo pick → keep it
    const primaryPath = project?.repoPaths?.[0];
    if (primaryPath) {
      const entry = globalRepoEntries.find((repo) => repo.localPath === primaryPath);
      if (entry) {
        setGlobalRepoId(entry.id);
        setO8RepoPathOverride(primaryPath);
        setO8CommitRepoPath(null);
      }
    }
    setO8AllRepos(true);
  }, [dashboardProjects.ledger, globalRepoEntries, setGlobalRepoId]);

  const handleO8SelectedFileChange = useCallback((filePath: string) => {
    setO8SelectedFile(filePath);
    setO8SelectedFileRepoPath(currentO8RepoPath);
  }, [currentO8RepoPath]);

  // Repo focus state owns whether the left column is in expanded "repo focus"
  // mode. Lifted here (instead of inside AgentPanel) so the column animation
  // can react to the same focusActive boolean and widen from the default
  // sidebar width to FOCUS_LEFT_PANEL_WIDTH without an overlay.
  const leftPanelFocus = useLeftPanelProjectFocus({
    registeredRepos: globalRepoEntries,
    ledger: dashboardProjects.ledger,
  });

  // "Control-room mode" — LeftPanelProjectFocus dispatches o8:control-room-wide
  // when the Control tab is active, so the left column widens to fit the
  // two-column control room and collapses back on Chats / close.
  const [controlRoomWide, setControlRoomWide] = useState(false);
  useEffect(() => {
    const handler = (event: Event) => {
      setControlRoomWide(Boolean((event as CustomEvent<{ wide?: boolean }>).detail?.wide));
    };
    window.addEventListener('o8:control-room-wide', handler);
    return () => window.removeEventListener('o8:control-room-wide', handler);
  }, []);

  const {
    activeWorkspaceChatSessionKey,
    activeWorkspaceLane,
    areWorkspaceTerminalRestoresSettled,
    collectOrchestratorLaneSnapshots,
    ensureWorkspaceTerminalTile,
    findInsertionTarget,
    findWorkspaceTarget,
    focusOrchestrationPacketLane,
    ideWorkspaceSessionsForSidebar,
    lifecycleEvents,
    registerWorkspaceTerminalHandle,
    sendAgentKill,
    sendTerminalAttach,
    sendTerminalCreate,
    sendTerminalDetach,
    sendTerminalInput,
    sendTerminalResize,
    sendTerminalVisibility,
    setTerminalTileRepoScope,
    setWorkspaceActiveTabKindByTileId,
    setWorkspaceChatSessionByTileId,
    setWorkspaceChatSessionsByTileId,
    setWorkspaceLaneByTileId,
    setWorkspaceTerminalResetNonceByTileId,
    termWsConnected,
    updateSupervisorWorkspaceTab,
    waitForWorkspaceTerminalTarget,
    workspaceActiveTabKindByTileId,
    workspaceChatSessionsByTileId,
    workspaceChatTargets,
    workspaceTerminalHandlesRef,
    workspaceTerminalResetNonceByTileId,
  } = useWorkspaceTerminal({
    activeTileId,
    contextualPanelHandlesRef,
    refreshWorkspaceLifecycle,
    setActiveTileId,
    setActiveWorkspace,
    setTileLayout,
    thoughtsMissionPackets: thoughtsMissionState.packets,
    tileLayout,
    workspaceScopeEntries,
    workspaceTerminalPreferredRepo,
  });

  // ── Client transcript store: seed known workspace sessions + bridge WS fanout ──
  const transcriptWsCallbacks = useMemo(
    () => buildTranscriptWsCallbacks({ merge: mergeTranscriptEntries }),
    [],
  );
  useSharedDesktopWs(undefined, transcriptWsCallbacks);

  const transcriptBootstrapKeysKey = useMemo(() => {
    const keys = new Set<string>();
    for (const sessions of Object.values(workspaceChatSessionsByTileId)) {
      for (const session of sessions) {
        if (session?.sessionKey) keys.add(session.sessionKey);
      }
    }
    if (activeWorkspaceChatSessionKey) keys.add(activeWorkspaceChatSessionKey);
    return [...keys].sort().join('|');
  }, [workspaceChatSessionsByTileId, activeWorkspaceChatSessionKey]);

  useEffect(() => {
    if (!transcriptBootstrapKeysKey) return;
    const sessionKeys = transcriptBootstrapKeysKey.split('|').filter(Boolean);
    if (sessionKeys.length === 0) return;
    const controller = new AbortController();
    void bootstrapTranscripts(sessionKeys, {
      merge: mergeTranscriptEntries,
      signal: controller.signal,
    });
    return () => controller.abort();
  }, [transcriptBootstrapKeysKey]);

  // ── Active workspace-tab kind ──
  // Surfaced to the AgentPanel so the Orchestrator / Assistant rows shimmer
  // only when the corresponding workspace tab is selected, not whenever the
  // repo is focused. Falls back to the first tile with a tracked kind when
  // the activeTileId points at something non-workspace (e.g. orchestrator tile).
  const activeWorkspaceTabKind = useMemo(() => {
    if (activeTileId && workspaceActiveTabKindByTileId[activeTileId]) {
      return workspaceActiveTabKindByTileId[activeTileId];
    }
    const values = Object.values(workspaceActiveTabKindByTileId).filter((kind) => kind !== null);
    return values[0] ?? null;
  }, [activeTileId, workspaceActiveTabKindByTileId]);

  useEffect(() => {
    if (activeWorkspaceTabKind !== 'chat' || !activeWorkspaceChatSessionKey) return;
    setActiveSessionKey((current) => (
      current === activeWorkspaceChatSessionKey ? current : activeWorkspaceChatSessionKey
    ));
  }, [activeWorkspaceChatSessionKey, activeWorkspaceTabKind, setActiveSessionKey]);

  const handleOpenHistoryChatFromPanel = useCallback((
    historyTabId: string,
    title: string,
    repo?: SavedChatRepoContext | null,
  ) => {
    const requestedSessionKey = `llm-chat:${historyTabId}`;
    const requestId = historyOpenRequestRef.current + 1;
    historyOpenRequestRef.current = requestId;
    setPendingHistoryRailSessionKey(requestedSessionKey);
    setActiveSessionKey(requestedSessionKey);
    void (async () => {
      try {
        const primaryHandle = await waitForWorkspaceTerminalHandle({
          read: () => workspaceTerminalHandlesRef.current.get('tile-root') ?? null,
          wait: (delayMs) => new Promise((resolve) => window.setTimeout(resolve, delayMs)),
          attempts: 20,
        });
        if (!primaryHandle) throw new Error('Primary workspace is unavailable');
        if (!isLatestHistoryOpenRequest(requestId, historyOpenRequestRef.current)) return;
        const snapshot = primaryHandle.getTabsSnapshot();
        // Reuse a tab that MATCHES the thread's kind — orchestrator threads
        // (thoughts-*) reuse only an orchestrator tab (Claude); never load them
        // into the free o8-Default casual chat. Falling through to historyTabId
        // makes a fresh tab of the right kind (see buildHistoryChatTab).
        const isOrchestratorThread = historyTabId.startsWith('thoughts-');
        const primaryConversationTab = isOrchestratorThread
          ? snapshot.tabs.find((tab) => tab.kind === 'orchestrator') ?? null
          : snapshot.tabs.find((tab) => tab.kind === 'llm-chat' && tab.id !== historyTabId)
              ?? snapshot.tabs.find((tab) => tab.kind === 'llm-chat')
              ?? null;
        const tabId = primaryHandle.openHistoryChat(primaryConversationTab?.id ?? historyTabId, title, repo);
        if (tabId) {
          window.dispatchEvent(new CustomEvent('o8:tab-focus-flash', { detail: { tabId } }));
          const loadThread = () => {
            if (!isLatestHistoryOpenRequest(requestId, historyOpenRequestRef.current)) return;
            window.dispatchEvent(new CustomEvent('o8:load-history-thread', {
              detail: { tabId, historyTabId },
            }));
          };
          // When the OrchestratorTab is already mounted + active, its
          // o8:load-history-thread listener is registered and a single
          // dispatch suffices. The 120/420ms retries are only needed when
          // the tab is being newly-activated — without them, the listener
          // can mount AFTER our first dispatch and miss it. The redundant
          // trampoline used to flicker the transcript on already-open
          // chats (3x load × ~80ms each). Cooldown in handleLoadThread
          // keeps the retries cheap even when they do fire.
          const tabAlreadyActive = snapshot.activeTabId === tabId;
          loadThread();
          if (!tabAlreadyActive) {
            window.setTimeout(loadThread, 120);
            window.setTimeout(loadThread, 420);
          }
        }
      } catch {
        // Best-effort sidebar navigation; the workspace terminal may still be mounting.
        setPendingHistoryRailSessionKey((current) => (
          current === requestedSessionKey ? null : current
        ));
      }
    })();
  }, [setActiveSessionKey, workspaceTerminalHandlesRef]);

  useEffect(() => {
    const supersedePendingHistoryOpen = () => {
      historyOpenRequestRef.current = supersedeHistoryOpenRequest(historyOpenRequestRef.current);
      setPendingHistoryRailSessionKey(null);
    };
    window.addEventListener(HISTORY_NAVIGATION_SUPERSEDED_EVENT, supersedePendingHistoryOpen);
    return () => window.removeEventListener(
      HISTORY_NAVIGATION_SUPERSEDED_EVENT,
      supersedePendingHistoryOpen,
    );
  }, []);

  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: string; title?: string }>).detail;
      if (detail?.threadId && /^thoughts-[A-Za-z0-9_-]{1,120}$/.test(detail.threadId)) handleOpenHistoryChatFromPanel(detail.threadId, detail.title || detail.threadId);
    };
    window.addEventListener('o8:open-pr-conversation', open);
    return () => window.removeEventListener('o8:open-pr-conversation', open);
  }, [handleOpenHistoryChatFromPanel]);

  const wsConnectionState = useWsConnectionState();
  const wsConnectedRef = useRef<typeof wsConnectionState>('disconnected');
  wsConnectedRef.current = wsConnectionState;
  const mobileRevealCursorRef = useRef(new Date(Date.now() - 3000).toISOString());
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const seen = new Set<string>();
    let disposed = false;
    let inFlight = false;

    const openRevealRequest = (requestedAt: string | null, thread: MobileOrchestratorThread | undefined) => {
      if (!requestedAt || !thread?.id || !thread.title) return;
      if (Date.parse(requestedAt) > Date.parse(mobileRevealCursorRef.current)) {
        mobileRevealCursorRef.current = requestedAt;
      }
      const seenKey = `${thread.id}:${requestedAt}`;
      if (seen.has(seenKey)) return;
      seen.add(seenKey);
      handleOpenHistoryChatFromPanel(
        thread.id,
        thread.title,
        historyRepoContextFromMobileThread(thread),
      );
    };

    const handleThreadEvent = (event: Event) => {
      const detail = (event as CustomEvent<{
        event?: string;
        data?: { requestedAt?: string; thread?: MobileOrchestratorThread };
      }>).detail;
      if (detail?.event !== 'reveal') return;
      openRevealRequest(
        typeof detail.data?.requestedAt === 'string' ? detail.data.requestedAt : null,
        detail.data?.thread,
      );
    };

    const pollMobileRevealRequests = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(`/api/mobile/orchestrator/threads/reveal?since=${encodeURIComponent(mobileRevealCursorRef.current)}`, { cache: 'no-store' });
        if (!res.ok || disposed) return;
        const data = await res.json() as {
          requests?: Array<{ requestedAt?: string; thread?: MobileOrchestratorThread }>;
        };
        const requests = Array.isArray(data.requests) ? data.requests : [];
        for (const request of requests) {
          openRevealRequest(
            typeof request.requestedAt === 'string' ? request.requestedAt : null,
            request.thread,
          );
        }
      } catch {
        // Best-effort mobile reveal bridge; the normal history list still works.
      } finally {
        inFlight = false;
      }
    };

    window.addEventListener('o8:orchestrator-threads', handleThreadEvent);
    void pollMobileRevealRequests();
    const timer = window.setInterval(() => {
      if (wsConnectedRef.current === 'connected') return;
      void pollMobileRevealRequests();
    }, 30000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener('o8:orchestrator-threads', handleThreadEvent);
    };
  }, [handleOpenHistoryChatFromPanel]);

  // ── Workspace tab hotkeys ──
  // Cmd+1..Cmd+9 jump to the Nth workspace tab, Cmd+Opt+Left / Right cycle
  // previous / next with wrap, Cmd+W closes the active tab. All dispatches
  // hit the primary workspace page owner even when a split pane has focus.
  // Flash is driven off a custom event
  // that TabBar listens for and pulses an accent shadow on the target label.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;
      const isEditable = target?.isContentEditable
        || tagName === 'INPUT'
        || tagName === 'TEXTAREA'
        || tagName === 'SELECT';
      const resolveHandle = () => {
        const handles = workspaceTerminalHandlesRef.current;
        return handles.get('tile-root') ?? null;
      };
      const flash = (tabId: string) => {
        window.dispatchEvent(new CustomEvent('o8:tab-focus-flash', { detail: { tabId } }));
      };
      // Cmd+Opt+Left / Right — cycle (allow inside editable fields too)
      if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        const handle = resolveHandle();
        if (!handle) return;
        const delta = event.key === 'ArrowRight' ? 1 : -1;
        if (handle.focusTabRelative(delta)) {
          event.preventDefault();
          const snap = handle.getTabsSnapshot();
          flash(snap.activeTabId);
        }
        return;
      }
      // Cmd+1-9 — jump straight to tab N. Allowed inside editable fields too
      // (like browsers / VS Code) so power users switch tabs without leaving
      // the composer. ⌘+digit is a no-op in a plain textarea, so nothing is
      // lost. Shift+digit naturally falls through (event.key becomes '!' etc).
      if (!event.altKey && event.key >= '1' && event.key <= '9') {
        const handle = resolveHandle();
        if (!handle) return;
        const index = Number.parseInt(event.key, 10);
        if (handle.focusTabAtIndex(index)) {
          event.preventDefault();
          const snap = handle.getTabsSnapshot();
          flash(snap.activeTabId);
        }
        return;
      }
      if (isEditable && !event.altKey) {
        // Cmd+W must not fire while typing — it would close the tab and drop
        // the in-progress draft. Cmd+Opt+Arrow and Cmd+digit bypass this
        // guard above, matching iTerm / browser tab navigation.
        return;
      }
      if (!event.altKey && !event.shiftKey && event.key.toLowerCase() === 'w') {
        const handle = resolveHandle();
        if (!handle) return;
        if (handle.closeActiveTab()) {
          event.preventDefault();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [workspaceTerminalHandlesRef]);

  // ── ⌘/ (and bare `?`) opens the keyboard-shortcuts reference overlay ──
  // ⌘/ is the macOS-convention "show shortcuts" binding; `?` is a fallback
  // that only fires when the user isn't typing into a field. Both skip
  // editable targets so they don't hijack literal `/` or `?` input.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const isSlash = (event.metaKey || event.ctrlKey)
        && !event.altKey
        && !event.shiftKey
        && event.key === '/';
      const isQuestion = !event.metaKey && !event.ctrlKey && !event.altKey && event.key === '?';
      if (!isSlash && !isQuestion) return;

      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;
      const isEditable = Boolean(
        target?.isContentEditable
          || tagName === 'INPUT'
          || tagName === 'TEXTAREA'
          || tagName === 'SELECT',
      );
      if (isEditable) return;

      event.preventDefault();
      setShortcutsOpen((current) => !current);
    };
    const openHelp = () => setShortcutsOpen(true);
    window.addEventListener('keydown', handler);
    window.addEventListener(OPEN_KEYBOARD_SHORTCUTS_EVENT, openHelp);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener(OPEN_KEYBOARD_SHORTCUTS_EVENT, openHelp);
    };
  }, []);

  // Active-workspace switch — clear the owned-session fleet cache so the next
  // consumer rebuilds immediately instead of serving a stale (up to 20s) TTL
  // entry from the previous workspace. Fire-and-forget; idempotent + cheap.
  // Deferred to an idle tick so it doesn't compete with synchronous bootstrap
  // work during the initial mount.
  useEffect(() => {
    if (!activeWorkspace) return;
    const controller = new AbortController();
    const run = () => {
      if (controller.signal.aborted) return;
      void fetch('/api/panel/fleet/invalidate', {
        method: 'POST',
        signal: controller.signal,
      }).catch(() => {});
    };
    const handle = safeRequestIdleCallback(run, { timeout: 2000 });
    return () => {
      safeCancelIdleCallback(handle);
      controller.abort();
    };
  }, [activeWorkspace]);

  const archivedLaneView = useLaneArchivedView();

  const activePackets = useMemo(
    () => thoughtsMissionState.packets.filter((packet) => !archivedLaneView.packetIds.has(packet.id)),
    [thoughtsMissionState.packets, archivedLaneView.packetIds],
  );
  const {
    activeSurfaceRepoPath,
    activeWorkspaceChatTargetKey,
    canvasStateByTileId,
    closeCanvasTab,
    ensureTileKind,
    getPreferredContextualPanelHandle,
    handleCloseTile,
    handlePreviewDetected,
    handleResizeSplit,
    handleSplitTile,
    openCanvasTab,
    registerContextualPanelHandle,
    selectCanvasTab,
    setCanvasStateByTileId,
    setTileLayoutHydrated,
    setWorkspacePreviews,
    tileLayoutHydrated,
    toggleContextualPanelTile,
    restoredRepoValidationState,
    retryRestoredRepoValidation,
    unverifiedRestoredRepoTileIds,
    workspaceChatTargetLabel,
    workspaceChatTargetRepoPath,
    workspacePreviews,
  } = useTileLayout({
    activeTileId,
    activeWorkspaceChatSessionKey,
    contextualPanelHandlesRef,
    findInsertionTarget,
    findWorkspaceTarget,
    globalRepoEntries,
    globalRepoEntry,
    refreshRestoredRepoState,
    repoInventoryRevision,
    setActiveTileId,
    setTileLayout,
    tileLayout,
    workspaceChatTargetKeyByRepoPath,
    workspaceChatTargets,
    workspaceSidePanelRepoPath: null,
    workspaceTerminalHandlesRef,
    workspaceTerminalPreferredRepo,
    waitForWorkspaceTerminalTarget,
  });

  const { switching: workspacePageSwitching } = useWorkspacePageLayouts({
    activeTabId: primaryWorkspace?.tabId ?? null,
    hydrated: tileLayoutHydrated,
    layout: tileLayout,
    setActiveTileId,
    setLayout: setTileLayout,
  });

  // Cmd/Ctrl+J toggles the orchestrator chat tile. Global shortcut,
  // ignored while the user is typing in an input.
  // Cmd+J used to toggle the thoughts tile. The Orchestrator is now a tab
  // inside WorkspaceTerminal, so the shortcut is retired. Can be reintroduced
  // later by wiring the handler into WorkspaceTerminal's focusTab handle.

  // O8 panel focus bus — when a write-class tool call in the orchestrator
  // chat emits a pivot request, swap the right panel's active tab to the
  // requested tab *only if the panel is already open*. If it's closed,
  // surface a toast the chat tile can render inline. Auto-opening the
  // panel would feel intrusive mid-conversation.
  useEffect(() => {
    const unsubscribe = subscribeO8PanelFocus((request) => {
      const panelOpen = chatVisible && rightPanelKind === 'o8';
      if (!panelOpen) {
        // Panel closed — silently drop the focus request. We used to
        // publish a toast here but no consumer ever subscribed.
        return;
      }
      const requestedTab = normalizeO8ActiveTab(request.tab);
      if (requestedTab) {
        if (requestedTab !== 'review') setO8ReviewLaneId(null);
        if (requestedTab === 'workspace' && request.artifactId) {
          setO8SelectedFile(request.artifactId);
          setO8SelectedFileRepoPath(currentO8RepoPath);
        }
        setO8ActiveTab(requestedTab);
      }
    });
    return unsubscribe;
  }, [chatVisible, currentO8RepoPath, rightPanelKind]);

  const handleOpenInbox = useCallback(() => {
    setRightPanelKind('o8');
    openRightPanelFromUser();
    setO8ActiveTab('inbox');
  }, [openRightPanelFromUser]);

  useEffect(() => {
    window.addEventListener('o8:open-inbox-tab', handleOpenInbox);
    return () => window.removeEventListener('o8:open-inbox-tab', handleOpenInbox);
  }, [handleOpenInbox]);

  const handleOpenHandoffs = useCallback(() => {
    if (chatVisible && rightPanelKind === 'o8' && o8ActiveTab === 'handoffs') {
      closeRightPanelFromUser();
      return;
    }
    setRightPanelKind('o8');
    openRightPanelFromUser();
    setO8ActiveTab('handoffs');
  }, [chatVisible, closeRightPanelFromUser, o8ActiveTab, openRightPanelFromUser, rightPanelKind]);

  useEffect(() => {
    window.addEventListener('o8:open-handoffs', handleOpenHandoffs);
    return () => window.removeEventListener('o8:open-handoffs', handleOpenHandoffs);
  }, [handleOpenHandoffs]);

  const openWorkspaceUtility = useCallback((kind: WorkspaceUtilityKind) => {
    setActiveNavSection('agents');
    openCanvasTab(workspaceUtilityTab(kind, (leftPanelFocus.view?.project ?? dashboardProjects.activeProject)?.id));
  }, [setActiveNavSection, openCanvasTab, leftPanelFocus.view?.project, dashboardProjects.activeProject]);
  useEffect(() => {
    const automations = () => openWorkspaceUtility('automations');
    const customize = (event: Event) => openWorkspaceUtility((event as CustomEvent<{ tab?: string }>).detail?.tab === 'plugins' ? 'plugins' : 'customize');
    window.addEventListener('o8:open-automations', automations);
    window.addEventListener('o8:open-customize', customize);
    return () => {
      window.removeEventListener('o8:open-automations', automations);
      window.removeEventListener('o8:open-customize', customize);
    };
  }, [openWorkspaceUtility]);
  // Migrate older saved navigation destinations into resident workspace tabs.
  useEffect(() => {
    if (activeNavSection === 'automations' || activeNavSection === 'customize') openWorkspaceUtility(activeNavSection);
  }, [activeNavSection, openWorkspaceUtility]);


  const handleRepoRemoved = useCallback((removedRepo: RepoRegistryEntry) => {
    const removedRepoPath = removedRepo.localPath;
    const nextGlobalRepoEntries = globalRepoEntries.filter((repo) => repo.id !== removedRepo.id);
    const scopedTileIds = collectRepoScopedTileIds(tileLayout.root, removedRepoPath);
    const affectedTerminalTileIds = new Set(scopedTileIds.terminal);
    const affectedCanvasTileIds = new Set(scopedTileIds.canvas);

    const nextWorkspaceChatSessionsByTileId = Object.entries(workspaceChatSessionsByTileId).reduce<Record<string, MobileInboxSnapshot['sessions']>>((next, [tileId, sessions]) => {
      const filteredSessions = sessions.filter((session) => !sessionBelongsToRepoScope(session, removedRepoPath));
      if (filteredSessions.length !== sessions.length) {
        affectedTerminalTileIds.add(tileId);
      }
      if (filteredSessions.length > 0) {
        next[tileId] = filteredSessions;
      }
      return next;
    }, {});

    const parsed = (() => {
      try {
        return JSON.parse(agentsJson) as PaletteAgentSummary[];
      } catch {
        return [] as PaletteAgentSummary[];
      }
    })();
    const filteredAgents = parsed.filter((agent) => !sessionBelongsToRepoScope(agent, removedRepoPath));
    const removedSessionKeys = new Set<string>([
      ...parsed.filter((agent) => sessionBelongsToRepoScope(agent, removedRepoPath)).map((agent) => agent.sessionKey),
      ...Object.values(workspaceChatSessionsByTileId).flatMap((sessions) => sessions
        .filter((session) => sessionBelongsToRepoScope(session, removedRepoPath))
        .map((session) => session.sessionKey)),
    ]);

    setAgentsJson(JSON.stringify(filteredAgents));
    // A confirmed removal (this callback only fires after AgentPanel's own
    // DELETE succeeds) is newer truth than anything in flight — bump the
    // shared epoch so a repo-inventory refresh that started earlier (e.g.
    // useGlobalRepoState's saved-scope recovery, still waiting on worktree
    // lookups) can never resurrect this repo by overwriting with
    // pre-removal data once it resolves.
    bumpRepoInventoryGeneration();
    setGlobalRepoEntries(nextGlobalRepoEntries);
    setAllRepoWorktrees((current) => {
      const next = { ...current };
      delete next[removedRepoPath];
      return next;
    });

    if (globalRepoId === removedRepo.id) {
      const fallbackRepo = nextGlobalRepoEntries[0] ?? null;
      setGlobalRepoId(fallbackRepo?.id ?? null);
      setGlobalRepoBranch(fallbackRepo?.defaultBranch ?? 'main');
      if (typeof window !== 'undefined') {
        if (fallbackRepo) {
          sessionStorage.setItem('cortex-global-repo-id', fallbackRepo.id);
        } else {
          sessionStorage.removeItem('cortex-global-repo-id');
        }
      }
    }

    if (pathBelongsToRepoScope(activeWorkspace, removedRepoPath)) {
      setActiveWorkspace(undefined);
    }

    if (pathBelongsToRepoScope(o8RepoPathOverride, removedRepoPath)) {
      setO8RepoPathOverride(null);
      setO8SelectedFile(null);
      setO8SelectedFileRepoPath(null);
    }

    setWorkspaceChatSessionsByTileId(nextWorkspaceChatSessionsByTileId);
    setWorkspaceChatSessionByTileId((current) => Object.entries(current).reduce<Record<string, string | undefined>>((next, [tileId, sessionKey]) => {
      if (affectedTerminalTileIds.has(tileId)) {
        return next;
      }
      if (!sessionKey) {
        next[tileId] = sessionKey;
        return next;
      }
      const sessions = nextWorkspaceChatSessionsByTileId[tileId] ?? [];
      if (sessions.some((session) => session.sessionKey === sessionKey)) {
        next[tileId] = sessionKey;
      }
      return next;
    }, {}));
    setWorkspaceChatTargetKeyByRepoPath((current) => Object.entries(current).reduce<Record<string, string>>((next, [repoPath, sessionKey]) => {
      if (!pathBelongsToRepoScope(repoPath, removedRepoPath) && !removedSessionKeys.has(sessionKey)) {
        next[repoPath] = sessionKey;
      }
      return next;
    }, {}));
    setWorkspaceLaneByTileId((current) => Object.entries(current).reduce<Record<string, WorkspaceLaneState | null>>((next, [tileId, lane]) => {
      if (affectedTerminalTileIds.has(tileId)) {
        return next;
      }
      if (!lane || !pathBelongsToRepoScope(lane.repoPath, removedRepoPath)) {
        next[tileId] = lane;
      }
      return next;
    }, {}));

    if (activeSessionKey && removedSessionKeys.has(activeSessionKey)) {
      setActiveSessionKey(undefined);
    }

    const nextLifecycleRecords = workspaceLifecycleRecords.filter((record) => (
      !pathBelongsToRepoScope(record.repoPath, removedRepoPath)
      && !pathBelongsToRepoScope(record.workspacePath, removedRepoPath)
    ));
    setWorkspaceLifecycleRecords(nextLifecycleRecords);
    setWorkspaceLifecycleSummary(summarizeLifecycleRecords(nextLifecycleRecords));
    void refreshWorkspaceLifecycle();

    if (globalRepoEntry?.localPath === removedRepoPath) {
      setSelectedRepoWorktrees(null);
    }

    if (affectedCanvasTileIds.size > 0) {
      setCanvasStateByTileId((current) => {
        const next = { ...current };
        for (const tileId of affectedCanvasTileIds) {
          next[tileId] = {
            tabs: [],
            activeTabId: null,
            revealKey: (current[tileId]?.revealKey ?? 0) + 1,
          };
        }
        return next;
      });
    }

    if (affectedTerminalTileIds.size > 0) {
      setWorkspaceTerminalResetNonceByTileId((current) => {
        const next = { ...current };
        for (const tileId of affectedTerminalTileIds) {
          next[tileId] = (next[tileId] ?? 0) + 1;
        }
        return next;
      });
    }

    setTileLayout((current) => ({
      ...current,
      root: clearRepoScopeFromTileLayout(current.root, removedRepoPath),
    }));
  }, [
    activeSessionKey,
    activeWorkspace,
    agentsJson,
    bumpRepoInventoryGeneration,
    globalRepoEntries,
    globalRepoEntry?.localPath,
    globalRepoId,
    refreshWorkspaceLifecycle,
    setActiveSessionKey,
    setActiveWorkspace,
    setAgentsJson,
    setAllRepoWorktrees,
    setCanvasStateByTileId,
    setGlobalRepoBranch,
    setGlobalRepoEntries,
    setGlobalRepoId,
    setSelectedRepoWorktrees,
    setWorkspaceChatSessionByTileId,
    setWorkspaceChatSessionsByTileId,
    setWorkspaceLaneByTileId,
    setWorkspaceTerminalResetNonceByTileId,
    tileLayout.root,
    workspaceChatSessionsByTileId,
    workspaceLifecycleRecords,
    o8RepoPathOverride,
  ]);

  useEffect(() => {
    const initTimer = setTimeout(() => { void refreshWorkspaceLifecycle(); }, 2_500);
    // WS-driven: instant refresh on lifecycle events instead of 30s polling
    const handler = () => { void refreshWorkspaceLifecycle(); };
    const wsEvents = ['o8:lifecycle-reconcile'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = window.setInterval(handler, 300_000); // 5min resilience fallback
    return () => {
      clearTimeout(initTimer);
      for (const e of wsEvents) window.removeEventListener(e, handler);
      window.clearInterval(fallbackId);
    };
  }, [refreshWorkspaceLifecycle]);

  useEffect(() => {
    if (wsStatus !== 'connected') return;
    void refreshWorkspaceLifecycle();
  }, [refreshWorkspaceLifecycle, wsStatus]);

  // ── Alert system (toast-only; tray removed) ──
  const {
    alerts: activeAlerts,
    updateAgents,
  } = useAlerts();

  const launchOrchestrationPacket = useCallback(async (packet: OrchestratorPacket): Promise<OrchestratorLaneBinding | null> => {
    if (packet.lane) {
      focusOrchestrationPacketLane(packet);
      return packet.lane;
    }

    // ── Create a lane for this packet ──
    let laneId: string | null = null;
    const laneApi = async (body: Record<string, unknown>) => {
      try {
        const res = await fetch('/api/lanes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return await res.json().catch(() => ({})) as Record<string, unknown>;
      } catch { return {}; }
    };
    const laneData = await laneApi({
      verb: 'open_lane',
      repoPath: packet.workspaceTargetPath ?? workspaceTerminalPreferredRepo?.localPath ?? '',
      branch: packet.branchTarget || 'main',
      runtime: packet.runtime,
      label: packet.title,
      packetId: packet.id,
      actor: 'user',
    });
    if (laneData.reason === 'packet_held' || laneData.reason === 'already_launching' || laneData.reason === 'packet_missing') {
      throw new Error(typeof laneData.note === 'string' ? laneData.note : 'This packet cannot launch right now.');
    }
    if (laneData.ok && laneData.laneId) {
      laneId = laneData.laneId as string;
      console.log(`[orchestrator] Lane created: ${laneId} for packet ${packet.referenceLabel}`);
    } else {
      console.warn('[orchestrator] Lane creation failed, continuing without lane tracking');
    }

    let targetScope = workspaceScopeEntries.find((entry) => entry.localPath === packet.workspaceTargetPath)
      ?? workspaceTerminalPreferredRepo
      ?? workspaceScopeEntries[0]
      ?? null;
    const rootRepo = targetScope?.isWorktree
      ? globalRepoEntries.find((repo) => targetScope?.registryRepoId ? repo.id === targetScope.registryRepoId : targetScope.localPath.startsWith(`${repo.localPath}/`)) ?? null
      : globalRepoEntries.find((repo) => repo.localPath === targetScope?.localPath) ?? null;

    if (rootRepo) {
      const currentBranch = targetScope?.branch ?? rootRepo.readiness?.currentBranch ?? rootRepo.defaultBranch ?? 'main';
      const requestedBranch = packet.branchTarget.trim();
      if (targetScope?.isWorktree && (!requestedBranch || requestedBranch === targetScope.branch)) {
        // Existing targeted worktree already matches the packet target.
      } else {
        let existingWorktree: WorktreeInfo | undefined;
        if (requestedBranch && requestedBranch !== currentBranch) {
          let repoWorktrees = allRepoWorktrees[rootRepo.localPath] ?? [];
          try {
            repoWorktrees = (await loadRepoWorktrees(rootRepo.localPath)).worktrees;
          } catch {
            // Fall back to the last selected/target-repo snapshot. The create
            // path still performs its own collision and branch checks.
          }
          existingWorktree = repoWorktrees.find((worktree) => worktree.branch === requestedBranch);
        }
        if (existingWorktree) {
          targetScope = {
            registryRepoId: rootRepo.id,
            name: rootRepo.name,
            localPath: existingWorktree.path,
            branch: existingWorktree.branch,
            readiness: null,
            remoteUrl: rootRepo.remoteUrl ?? undefined,
            isWorktree: true,
            worktreeStatus: existingWorktree.status,
          };
        } else if (requestedBranch && requestedBranch !== currentBranch) {
          const response = await fetch('/api/worktrees', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              repo: rootRepo.localPath,
              agentType: packet.runtime,
              taskName: `${packet.referenceLabel}-${packet.title}`,
              branchName: requestedBranch,
              baseBranch: currentBranch,
              managed: packet.runtime === 'claude-code',
              skipSetup: true,
              isolationPreference: rootRepo.setup.workspaceIsolationPreference,
            }),
          });
          const payload = await response.json().catch(() => ({})) as { worktree?: WorktreeInfo; error?: string };
          if (!response.ok || !payload.worktree) {
            throw new Error(payload.error ?? 'Unable to create orchestrator worktree lane.');
          }
          setAllRepoWorktrees((current) => {
            const existing = current[rootRepo.localPath] ?? [];
            return {
              ...current,
              [rootRepo.localPath]: [
                ...existing.filter((worktree) => worktree.id !== payload.worktree!.id),
                payload.worktree!,
              ],
            };
          });
          targetScope = {
            registryRepoId: rootRepo.id,
            name: rootRepo.name,
            localPath: payload.worktree.path,
            branch: payload.worktree.branch,
            readiness: null,
            remoteUrl: rootRepo.remoteUrl ?? undefined,
            isWorktree: true,
            worktreeStatus: payload.worktree.status,
          };
        }
      }
    }

    const repoPath = targetScope?.localPath ?? workspaceTerminalPreferredRepo?.localPath ?? null;
    const activeOrchestratorThreadId = workspaceHeaderActive.kind === 'orchestrator'
      ? workspaceHeaderActive.tabs.find((tab) => tab.id === workspaceHeaderActive.tabId)?.orchestratorThreadId?.trim() ?? ''
      : '';
    const launchPacket = activeOrchestratorThreadId
      ? { ...packet, orchestratorThreadId: activeOrchestratorThreadId }
      : packet;

    // Update lane with worktree path if one was created
    if (laneId && targetScope?.isWorktree && targetScope.localPath) {
      void laneApi({ verb: 'bind_worktree', laneId, worktreePath: targetScope.localPath, actor: 'system' });
    }

    const workspaceTarget = await waitForWorkspaceTerminalTarget({ repoPath });
    if (!workspaceTarget) {
      if (laneId) void laneApi({ verb: 'request_review', laneId, actor: 'system' });
      return null;
    }

    // All four runtimes are first-class workspace-tab runtimes since v0.1.24.
    // Use packet.runtime directly so the monitoring tab shows the correct
    // agent label, streams from the right /api/mobile/history branch, and
    // pins the right default model instead of masquerading as Codex.
    const chatRuntime = packet.runtime;
    const tabId = workspaceTarget.handle.openCliChatSession({
      runtime: chatRuntime,
      repo: targetScope ? {
        name: targetScope.name,
        localPath: targetScope.localPath,
        branch: targetScope.branch ?? 'main',
        readiness: targetScope.readiness ?? null,
        remoteUrl: targetScope.remoteUrl ?? undefined,
        registryRepoId: targetScope.registryRepoId,
        isWorktree: targetScope.isWorktree ?? false,
        worktreeStatus: targetScope.worktreeStatus ?? null,
      } : undefined,
      initialText: buildOrchestrationPacketDraft(
        thoughtsMissionState,
        launchPacket,
        targetScope?.name ?? targetScope?.localPath ?? null,
      ),
      autoSend: true,
      createNew: true,
      label: packet.title,
      orchestrationPacket: buildOrchestrationPacketBadge({
        ...launchPacket,
        status: 'running',
      }),
      autoArchiveOnIdle: false,
    });
    enqueueFtuxMilestone('firstAgentSpawned');

    setActiveTileId(workspaceTarget.tileId);
    setLatestDispatchedTabId(tabId);
    setLatestDispatchedAt(Date.now());

    // ── Notify the lane that a session was created ──
    if (laneId) {
      void laneApi({ verb: 'attach_session', laneId, sessionKey: tabId, actor: 'system' });
    }

    return {
      tileId: workspaceTarget.tileId,
      tabId,
      repoPath,
      runtime: packet.runtime,
      laneId,
    };
  }, [
    allRepoWorktrees,
    enqueueFtuxMilestone,
    focusOrchestrationPacketLane,
    globalRepoEntries,
    loadRepoWorktrees,
    setAllRepoWorktrees,
    thoughtsMissionState,
    waitForWorkspaceTerminalTarget,
    workspaceHeaderActive.kind,
    workspaceHeaderActive.tabId,
    workspaceHeaderActive.tabs,
    workspaceScopeEntries,
    workspaceTerminalPreferredRepo,
  ]);

  // ── Repo alignment — click repo name → align whole app ──
  const handleAlignToRepo = useCallback((repoId: string) => {
    void handleSelectRegisteredRepo(repoId);
    setO8AllRepos(false); // picking a specific repo exits the All-repos aggregate
    const targetRepo = globalRepoEntries.find((r) => r.id === repoId);
    if (targetRepo) {
      setO8RepoPathOverride(targetRepo.localPath);
      setO8SelectedFile(null);
      setO8SelectedFileRepoPath(null);
    }
  }, [globalRepoEntries, handleSelectRegisteredRepo]);

  const handleRepoAddedFromPanel = useCallback(async (repo: RepoRegistryEntry) => {
    const repos = await loadRegisteredRepos();
    const selected = repos.find((entry) => entry.id === repo.id) ?? repo;
    setGlobalRepoId(selected.id);
    setGlobalRepoBranch(selected.defaultBranch || 'main');
    setO8RepoPathOverride(selected.localPath);
    setO8SelectedFile(null);
    setO8SelectedFileRepoPath(null);
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('cortex-global-repo-id', selected.id);
    }
  }, [loadRegisteredRepos, setGlobalRepoBranch, setGlobalRepoId]);

  // ── Routing callbacks for AgentPanel ──
  // Open the wide O8 panel pinned to a specific repo path + tab. Callers
  // that need review mode pass `workspace`; otherwise the panel lands on
  // the operator briefing pulse.
  const handleOpenO8Panel = useCallback((options: { repoPath?: string | null; tab?: O8Tab; reviewLaneId?: string | null }) => {
    if (options.repoPath) setO8RepoPathOverride(options.repoPath);
    const nextTab = normalizeO8ActiveTab(options.tab) ?? DEFAULT_O8_ACTIVE_TAB;
    setO8ReviewLaneId(nextTab === 'review' ? options.reviewLaneId ?? null : null);
    setO8ActiveTab(nextTab);
    setRightPanelKind('o8');
    openRightPanelFromUser();
  }, [openRightPanelFromUser]);

  useThreadWorkspaceNavigation({
    currentWorkspaceId: () => workspaceHeaderActive.workspaceId,
    availability: () => threadPanelAvailability(
      typeof window !== 'undefined' ? window.innerWidth : getResponsiveViewportWidth(),
      RESPONSIVE_RIGHT_PANEL_COLLAPSE_WIDTH,
    ),
    resolve: (target) => {
      const workspace = workspaceActiveMap.get(target.workspaceId);
      if (!workspace?.tileId || !workspaceTerminalHandlesRef.current.has(workspace.tileId)
        || !globalRepoEntries.some((repo) => repo.localPath === target.repoPath)) return null;
      const project = resolveThreadProject(dashboardProjects.ledger?.projects ?? [], dashboardProjects.activeProject, target.repoPath, false);
      return {
        projectId: project?.id ?? null,
        activate: () => {
          setActiveTileId(workspace.tileId);
          setO8AllRepos(false);
          setO8CommitSha(null);
          setO8CommitRepoPath(null);
          setO8CommitRepoSlug(null);
          handleOpenO8Panel({ repoPath: target.repoPath, tab: 'threads' });
        },
        isActive: () => workspaceHeaderActive.workspaceId === target.workspaceId,
      };
    },
    readTasks: () => readThreadPages({ projectId: null, repoPaths: globalRepoEntries.map(repo => repo.localPath) }, AbortSignal.timeout(5000)),
  });

  const handleToggleWorkspacePip = useCallback((surface: 'browser' | 'spec', repoPath?: string | null) => {
    setO8RepoPathOverride(repoPath ?? null);
    if (surface === 'browser') closeRightPanelFromUser();
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(
      surface === 'browser' ? BROWSER_PIP_EVENT : O8_SPEC_PIP_EVENT,
      { detail: { toggle: true } },
    ));
  }, [closeRightPanelFromUser]);

  const handleSelectSession = useCallback((
    sessionKey: string,
    hint?: { title?: string; runtime?: OrchestratorRuntime; repoPath?: string | null; tmuxSession?: string },
  ) => {
    // Open the session transcript in a canvas chat tab.
    // `hint.title` is the pass-through (Option D): an archived row already has
    // its real title in hand — thread it so the tab opens with the right label
    // instead of the runtime fallback, since archived sessions aren't in the
    // `ideWorkspaceSessionsForSidebar` lookup below. Live tabs self-heal via the
    // setTabLabelIfAuto effect; this covers the archived case the effect can't reach.
    void (async () => {
      const selectedSession = ideWorkspaceSessionsForSidebar.find((session) => (
        session.sessionKey === sessionKey
        || session.id === sessionKey
        || session.sessionId === sessionKey
        || session.runtimeSurface?.id === sessionKey
      )) ?? parsedAgents.find((agent) => agent.sessionKey === sessionKey || agent.id === sessionKey);
      const runtime = runtimeFromSessionKeyId(sessionKey)
        ?? (isOrchestratorRuntime(selectedSession?.runtime) ? selectedSession.runtime : hint?.runtime)
        ?? 'codex';
      const knownScope = selectedSession?.workspace ?? selectedSession?.runtimeSurface?.cwd ?? hint?.repoPath;
      // Search can return a cloud session before the sidebar inventory catches up.
      const resolvedLane = runtime === 'cloud' && !knownScope
        ? await resolveFocusableLaneBinding({ sessionKey, runtime }) : null;
      const sessionScope = knownScope ?? resolvedLane?.repoPath ?? null;
      const targetRepo = sessionScope
        ? workspaceScopeEntries.find((repo) => (
          pathBelongsToRepoScope(sessionScope, repo.localPath)
          || pathBelongsToRepoScope(repo.localPath, sessionScope)
        ))
        : null;
      const terminalSession = hint?.tmuxSession?.trim()
        || (selectedSession?.runtimeSurface?.ownership === 'discovered'
          ? selectedSession.tmuxSession?.trim()
          : null);
      if (terminalSession) {
        for (const [tileId, handle] of workspaceTerminalHandlesRef.current) {
          if (!handle.focusTerminalSession(terminalSession)) continue;
          setActiveTileId(tileId);
          return;
        }
        const terminalTarget = await waitForWorkspaceTerminalTarget({
          repoPath: targetRepo?.localPath ?? sessionScope ?? undefined,
        });
        if (!terminalTarget) return;
        const repo = targetRepo ? {
          name: targetRepo.name,
          localPath: targetRepo.localPath,
          remoteUrl: targetRepo.remoteUrl,
          branch: targetRepo.branch,
          readiness: targetRepo.readiness,
          registryRepoId: targetRepo.registryRepoId,
          isWorktree: targetRepo.isWorktree,
          worktreeStatus: targetRepo.worktreeStatus,
        } : null;
        terminalTarget.handle.openAttachedTerminalSession({
          sessionKey,
          tmuxSession: terminalSession,
          label: hint?.title ?? selectedSession?.name ?? 'CLI terminal',
          statusEvidence: selectedSession?.statusEvidence,
          repo: repo ?? undefined,
        }, repo);
        setActiveTileId(terminalTarget.tileId);
        return;
      }
      // A left-rail chat is a workspace page, never a replacement for the
      // focused terminal pane. The primary session owner remains mounted even
      // when its pane is absent from the current split layout.
      const primaryHandle = await waitForWorkspaceTerminalHandle({
        read: () => workspaceTerminalHandlesRef.current.get('tile-root') ?? null,
        wait: (delayMs) => new Promise((resolve) => window.setTimeout(resolve, delayMs)),
        attempts: 20,
      });
      if (!primaryHandle) return;
      // Canonical label — never an id slice. agentDisplayLabel falls back to
      // the runtime's human name ("Codex") rather than a raw `codex-owned:...`
      // key, so the old `sessionKey.split(':').pop()?.slice(0,12)` → literal
      // "codex-owned-" leak is impossible by construction.
      const label = agentDisplayLabel({
        name: hint?.title ?? selectedSession?.name,
        title: selectedSession?.surfaceLabel?.trim() || selectedSession?.currentTask?.trim(),
        runtime,
      });
      primaryHandle.openCliChatSession({
        runtime,
        repo: targetRepo ? {
          name: targetRepo.name,
          localPath: targetRepo.localPath,
          remoteUrl: targetRepo.remoteUrl,
          branch: targetRepo.branch,
          readiness: targetRepo.readiness,
          registryRepoId: targetRepo.registryRepoId,
          isWorktree: targetRepo.isWorktree,
          worktreeStatus: targetRepo.worktreeStatus,
        } : runtime === 'cloud' && sessionScope ? {
          name: sessionScope.split(/[\\/]/).filter(Boolean).pop() ?? 'Repository',
          localPath: sessionScope,
        } : undefined,
        targetSessionKey: sessionKey,
        label,
      });
    })();
  }, [ideWorkspaceSessionsForSidebar, parsedAgents, setActiveTileId, waitForWorkspaceTerminalTarget, workspaceScopeEntries, workspaceTerminalHandlesRef]);

  useEffect(() => {
    const handleFocusSpawnedAgentLane = (event: Event) => {
      const detail = (event as CustomEvent<{
        packetId?: string | null;
        sessionKey?: string | null;
        tmuxSession?: string | null;
        laneId?: string | null;
        title?: string | null;
      }>).detail;
      const packetId = detail?.packetId?.trim() ?? '';
      const sessionKey = detail?.sessionKey?.trim() ?? '';
      const laneId = detail?.laneId?.trim() ?? '';
      const packet = thoughtsMissionStateRef.current.packets.find((candidate) => (
        (packetId && candidate.id === packetId)
        || (laneId && candidate.lane?.laneId === laneId)
        || (sessionKey && candidate.lane?.sessionKey === sessionKey)
        || (sessionKey && candidate.lane?.tabId === sessionKey)
      )) ?? null;
      if (packet) {
        focusOrchestrationPacketLane(packet);
        return;
      }
      if (sessionKey) handleSelectSession(sessionKey, {
        title: detail?.title ?? undefined,
        tmuxSession: detail?.tmuxSession ?? undefined,
      });
      if (!sessionKey && (laneId || packetId)) {
        void (async () => {
          const resolvedLane = await resolveFocusableLaneBinding({
            laneId,
            packetId,
            runtime: 'codex',
          });
          const resolvedSessionKey = resolvedLane?.sessionKey?.trim();
          if (!resolvedSessionKey) return;
          handleSelectSession(resolvedSessionKey, detail?.title ? { title: detail.title } : undefined);
        })();
      }
    };
    window.addEventListener('o8:focus-spawned-agent-lane', handleFocusSpawnedAgentLane);
    return () => window.removeEventListener('o8:focus-spawned-agent-lane', handleFocusSpawnedAgentLane);
  }, [focusOrchestrationPacketLane, handleSelectSession]);

  const flashWorkspaceTab = useCallback((tabId: string) => {
    if (!tabId) return;
    window.dispatchEvent(new CustomEvent('o8:tab-focus-flash', { detail: { tabId } }));
  }, []);

  const handleOpenPluginTerminal = useCallback(async (terminal: { sessionName: string; label: string; workspaceRoot: string | null }) => {
    const target = await waitForWorkspaceTerminalTarget({ preferredTileId: activeTileId, fallbackToAnyExisting: true, activate: false });
    const repo = globalRepoEntries.find((entry) => entry.localPath === terminal.workspaceRoot) ?? null;
    const tabId = target.handle.openAttachedTerminalSession({ sessionKey: terminal.sessionName, tmuxSession: terminal.sessionName, label: terminal.label, readOnly: false }, repo ? { ...repo, remoteUrl: repo.remoteUrl ?? undefined } : null);
    if (!tabId) throw new Error('Workspace terminal view unavailable.');
    setActiveTileId(target.tileId);
    setActiveNavSection('agents');
    flashWorkspaceTab(tabId);
  }, [waitForWorkspaceTerminalTarget, activeTileId, globalRepoEntries, setActiveTileId, setActiveNavSection, flashWorkspaceTab]);
  const workspaceUtilityContext = useMemo(() => ({ projects: dashboardProjects.ledger?.projects ?? [], registeredRepos: globalRepoEntries, onOpenPluginTerminal: handleOpenPluginTerminal }), [dashboardProjects.ledger, globalRepoEntries, handleOpenPluginTerminal]);

  // Failed spawns must be VISIBLE, not ring-buffer-only — a swallowed failure
  // IS "the New session button does nothing" (report D3YPBP rounds 1-3, still
  // undiagnosable on the reporter's machine because the error text never left
  // console.error). The toast carries the real message so a screenshot is a
  // diagnosis.
  const [spawnErrorMessage, setSpawnErrorMessage] = useState<string | null>(null);
  const reportSpawnFailure = useCallback((kind: string, error: unknown) => {
    console.error(`[workspace-spawn] ${kind} spawn failed:`, error);
    const detail = error instanceof Error ? error.message : String(error);
    // Field telemetry for the silent-failure class (D3YPBP): the toast tells
    // the operator, this tells US how often it happens across installs.
    captureAnomaly('workspace-spawn failed', { kind, detail });
    recordSpawnEvent(`${kind}:error ${detail}`);
    setSpawnErrorMessage(`New ${kind} session failed: ${detail}`);
  }, []);

  useEffect(() => {
    const handleFocusRepoWorkspace = (event: Event) => {
      handleRepoWorkspaceFocusEvent(event, {
        repoEntries: globalRepoEntries,
        handleAlignToRepo,
        handleOpenO8Panel,
        setActiveTileId,
        setActiveWorkspace,
        waitForWorkspaceTerminalTarget,
        workspaceTerminalHandlesRef,
        flashWorkspaceTab,
        reportSpawnFailure,
      });
    };

    window.addEventListener(FOCUS_REPO_WORKSPACE_TAB_EVENT, handleFocusRepoWorkspace);
    return () => window.removeEventListener(FOCUS_REPO_WORKSPACE_TAB_EVENT, handleFocusRepoWorkspace);
  }, [flashWorkspaceTab, globalRepoEntries, handleAlignToRepo, handleOpenO8Panel, reportSpawnFailure, setActiveTileId, setActiveWorkspace, waitForWorkspaceTerminalTarget, workspaceTerminalHandlesRef]);

  const handleCreateWorkspaceOrchestrator = useCallback((repo?: { name: string; localPath: string; remoteUrl?: string; branch?: string | null } | null) => {
    void (async () => {
      recordSpawnEvent(`orchestrator:requested activeTile=${activeTileId ?? 'none'}`);
      try {
        const primaryHandle = workspaceTerminalHandlesRef.current.get('tile-root');
        const target = primaryHandle
          ? { tileId: 'tile-root', handle: primaryHandle }
          : await waitForWorkspaceTerminalTarget({ preferredTileId: 'tile-root', fallbackToAnyExisting: true, activate: false });
        if (findTile(tileLayout.root, target.tileId)) setActiveTileId(target.tileId);
        const tabId = target.handle.openOrchestratorTab(repo ?? undefined);
        recordSpawnEvent(`orchestrator:done tile=${target.tileId} tab=${tabId}`);
        flashWorkspaceTab(tabId);
      } catch (error) {
        reportSpawnFailure('orchestrator', error);
      }
    })();
  }, [activeTileId, flashWorkspaceTab, reportSpawnFailure, setActiveTileId, tileLayout.root, waitForWorkspaceTerminalTarget, workspaceTerminalHandlesRef]);

  const onboardingTargetRef = useRef<{ projectId: string; tileId: string; tabId: string; text: string } | null>(null);
  const handleOnboardingComplete = useMemo(() => createOnboardingCompletionHandler({
    loadRegisteredRepos, handleSelectRegisteredRepo, waitForWorkspaceTerminalTarget,
    onboardingTargetRef, setActiveTileId, flashWorkspaceTab, handleSetupComplete,
  }), [flashWorkspaceTab, handleSelectRegisteredRepo, handleSetupComplete, loadRegisteredRepos, setActiveTileId, waitForWorkspaceTerminalTarget]);

  const handleCreateWorkspaceChat = useCallback(() => {
    void (async () => {
      recordSpawnEvent(`chat:requested activeTile=${activeTileId ?? 'none'}`);
      try {
        const primaryHandle = workspaceTerminalHandlesRef.current.get('tile-root');
        const target = primaryHandle
          ? { tileId: 'tile-root', handle: primaryHandle }
          : await waitForWorkspaceTerminalTarget({ repoPath: workspaceTerminalPreferredRepo?.localPath ?? null, preferredTileId: 'tile-root', fallbackToAnyExisting: true, activate: false });
        if (findTile(tileLayout.root, target.tileId)) setActiveTileId(target.tileId);
        const tabId = target.handle.openLlmChatSession({
          repo: workspaceTerminalPreferredRepo ?? undefined,
          label: 'Chat',
          createNew: true,
        });
        recordSpawnEvent(`chat:done tile=${target.tileId} tab=${tabId}`);
        flashWorkspaceTab(tabId);
      } catch (error) {
        reportSpawnFailure('chat', error);
      }
    })();
  }, [activeTileId, flashWorkspaceTab, reportSpawnFailure, setActiveTileId, tileLayout.root, waitForWorkspaceTerminalTarget, workspaceTerminalHandlesRef, workspaceTerminalPreferredRepo]);

  const handleCreateWorkspaceTerminal = useCallback(() => {
    void (async () => {
      recordSpawnEvent(`terminal:requested activeTile=${activeTileId ?? 'none'}`);
      try {
        const primaryHandle = workspaceTerminalHandlesRef.current.get('tile-root');
        const target = primaryHandle
          ? { tileId: 'tile-root', handle: primaryHandle }
          : await waitForWorkspaceTerminalTarget({ repoPath: workspaceTerminalPreferredRepo?.localPath ?? null, preferredTileId: 'tile-root', fallbackToAnyExisting: true, activate: false });
        if (findTile(tileLayout.root, target.tileId)) setActiveTileId(target.tileId);
        const tabId = target.handle.openTerminalTab(workspaceTerminalPreferredRepo ?? undefined);
        recordSpawnEvent(`terminal:done tile=${target.tileId} tab=${tabId}`);
        flashWorkspaceTab(tabId);
      } catch (error) {
        reportSpawnFailure('terminal', error);
      }
    })();
  }, [activeTileId, flashWorkspaceTab, reportSpawnFailure, setActiveTileId, tileLayout.root, waitForWorkspaceTerminalTarget, workspaceTerminalHandlesRef, workspaceTerminalPreferredRepo]);

  const handleSelectIssue = useCallback((issueNumber: number, repo?: string) => {
    setRightPanelKind('review');
    openRightPanelFromUser();
    openCanvasTab({
      id: `issue:${issueNumber}${repo ? `:${repo}` : ''}`,
      kind: 'issue',
      label: `#${issueNumber}`,
      resourceId: String(issueNumber),
      meta: repo ? { repo } : undefined,
    });
  }, [openCanvasTab, openRightPanelFromUser]);

  useVisualizationWorkspaceEvents(openCanvasTab);

  // Stable callbacks passed to CommandPalette — extracted to avoid defeating
  // memo boundaries with fresh inline arrows on every render (#809).
  const handlePaletteOpen = useCallback(() => {
    setCommandPaletteOpen(true);
  }, []);

  // A primary left-nav action (new session, search, select session/repo) should
  // leave the Automations page-takeover — same as the page's back button — so the
  // center returns to the workspace instead of staying stuck on Automations.
  const leaveNavTakeover = useCallback(() => {
    setActiveNavSection('agents');
  }, [setActiveNavSection]);

  const handlePaletteClose = useCallback(() => {
    setCommandPaletteOpen(false);
  }, []);

  const handlePaletteSelectIssue = useCallback((issueNumber: number, repo?: string) => {
    handleSelectIssue(issueNumber, repo);
  }, [handleSelectIssue]);

  const handlePaletteSelectFile = usePaletteFileSelection(activeWorkspace, openCanvasTab);

  const handlePaletteSelectAgent = useCallback((sessionKey: string) => {
    handleSelectSession(sessionKey);
  }, [handleSelectSession]);

  const handlePaletteSelectPacket = useCallback((
    packetId?: string,
    laneId?: string,
    sessionKey?: string,
    title?: string,
  ) => {
    const packet = thoughtsMissionStateRef.current.packets.find((candidate) => (
      (packetId && candidate.id === packetId)
      || (laneId && candidate.lane?.laneId === laneId)
      || (sessionKey && candidate.lane?.sessionKey === sessionKey)
    ));
    if (packet) {
      focusOrchestrationPacketLane(packet);
      return;
    }
    void (async () => {
      const resolved = await resolveFocusableLaneBinding({
        laneId: laneId ?? '',
        packetId: packetId ?? '',
        sessionKey: sessionKey ?? '',
        runtime: runtimeFromSessionKeyId(sessionKey) ?? 'codex',
      });
      if (resolved?.sessionKey) {
        handleSelectSession(resolved.sessionKey, {
          ...(title ? { title } : {}),
          runtime: resolved.runtime,
          repoPath: resolved.repoPath,
        });
      } else if (sessionKey) {
        handleSelectSession(sessionKey, title ? { title } : undefined);
      }
    })();
  }, [focusOrchestrationPacketLane, handleSelectSession]);

  const handlePaletteSelectDirective = useCallback((_directiveId: string) => {
    openWorkspaceUtility('customize');
  }, [openWorkspaceUtility]);

  // Opens a file path. Shared by (a) agent-chat file clicks routed through
  // O8Panel's `o8:open-file` → onOpenFile, and (b) Finder "Open With → o8"
  // (FileOpenBridge). Surface-aware (Q ruling 2026-07-11): open the file where
  // you're already working. If you're on the CANVAS side (the center is showing a
  // canvas) open it there; otherwise you're on the default IDE side, so open it
  // in the right-panel Files view instead of hijacking you into a canvas tab.
  const handleOpenFileInWorkspace = useCallback((filePath: string) => {
    const path = filePath.trim();
    if (!path) return;

    const onCanvasSide = activeWorkspaceTabKind === 'canvas' || activeWorkspaceTabKind === 'fleet-canvas';
    if (!onCanvasSide) {
      // Default IDE side → surface the file in the right-panel Files view.
      setRightPanelKind('o8');
      openRightPanelFromUser();
      setO8ActiveTab('files');
      // The Files viewer wants a repo-relative path (absolute paths are
      // allowlist-gated). Resolve the registered repo that contains this file,
      // point the panel at it, and select the file relative to it.
      const containingRepo = globalRepoEntries.find((entry) => entry.localPath
        && (path === entry.localPath || path.startsWith(`${entry.localPath}/`)));
      if (containingRepo?.localPath) {
        const relative = path.slice(containingRepo.localPath.length + 1) || path;
        setO8RepoPathOverride(containingRepo.localPath);
        setO8SelectedFile(relative);
        setO8SelectedFileRepoPath(containingRepo.localPath);
      } else {
        // Not inside a known repo — hand the absolute path through as-is.
        handleO8SelectedFileChange(path);
      }
      return;
    }

    // Canvas side → open the file as a canvas/inspector tab (prior behavior).
    // Prefers a live WorkspaceTerminal target; falls back to a center canvas tab
    // when none is ready yet (target resolves after hydration).
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    const kind = (WORKSPACE_IMAGE_EXTENSIONS.has(ext) ? 'image' : 'file') as 'image' | 'file';
    const tab = { id: `${kind}:${path}`, kind, label: path.split('/').pop() ?? path, resourceId: path };
    void (async () => {
      const target = await waitForWorkspaceTerminalTarget({});
      if (target) target.handle.openInspectorTab(tab);
      else openCanvasTab(tab);
    })();
  }, [activeWorkspaceTabKind, setRightPanelKind, openRightPanelFromUser, setO8ActiveTab, handleO8SelectedFileChange, globalRepoEntries, setO8RepoPathOverride, openCanvasTab, waitForWorkspaceTerminalTarget]);

  // Dashboard-level o8:open-file listener. O8Panel carries its own, but it
  // unmounts under a page takeover (Customize/Automations/Settings) — a file
  // opened FROM one of those surfaces would race the workspace remount and
  // silently drop. This listener is always mounted; the handler's state sets
  // are idempotent when O8Panel's copy also fires.
  useEffect(() => {
    const handler = (event: Event) => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path;
      if (typeof path === 'string' && path) handleOpenFileInWorkspace(path);
    };
    window.addEventListener('o8:open-file', handler);
    return () => window.removeEventListener('o8:open-file', handler);
  }, [handleOpenFileInWorkspace]);

  const handleSelectPR = useCallback((prNumber: number, repo?: string) => {
    setRightPanelKind('review');
    openRightPanelFromUser();
    openCanvasTab({
      id: `pr:${prNumber}${repo ? `:${repo}` : ''}`,
      kind: 'pr',
      label: `PR #${prNumber}`,
      resourceId: String(prNumber),
      meta: repo ? { repo } : undefined,
    });
  }, [openCanvasTab, openRightPanelFromUser]);

  const handleReviewPR = useCallback((prNumber: number, repo?: string, repoPath?: string) => {
    if (repoPath) setO8RepoPathOverride(repoPath);
    if (prNumber > 0) rememberRightPr(prNumber, repo, repoPath || currentO8RepoPath);
    if (prNumber > 0) window.dispatchEvent(new CustomEvent('o8:pr-selected', { detail: { prNumber, repo, repoPath: repoPath || currentO8RepoPath } }));
    setO8CommitSha(null);
    setO8CommitRepoPath(null);
    setO8CommitRepoSlug(null);
    setO8ActiveTab('activity');
    setO8PrNumber(prNumber || null);
    setO8PrRepo(repo ?? null);
    setRightPanelKind('o8');
    openRightPanelFromUser();
  }, [currentO8RepoPath, openRightPanelFromUser, rememberRightPr]);

  const handleRightPrTabSelect = useCallback((tab: RightPrTab) => {
    handleReviewPR(tab.number, tab.repo || undefined, tab.repoPath || undefined);
  }, [handleReviewPR]);
  const handleRightPrTabClose = useCallback((tab: RightPrTab) => {
    const index = rightPrTabs.findIndex((entry) => entry.id === tab.id);
    forgetRightPr(tab.id);
    if (o8PrNumber === tab.number && rightPrTabId(o8PrNumber, o8PrRepo, currentO8RepoPath) === tab.id) {
      const remaining = rightPrTabs.filter((entry) => entry.id !== tab.id);
      const next = remaining[Math.min(index, remaining.length - 1)];
      if (next) handleRightPrTabSelect(next);
      else { setO8PrNumber(null); setO8PrRepo(null); }
    }
  }, [currentO8RepoPath, forgetRightPr, handleRightPrTabSelect, o8PrNumber, o8PrRepo, rightPrTabs]);
  const handleCloseRightPr = useCallback((number: number, repo?: string | null) => {
    const tab = rightPrTabs.find((entry) => entry.id === rightPrTabId(number, repo, currentO8RepoPath));
    if (tab) handleRightPrTabClose(tab);
    else { setO8PrNumber(null); setO8PrRepo(null); }
  }, [currentO8RepoPath, handleRightPrTabClose, rightPrTabs]);
  const handleHeaderPanelTabChange = useCallback((tab: O8Tab) => {
    if (tab === 'activity') { setO8PrNumber(null); setO8PrRepo(null); }
    handlePrimaryPanelTabChange(tab);
  }, [handlePrimaryPanelTabChange]);

  const handleDeepReviewPR = useCallback((prNumber: number, repo?: string) => {
    handleSelectPR(prNumber, repo);
    handleReviewPR(prNumber, repo);
  }, [handleReviewPR, handleSelectPR]);

  // Bridge for transcript PR-link clicks. LLMMarkdown intercepts GitHub
  // PR URLs and dispatches `o8:open-pr` instead of opening the browser;
  // the listener routes through handleReviewPR so the right panel opens
  // Activity with the inline PrPanel detail.
  useEffect(() => {
    const handleOpenPr = (event: Event) => {
      const detail = (event as CustomEvent<{ prNumber?: number; repo?: string; repoPath?: string }>).detail;
      if (!detail || typeof detail.prNumber !== 'number') return;
      handleReviewPR(detail.prNumber, detail.repo, detail.repoPath);
    };
    window.addEventListener('o8:open-pr', handleOpenPr);
    return () => { window.removeEventListener('o8:open-pr', handleOpenPr); };
  }, [handleReviewPR]);

  // Bridge for "Needs attention" clicks on a repo card. The status pill
  // dispatches `o8:resolve-blocker` with the repo + explanation. We
  // focus the affected repo and inject a draft into the orchestrator
  // chat composer so the user can ask the agent for help. Does NOT
  // auto-send — user reviews + presses send.
  useEffect(() => {
    const handleResolveBlocker = (event: Event) => {
      const detail = (event as CustomEvent<{
        repoPath?: string;
        repoName?: string;
        explanation?: string;
        statusLabel?: string;
      }>).detail;
      if (!detail?.repoPath) return;
      // Focus this repo as the active workspace.
      setActiveWorkspace(detail.repoPath);
      // Compose a draft message — short and direct.
      const repoLabel = detail.repoName ?? detail.repoPath.split('/').pop() ?? 'this repo';
      const issue = (detail.explanation ?? detail.statusLabel ?? 'has an unspecified blocker').trim();
      const draftText = `\`${repoLabel}\` needs attention: ${issue}\n\nHelp me resolve this — read the repo, figure out what's missing or misconfigured, and propose a concrete fix.`;
      setThoughtsDraftInjection({
        id: `blocker-${Date.now()}`,
        text: draftText,
      });
    };
    window.addEventListener('o8:resolve-blocker', handleResolveBlocker);
    return () => { window.removeEventListener('o8:resolve-blocker', handleResolveBlocker); };
  }, [setActiveWorkspace, setThoughtsDraftInjection]);

  // Right-clicking an inline image in o8.md → "Add to chat" dispatches
  // `o8:attach-image` with the asset URL. Fetch it here (single, always-mounted
  // listener — avoids multi-firing across the visibility:hidden chat tabs), encode
  // as a data URI, and stash it as an image injection the visible chat composer
  // consumes once.
  useEffect(() => {
    const handleAttachImage = (event: Event) => {
      const detail = (event as CustomEvent<{ url?: string; name?: string }>).detail;
      if (!detail?.url) return;
      const url = detail.url;
      const name = detail.name || 'image';
      void (async () => {
        try {
          const res = await fetch(url);
          if (!res.ok) return;
          const blob = await res.blob();
          const dataUri = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
          setThoughtsImageInjection({
            id: `img-${Date.now()}`,
            dataUri,
            name,
            mimeType: blob.type || 'image/png',
          });
        } catch { /* transient — ignore */ }
      })();
    };
    window.addEventListener('o8:attach-image', handleAttachImage);
    return () => window.removeEventListener('o8:attach-image', handleAttachImage);
  }, [setThoughtsImageInjection]);

  const handleImageInjectionConsumed = useCallback(() => {
    setThoughtsImageInjection(null);
  }, [setThoughtsImageInjection]);

  const handleExpandWorkspace = useCallback((workspace: string, repo: string | null) => {
    setActiveWorkspace(workspace);
    // Only open README tab if workspace actually has a README
    fetch(`/api/panel/readme?workspace=${encodeURIComponent(workspace)}`)
      .then(res => res.json())
      .then(data => {
        if (data.content) {
          openCanvasTab({
            id: `readme:${workspace}`,
            kind: 'readme',
            label: 'README',
            resourceId: workspace,
            meta: repo ? { repo } : undefined,
          });
        }
      })
      .catch(() => { /* no README, skip */ });
  }, [openCanvasTab, setActiveWorkspace]);

  const handleOpenGitLog = useCallback((_workspace?: string) => {
    /* git-log surface deferred — was wired to dead WorkspaceSidePanel */
  }, []);

  const handleOpenAuditLog = useCallback(() => {
    const tab: CanvasTab = {
      id: 'audit-log:approvals',
      kind: 'audit-log',
      label: 'Audit Log',
      resourceId: 'approvals',
    };
    void (async () => {
      const workspaceTarget = await waitForWorkspaceTerminalTarget({});
      if (workspaceTarget) {
        workspaceTarget.handle.openInspectorTab(tab);
        return;
      }
      openCanvasTab(tab);
    })();
  }, [openCanvasTab, waitForWorkspaceTerminalTarget]);

  const openApprovalsDiscoverySurface = useCallback(() => {
    handleOpenInbox();
  }, [handleOpenInbox]);

  const handleToggleChatPanel = useCallback(() => {
    // v1: chat panel removed — toggle workspace instead
    if (chatVisible) {
      closeRightPanelFromUser();
      return;
    }
    openRightPanelFromUser();
  }, [chatVisible, closeRightPanelFromUser, openRightPanelFromUser]);

  const handleToggleO8Panel = useCallback(() => {
    if (chatVisible && rightPanelKind === 'o8') {
      // o8 → collapsed. Keep kind=o8 so next click re-opens straight to O8
      // (not the workspace side panel). Clear commit context so reopening
      // doesn't re-expand a stale commit detail.
      closeRightPanelFromUser();
      setO8CommitSha(null);
      setO8CommitRepoPath(null);
      setO8CommitRepoSlug(null);
      return;
    }
    setRightPanelKind('o8');
    openRightPanelFromUser();
  }, [chatVisible, closeRightPanelFromUser, openRightPanelFromUser, rightPanelKind]);

  // Reveal Browser and carry the requested URL into its repository scope.
  const handleOpenBrowser = useCallback((url?: string) => {
    if (typeof url === 'string' && url) setO8BrowserUrl(url);
    setRightPanelKind('o8');
    openRightPanelFromUser();
    setO8ActiveTab('browser');
  }, [openRightPanelFromUser]);
  useBrowserOpenRequests(handleOpenBrowser, o8AllRepos ? 'right-panel:all-repos' : `right-panel:${currentO8RepoPath ?? 'default'}`);

  const handleSelectWorkspaceChatTarget = useCallback((sessionKey: string) => {
    setWorkspaceChatTargetKeyByRepoPath((current) => {
      if (current[workspaceChatTargetRepoPath] === sessionKey) {
        return current;
      }
      return {
        ...current,
        [workspaceChatTargetRepoPath]: sessionKey,
      };
    });
  }, [workspaceChatTargetRepoPath]);

  const handlePreviewSelection = useCallback((selection: PreviewSelectionPayload) => {
    const payload: AgentPanelChatInjectionPayload = {
      reason: 'preview',
      text: formatPreviewSelectionContext(selection),
    };
    openRightPanelFromUser();
    setRightPanelMode('chat');
    setDesktopDraftInjection({
      id: `${payload.reason}-${Date.now()}`,
      text: payload.text,
    });
  }, [openRightPanelFromUser, setDesktopDraftInjection]);

  const handleDesignModeGrab = useCallback((grabbed: GrabbedElement) => {
    setGrabbedElement(grabbed);
  }, []);

  // Stage 4b — a click-to-grab inside the NATIVE browser-view window can't reach
  // the DesignModeOverlay (it's a separate OS window), so NativeBrowserSurface
  // grabs in-page and dispatches the result here. Route it to the same handler +
  // exit Design Mode (the overlay's own onClose never fired for that click).
  const designModeClose = designMode.close;
  useEffect(() => {
    const onResult = (event: Event) => {
      const grabbed = (event as CustomEvent<{ grabbed?: GrabbedElement }>).detail?.grabbed;
      if (grabbed) {
        handleDesignModeGrab(grabbed);
        designModeClose();
      }
    };
    window.addEventListener('o8:design-grab-result', onResult);
    return () => window.removeEventListener('o8:design-grab-result', onResult);
  }, [handleDesignModeGrab, designModeClose]);

  // The grab result card opens over the native browser-view window (an always-on-
  // top OS window that would otherwise hide it). Tell NativeBrowserSurface to hide
  // the native window while the card is open, and restore it on close.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('o8:native-browser-occlude', { detail: { occlude: grabbedElement != null } }));
  }, [grabbedElement]);

  // #746 — Auto-directive proposer Accept callback. Re-uses the same draft
  // injection pipeline as design-mode capture so the orchestrator chat
  // composer pre-fills with the proposed directive text.
  const handleAcceptDirectiveProposal = useCallback((draft: { id: string; text: string }) => {
    setThoughtsDraftInjection(draft);
  }, [setThoughtsDraftInjection]);

  // Request-changes from a rejected packet's banner HANDS THE PACKET TO THE
  // ORCHESTRATOR (Q ruling 2026-07-11): a declined packet's recovery is a
  // decision (rebase / re-dispatch / fix directly / drop), not a blind worker
  // re-run — so it belongs with the one brain that owns recovery. We focus the
  // orchestrator tab and pre-fill its composer with the reason + operator note,
  // ready for the operator to review and send.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as { text?: string } | undefined;
      const text = detail?.text?.trim();
      if (!text) return;
      for (const handle of workspaceTerminalHandlesRef.current.values()) {
        const snap = handle.getTabsSnapshot();
        const orchTab = snap.tabs.find((tab) => tab.kind === 'orchestrator');
        if (orchTab) {
          handle.focusTab(orchTab.id);
          window.dispatchEvent(new CustomEvent('o8:tab-focus-flash', { detail: { tabId: orchTab.id } }));
          break;
        }
      }
      setThoughtsDraftInjection({ id: `req-changes-${Date.now()}`, text });
    };
    window.addEventListener('o8:orchestrator-inject', handler as EventListener);
    return () => window.removeEventListener('o8:orchestrator-inject', handler as EventListener);
  }, [setThoughtsDraftInjection, workspaceTerminalHandlesRef]);

  const injectPayloadIntoRepoChat = useCallback((payload: AgentPanelChatInjectionPayload, repoOverride?: WorkspaceSidePanelRepo | null) => {
    const nextInjection = {
      id: `${payload.reason}-${Date.now()}`,
      text: payload.text,
      previewImageDataUri: payload.previewImageDataUri,
    };
    // Previously this short-circuited into the thoughts tile draft; that tile
    // no longer exists, so we always route injections through the workspace
    // terminal target path below.
    void (async () => {
      const targetRepo = repoOverride?.localPath ? repoOverride : (globalRepoEntry
        ? {
            name: globalRepoEntry.name,
            localPath: globalRepoEntry.localPath,
            branch: globalRepoEntry.readiness?.currentBranch ?? globalRepoBranch,
            readiness: globalRepoEntry.readiness ?? null,
            remoteUrl: globalRepoEntry.remoteUrl ?? undefined,
          }
        : null);
      const targetRepoPath = targetRepo?.localPath ?? '__global__';
      if (payload.reason === 'design-draw') {
        try {
          const preferredThreadId = activeSessionKey?.startsWith('llm-chat:')
            ? activeSessionKey.slice('llm-chat:'.length)
            : null;
          const loadedTarget = targetRepo?.localPath
            ? selectRepoOrchestratorConversation(
                Array.from(workspaceTerminalHandlesRef.current.entries()).map(([tileId, handle]) => ({
                  tileId,
                  ...handle.getTabsSnapshot(),
                })),
                targetRepo.localPath,
                preferredThreadId,
              )
            : null;
          const workspaceTarget = loadedTarget
            ? {
                tileId: loadedTarget.tileId,
                handle: workspaceTerminalHandlesRef.current.get(loadedTarget.tileId),
              }
            : await waitForWorkspaceTerminalTarget({
                repoPath: targetRepo?.localPath ?? null,
                activate: false,
              });
          if (!workspaceTarget.handle) {
            throw new Error('The selected orchestrator workspace is no longer mounted.');
          }
          const tabId = loadedTarget?.tabId
            ?? workspaceTarget.handle.openOrchestratorTab(targetRepo ?? undefined);
          if (!workspaceTarget.handle.injectIntoOrchestrator(tabId, payload.text, {
            previewImageDataUri: payload.previewImageDataUri,
          })) {
            throw new Error('The orchestrator conversation could not accept the design turn.');
          }
        } catch (error) {
          console.error('[design-draw] orchestrator injection failed:', error);
        }
        return;
      }
      const preferredChatTargetKey = workspaceChatTargetKeyByRepoPath[targetRepoPath]
        ?? (workspaceChatTargets.some((target) => target.sessionKey === activeWorkspaceChatSessionKey)
          ? activeWorkspaceChatSessionKey
          : workspaceChatTargets[0]?.sessionKey)
        ?? undefined;
      const workspaceTarget = await waitForWorkspaceTerminalTarget({
        repoPath: targetRepo?.localPath ?? null,
      });
      if (workspaceTarget) {
        setActiveTileId(workspaceTarget.tileId);
        if (targetRepo?.localPath) {
          setActiveWorkspace(targetRepo.localPath);
        }
        workspaceTarget.handle.injectIntoCliChat(payload.text, {
          repo: targetRepo ?? undefined,
          draftReason: payload.reason,
          previewImageDataUri: payload.previewImageDataUri,
          targetSessionKey: preferredChatTargetKey,
        });
        return;
      }
      openRightPanelFromUser();
      setRightPanelMode('chat');
      setDesktopDraftInjection(nextInjection);
    })();
  }, [activeSessionKey, activeWorkspaceChatSessionKey, globalRepoBranch, globalRepoEntry, openRightPanelFromUser, setActiveWorkspace, setDesktopDraftInjection, waitForWorkspaceTerminalTarget, workspaceChatTargetKeyByRepoPath, workspaceChatTargets, workspaceTerminalHandlesRef]);

  const handleAgentPanelChatInjection = useCallback((payload: AgentPanelChatInjectionPayload) => {
    injectPayloadIntoRepoChat(payload, null);
  }, [injectPayloadIntoRepoChat]);

  // ── Native Design Mode draw → repo chat ──
  // The in-page draw layer (native browser pages stay LIVE while the operator
  // draws) submits through NativeBrowserSurface, which captures the live
  // window AT SEND (Q ruling 2026-07-12) and dispatches this event. Persist
  // the screenshot, then inject prompt + region + sampled elements + shot
  // path — same shape as the iframe path's onDrawPrompt below.
  const closeDesignMode = designMode.close;
  useEffect(() => {
    const onNativeDraw = (event: Event) => {
      const detail = (event as CustomEvent<{
        text?: string;
        rect?: { left: number; top: number; width: number; height: number };
        elements?: Array<{ selector: string; tag: string; text: string; component?: string | null }>;
        viewport?: { width: number; height: number } | null;
        screenshotBase64?: string | null;
      }>).detail;
      const text = detail?.text?.trim();
      if (!text) return;
      const finish = (shotPath: string | null, cropPath: string | null, cropBase64: string | null) => {
        const rect = detail?.rect;
        const region = rect
          ? `${Math.round(rect.width)}×${Math.round(rect.height)} region at (${Math.round(rect.left)}, ${Math.round(rect.top)})`
          : 'drawn region';
        const elements = detail?.elements?.length
          ? `\nElements under the drawing:\n${detail.elements.map(formatDrawElement).join('\n')}`
          : '';
        const shot = shotPath ? `\nScreenshot (full page): ${shotPath}` : '';
        const crop = cropPath ? `\nScreenshot (drawn region crop): ${cropPath}` : '';
        injectPayloadIntoRepoChat({
          reason: 'design-draw',
          text: `${text}\n\n[Design Mode drawing — ${region}]${elements}${shot}${crop}`,
          previewImageDataUri: cropBase64 ? `data:image/png;base64,${cropBase64}` : undefined,
        }, null);
        closeDesignMode();
      };
      const screenshot = detail?.screenshotBase64;
      if (screenshot) {
        const ts = Date.now();
        const persist = (base64: string, variant: 'full' | 'crop'): Promise<string | null> =>
          fetch('/api/panel/design-shot', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ screenshotBase64: base64, variant, ts }),
          })
            .then((res) => (res.ok ? res.json() : null))
            .then((data: { path?: string } | null) => data?.path ?? null)
            .catch(() => null);
        // Full page always; the crop of the stroke bounds when we have a rect.
        const cropPromise = detail?.rect
          ? cropRegionBase64(screenshot, detail.rect, detail.viewport ?? null, { pad: 8 })
              .then(async (cropB64) => ({
                cropBase64: cropB64,
                cropPath: cropB64 ? await persist(cropB64, 'crop') : null,
              }))
          : Promise.resolve({ cropBase64: null, cropPath: null });
        void Promise.all([persist(screenshot, 'full'), cropPromise])
          .then(([shotPath, cropResult]) => finish(shotPath, cropResult.cropPath, cropResult.cropBase64))
          .catch(() => finish(null, null, null));
      } else {
        finish(null, null, null);
      }
    };
    window.addEventListener('o8:design-draw-native', onNativeDraw);
    return () => window.removeEventListener('o8:design-draw-native', onNativeDraw);
  }, [injectPayloadIntoRepoChat, closeDesignMode]);

  // ── Feed agent data to alert engine + search ──
  const handleAgentsUpdate = useCallback((agents: unknown[]) => {
    // AgentDetail from AgentPanel is compatible with AgentSummary for alert detection
    // (has id, name, status, context, approvalStatus, lastEventAt, sessionKey)
    updateAgents(agents as import('@/lib/fleet/types').AgentSummary[]);
    setAgentsJson(JSON.stringify(agents));
  }, [setAgentsJson, updateAgents]);

  // ── Run command in bottom terminal ──
  const handleRunInTerminal = useCallback((command: string) => {
    const tileId = ensureTileKind('contextual-panel', {
      direction: 'horizontal',
      preferredKinds: ['terminal', 'contextual-panel', 'preview'],
      ratio: 0.68,
    });
    const runCommand = (attempt = 0) => {
      const handle = getPreferredContextualPanelHandle(tileId);
      if (handle) {
        handle.runCommand(command);
        return;
      }
      if (attempt < 8) {
        window.setTimeout(() => runCommand(attempt + 1), 50);
      }
    };
    runCommand();
  }, [ensureTileKind, getPreferredContextualPanelHandle]);

  // ── Alert action: navigate to agent session ──
  const handleAlertAction = useCallback((alert: import('@/lib/alerts/types').Alert) => {
    if (alert.sessionKey) {
      setActiveSessionKey(alert.sessionKey);
    }
  }, [setActiveSessionKey]);

  const handleOpenDeploy = useCallback((project?: string) => {
    openCanvasTab({
      id: `deploy:${project ?? 'all'}`,
      kind: 'deploy',
      label: 'Deploys',
      resourceId: project ?? '',
      meta: project ? { project } : undefined,
    });
  }, [openCanvasTab]);

  const handleOpenCI = useCallback((repo: string) => {
    // CI surface lives on the O8 panel's Activity tab now (filter pill for CI runs).
    setO8ActiveTab('activity');
    setO8PrRepo(repo ?? null);
    setRightPanelKind('o8');
    openRightPanelFromUser();
  }, [openRightPanelFromUser]);

  const handleCreateIssue = useCallback((repo?: string) => {
    openCanvasTab({
      id: `new-issue:${repo ?? 'default'}:${Date.now()}`,
      kind: 'new-issue',
      label: 'New Issue',
      resourceId: 'new',
      meta: repo ? { repo } : undefined,
    });
  }, [openCanvasTab]);

  const handleLaunchWorkspaceAgent = useCallback(async (request: {
    repoPath: string;
    runtime?: OrchestratorRuntime;
    modelId?: string;
    initialText?: string;
    autoSend?: boolean;
    createNew?: boolean;
    label?: string;
    targetSessionKey?: string;
    supervisorStatus?: string | null;
    autoArchiveOnIdle?: boolean;
    /** Agent-originated (Symon / supervisor auto-open): surface the worker
     *  quietly — no active-tab switch, no global repo-scope flip. */
    background?: boolean;
  }) => {
    const repos = globalRepoEntries.length > 0 ? globalRepoEntries : await loadRegisteredRepos();
    const repoEntry = repos.find((repo) => repo.localPath === request.repoPath);

    if (!repoEntry) {
      throw new Error(`No local checkout is registered for ${request.repoPath}. Open the repo locally before launching work there.`);
    }

    if (!request.background) {
      setGlobalRepoId(repoEntry.id);
      setGlobalRepoBranch(repoEntry.defaultBranch || 'main');
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('cortex-global-repo-id', repoEntry.id);
      }
    }

    void fetch('/api/panel/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'touch', id: repoEntry.id }),
    }).catch(() => null);

    const workspaceTarget = await waitForWorkspaceTerminalTarget({
      repoPath: repoEntry.localPath,
    });
    if (!workspaceTarget) {
      throw new Error('No workspace terminal is available to launch the CLI session.');
    }

    // If this auto-spawn corresponds to a packet that was dispatched via
    // MCP (or any non-UI path), look it up in the mission state and attach
    // the orchestrationPacket badge + mark the tab as the latest dispatch
    // so the workspace tab card and the orange tab highlight render
    // identically to UI-launched packets.
    const matchingPacket = request.targetSessionKey
      ? thoughtsMissionStateRef.current.packets.find((p) => p.lane?.sessionKey === request.targetSessionKey) ?? null
      : null;
    const orchestrationPacket = matchingPacket
      ? buildOrchestrationPacketBadge({ ...matchingPacket, status: matchingPacket.status === 'draft' ? 'running' : matchingPacket.status })
      : undefined;

    const tabId = workspaceTarget.handle.openCliChatSession({
      runtime: request.runtime,
      repo: {
        name: repoEntry.name,
        localPath: repoEntry.localPath,
        branch: repoEntry.readiness?.currentBranch ?? repoEntry.defaultBranch,
        readiness: repoEntry.readiness ?? null,
        remoteUrl: repoEntry.remoteUrl ?? undefined,
      },
      modelId: request.modelId,
      initialText: request.initialText,
      autoSend: request.autoSend,
      createNew: request.createNew ?? true,
      label: request.label,
      targetSessionKey: request.targetSessionKey,
      supervisorStatus: request.supervisorStatus,
      autoArchiveOnIdle: request.autoArchiveOnIdle,
      orchestrationPacket,
      background: request.background,
    });
    enqueueFtuxMilestone('firstAgentSpawned');

    if (orchestrationPacket && tabId) {
      setLatestDispatchedTabId(tabId);
      setLatestDispatchedAt(Date.now());
    }
  }, [enqueueFtuxMilestone, globalRepoEntries, loadRegisteredRepos, setGlobalRepoBranch, setGlobalRepoId, waitForWorkspaceTerminalTarget]);

  // ── Auto-open workspace tab when orchestrator launches a Codex agent ──
  const openedSupervisorAgentsRef = useRef(new Set<string>());
  useEffect(() => {
    const handleSupervisorUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{
        surfaceId?: string;
        name?: string;
        status?: string;
        repoPath?: string;
        launchContext?: import('@/lib/orchestrator/types').WorkerLaunchContext;
      }>).detail;
      if (!detail?.surfaceId || !detail.status) return;

      if (detail.status !== 'launched') {
        updateSupervisorWorkspaceTab(detail.surfaceId, detail.status, detail.name);
        return;
      }
      if (updateSupervisorWorkspaceTab(detail.surfaceId, detail.status, detail.name)) {
        openedLaneSessionsCache().add(detail.surfaceId);
        return;
      }
      if (!detail.repoPath) return;
      const packet = thoughtsMissionStateRef.current.packets.find((candidate) => candidate.lane?.sessionKey === detail.surfaceId);
      if (shouldPresentWorkerInSplit(detail.launchContext ?? packet?.launchContext)) return;

      // Deduplicate — only open once per surfaceId
      if (openedSupervisorAgentsRef.current.has(detail.surfaceId)) return;
      openedSupervisorAgentsRef.current.add(detail.surfaceId);
      openedLaneSessionsCache().add(detail.surfaceId);

      void handleLaunchWorkspaceAgent({
        repoPath: detail.repoPath,
        runtime: 'codex',
        label: detail.name ?? 'Codex Agent',
        createNew: true,
        autoSend: false,
        targetSessionKey: detail.surfaceId,
        supervisorStatus: detail.status,
        autoArchiveOnIdle: false,
        // Supervisor launches are agent-originated by definition (Symon
        // dispatch, orchestrator delegate) — the worker tab lands in the
        // rail like any dispatched agent, but the operator's active surface
        // is never hijacked (Q ruling 2026-07-17). Human spawns go through
        // o8:request-spawn-tab / New session, which keep focus.
        background: true,
      }).catch((err) => {
        openedLaneSessionsCache().delete(detail.surfaceId!);
        console.error('[dashboard] Failed to auto-open tab for orchestrator agent:', err);
      });
    };

    window.addEventListener('cortex:agent-supervisor-update', handleSupervisorUpdate);
    return () => window.removeEventListener('cortex:agent-supervisor-update', handleSupervisorUpdate);
  }, [handleLaunchWorkspaceAgent, updateSupervisorWorkspaceTab]);

  const handleLaunchWorkspaceRepoTask = useCallback(async (request: {
    kind: 'issue' | 'pr';
    repo: string;
    number: number;
    title: string;
    body?: string;
    branch?: string;
  }) => {
    const response = await fetch('/api/panel/repos');
    const data = await response.json() as { repos?: RepoRegistryEntry[] };
    const repoEntry = (data.repos ?? []).find((repo) => repoSlugFromRemote(repo.remoteUrl) === request.repo);

    if (!repoEntry) {
      throw new Error(`No local checkout is registered for ${request.repo}. Open the repo locally before launching work there.`);
    }

    setGlobalRepoId(repoEntry.id);
    setGlobalRepoBranch(repoEntry.defaultBranch || 'main');
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('cortex-global-repo-id', repoEntry.id);
    }

    void fetch('/api/panel/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'touch', id: repoEntry.id }),
    }).catch(() => null);

    const workspaceTarget = await waitForWorkspaceTerminalTarget({
      repoPath: repoEntry.localPath,
    });
    if (!workspaceTarget) {
      throw new Error('No workspace terminal is available to launch the CLI session.');
    }

    let currentBranch = repoEntry.defaultBranch || 'main';
    try {
      const branchResponse = await fetch(`/api/panel/branches?path=${encodeURIComponent(repoEntry.localPath)}`);
      const branchData = await branchResponse.json() as { branches?: Array<{ name: string; current: boolean }> };
      const current = (branchData.branches ?? []).find((branch) => branch.current);
      if (current?.name) currentBranch = current.name;
    } catch {
      // keep default branch fallback
    }

    const effectiveBranch = repoEntry.readiness?.currentBranch ?? currentBranch;
    const readinessLines = [
      repoEntry.readiness
        ? `Readiness: ${repoEntry.readiness.label} — ${repoEntry.readiness.summary}`
        : 'Readiness: unknown',
      `Local checkout: ${repoEntry.localPath}`,
      `Current branch: ${effectiveBranch}`,
      `Default branch: ${repoEntry.defaultBranch}`,
      effectiveBranch === repoEntry.defaultBranch
        ? 'You are operating directly on the default branch right now.'
        : `You are not on the default branch; the current local branch is ${effectiveBranch}.`,
      repoEntry.setup.installCommand
        ? `Install command: ${repoEntry.setup.installCommand}${repoEntry.setup.installOnCreateWorkspace ? ' (saved as default setup)' : ''}`
        : 'Install command: none saved',
      repoEntry.setup.buildCommand
        ? `Build command: ${repoEntry.setup.buildCommand}${repoEntry.setup.runBuildOnCreateWorkspace ? ' (saved for bootstrap)' : ''}`
        : 'Build command: none saved',
      repoEntry.setup.devCommand
        ? `Dev command: ${repoEntry.setup.devCommand}${repoEntry.setup.defaultPort ? ` on port ${repoEntry.setup.defaultPort}` : ''}`
        : 'Dev command: none saved',
      repoEntry.setup.envFiles.length > 0
        ? `Env files: ${repoEntry.setup.envFiles.join(', ')} (mode: ${repoEntry.setup.envMode})`
        : 'Env files: none saved',
      repoEntry.readiness?.nextAction
        ? `Next readiness action: ${repoEntry.readiness.nextAction}`
        : null,
    ];

    const prompt = request.kind === 'issue'
      ? [
          `Work on GitHub issue #${request.number} in ${request.repo}: ${request.title}.`,
          'Use this workspace CLI session as the operator surface.',
          'Start by using the issue context included below and inspecting the current local repo state.',
          'Do not rely on `gh issue view`, GitHub GraphQL, or other remote issue fetches unless the provided issue context is clearly missing something critical.',
          'Before coding, establish whether this repo is actually runnable from this checkout using the saved setup/dev commands and the current branch state below.',
          'If the repo is not ready, say exactly what is missing or broken before you implement anything.',
          'Implement the smallest correct fix, validate it with focused checks, and do not claim success unless the relevant path actually works end to end.',
          'If a runtime/dev-server blocker prevents validation, stop and report the blocker explicitly instead of assuming the feature works.',
          `Repo readiness context:\n${readinessLines.join('\n')}`,
          request.body ? `Issue context:\n${request.body}` : null,
        ].filter(Boolean).join('\n\n')
      : [
          `Review GitHub PR #${request.number} in ${request.repo}: ${request.title}.`,
          `Head branch: ${request.branch ?? 'unknown'}.`,
          'Use this workspace CLI session as the review surface.',
          'Before signing off, establish whether this checkout is runnable and note any setup/runtime blockers using the readiness context below.',
          'Read the PR context and changed files, validate the change locally, identify risks or regressions, and state clearly if the branch cannot be verified end to end.',
          `Repo readiness context:\n${readinessLines.join('\n')}`,
        ].join('\n\n');

    const taskLabel = request.kind === 'issue'
      ? `#${request.number} — ${request.title}`
      : `PR #${request.number} — ${request.title}`;

    workspaceTarget.handle.openCliChatSession({
      runtime: undefined,
      repo: {
        name: repoEntry.name,
        localPath: repoEntry.localPath,
        branch: repoEntry.readiness?.currentBranch ?? repoEntry.defaultBranch,
        readiness: repoEntry.readiness ?? null,
        remoteUrl: repoEntry.remoteUrl ?? undefined,
      },
      modelId: undefined,
      initialText: prompt,
      autoSend: true,
      createNew: true,
      label: taskLabel,
    });
    enqueueFtuxMilestone('firstAgentSpawned');
  }, [enqueueFtuxMilestone, setGlobalRepoBranch, setGlobalRepoId, waitForWorkspaceTerminalTarget]);

  const handleSelectFile = useCallback((filePath: string, workspace?: string) => {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'].includes(ext);
    const diffWorkspace = workspace ?? activeWorkspace ?? globalRepoEntry?.localPath ?? null;

    setO8SelectedFile(filePath);
    setO8SelectedFileRepoPath(diffWorkspace);
    if (diffWorkspace) {
      setO8RepoPathOverride(diffWorkspace);
    }
    setO8ActiveTab('workspace');
    setRightPanelKind('o8');
    openRightPanelFromUser();

    openCanvasTab({
      id: `${isImage ? 'image' : 'file'}:${filePath}${workspace ? `:${workspace}` : ''}`,
      kind: isImage ? 'image' : 'file',
      label: filePath.split('/').pop() ?? filePath,
      resourceId: filePath,
      meta: workspace ? { workspace } : undefined,
    });
  }, [activeWorkspace, globalRepoEntry?.localPath, openCanvasTab, openRightPanelFromUser]);

  const handleOpenSpecInWorkspace = useCallback((repoPath: string) => {
    setO8CommitSha(null);
    setO8CommitRepoPath(null);
    setO8CommitRepoSlug(null);
    setO8RepoPathOverride(repoPath);
    setO8ActiveTab('spec');
    setRightPanelKind('o8');
    openRightPanelFromUser();
  }, [openRightPanelFromUser]);

  const handleSelectCommit = useCallback((hash: string, meta?: Record<string, string>) => {
    const nextMeta: Record<string, string> = { ...(meta ?? {}) };
    const matchedRepo = nextMeta.workspace
      ? globalRepoEntries.find((repo) => (
          nextMeta.workspace === repo.localPath
          || nextMeta.workspace.startsWith(`${repo.localPath}/`)
        )) ?? null
      : nextMeta.repo
        ? globalRepoEntries.find((repo) => repoSlugFromRemote(repo.remoteUrl) === nextMeta.repo) ?? null
        : globalRepoEntry ?? null;

    if (matchedRepo) {
      if (!nextMeta.workspace) {
        nextMeta.workspace = matchedRepo.localPath;
      }
      if (!nextMeta.repo) {
        const repoSlug = repoSlugFromRemote(matchedRepo.remoteUrl);
        if (repoSlug) {
          nextMeta.repo = repoSlug;
        }
      }
    }

    const repoPath = matchedRepo?.localPath ?? nextMeta.workspace ?? globalRepoEntry?.localPath ?? null;
    const repoSlug = nextMeta.repo
      ?? repoSlugFromRemote(matchedRepo?.remoteUrl)
      ?? null;

    setO8PrNumber(null);
    setO8PrRepo(null);
    setO8ActiveTab('workspace');
    setO8CommitSha(hash);
    setO8CommitRepoPath(repoPath);
    setO8CommitRepoSlug(repoSlug);
    setRightPanelKind('o8');
    openRightPanelFromUser();
  }, [globalRepoEntries, globalRepoEntry, openRightPanelFromUser]);

  const handleClearCommit = useCallback(() => {
    setO8CommitSha(null);
    setO8CommitRepoPath(null);
    setO8CommitRepoSlug(null);
  }, []);

  const handleSelectO8RepoPath = useCallback((repoPath: string) => {
    handleClearCommit();
    setO8RepoPathOverride(repoPath);
    setO8AllRepos(false); // a concrete repo pick (selector / overview row) exits All-repos
    setO8SelectedFile(null);
    setO8SelectedFileRepoPath(null);
  }, [handleClearCommit]);

  // "All repos" — the shared O8RepoSelector and the left project pick route here.
  const handleSelectO8AllRepos = useCallback(() => {
    setO8AllRepos(true);
  }, []);

  const startColumnResize = useColumnResize(setPanelDragActive);
  const startLeftDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    startColumnResize(event, { side: 'left', min: 160, max: 500, commit: setLeftWidth });
  }, [setLeftWidth, startColumnResize]);
  const startRightDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    startColumnResize(event, { side: 'right', chrome: rightColumnChrome, min: MIN_RIGHT_PANEL_WIDTH, max: MAX_RIGHT_PANEL_WIDTH, commit: setRightWidth });
  }, [setRightWidth, startColumnResize, rightColumnChrome]);
  const startO8Drag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    startColumnResize(event, { side: 'right', chrome: rightColumnChrome, min: MIN_O8_PANEL_WIDTH, max: MAX_O8_PANEL_WIDTH, commit: setO8Width });
  }, [setO8Width, startColumnResize, rightColumnChrome]);

  const firstFileChangeCandidate = useMemo(() => {
    const source = parsedAgents.find((agent) => (
      Boolean(agent.activity?.filePath)
      || Boolean((agent.localDiff?.changedFiles ?? 0) > 0)
    ));
    if (!source) {
      return null;
    }

    return {
      path: source.activity?.filePath ?? null,
      workspace: source.workspace ?? source.runtimeSurface?.cwd ?? null,
    };
  }, [parsedAgents]);
  const hasPendingApprovals = useMemo(
    () => approvalCount > 0 || parsedAgents.some((agent) => agent.approvalStatus === 'pending'),
    [approvalCount, parsedAgents],
  );
  const hasCompletedSession = useMemo(
    () => Array.from(lifecycleEvents.values()).some((entry) => entry.state === 'completed'),
    [lifecycleEvents],
  );
  useEffect(() => {
    if (
      ftuxDormant
      || !ftuxMilestones.firstAgentSpawned.seen
      || ftuxMilestones.firstFileChange.seen
      || !firstFileChangeCandidate
    ) {
      return;
    }

    setFtuxFirstChangedFile((current) => current ?? {
      path: firstFileChangeCandidate.path ?? 'Changed workspace files',
      workspace: firstFileChangeCandidate.workspace,
    });
    enqueueFtuxMilestone('firstFileChange');
    if (firstFileChangeCandidate.path) {
      handleSelectFile(firstFileChangeCandidate.path, firstFileChangeCandidate.workspace ?? undefined);
    }
  }, [
    enqueueFtuxMilestone,
    firstFileChangeCandidate,
    ftuxDormant,
    ftuxMilestones.firstAgentSpawned.seen,
    ftuxMilestones.firstFileChange.seen,
    handleSelectFile,
    setFtuxFirstChangedFile,
  ]);

  useEffect(() => {
    if (
      ftuxDormant
      || !ftuxMilestones.firstAgentSpawned.seen
      || ftuxMilestones.firstApproval.seen
      || !hasPendingApprovals
    ) {
      return;
    }

    enqueueFtuxMilestone('firstApproval');
  }, [
    enqueueFtuxMilestone,
    ftuxDormant,
    ftuxMilestones.firstAgentSpawned.seen,
    ftuxMilestones.firstApproval.seen,
    hasPendingApprovals,
  ]);

  useEffect(() => {
    if (
      ftuxDormant
      || !ftuxMilestones.firstAgentSpawned.seen
      || ftuxMilestones.firstCompletion.seen
      || !hasCompletedSession
    ) {
      return;
    }

    enqueueFtuxMilestone('firstCompletion');
  }, [
    enqueueFtuxMilestone,
    ftuxDormant,
    ftuxMilestones.firstAgentSpawned.seen,
    ftuxMilestones.firstCompletion.seen,
    hasCompletedSession,
  ]);

  useEffect(() => {
    if (ftuxDormant || ftuxMilestones.firstMobilePrompt.seen || resolvedApprovalCount < 1) {
      return;
    }

    enqueueFtuxMilestone('firstMobilePrompt');
  }, [
    enqueueFtuxMilestone,
    ftuxDormant,
    ftuxMilestones.firstMobilePrompt.seen,
    resolvedApprovalCount,
  ]);

  // ── Domain lanes — reactive query, invalidated by WS lane-lifecycle events ──
  const { data: domainLanesRaw } = useReactiveQuery<{ lanes?: Array<{ id: string; packetId: string | null; status: string; sessionKey: string | null; lastEventLabel: string | null; branch?: string; repoPath?: string; label?: string }> }>({
    queryKey: ['lanes', 'active'],
    queryFn: async () => {
      return await fetchSWRJson<{ lanes?: Array<{ id: string; packetId: string | null; status: string; sessionKey: string | null; lastEventLabel: string | null; branch?: string; repoPath?: string; label?: string }> }>('lanes:active', '/api/lanes?active=true')
        .catch(() => ({ lanes: [] }));
    },
    wsEvents: ['lane-lifecycle', 'agent-lifecycle'],
    staleTime: 10_000,
  });
  const domainLanes = useMemo<DomainLaneSummary[]>(() => {
    return (domainLanesRaw?.lanes ?? [])
      .filter((l): l is typeof l & { packetId: string } => Boolean(l.packetId))
      .map((l) => ({ laneId: l.id, packetId: l.packetId, status: l.status, sessionKey: l.sessionKey, lastEventLabel: l.lastEventLabel, branch: l.branch, repoPath: l.repoPath, label: l.label }));
  }, [domainLanesRaw]);
  // Footer merge beacon — fleet-wide review-gate lanes split into
  // needs-review vs approved-awaiting-merge, derived from the same already-live
  // lanes poll plus durable approval records. Exclude
  // lanes whose PACKET has merged/released/archived — the lane summary status can
  // lag (stale-stuck at 'reviewing' after the packet closed), which left a
  // just-merged packet counting as "1 ready" in the beacon.
  const closedPacketIds = useMemo(() => {
    const closed = new Set<string>();
    for (const packet of thoughtsMissionState.packets) {
      if (packet.releaseState === 'released' || packet.archivedAt || packet.status === 'archived') {
        closed.add(packet.id);
      }
    }
    return closed;
  }, [thoughtsMissionState.packets]);
  // Best-effort governance hygiene packets (decompose fan-outs from the
  // 800-line ceiling scan) are NOT merge gates — their own brief says so. Keep
  // them out of the operator review beacon so they don't demand an amber dot;
  // they still surface in the left packet list. (Q ruling 2026-07-11.)
  //
  // Two sources, because a completed hygiene lane often DETACHES from the live
  // mission state (its packet is no longer in thoughtsMissionState.packets), so
  // the packetType tag alone misses it. The decomposition pipeline stamps its
  // packets with a `decompose-` id prefix and uses that same prefix as its own
  // identity check — so a parked lane whose packetId carries the prefix is a
  // decompose packet even when the packet object is gone.
  const nonGatingPacketIds = useMemo(() => {
    const nonGating = new Set<string>();
    for (const packet of thoughtsMissionState.packets) {
      if (packet.packetType === 'decompose') {
        nonGating.add(packet.id);
      }
    }
    for (const lane of domainLanes) {
      if (lane.packetId.startsWith('decompose-')) {
        nonGating.add(lane.packetId);
      }
    }
    return nonGating;
  }, [thoughtsMissionState.packets, domainLanes]);
  const parkedLanes = useMemo(
    () => deriveParkedLanes(domainLanes, closedPacketIds, approvals, nonGatingPacketIds),
    [approvals, domainLanes, closedPacketIds, nonGatingPacketIds],
  );

  const handleOpenReviewLane = useCallback((lane: ParkedLane) => {
    if (lane.repoPath) {
      setO8RepoPathOverride(lane.repoPath);
      setO8SelectedFile(null);
      setO8SelectedFileRepoPath(null);
    }
    setO8ReviewLaneId(lane.laneId);
    setO8ActiveTab('review');
    setRightPanelKind('o8');
    openRightPanelFromUser();
  }, [openRightPanelFromUser]);

  const handleOpenAwaitingMerge = useCallback(() => {
    setRightPanelKind('o8');
    openRightPanelFromUser();
    setO8ActiveTab('inbox');
  }, [openRightPanelFromUser]);

  // #2147 — keep this window in step with quiet mode, including a toggle made
  // from another window or from the native shell.
  useEffect(() => watchQuietMode(), []);

  // #2147 — the overlay status pill lives in a DIFFERENT window that outlives
  // this one, so a change-only push leaves it painting a count from a previous
  // run after every reload. Re-stamp and re-emit on a heartbeat; the pill drops
  // anything older than PARKED_LANES_STALE_AFTER_MS, so a dashboard that went
  // away lets the count lapse instead of freezing it.
  useEffect(() => {
    if (!canUseTauriEvents()) return;
    const breakdown = parkedLanes.reduce<Record<string, number>>((acc, lane) => {
      acc[lane.status] = (acc[lane.status] ?? 0) + 1;
      return acc;
    }, {});
    const repos = Array.from(new Set(parkedLanes
      .map((lane) => lane.repoPath?.trim().replace(/\/+$/, '').split('/').filter(Boolean).at(-1) ?? null)
      .filter((name): name is string => Boolean(name))));
    const parts = [
      breakdown.reviewing ? `${breakdown.reviewing} review ready` : null,
      breakdown.awaiting_orchestrator ? `${breakdown.awaiting_orchestrator} escalated` : null,
      breakdown.awaiting_human ? `${breakdown.awaiting_human} awaiting human` : null,
    ].filter((part): part is string => Boolean(part));
    const tooltip = parts.length > 0
      ? `${parts.join(' · ')}${repos.length > 0 ? ` · ${repos.slice(0, 3).join(', ')}` : ''}`
      : 'No lanes ready for review';
    const publish = () => {
      import('@tauri-apps/api/event')
        .then(({ emit }) => {
          void emit('o8:parked-lanes-status', {
            count: parkedLanes.length,
            waiting: parkedLanes.length,
            repos,
            breakdown,
            tooltip,
            emittedAt: Date.now(),
            runId: PARKED_LANES_RUN_ID,
          } satisfies ParkedLanesStatusPayload);
        })
        .catch(() => {});
    };
    publish();
    const heartbeat = setInterval(publish, PARKED_LANES_HEARTBEAT_MS);
    return () => clearInterval(heartbeat);
  }, [parkedLanes]);

  useEffect(() => {
    if (!tileLayoutHydrated) return;
    if (workspaceTerminalHandlesRef.current.size === 0) return;
    if (!areWorkspaceTerminalRestoresSettled()) return;
    // Reconcile INPUTS (lane snapshots + runtime truth) INTO the mission state.
    // Read the current state through the ref — NOT as a dependency — because this
    // effect WRITES the same state. Depending on thoughtsMissionState created a
    // self-trigger storm: each write minted a fresh `updatedAt` (nowIso) and the
    // live heartbeat timestamps inside the reconcile inputs kept the change-guard
    // perpetually true, so the effect re-armed itself on its own write and fired
    // `Maximum update depth exceeded` on every agent heartbeat (~2.5s). Driving
    // it off the inputs alone makes it reconcile ONCE per heartbeat (correct).
    const current = thoughtsMissionStateRef.current;
    const reconciled = reconcileOrchestratorMissionState(current, {
      laneSnapshots: collectOrchestratorLaneSnapshots(),
      runtimeTruth: orchestratorRuntimeTruth,
      domainLanes,
    });
    const changed = JSON.stringify({
      prompt: reconciled.prompt,
      summary: reconciled.summary,
      packets: reconciled.packets,
      updatedAt: reconciled.updatedAt,
    }) !== JSON.stringify({
      prompt: current.prompt,
      summary: current.summary,
      packets: current.packets,
      updatedAt: current.updatedAt,
    });
    if (changed) {
      const updated = updateOrchestratorMissionState(reconciled);
      setThoughtsMissionState(updated);
      scheduleThoughtsMissionPersist(updated);
    }
  }, [
    areWorkspaceTerminalRestoresSettled,
    collectOrchestratorLaneSnapshots,
    domainLanes,
    orchestratorRuntimeTruth,
    scheduleThoughtsMissionPersist,
    setThoughtsMissionState,
    tileLayoutHydrated,
    workspaceChatSessionsByTileId,
    workspaceTerminalHandlesRef,
  ]);
  const paletteAgents = useMemo(() => parsedAgents, [parsedAgents]);
  const selectedSessionAgent = useMemo(
    () => paletteAgents.find((agent) => agent.sessionKey === activeSessionKey)
      ?? paletteAgents.find((agent) => agent.isCurrentSession)
      ?? null,
    [activeSessionKey, paletteAgents],
  );
  const scopedRepoAgents = useMemo(
    () => paletteAgents.filter((agent) => {
      const repoSlug = repoSlugFromAgent(agent);
      return Boolean(globalRepo && repoSlug === globalRepo);
    }),
    [globalRepo, paletteAgents],
  );
  const currentReviewAgent = useMemo(() => {
    const seen = new Set<string>();
    const candidates = [selectedSessionAgent, ...scopedRepoAgents].filter((agent): agent is PaletteAgentSummary => {
      if (!agent || seen.has(agent.sessionKey)) return false;
      seen.add(agent.sessionKey);
      return true;
    });

    return candidates.find((agent) => {
      const repoSlug = repoSlugFromAgent(agent) || globalRepo;
      return Boolean(repoSlug && agent.pr?.number && agent.pr.state !== 'closed');
    }) ?? null;
  }, [globalRepo, scopedRepoAgents, selectedSessionAgent]);
  const currentIssueTarget = useMemo(() => {
    const seen = new Set<string>();
    const candidates = [selectedSessionAgent, ...scopedRepoAgents].filter((agent): agent is PaletteAgentSummary => {
      if (!agent || seen.has(agent.sessionKey)) return false;
      seen.add(agent.sessionKey);
      return true;
    });

    for (const agent of candidates) {
      const issueNumber = parseIssueNumber(agent.currentTask);
      const repoSlug = repoSlugFromAgent(agent) || globalRepo;
      if (issueNumber && repoSlug) {
        return {
          number: issueNumber,
          repo: repoSlug,
          title: agent.currentTask?.trim() || `Issue #${issueNumber}`,
        };
      }
    }

    return null;
  }, [globalRepo, scopedRepoAgents, selectedSessionAgent]);
  const currentWorkspaceLifecycleRecord = useMemo(() => {
    const workflowAgent = currentReviewAgent ?? selectedSessionAgent ?? scopedRepoAgents[0] ?? null;
    if (workflowAgent?.sessionKey) {
      const liveMatch = workspaceLifecycleRecords.find((record) => (
        record.live && record.sessionKey === workflowAgent.sessionKey
      ));
      if (liveMatch) {
        return liveMatch;
      }
    }

    const fallbackRepoPath = workspaceTerminalPreferredRepo?.localPath ?? globalRepoEntry?.localPath ?? null;
    if (!fallbackRepoPath) return null;

    return workspaceLifecycleRecords.find((record) => (
      !record.archivedAt && record.repoPath === fallbackRepoPath
    )) ?? null;
  }, [currentReviewAgent, globalRepoEntry?.localPath, scopedRepoAgents, selectedSessionAgent, workspaceLifecycleRecords, workspaceTerminalPreferredRepo?.localPath]);
  const archivedWorkspaceCandidate = useMemo(() => {
    const preferredRepoPath = workspaceTerminalPreferredRepo?.localPath ?? globalRepoEntry?.localPath ?? null;
    return [...workspaceLifecycleRecords]
      .filter((record) => Boolean(record.archivedAt))
      .sort((left, right) => {
        const leftPreferred = preferredRepoPath ? left.repoPath === preferredRepoPath : false;
        const rightPreferred = preferredRepoPath ? right.repoPath === preferredRepoPath : false;
        if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
        const leftTime = left.archivedAt ? new Date(left.archivedAt).getTime() : 0;
        const rightTime = right.archivedAt ? new Date(right.archivedAt).getTime() : 0;
        return rightTime - leftTime;
      })[0] ?? null;
  }, [globalRepoEntry?.localPath, workspaceLifecycleRecords, workspaceTerminalPreferredRepo?.localPath]);
  const nextAttentionWorkspace = useMemo(() => {
    if (!workspaceLifecycleSummary.nextAttentionWorkspaceId) return null;
    return workspaceLifecycleRecords.find((record) => record.id === workspaceLifecycleSummary.nextAttentionWorkspaceId) ?? null;
  }, [workspaceLifecycleRecords, workspaceLifecycleSummary.nextAttentionWorkspaceId]);
  const selectedSessionWorktree = selectedSessionAgent?.worktree ?? null;

  useEffect(() => {
    if (!activeSessionKey || selectedSessionAgent || paletteAgents.length === 0) return;
    // Sidebar chat-history clicks set activeSessionKey to `llm-chat:<tabId>`
    // — these are chat-thread selections, not CLI session selections, so a
    // palette agent will never match. Without this guard the fallback below
    // overwrites the chat-thread selection with a CLI session key on the
    // very next render, killing the active-row shimmer + highlight.
    if (activeSessionKey.startsWith('llm-chat:')) return;
    const fallbackSession = paletteAgents.find((agent) => agent.isCurrentSession) ?? paletteAgents[0];
    if (!fallbackSession || fallbackSession.sessionKey === activeSessionKey) return;
    setActiveSessionKey(fallbackSession.sessionKey);
  }, [activeSessionKey, paletteAgents, selectedSessionAgent, setActiveSessionKey]);

  useEffect(() => {
    if (!currentWorkspaceLifecycleRecord || currentWorkspaceLifecycleRecord.archivedAt || currentWorkspaceLifecycleRecord.unreadCount === 0) {
      return;
    }
    const marker = `${currentWorkspaceLifecycleRecord.id}:${currentWorkspaceLifecycleRecord.lastActivityAt ?? ''}`;
    if (lastMarkedWorkspaceReadRef.current === marker) {
      return;
    }
    lastMarkedWorkspaceReadRef.current = marker;
    void mutateWorkspaceLifecycle('mark_read', currentWorkspaceLifecycleRecord.id).catch(() => undefined);
  }, [currentWorkspaceLifecycleRecord, mutateWorkspaceLifecycle]);

  const tileRegistry = useMemo(() => createTileRegistry({
    activeTileId,
    canvasStateByTileId,
    closeCanvasTab,
    ensureWorkspaceTerminalTile,
    focusOrchestrationPacketLane,
    globalRepoEntries,
    handleAgentPanelChatInjection,
    handleCloseTile,
    handleOpenBrowser,
    handleLaunchWorkspaceAgent,
    handleLaunchWorkspaceRepoTask,
    handleOpenCI,
    handleOpenGitLog,
    handlePreviewDetected,
    handlePreviewSelection,
    handleSelectCommit,
    handleSelectRegisteredRepo,
    handleSplitTile,
    handleThoughtsMissionStateChange,
    launchOrchestrationPacket,
    orchestratorWorkspaceTargets,
    parsedAgents,
    registerContextualPanelHandle,
    registerWorkspaceTerminalHandle,
    selectCanvasTab,
    setActiveTileId,
    setActiveWorkspace,
    setTileLayout,
    setTileLayoutHydrated,
    setTerminalTileRepoScope,
    setWorkspaceActiveTabKindByTileId,
    setWorkspaceChatSessionByTileId,
    setWorkspaceChatSessionsByTileId,
    setWorkspaceLaneByTileId,
    sendAgentKill,
    sendTerminalAttach,
    sendTerminalCreate,
    sendTerminalDetach,
    sendTerminalInput,
    sendTerminalResize,
    sendTerminalVisibility,
    termWsConnected,
    thoughtsDraftInjection,
    thoughtsMissionState,
    tileLayout,
    restoredRepoValidationState,
    retryRestoredRepoValidation,
    unverifiedRestoredRepoTileIds,
    workspacePreviews,
    workspaceScopeEntries,
    workspaceTerminalPreferredRepo,
    workspaceTerminalHandlesRef,
    workspaceTerminalResetNonceByTileId,
  }), [
    canvasStateByTileId,
    closeCanvasTab,
    globalRepoEntries,
    workspaceTerminalPreferredRepo,
    workspaceTerminalHandlesRef,
    handleCloseTile,
    handleOpenBrowser,
    handleSplitTile,
    handleAgentPanelChatInjection,
    ensureWorkspaceTerminalTile,
    handleLaunchWorkspaceRepoTask,
    handlePreviewDetected,
    handlePreviewSelection,
    handleLaunchWorkspaceAgent,
    handleSelectCommit,
    handleSelectRegisteredRepo,
    handleOpenCI,
    handleOpenGitLog,
    handleThoughtsMissionStateChange,
    parsedAgents,
    registerContextualPanelHandle,
    registerWorkspaceTerminalHandle,
    workspaceScopeEntries,
    selectCanvasTab,
    setActiveTileId,
    setActiveWorkspace,
    setTileLayout,
    setTileLayoutHydrated,
    setTerminalTileRepoScope,
    setWorkspaceActiveTabKindByTileId,
    setWorkspaceChatSessionByTileId,
    setWorkspaceChatSessionsByTileId,
    setWorkspaceLaneByTileId,
    sendAgentKill,
    sendTerminalAttach,
    sendTerminalCreate,
    sendTerminalDetach,
    sendTerminalInput,
    sendTerminalResize,
    sendTerminalVisibility,
    termWsConnected,
    tileLayout,
    thoughtsDraftInjection,
    thoughtsMissionState,
    unverifiedRestoredRepoTileIds,
    restoredRepoValidationState,
    retryRestoredRepoValidation,
    activeTileId,
    orchestratorWorkspaceTargets,
    launchOrchestrationPacket,
    focusOrchestrationPacketLane,
    workspaceTerminalResetNonceByTileId,
    workspacePreviews,
  ]);
  const showCompletionFtux = activeFtuxMilestone === 'firstCompletion';
  const showAgentPanelFtux = activeFtuxMilestone === 'firstAgentSpawned' || showCompletionFtux;
  const showCanvasFtux = activeFtuxMilestone === 'firstFileChange';
  const showApprovalFtux = activeFtuxMilestone === 'firstApproval';
  const showMobileFtux = activeFtuxMilestone === 'firstMobilePrompt';
  const changedFileLabel = ftuxFirstChangedFile?.path.split('/').pop() ?? 'your latest edit';
  const mobilePromptBody = mobileRemoteHref.startsWith('http')
    ? `Use ${mobileRemoteHref.replace(/^https?:\/\//, '')} from your phone the next time you need to review an approval away from your desk.`
    : 'Open the mobile remote next time you want to review an approval away from your desk.';
  const mobilePromptActions: GuidedDiscoveryAction[] = [
    {
      label: 'Open mobile remote',
      href: mobileRemoteHref,
      emphasized: true,
    },
  ];

  if (mobileRemoteHref.startsWith('http')) {
    mobilePromptActions.push({
      label: 'Copy link',
      onClick: () => {
        void navigator.clipboard?.writeText(mobileRemoteHref).catch(() => undefined);
        dismissFtuxMilestone();
      },
    });
  }

  const {
    closeSettingsOverlay,
    toggleSettingsOverlay,
  } = useSettingsOverlayDismiss({
    activeNavSection,
    panelRef: settingsPanelRef,
    setActiveNavSection,
  });

  const settingsTakeoverActive = activeNavSection === 'settings';
  const workspaceSurfaceHidden = settingsTakeoverActive || activeNavSection === 'projects';
  useEffect(() => {
    if (!settingsTakeoverActive) {
      if (settingsWasOpenRef.current) {
        requestAnimationFrame(() => {
          const composer = Array.from(workspaceSurfaceRef.current?.querySelectorAll<HTMLTextAreaElement>('textarea:not([disabled])') ?? [])
            .find((element) => element.getClientRects().length > 0 && !element.closest('[inert]'));
          (composer ?? document.getElementById('o8-profile-menu-button'))?.focus();
        });
      }
      settingsWasOpenRef.current = false;
      return;
    }

    settingsWasOpenRef.current = true;
    const panel = settingsPanelRef.current;
    if (!panel) return;
    const selector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusFirst = () => {
      if (!panel.contains(document.activeElement)) panel.querySelector<HTMLElement>(selector)?.focus();
    };
    const frame = requestAnimationFrame(focusFirst);
    const observer = new MutationObserver(focusFirst);
    observer.observe(panel, { childList: true, subtree: true });
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(selector));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    panel.addEventListener('keydown', trapFocus);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      panel.removeEventListener('keydown', trapFocus);
    };
  }, [settingsTakeoverActive]);

  // ── Mobile pairing — open the full-screen QR view as a canvas tab ──
  // Always closes the settings overlay first so the tab is visible when this
  // is triggered from the Connections settings tab (overlay covers the
  // workspace); a no-op when fired from the status-bar phone button.
  const openMobilePairing = useCallback(() => {
    closeSettingsOverlay();
    openCanvasTab({
      id: 'mobile-pairing',
      kind: 'mobile-pairing',
      label: 'Pair Mobile',
      resourceId: 'mobile-pairing',
    });
  }, [closeSettingsOverlay, openCanvasTab]);

  useEffect(() => {
    const handleOpenPairing = () => { openMobilePairing(); };
    const handleOpenSettings = (event: Event) => {
      const detail = (event as CustomEvent<OpenSettingsTabDetail>).detail;
      if (detail?.tab) handleOpenSettingsTab(detail.tab as SettingsTab);
    };
    window.addEventListener(OPEN_MOBILE_PAIRING_EVENT, handleOpenPairing);
    window.addEventListener(OPEN_SETTINGS_TAB_EVENT, handleOpenSettings);
    return () => {
      window.removeEventListener(OPEN_MOBILE_PAIRING_EVENT, handleOpenPairing);
      window.removeEventListener(OPEN_SETTINGS_TAB_EVENT, handleOpenSettings);
    };
  }, [openMobilePairing, handleOpenSettingsTab]);

  // ── Power-user chrome shortcuts ──
  // macOS / VS Code conventions, each mapped to a real existing action:
  //   ⌘T new orchestrator tab · ⌘, settings · ⌘B left sidebar · ⌘⌥B right panel
  //   ⌘J bottom terminal · ⌘⇧J Terminal Mode
  // Allowed even while typing — these are app-chrome toggles, none emit text,
  // and power users expect them to fire mid-compose (matches VS Code). Placed
  // here (not with the other hotkey effects above) so toggleSettingsOverlay is
  // already defined — referencing it earlier would hit its const TDZ.
  useEffect(() => {
    const handler = createDashboardChromeKeydownHandler({
      openCanvas: () => window.location.assign('/preview/canvas-glass'),
      openSettings: toggleSettingsOverlay,
      spawnOrchestrator: () => dispatchSpawn('orchestrator'),
      toggleBottomPanel: toggleContextualPanelTile,
      toggleRightPanel: handleToggleO8Panel,
      toggleSidebar: toggleSidebarFromChrome,
      toggleTerminalMode: toggleActiveTerminalMode,
    });
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dispatchSpawn, handleToggleO8Panel, toggleActiveTerminalMode, toggleContextualPanelTile, toggleSettingsOverlay, toggleSidebarFromChrome]);

  // ── Symon o8-control: `o8:ui-command` → open a named o8 surface ──
  // The voice agent's `o8_ui_open` tool emits this (src-tauri/src/agent/tools/
  // o8_ui.rs). Routes to the SAME handlers the buttons use — settings overlay,
  // mobile-pairing canvas tab, right-panel tabs, browser pane — so voice and
  // click stay in lockstep. voice_settings never arrives here (Rust opens the
  // standalone window directly).
  useEffect(() => {
    if (!canUseTauriEvents()) return;
    const O8_TAB_SURFACES: Record<string, O8Tab> = {
      inbox: 'inbox',
      prs: 'prs',
      activity: 'activity',
      review: 'review',
      o8md: 'spec',
      workspace: 'workspace',
      files: 'files',
      terminal: 'terminal',
      browser: 'browser',
    };
    return subscribeTauriEvent<{ surface: string; url?: string }>('o8:ui-command', (event) => {
        const surface = event.payload?.surface ?? '';
        if (surface === 'settings') {
          handleOpenSettingsTab('git-prs');
          return;
        }
        if (surface === 'mobile_qr') {
          openMobilePairing();
          return;
        }
        if (surface === 'automations') {
          window.dispatchEvent(new CustomEvent('o8:open-automations'));
          return;
        }
        if (surface === 'orchestrator_draft') {
          // Symon's "tell the orchestrator…" — drafts only, the user sends.
          const text = (event.payload as { text?: string })?.text;
          if (text) setThoughtsDraftInjection({ id: `symon-${Date.now()}`, text });
          return;
        }
        if (surface === 'set') {
          // Symon's o8_ui_set — flip a UI preference through the SAME setter the
          // Settings control uses. theme/surface are client-side (ThemeProvider);
          // canvas_mode is the experimentalCanvas operator default (same POST as
          // the Settings toggle — loopback webview passes the gate).
          const { key, value } = (event.payload as { key?: string; value?: string });
          if (key === 'theme' && (value === 'dark' || value === 'light')) {
            // #1649: All Glass pins dark-over-glass — applying a palette under
            // it while toasting success is a lie. Leave the mode, then apply.
            if (workspaceGlass) {
              setWorkspaceGlass(false);
              setPalette(value);
              toast(`Left All glass — theme set to ${value}.`, 'success');
            } else {
              setPalette(value);
              toast(`Theme set to ${value}.`, 'success');
            }
          } else if (key === 'surface' && (value === 'glass' || value === 'solid')) {
            if (workspaceGlass && value === 'solid') {
              setWorkspaceGlass(false);
              setReduceTransparency('on');
              toast('Left All glass — surface set to solid.', 'success');
            } else {
              setReduceTransparency(value === 'solid' ? 'on' : 'off');
              toast(`Surface set to ${value}.`, 'success');
            }
          } else if (key === 'canvas_mode' && (value === 'on' || value === 'off')) {
            fetch('/api/panel/operator-defaults', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ experimentalCanvas: value === 'on' }),
            })
              .then((r) => { if (!r.ok) throw new Error('rejected'); toast(`Canvas mode ${value}.`, 'success'); })
              .catch(() => toast('Could not change Canvas mode.', 'error'));
          } else {
            console.warn(`[symon-o8ui] bad set: key="${key}" value="${value}"`);
            toast(`I can't set ${key ?? '?'} to ${value ?? '?'}.`, 'error');
          }
          return;
        }
        const tab = O8_TAB_SURFACES[surface];
        if (!tab) {
          // Fail loud on tool-vocab↔UI drift — a surface Symon's o8_ui_open
          // enum knows but the dashboard has no handler for. A silent return is
          // exactly how "open canvas" used to vanish into nothing; surface it so
          // the gap is visible instead of guessed-around.
          console.warn(`[symon-o8ui] no dashboard handler for surface "${surface}"`);
          toast(`I don't know the o8 surface "${surface}".`, 'error');
          return;
        }
        setRightPanelKind('o8');
        openRightPanelFromUser();
        setO8ActiveTab(tab);
        if (surface === 'browser' && event.payload?.url) {
          // Let the pane mount before pushing the URL into it.
          const url = event.payload.url;
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('o8:open-browser', { detail: { url } }));
          }, 250);
        }
      });
  }, [handleOpenSettingsTab, openMobilePairing, openRightPanelFromUser, setThoughtsDraftInjection, setPalette, setReduceTransparency, workspaceGlass, setWorkspaceGlass]);

  // ── Voice P3: ⌘⇧, global shortcut → open the settings overlay ──
  // The Rust global-shortcut handler emits `o8:open-settings` (o8 settings is an
  // overlay in THIS webview, not a separate window, so it can't be opened from
  // Rust directly). Toggling matches the in-app ⌘, binding above. Tauri-only.
  useEffect(() => {
    if (!canUseTauriEvents()) return;
    return subscribeTauriEvent('o8:open-settings', () => { toggleSettingsOverlay(); });
  }, [toggleSettingsOverlay]);

  // ── Voice P4: Ctrl+Shift+R while o8 is frontmost → speak o8's OWN webview selection ──
  // o8's WKWebView doesn't expose its text selection to the native AX/Cmd+C
  // grab, so the Rust Ctrl+Shift+R handler emits `o8:speak-selection` when o8 is the
  // frontmost app; we read `window.getSelection()` here and speak it through the
  // native TTS engine. For other apps the Rust side grabs the selection itself.
  useEffect(() => {
    if (!canUseTauriEvents()) return;
    return subscribeTauriEvent('o8:speak-selection', () => {
        // xterm selections are NOT DOM selections — when the DOM has nothing,
        // fall back to any live terminal's own selection so the read chord
        // works inside terminal tabs (Claude Code TUIs included).
        const domText = window.getSelection()?.toString().trim() ?? '';
        const xtermText = domText ? '' : readAnyXtermSelection().trim();
        const text = domText || xtermText;
        // Field diagnostics (#1545): a dead read must say which stage was empty.
        console.info(
          '[speak-selection] chord received: dom=%d chars, xterm=%d chars',
          domText.length,
          xtermText.length,
        );
        if (!text) return;
        import('@tauri-apps/api/core')
          .then(({ invoke }) => invoke('tts_speak', { text }))
          .catch((err) => { console.warn('[speak-selection] tts_speak failed:', err); });
      });
  }, []);

  const showSidebarColumn = sidebarVisible && !responsiveAutoCollapsed.left && !compactShell;
  const showCompactNavigationRail = !compactShell;
  const sidebarOverlay = Boolean(viewportBands?.belowLeftCollapse);
  const closeChatList = () => {
    noteSidebarManualIntent(false);
    setSidebarVisible(false);
    window.requestAnimationFrame(() => document.getElementById('o8-chat-list-toggle')?.focus());
  };
  const showRightPanelColumn = chatVisible && !compactShell && !viewportBands?.belowRightCollapse;
  const workspaceInset = compactShell ? 2 : 4;

  // History-row focus follows the thread bound to the actually focused
  // workspace tab. A freshly spawned orchestrator has no thread yet, so it
  // must clear the rail shimmer instead of inheriting activeSessionKey from
  // the previously viewed conversation. The workspace-active-label broadcast
  // rerenders this page on tab switches and when a thread becomes bound.
  const focusedWorkspaceSnapshot = activeTileId
    ? workspaceTerminalHandlesRef.current.get(activeTileId)?.getTabsSnapshot()
    : null;
  const focusedWorkspaceTab = focusedWorkspaceSnapshot?.tabs.find(
    (tab) => tab.id === focusedWorkspaceSnapshot.activeTabId,
  );
  const isPullRequestWorkspace = activeNavSection === 'agents' && focusedWorkspaceTab?.canvasKind === 'pull-requests';
  useEffect(() => {
    if (!pendingHistoryRailSessionKey) return;
    const pendingThreadId = pendingHistoryRailSessionKey.replace(/^llm-chat:/, '');
    const focusedThreadId = focusedWorkspaceTab?.orchestratorThreadId?.trim() || focusedWorkspaceTab?.id;
    const chatSettled = activeWorkspaceChatSessionKey === pendingHistoryRailSessionKey;
    if (focusedThreadId !== pendingThreadId && !chatSettled) return;
    setPendingHistoryRailSessionKey(null);
  }, [activeWorkspaceChatSessionKey, focusedWorkspaceTab?.id, focusedWorkspaceTab?.orchestratorThreadId, pendingHistoryRailSessionKey]);
  const railActiveSessionKey = resolveRailActiveSessionKey(
    activeSessionKey,
    focusedWorkspaceTab,
    pendingHistoryRailSessionKey,
  );

  // One list instance survives collapse, navigation takeovers, and width changes.
  const agentPanelElement = (
    <AgentPanel
      onOpenChatReview={(laneId, repoPath) => { leaveNavTakeover(); handleOpenO8Panel({ tab: 'review', reviewLaneId: laneId, repoPath }); }}
      navigationRail={showCompactNavigationRail}
      activeSessionKey={railActiveSessionKey}
      selectedRepo={globalRepo ?? repoSlugFromRemote(workspaceTerminalPreferredRepo?.remoteUrl)}
      selectedRepoBranch={globalRepoEntry?.readiness?.currentBranch ?? globalRepoBranch ?? workspaceTerminalPreferredRepo?.branch ?? null}
      selectedRepoLocalPath={globalRepoEntry?.localPath ?? workspaceTerminalPreferredRepo?.localPath ?? null}
      workingRepoPath={focusedWorkspaceTab?.repoPath ?? null}
      activeWorkspacePath={activeWorkspace ?? null}
      activeWorkspaceTabKind={activeWorkspaceTabKind}
      onFocusOrchestratorTab={() => {
        for (const handle of workspaceTerminalHandlesRef.current.values()) {
          const snap = handle.getTabsSnapshot();
          const orchTab = snap.tabs.find((tab) => tab.kind === 'orchestrator');
          if (orchTab) {
            handle.focusTab(orchTab.id);
            window.dispatchEvent(new CustomEvent('o8:tab-focus-flash', { detail: { tabId: orchTab.id } }));
            return;
          }
        }
      }}
      onFocusAssistantTab={() => {
        let fallbackHandle: TerminalTabHandle | null = null;
        for (const handle of workspaceTerminalHandlesRef.current.values()) {
          fallbackHandle ??= handle;
          const snap = handle.getTabsSnapshot();
          const assistantTab = snap.tabs.find((tab) => tab.kind === 'llm-chat');
          if (assistantTab) {
            handle.focusTab(assistantTab.id);
            window.dispatchEvent(new CustomEvent('o8:tab-focus-flash', { detail: { tabId: assistantTab.id } }));
            return;
          }
        }
        if (fallbackHandle) {
          const tabId = fallbackHandle.openLlmChatSession({
            repo: workspaceTerminalPreferredRepo ?? undefined,
            label: 'Chat',
          });
          window.dispatchEvent(new CustomEvent('o8:tab-focus-flash', { detail: { tabId } }));
        }
      }}
      onCreateWorkspaceOrchestrator={(repo) => { leaveNavTakeover(); handleCreateWorkspaceOrchestrator(repo); }}
      onCreateWorkspaceChat={() => { leaveNavTakeover(); handleCreateWorkspaceChat(); }}
      onCreateWorkspaceTerminal={() => { leaveNavTakeover(); handleCreateWorkspaceTerminal(); }}
      onOpenCommandPalette={() => { leaveNavTakeover(); handlePaletteOpen(); }}
      onOpenProjectManagement={(projectId) => { setProjectLibraryRequest((request) => ({ projectId: projectId ?? null, revision: request.revision + 1 })); setActiveNavSection('projects'); }}
      onOpenSettings={toggleSettingsOverlay}
      onOpenMobilePairing={openMobilePairing}
      selectedRepoReadiness={globalRepoEntry?.readiness ?? workspaceTerminalPreferredRepo?.readiness ?? null}
      onLaunchWorkspaceAgent={handleLaunchWorkspaceAgent}
      onLaunchWorkspaceTask={handleLaunchWorkspaceRepoTask}
      onSelectSession={(sessionKey: string, hint?: { title?: string }) => { leaveNavTakeover(); handleSelectSession(sessionKey, hint); }}
      onOpenHistoryChat={(...args) => { leaveNavTakeover(); handleOpenHistoryChatFromPanel(...args); }}
      onSelectRepo={(repoId) => { leaveNavTakeover(); handleAlignToRepo(repoId); }}
      onSelectIssue={handleSelectIssue}
      onSelectCommit={handleSelectCommit}
      onSelectPR={handleSelectPR}
      onReviewPR={handleReviewPR}
      onRepoRemoved={handleRepoRemoved}
      onOpenSpecInWorkspace={handleOpenSpecInWorkspace}
      onExpandWorkspace={handleExpandWorkspace}
      onSelectFile={handleSelectFile}
      onOpenCI={handleOpenCI}
      onCreateIssue={handleCreateIssue}
      onOpenGitLog={handleOpenGitLog}
      onOpenDeploy={handleOpenDeploy}
      onAgentsUpdate={handleAgentsUpdate}
      onAgentKill={sendAgentKill}
      lifecycleEvents={lifecycleEvents}
      orchestratorPackets={activePackets}
      orchestratorMissionState={thoughtsMissionState}
      registeredRepos={globalRepoEntries}
      ideWorkspaceSessions={ideWorkspaceSessionsForSidebar}
      leftPanelFocus={leftPanelFocus}
    />
  );

  return (
    <DictationHost>
      <AttendanceHeartbeat />
      <FileOpenBridge onOpenFile={handleOpenFileInWorkspace} />
      {process.env.NODE_ENV === 'development' ? (
        <Suspense fallback={null}>
          <LazyThemeLab />
        </Suspense>
      ) : null}
      <UiZoomLayer />
      <RealtimeVoiceHost />
      <SymonTextBridgeHost />
      <VisualInstructionHost />
      <NarrationSpeakerHost />
      <ReportIssueHost />
      <TelemetryCrashCapture />
      <SentryBrowserInit />
      {!inTauri ? <div aria-hidden="true" style={{
        position: 'fixed', top: 0, left: 0, right: 0,
        height: 'calc(100vh / var(--ui-zoom, 1))',
        pointerEvents: 'none',
        backdropFilter: 'blur(18px) saturate(1.02)',
        WebkitBackdropFilter: 'blur(18px) saturate(1.02)',
      }} /> : null}
    <div data-vibrancy-passthrough="" data-mcp-scope="dashboard" style={{
      // Divided by --ui-zoom: WebKit CSS zoom scales output but vh keeps
      // computing against the unscaled window, so a plain 100vh shell shrinks
      // into the corner when zooming out (operator video, 2026-07-06).
      height: 'calc(100vh / var(--ui-zoom, 1))',
      display: 'flex',
      flexDirection: 'column',
      background: inTauri && !isNonMacShell() && paletteId === 'dark' ? DARK_FRAME_GLASS_TINT : effectiveGlassSurface ? 'var(--t-bg-gradient)' : 'var(--t-shell-frame-bg, var(--t-bg-gradient))',
      ...(!compactShell ? {
        ['--o8-shell-header-height' as string]: `${SHELL_HEADER_HEIGHT}px`,
        ['--o8-shell-edge-inset' as string]: `${SHELL_EDGE_INSET}px`,
        ['--o8-shell-header-bg' as string]: 'transparent',
        ['--o8-shell-header-border' as string]: 'none',
      } : {}),
      isolation: inTauri ? undefined : 'isolate',
      color: 'var(--t-text)',
      fontFamily: 'var(--font-sans-system)',
      overflow: 'hidden',
      position: 'relative',
    }}>
      {/* UpdateBanner is mounted from the root layout as a center-top portal. */}

      {/* ── Connection Banner (#634) — surfaces dropped WebSocket so users
          know why agent statuses, transcripts, and approvals appear frozen.
          Reuses the existing reconnect/backoff machinery in
          DesktopWebSocketContext; this only adds the chrome surface.
          ConnectionBanner moved out of the workspace top — same state
          now surfaces as ConnectionPill inside AgentPanel above the
          UpdateCard slot (operator pass 2026-05-27). ── */}

      {/* DesignModeOverlay only renders the actual overlay when design mode
          is active. Wrapping it in a guarded Suspense + lazy() keeps its
          ~500-line module out of the initial dashboard chunk; the chunk is
          only fetched once the user toggles design mode (Cmd+Shift+D). */}
      {designMode.active ? (
        <Suspense fallback={null}>
          <LazyDesignModeOverlay
            active={designMode.active}
            onClose={designMode.close}
            onDrawPrompt={(payload) => {
              // Draw routing (Q 2026-07-12): prompt + region + the SILENTLY
              // collected elements under the stroke land in the repo chat.
              // Part 2 (Q's follow-up reference video) adds the screenshot
              // crop of the circled area.
              const region = `${Math.round(payload.rect.width)}×${Math.round(payload.rect.height)} region at (${Math.round(payload.rect.left)}, ${Math.round(payload.rect.top)})`;
              const page = o8BrowserHoverUrl ? `\nPage: ${o8BrowserHoverUrl}` : '';
              const elements = payload.elements.length > 0
                ? `\nElements under the drawing:\n${payload.elements.map(formatDrawElement).join('\n')}`
                : '';
              injectPayloadIntoRepoChat({
                reason: 'design-draw',
                text: `${payload.text}\n\n[Design Mode drawing — ${region}]${page}${elements}`,
              }, null);
            }}
          />
        </Suspense>
      ) : null}

      {/* The grabbed element (Design Mode click) — a floating panel over the
          whole dashboard, regardless of whether chrome or an embedded browser
          was grabbed. "Edit with AI" routes the rich payload into the agent
          chat; "Open Source" opens the inferred file in an inspector tab. */}
      {grabbedElement ? (
        <div style={{ position: 'fixed', bottom: 56, right: 16, width: 360, zIndex: 9998 }}>
          <Suspense fallback={null}>
            <LazyO8ElementPanel
              element={grabbedElement}
              onClose={() => setGrabbedElement(null)}
              onEditWithAI={async (context, { forceFresh }) => {
                const outcome = await routeUiLoopEdit({
                  repoPath: globalRepoEntry?.localPath,
                  context: { ...context, ...(o8BrowserHoverUrl ? { previewUrl: o8BrowserHoverUrl } : {}) },
                  forceFresh,
                  injectFallback: () => injectPayloadIntoRepoChat({
                    reason: 'element-edit',
                    text: context.text,
                    previewImageDataUri: context.previewImageDataUri,
                  }, null),
                });
                if (outcome.kind === 'fallback') setGrabbedElement(null);
                return outcome;
              }}
              onFocusPacket={(packet) => handlePaletteSelectPacket(packet.packetId, packet.laneId, undefined, packet.label)}
              onShowProof={showUiLoopProof}
            />
          </Suspense>
        </div>
      ) : null}

      {/* Keyboard-shortcuts reference. Opened on ⌘/ or `?`, and from
          Quick settings → Get help. Only mounts the chunk once requested. */}
      {shortcutsOpen ? (
        <Suspense fallback={null}>
          <LazyKeyboardShortcutsOverlay
            open={shortcutsOpen}
            onClose={() => setShortcutsOpen(false)}
          />
        </Suspense>
      ) : null}

      {/* CommandPalette is opened on Cmd+K. The dashboard owns the hotkey
          listener (above) so the palette chunk only needs to be present
          once the user opens it. */}
      {commandPaletteOpen ? (
        <Suspense fallback={null}>
          <LazyCommandPalette
            open={commandPaletteOpen}
            onClose={handlePaletteClose}
            workspace={activeWorkspace ?? null}
            repo={globalRepo ?? null}
            actionItems={(() => {
              const ledger = dashboardProjects.ledger;
              const items: CommandPaletteActionItem[] = [];
              const activeRepoPath = globalRepoEntry?.localPath
                ?? workspaceTerminalPreferredRepo?.localPath
                ?? null;
              const activeRepoName = globalRepoEntry?.name
                ?? workspaceTerminalPreferredRepo?.name
                ?? null;

              items.push({
                id: 'workspace:terminal-mode',
                title: 'Toggle Terminal Mode',
                detail: 'Show the active workspace terminal full-bleed',
                shortcut: '⌘⇧J',
                onActivate: toggleActiveTerminalMode,
              });

              for (const repoEntry of globalRepoEntries) {
                items.push({
                  id: `repo:focus:${repoEntry.id}`,
                  title: `Focus ${repoEntry.name}`,
                  detail: repoEntry.localPath,
                  onActivate: () => handleAlignToRepo(repoEntry.id),
                });
              }

              // Switch-to entries for every project that isn't the active one.
              if (ledger) {
                for (const project of ledger.projects) {
                  if (project.id === ledger.activeProjectId || project.repoPaths.length === 0) continue;
                  items.push({
                    id: `project:switch:${project.id}`,
                    title: `Switch to ${project.name}`,
                    detail: `${project.repoPaths.length} repo${project.repoPaths.length === 1 ? '' : 's'}`,
                    swatchColor: project.color,
                    onActivate: () => { void dashboardProjects.switchActive(project.id); },
                  });
                }
              }

              // Move-active-repo entries — only when there's a focused repo.
              if (ledger && activeRepoPath && activeRepoName) {
                const currentOwner = ledger.projects.find((p) => p.repoPaths.includes(activeRepoPath));
                for (const project of ledger.projects) {
                  if (project.id === currentOwner?.id) continue;
                  items.push({
                    id: `project:move:${project.id}`,
                    title: `Move ${activeRepoName} to ${project.name}`,
                    detail: currentOwner ? `From ${currentOwner.name}` : 'Currently unassigned',
                    swatchColor: project.color,
                    onActivate: () => { void dashboardProjects.moveRepoToProject(activeRepoPath, project.id); },
                  });
                }
              }

              return items;
            })()}
            onSelectIssue={handlePaletteSelectIssue}
            onSelectFile={handlePaletteSelectFile}
            onSelectAgent={handlePaletteSelectAgent}
            onSelectChat={handleOpenHistoryChatFromPanel}
            onSelectPacket={handlePaletteSelectPacket}
            onSelectInbox={handleOpenInbox}
            onSelectDirective={handlePaletteSelectDirective}
          />
        </Suspense>
      ) : null}

      <AnimatePresence initial={false}>
        {showApprovalFtux ? (
          <motion.div
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.98 }}
            transition={FTUX_SPRING_TRANSITION}
            style={{
              alignSelf: 'flex-end',
              marginTop: 12,
              marginRight: 16,
              marginBottom: 12,
              marginLeft: 16,
              minHeight: 44,
              padding: '12px 14px',
              borderRadius: 14,
              border: '1px solid color-mix(in srgb, var(--t-accent, #2563eb) 22%, transparent)',
              background: 'color-mix(in srgb, var(--t-panel-translucent, rgba(255,255,255,0.9)) 90%, white 10%)',
              backdropFilter: 'blur(18px)',
              WebkitBackdropFilter: 'blur(18px)',
              boxShadow: '0 18px 48px rgba(15, 23, 42, 0.12)',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              maxWidth: 460,
              zIndex: 20,
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
              <span style={{
                fontSize: 10,
                lineHeight: 1.2,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--t-text-muted)',
              }}>
                Guided Discovery
              </span>
              <strong style={{
                fontSize: 14,
                lineHeight: 1.3,
                fontWeight: 700,
                letterSpacing: '-0.02em',
                color: 'var(--t-text)',
              }}>
                Agents check with you before risky actions
              </strong>
              <span style={{
                fontSize: 12,
                lineHeight: 1.55,
                letterSpacing: '-0.01em',
                color: 'var(--t-text-muted)',
              }}>
                Approval requests land in the Inbox, so risky actions stay visible until you decide.
              </span>
            </div>
            <button
              type="button"
              onClick={openApprovalsDiscoverySurface}
              style={{
                minHeight: 44,
                padding: '0 14px',
                borderRadius: 12,
                border: '1px solid color-mix(in srgb, var(--t-accent, #2563eb) 24%, transparent)',
                background: 'color-mix(in srgb, var(--t-accent, #2563eb) 10%, transparent)',
                color: 'var(--t-text)',
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: '-0.01em',
                cursor: 'pointer',
                fontFamily: 'var(--font-sans-system)',
                flexShrink: 0,
              }}
            >
              Open Inbox
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {settingsTakeoverActive && (
        <div ref={settingsPanelRef} data-mcp-scope="settings" style={{ flex: 1, minHeight: 0, overflow: 'hidden', marginLeft: compactShell ? 0 : NAVIGATION_RAIL_WIDTH, marginRight: compactShell ? 0 : SHELL_EDGE_INSET, marginBottom: compactShell ? 0 : SHELL_EDGE_INSET }}>
          <Suspense fallback={<div style={{ padding: 24, color: 'var(--t-text-muted)', fontSize: 13 }}>Loading settings…</div>}>
            <LazySettingsPage initialTab={settingsInitialTab} onClose={closeSettingsOverlay} />
          </Suspense>
        </div>
      )}
      <AddRepoFlowHost
        onRepoAdded={handleRepoAddedFromPanel}
        onSelectRepo={(repoId) => { leaveNavTakeover(); handleAlignToRepo(repoId); }}
      />
      <ConfirmToastHost />
      <DesktopCloseCoordinator />
      <TerminalCloseDialog />

      {/* ── Main Layout (horizontal) ── */}
      <div data-mcp-scope="main-layout" aria-hidden={settingsTakeoverActive} inert={settingsTakeoverActive} style={{
        flex: 1,
        display: settingsTakeoverActive ? 'none' : 'flex',
        overflow: 'hidden',
        minHeight: 0, // critical: allow flex children to shrink for scroll
        position: 'relative',
        paddingRight: compactShell ? 0 : SHELL_EDGE_INSET,
        paddingBottom: compactShell ? 0 : SHELL_EDGE_INSET,
      }}>
      {/* Navigation retains its own column whether chats are open or closed. */}
      {showCompactNavigationRail ? <div aria-hidden="true" style={{ width: NAVIGATION_RAIL_WIDTH, flexShrink: 0 }} /> : null}

      {/* ── Left: Agent Panel ── */}
      {(() => {
        // When a repo is focused, we want the column to behave like the
        // operator dragged the resizer wider — not an overlay sliding over
        // the workspace. The width is animated; the focus content renders
        // inline inside AgentPanel.
        const effectiveLeftWidth = leftPanelFocus.active ? (controlRoomWide ? CONTROL_ROOM_WIDTH : FOCUS_LEFT_PANEL_WIDTH) : leftWidth;
        // The header belongs to the outer frame; only the reading surface
        // below it paints a card.
        const leftHeader = (
          <LeftHeaderStrip
            sidebarVisible={showSidebarColumn} onToggleSidebar={toggleSidebarFromChrome}
            windowControls={!showCompactNavigationRail} onSearch={handlePaletteOpen}
            inCard
          />
        );
        const leftContent = (
          <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <GuidedDiscoveryHalo active={showAgentPanelFtux} borderRadius={20} />
            <GuidedDiscoveryCoachmark
              visible={showAgentPanelFtux}
              position="top-left"
              title={showCompletionFtux ? 'Completed sessions are saved' : 'Live agent sessions appear here'}
              body={showCompletionFtux
                ? 'Open Archived in Chats to revisit finished work.'
                : 'When you dispatch work, the sidebar keeps the active session card within reach.'}
            />
            {agentPanelElement}
          </div>
        );
        return (
        <ChatListColumn visible={showSidebarColumn} width={effectiveLeftWidth} overlay={sidebarOverlay} onClose={closeChatList}>
        <motion.div
          animate={{ opacity: 1 }}
          transition={
            leftPanelFocus.active
              ? { type: 'spring', stiffness: 360, damping: 32 }
              : showAgentPanelFtux
                ? FTUX_SPRING_TRANSITION
                // type:false = instant set. The old duration:0.001 still ran a
                // rAF animation per width change, which fought the style width
                // during drags and oscillated (jitter recording 2026-07-10).
                : { type: false }
          }
          // No data-chrome-surface here anymore — the inner card paints a
          // SOLID surface over the vibrancy, so children use the regular
          // palette (dark text in light mode) rather than the chrome-flip
          // (white text on dark vibrancy bleed) overrides.
          style={{
            width: '100%',
            maxWidth: '100%',
            flexShrink: 0,
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            // Allow the inner card's drop shadow to escape the column box.
            overflow: 'visible',
            position: 'relative',
            paddingTop: compactShell ? 4 : 0,
            paddingLeft: 0,
            paddingRight: 0,
            paddingBottom: 0,
          }}
        >
          {leftHeader}
          <ChatListCard glass={effectiveGlassSurface} joined={joinedWorkspaceFrame} overlay={sidebarOverlay}>
            {leftContent}
          </ChatListCard>
        </motion.div>
        </ChatListColumn>
      );
      })()}

      {showSidebarColumn && !sidebarOverlay ? <ChatListResizeEdge width={leftWidth}
        glass={effectiveGlassSurface} joined={joinedWorkspaceFrame} onStartDrag={startLeftDrag} setWidth={setLeftWidth} /> : null}

      {/* ── Center + right region ──
          Wrapped in its own column so the DesktopStatusBar renders at ITS
          bottom instead of spanning the full window (Q ruling 2026-07-16):
          the sidebar column now runs full-height to the window bottom — the
          status bar's old left band was an empty anchor after its utilities
          moved out. */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', minWidth: 0, overflow: 'hidden', containerType: 'inline-size' }}>

      {/* ── Center: Workspace Surface ── */}
      <div data-mcp-scope="workspace" aria-hidden={rightPanelMaximized} inert={rightPanelMaximized} style={{
        flex: 1,
        display: rightPanelMaximized ? 'none' : 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
        minWidth: 0,
        background: 'transparent',
        // Content owns the perimeter curve; headers remain in the shared frame.
        borderRadius: 0,
        marginTop: compactShell ? workspaceInset : 0,
        marginBottom: compactShell ? workspaceInset : 0,
        marginLeft: joinedWorkspaceFrame ? 0 : workspaceInset,
        marginRight: !joinedWorkspaceFrame && showRightPanelColumn ? workspaceInset : 0,
      }}>
        {(!workspaceSurfaceHidden || !showSidebarColumn) && <WorkspaceHeaderStrip
          leadingInset={!showCompactNavigationRail}
          sidebarVisible={showSidebarColumn}
          onToggleSidebar={toggleSidebarFromChrome} onSearch={handlePaletteOpen}
          rightPanelOpen={showRightPanelColumn}
          rightPanelDisabled={viewportBands?.belowRightCollapse ?? false}
          onToggleRightPanel={compactShell || isPullRequestWorkspace ? undefined : handleToggleO8Panel}
          projectContextRailAvailable={workspaceHeaderActive.contextRailAvailable}
          projectContextRailVisible={workspaceHeaderActive.contextRailVisible}
          onToggleProjectContextRail={compactShell ? undefined : () => {
            if (typeof window === 'undefined') return;
            window.dispatchEvent(new CustomEvent('o8:request-toggle-context-rail', {
              detail: { workspaceId: workspaceHeaderActive.workspaceId },
            }));
          }}
          headerLabel={primaryWorkspace?.label ?? workspaceHeaderActive.label}
          headerTabs={primaryWorkspace?.tabs ?? workspaceHeaderActive.tabs}
          tabWorkspaceId={primaryWorkspace?.workspaceId ?? workspaceHeaderActive.workspaceId}
          paneCount={multiTerminalPaneLayout ? workspaceLeaves.length : undefined}
          workspaceId={workspacePageSwitching ? null : workspaceAddTargetId}
          terminalModeActive={workspaceHeaderActive.terminalModeActive}
          headerActiveTabId={primaryWorkspace?.tabId ?? workspaceHeaderActive.tabId}
          finishedTabCount={primaryWorkspace?.finishedTabCount ?? workspaceHeaderActive.finishedTabCount}
          approvalCount={showRightPanelColumn ? 0 : approvalCount}
          onOpenInbox={handleOpenInbox}
        />}
        {/* Solid modes join adjacent panels; glass keeps each card curved. */}
        <SmoothCorners corners={workspaceFrameCorners(joinedWorkspaceFrame, !showSidebarColumn || sidebarOverlay, !showRightPanelColumn, joinedWorkspaceFrame ? 14 : WORKSPACE_RAIL_CORNER_RADIUS)} autoEffects={false} style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <GuidedDiscoveryHalo active={showCanvasFtux} borderRadius={18} />
        <GuidedDiscoveryCoachmark
          visible={showCanvasFtux}
          position="top-left"
          title="Your agent made changes"
          body={`Use the workspace canvas to inspect ${changedFileLabel} and keep following the edit trail as the agent works.`}
          actions={ftuxFirstChangedFile?.path ? [
            {
              label: 'Review file',
              onClick: () => {
                dismissFtuxMilestone();
                handleSelectFile(ftuxFirstChangedFile.path, ftuxFirstChangedFile.workspace ?? undefined);
              },
              emphasized: true,
            },
          ] : []}
        />

        {activeNavSection === 'projects' ? <Suspense fallback={null}><LazyProjectsPage key={projectLibraryRequest.revision} initialProjectId={projectLibraryRequest.projectId} onClose={() => setActiveNavSection('agents')} /></Suspense> : null}
          <div
            ref={workspaceSurfaceRef}
            aria-hidden={workspaceSurfaceHidden}
            inert={workspaceSurfaceHidden}
            style={{
              flex: 1,
              minHeight: 0,
              display: workspaceSurfaceHidden ? 'none' : 'flex',
              flexDirection: 'column',
            }}
          >
          <OrchestratorDataProvider
            activeProjectId={dashboardProjects.ledger?.activeProjectId ?? null}
            agents={parsedAgents}
            missionState={thoughtsMissionState}
            workspaceTargets={orchestratorWorkspaceTargets}
            onMissionStateChange={handleThoughtsMissionStateChange}
            onLaunchPacket={launchOrchestrationPacket}
            draftInjection={thoughtsDraftInjection} imageInjection={thoughtsImageInjection} onImageInjectionConsumed={handleImageInjectionConsumed}
            onSelectSession={handleSelectSession}
            latestDispatchedTabId={latestDispatchedTabId}
            latestDispatchedAt={latestDispatchedAt}
            onAcceptDirectiveProposal={handleAcceptDirectiveProposal}
            selectedPacketId={selectedPacketId}
            onSelectedPacketChange={setSelectedPacketId}
            onOpenO8Panel={handleOpenO8Panel}
            onToggleWorkspacePip={handleToggleWorkspacePip}
            o8PanelVisible={showRightPanelColumn && rightPanelKind === 'o8'}
          >
            <WorkspaceUtilityProvider value={workspaceUtilityContext}>
            <TileContainer
              layout={tileLayout}
              joined={joinedWorkspaceFrame}
              paneLabels={workspacePaneLabels}
              keepPrimarySessionAlive
              interactionDisabled={workspacePageSwitching}
              activeTileId={activeTileId}
              registry={tileRegistry}
              onActivateTile={setActiveTileId}
              onCloseTile={handleCloseTile}
              onResizeSplit={handleResizeSplit}
              onSplitTile={handleSplitTile}
            />
            </WorkspaceUtilityProvider>
            <DashboardHydrationMarker />
          </OrchestratorDataProvider>
          </div>
        </SmoothCorners>
      </div>

      <motion.div
            data-right-panel-maximized={rightPanelMaximized}
            aria-hidden={!showRightPanelColumn}
            inert={!showRightPanelColumn}
            // Animate the LAYOUT WIDTH (not just opacity/x) so the center
            // column reflows smoothly as the panel collapses — instead of
            // the panel holding its full footprint through a cosmetic
            // fade/slide and then snapping the center when it unmounts.
            // overflow:hidden clips the fixed-width content during the
            // collapse; the inner keeps its own drag-resize width animation.
            // The chrome allowance covers the divider and outer panel inset.
            initial={false}
            animate={{ width: showRightPanelColumn ? rightPanelMaximized ? '100%' : rightColumnChrome + (rightPanelKind === 'o8' ? o8Width : rightWidth) : 0, opacity: showRightPanelColumn ? 1 : 0 }}
            // Instant while the operator drags the resize handle — easing a
            // per-mousemove target makes the panel rubber-band behind the
            // cursor. The 260ms ease stays for open/close mount/unmount.
            transition={panelDragActive ? { type: false } : { duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            style={{
              display: 'flex',
              height: '100%',
              flexShrink: 0,
              maxWidth: rightPanelMaximized ? '100%' : `max(0px, calc(100cqw - ${WORKSPACE_RESERVE}px))`,
              overflow: showRightPanelColumn ? 'visible' : 'hidden',
            }}
          >
            {!rightPanelMaximized ? <RightPanelResizeEdge
              joined={joinedWorkspaceFrame}
              width={rightPanelKind === 'o8' ? o8Width : rightWidth}
              minimum={rightPanelKind === 'o8' ? MIN_O8_PANEL_WIDTH : MIN_RIGHT_PANEL_WIDTH}
              maximum={rightPanelKind === 'o8' ? MAX_O8_PANEL_WIDTH : MAX_RIGHT_PANEL_WIDTH}
              onStartDrag={rightPanelKind === 'o8' ? startO8Drag : startRightDrag}
              onResize={rightPanelKind === 'o8' ? setO8Width : setRightWidth}
            /> : null}

            <motion.div
              data-mcp-scope="chat-panel"
              initial={false}
              animate={{ width: rightPanelMaximized ? '100%' : rightPanelKind === 'o8' ? o8Width : rightWidth }}
              transition={panelDragActive ? { type: false } : { duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              style={{
                flexShrink: 0,
                alignSelf: 'stretch',
                maxWidth: rightPanelMaximized ? '100%' : `max(0px, calc(100cqw - ${WORKSPACE_RESERVE + rightColumnChrome}px))`,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                // borderRadius:0 — the corner shape is owned by the inner Lisse
                // SmoothCorners below (same squircle as the center workspace card).
                // A plain rounded-rect clip here would shave the squircle's bulge
                // at the 45° diagonal, breaking the continuity with everything else.
                borderRadius: 0,
                marginTop: compactShell ? 4 : 0,
                marginBottom: compactShell ? 4 : 0,
                marginRight: 0,
              }}
            >
              {/* Header stays outside the content clip on the shared frame. */}
              <PanelHeaderStrip
                maximized={rightPanelMaximized}
                onToggleMaximized={toggleRightPanelMaximized}
                o8PanelVisible={rightPanelKind === 'o8'}
                workspacePanelVisible={rightPanelKind === 'review'}
                onToggleO8Panel={handleToggleO8Panel}
                o8ActiveTab={o8ActiveTab}
                onO8TabChange={rightPanelKind === 'o8' ? handleHeaderPanelTabChange : undefined}
                splitEnabled={o8SplitEnabled}
                onToggleSplit={rightPanelKind === 'o8' ? toggleO8PanelSplit : undefined}
                approvalCount={approvalCount}
                onOpenInbox={handleOpenInbox}
                panelTabsSlotRef={setPanelHeaderTabSlot}
                showBrowserTabs={rightPanelKind === 'o8' && o8ActiveTab === 'browser'}
                prTabsSlot={<RightPrTabs tabs={rightPrTabs} activeId={o8ActiveTab === 'activity' && o8PrNumber ? rightPrTabId(o8PrNumber, o8PrRepo, currentO8RepoPath) : null} onSelect={handleRightPrTabSelect} onClose={handleRightPrTabClose} />}
              />
              <SmoothCorners corners={workspaceFrameCorners(joinedWorkspaceFrame, rightPanelMaximized && (!showSidebarColumn || sidebarOverlay), true)} autoEffects={false} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                {mountedRightPanels.o8 && (
                  <motion.div
                    aria-hidden={rightPanelKind !== 'o8'}
                    inert={rightPanelKind !== 'o8'}
                    initial={false}
                    animate={{ opacity: rightPanelKind === 'o8' ? 1 : 0, x: rightPanelKind === 'o8' ? 0 : 12 }}
                    transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                    style={{
                      flex: 1,
                      minHeight: 0,
                      display: rightPanelKind === 'o8' ? 'flex' : 'none',
                      flexDirection: 'column',
                    }}
                  >
                    <Suspense fallback={<div aria-hidden style={{ flex: 1, minHeight: 0, background: 'var(--t-chrome)' }} />}>
                      <OrchestratorDataProvider
                        activeProjectId={dashboardProjects.ledger?.activeProjectId ?? null}
                        agents={parsedAgents}
                        missionState={thoughtsMissionState}
                        workspaceTargets={orchestratorWorkspaceTargets}
                        onMissionStateChange={handleThoughtsMissionStateChange}
                        onLaunchPacket={launchOrchestrationPacket}
                        draftInjection={thoughtsDraftInjection} imageInjection={thoughtsImageInjection} onImageInjectionConsumed={handleImageInjectionConsumed}
                        onSelectSession={handleSelectSession}
                        latestDispatchedTabId={latestDispatchedTabId}
                        latestDispatchedAt={latestDispatchedAt}
                        onAcceptDirectiveProposal={handleAcceptDirectiveProposal}
                        selectedPacketId={selectedPacketId}
                        onSelectedPacketChange={setSelectedPacketId}
                        onOpenO8Panel={handleOpenO8Panel}
                      >
                        <LazyO8Panel
                          active={showRightPanelColumn && rightPanelKind === 'o8'}
                          repoPath={currentO8RepoPath}
                          registeredRepos={activeProjectRepoEntries}
                          linkableRepos={globalRepoEntries}
                          prContextTabId={workspaceHeaderActive.kind === 'orchestrator' ? workspaceHeaderActive.tabId : null}
                          prContextId={workspaceHeaderActive.kind === 'orchestrator' && workspaceHeaderActive.tabId
                            ? (() => {
                              const threadId = workspaceHeaderActive.tabs.find((tab) => tab.id === workspaceHeaderActive.tabId)?.orchestratorThreadId;
                              return threadId ? `thread:${threadId}` : `tab:${workspaceHeaderActive.tabId}`;
                            })()
                            : `worktree:${currentO8RepoPath ?? 'unbound'}`}
                          onRepoPathChange={handleSelectO8RepoPath}
                          allRepos={o8AllRepos}
                          onSelectAllRepos={handleSelectO8AllRepos}
                          previews={workspacePreviews}
                          activeTab={o8ActiveTab}
                          onActiveTabChange={handleHeaderPanelTabChange}
                          secondaryTab={visibleSecondaryTab}
                          onSecondaryTabChange={handleSecondaryPanelTabChange}
                          selectedFile={scopedO8SelectedFile}
                          reviewLaneId={o8ReviewLaneId}
                          onSelectedFileChange={handleO8SelectedFileChange}
                          prNumber={o8PrNumber}
                          prRepo={o8PrRepo}
                          repoSlug={o8CommitRepoSlug ?? repoSlugFromRemote(globalRepoEntry?.remoteUrl)}
                          browserUrl={o8BrowserUrl}
                          browserStateKey={o8AllRepos ? 'right-panel:all-repos' : `right-panel:${currentO8RepoPath ?? 'default'}`}
                          onBrowserActiveUrlChange={setO8BrowserHoverUrl}
                          headerTabSlot={panelHeaderTabSlot}
                          commitSha={o8CommitSha}
                          onClearCommit={handleClearCommit}
                          onSelectCommit={handleSelectCommit}
                          onSelectPR={handleReviewPR}
                          onClosePR={handleCloseRightPr}
                          onSelectIssue={handleSelectIssue}
                          onOpenFile={handleOpenFileInWorkspace}
                          registerContextualPanelHandle={registerContextualPanelHandle}
                          sendTerminalCreate={sendTerminalCreate}
                          sendTerminalAttach={sendTerminalAttach}
                          sendTerminalInput={sendTerminalInput}
                          sendTerminalResize={sendTerminalResize}
                          sendTerminalDetach={sendTerminalDetach}
                          sendAgentKill={sendAgentKill}
                          termWsConnected={termWsConnected}
                          onOpenMainTerminal={(repoPath) => openMainTerminal({
                            handles: workspaceTerminalHandlesRef.current,
                            repoPath,
                            repo: repoPath ? { localPath: repoPath, name: globalRepoEntries.find((repo) => repo.localPath === repoPath)?.name ?? 'Project' } : undefined,
                            activate: setActiveTileId,
                            waitForTarget: () => waitForWorkspaceTerminalTarget({ repoPath, fallbackToAnyExisting: !repoPath }),
                          })}
                        />
                      </OrchestratorDataProvider>
                    </Suspense>
                  </motion.div>
                )}
                {mountedRightPanels.review && (
                  <motion.div
                    aria-hidden={rightPanelKind !== 'review'}
                    inert={rightPanelKind !== 'review'}
                    initial={false}
                    animate={{ opacity: rightPanelKind === 'review' ? 1 : 0, x: rightPanelKind === 'review' ? 0 : 12 }}
                    transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                    style={{
                      flex: 1,
                      minHeight: 0,
                      display: rightPanelKind === 'review' ? 'flex' : 'none',
                      flexDirection: 'column',
                    }}
                  >
                    <Suspense fallback={<div aria-hidden style={{ flex: 1, minHeight: 0, background: 'var(--t-chrome)' }} />}>
                      <OrchestratorDataProvider
                        activeProjectId={dashboardProjects.ledger?.activeProjectId ?? null}
                        agents={parsedAgents}
                        missionState={thoughtsMissionState}
                        workspaceTargets={orchestratorWorkspaceTargets}
                        onMissionStateChange={handleThoughtsMissionStateChange}
                        onLaunchPacket={launchOrchestrationPacket}
                        draftInjection={thoughtsDraftInjection} imageInjection={thoughtsImageInjection} onImageInjectionConsumed={handleImageInjectionConsumed}
                        onSelectSession={handleSelectSession}
                        latestDispatchedTabId={latestDispatchedTabId}
                        latestDispatchedAt={latestDispatchedAt}
                        onAcceptDirectiveProposal={handleAcceptDirectiveProposal}
                        selectedPacketId={selectedPacketId}
                        onSelectedPacketChange={setSelectedPacketId}
            onOpenO8Panel={handleOpenO8Panel}
                      >
                        <LazyReviewPanel repoPath={currentO8RepoPath} selectedFile={scopedO8SelectedFile} reviewLaneId={o8ReviewLaneId} />
                      </OrchestratorDataProvider>
                    </Suspense>
                  </motion.div>
                )}
              </SmoothCorners>
            </motion.div>
          </motion.div>


      {/* ── Alert Toast (desktop only — urgent alerts slide in bottom-left near bell) ── */}
      <AlertToast alerts={activeAlerts} compact={compactShell} onAction={handleAlertAction} />

      {showCompactNavigationRail ? <CompactNavigationRail
        glassSurface={chromeMounted && (isGlassSurface || (workspaceGlass && inTauri && !isNonMacShell()))}
        workspacePage={isWorkspaceUtilityKind(focusedWorkspaceTab?.canvasKind) ? focusedWorkspaceTab.canvasKind : undefined}
        activeDestination={activeNavSection}
        onHome={leaveNavTakeover}
        onOpenSettings={() => handleOpenSettingsTab('general')}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onNewSession={() => {
          leaveNavTakeover();
          const repo = leftPanelFocus.view?.selectedRepo
            ?? activeProjectRepoEntries.find((entry) => entry.localPath === globalRepoEntry?.localPath)
            ?? activeProjectRepoEntries[0]
            ?? workspaceTerminalPreferredRepo;
          if (repo?.readiness?.state === 'missing') {
            setActiveNavSection('projects');
            return;
          }
          handleCreateWorkspaceOrchestrator(repo ? {
            name: repo.name,
            localPath: repo.localPath,
            remoteUrl: repo.remoteUrl ?? undefined,
            branch: repo.readiness?.currentBranch ?? repo.defaultBranch ?? null,
          } : undefined);
        }}
        onCreateTerminal={() => { leaveNavTakeover(); handleCreateWorkspaceTerminal(); }}
        onOpenUsage={() => {
          leaveNavTakeover();
          openCanvasTab({ id: 'usage', kind: 'usage', label: 'Usage', resourceId: 'usage' });
        }}
        onOpenPRs={() => {
          leaveNavTakeover();
          const repoPath = focusedWorkspaceTab?.repoPath ?? globalRepoEntry?.localPath ?? workspaceTerminalPreferredRepo?.localPath ?? null;
          openCanvasTab({
            id: `pull-requests:${repoPath ?? 'unbound'}`,
            kind: 'pull-requests',
            label: 'Pull requests',
            resourceId: repoPath ?? '',
            meta: repoPath ? { workspace: repoPath } : undefined,
          });
          closeRightPanelFromUser();
        }}
        onOpenProjects={() => { setProjectLibraryRequest((request) => ({ projectId: null, revision: request.revision + 1 })); setActiveNavSection('projects'); }}
      /> : null}

      </div>{/* end center+right row */}

      </div>{/* end center+right column */}
      </div>{/* end main layout */}

      <GuidedDiscoveryCoachmark
        visible={showMobileFtux}
        position="bottom-right"
        title="Approve from your phone next time"
        body={mobilePromptBody}
        actions={mobilePromptActions}
        maxWidth={340}
      />

      {/* Orchestrator chat lives entirely inside the tile system now —
          open it via the tile picker or the dedicated NavRail button.
          The floating ThoughtsCard overlay was removed in the
          thoughts→workspace merge. */}

      {/* ── First Launch Onboarding ── */}
      <Suspense fallback={null}>
        <LazyTelemetryConsentCard blocked={!setupCheckComplete || setupWizardOpen} />
      </Suspense>
      {setupWizardOpen && (
        <Suspense fallback={null}>
          <LazyOnboarding onComplete={handleOnboardingComplete} completionError={setupCompleteError} />
        </Suspense>
      )}

      {/* ── Panel-drag shield ──
          While a panel-resize divider is being dragged, an embedded browser
          iframe (or engine webview) inside the O8 panel would swallow the
          mousemove/mouseup the moment the cursor crossed it — the drag sticks
          and the inner page can even be resized by the gesture (report
          0.1.575). A transparent full-viewport capture layer keeps every
          pointer event flowing to the document-level drag listeners so no
          iframe/webview ever sees them. (The native browser is a separate OS
          window handled by the occlude effect above.) */}
      {panelDragActive ? (
        <div
          aria-hidden
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 300,
            cursor: 'col-resize',
            background: 'transparent',
          }}
        />
      ) : null}

      {/* Drag-to-split ghost pill — follows the cursor while a chat/thread
          row is dragged from the left rail (split-screen parity). Renders
          nothing when idle. */}
      <ThreadDragGhost />

      {/* ONE boot loader for the whole boot/restore sequence — stays mounted
          while any phase (tab hydration, lazy tab chunk, thread restore)
          holds a claim, so the phases never flash the greeting/blank between
          handoffs (Q video, 0.1.604). See workspace-boot-loader-claim.tsx. */}
      <WorkspaceBootLoaderHost />

      {/* Failed New-session spawns surface here — never silent (D3YPBP). */}
      <SpawnErrorToast message={spawnErrorMessage} onDismiss={() => setSpawnErrorMessage(null)} />

      {/* Floating browser PIP — only when no side panel is
          open; triggered by hovering browser tool clusters in the transcript.
          Scope key MUST match the O8Panel browserStateKey above. */}
      <BrowserPipCard
        active={!showRightPanelColumn}
        panelVisible={showRightPanelColumn}
        browserVisible={showRightPanelColumn && rightPanelKind === 'o8' && o8ActiveTab === 'browser'}
        boundsRef={workspaceSurfaceRef}
        scopeKey={o8AllRepos ? 'right-panel:all-repos' : `right-panel:${currentO8RepoPath ?? 'default'}`}
        onOpenBrowser={(url) => { if (url) setO8BrowserUrl(url); handleOpenO8Panel({ tab: 'browser' }); }}
      />
      <O8SpecPipCard
        active={!showRightPanelColumn || rightPanelKind !== 'o8' || o8ActiveTab !== 'spec'}
        contextKey={`${workspaceHeaderActive.workspaceId ?? 'home'}:${workspaceHeaderActive.tabId ?? 'none'}`}
        repoPath={currentO8RepoPath}
        onOpenSpec={() => handleOpenO8Panel({ tab: 'spec' })}
      />

    </div>
    </DictationHost>
  );
}
