'use client';

import { MutableRefObject, Suspense, memo, useEffect, useMemo, useState } from 'react';
import { Terminal as TerminalIcon } from '../lucide-shims';
import type { CanvasTab } from '@/components/desktop/Canvas';
import { TerminalStatusEvidenceDisclosure } from '@/components/desktop/TerminalStatusEvidenceRows';
import { TerminalLaneApproval } from './TerminalLaneApproval';
import type { WorkspaceAttachedTerminalSession } from '@/components/desktop/workspace-terminal/terminal-mode';
import { WorkspaceChatPane } from '@/components/desktop/workspace-terminal/WorkspaceChatPane';
import type { RegisteredRepo, TerminalTab } from '@/components/desktop/workspace-terminal/types';
import { repoSlugFromRemote, shortenPath } from '@/components/desktop/workspace-terminal/utils';
import { XtermPanel, type XtermPanelHandle } from '@/components/desktop/workspace-terminal/XtermPanel';
import { useTheme } from '@/lib/theme/context';
import { isWebMachineBrowserSurface } from '@/lib/connect/web-machine-surface';
import { isNonMacShell } from '@/lib/desktop/host-platform';
import { WorkspaceBootLoaderClaim } from '@/components/desktop/workspace-terminal/workspace-boot-loader-claim';
import { WorkspaceBootLoader } from '@/components/desktop/workspace-terminal/WorkspaceBootLoader';
import { updateResidentTabIds } from '@/components/desktop/workspace-terminal/resident-tabs';
import { retryingLazy } from '@/lib/react/retrying-lazy';
import { OUTSIDE_WORKER_HOST_EMPTY_EVENT } from './use-session-tiles';
import type { TerminalStatusEvidence } from '@/lib/terminal-status/resolve';
import { useWsConnectionEpoch } from '@/components/desktop/hooks/DesktopWebSocketContext';

// LazyLLMChat used to render the Assistant tab (kind='llm-chat'). The
// chooser-spawn rewrite routes both orchestrator and llm-chat tabs
// through OrchestratorTab now (chat tabs run with lockedMode='chat'),
// so the standalone LLMChat surface is no longer mounted from here.
const LazyCanvas = retryingLazy(() => import('@/components/desktop/Canvas').then((module) => ({ default: module.Canvas })), { label: 'Canvas' });
const LazyOrchestratorTab = retryingLazy(() => import('@/components/desktop/workspace-terminal/OrchestratorTab').then((module) => ({ default: module.OrchestratorTab })), { label: 'Orchestrator tab' });
const LazyFleetCanvasTab = retryingLazy(() => import('@/components/desktop/workspace-terminal/FleetCanvasTab').then((module) => ({ default: module.FleetCanvasTab })), { label: 'Fleet canvas' });
const LazyChatGPTPlanChat = retryingLazy(() => import('@/components/desktop/workspace-terminal/ChatGPTPlanChat').then((module) => ({ default: module.ChatGPTPlanChat })), { label: 'ChatGPT plan chat' });

interface WorkspaceTerminalPanelsProps {
  workspaceId: string;
  tileId?: string;
  pendingRemotePane?: boolean;
  visibleTabs: TerminalTab[];
  /** True once the tab restore for the CURRENT restore key has landed. While
   *  false, a zero-tab workspace is "not restored yet", never "empty" — the
   *  CTA must not render a clickable surface whose spawns a landing restore
   *  would clobber (GQXEZD). */
  restoreSettled: boolean;
  effectiveActiveTabId: string;
  attachedTerminalSessions?: WorkspaceAttachedTerminalSession[];
  terminalModeStatusEvidence?: TerminalStatusEvidence;
  termWsConnected: boolean;
  panelRefs: MutableRefObject<Map<string, XtermPanelHandle>>;
  onCloseTab: (tabId: string) => void;
  onNewTerminal?: (repo?: RegisteredRepo) => void;
  onRunInTerminal: (command: string) => void;
  onOpenWorkspaceCommitTab: (hash: string, meta?: Record<string, string>, repo?: RegisteredRepo) => void;
  onUpdateLlmSummary: (tabId: string, summary: string | null) => void;
  onUpdateLinkedIssue: (tabId: string, linkedIssue: import('@/components/desktop/IssueLinkPicker').LinkedIssueRef | null) => void;
  onUpdateChatMessages: (tabId: string, messages: import('@/lib/mobile/types').MobileTranscriptEntry[]) => void;
  onUpdateChatSessionKey: (tabId: string, sessionKey: string) => void;
  onUpdateChatModel: (tabId: string, modelId: string) => void;
  onConsumeChatDraftInjection: (tabId: string, injectionId: string) => void;
  onSaveCheckpoint: (tabId: string) => void;
  onRestoreLatestCheckpoint: (tabId: string) => void;
  projectContextRailVisible: boolean;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number, readOnly?: boolean) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalVisibility: (sessionName: string, visible: boolean, options?: { epoch?: number; needsResync?: boolean; cols?: number; rows?: number }) => void;
  sendTerminalDetach: (sessionName: string) => void;
  onInjectChatContext?: (payload: import('@/lib/chat/injection').AgentPanelChatInjectionPayload) => void;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onLaunchWorkspaceTask?: (request: import('@/components/desktop/Canvas').CanvasRepoTaskLaunchRequest) => Promise<void>;
}

function WorkspaceTerminalPanelsBase({
  workspaceId,
  tileId,
  pendingRemotePane = false,
  visibleTabs,
  effectiveActiveTabId,
  attachedTerminalSessions = [],
  terminalModeStatusEvidence,
  termWsConnected,
  panelRefs,
  onCloseTab,
  onNewTerminal,
  onRunInTerminal,
  onOpenWorkspaceCommitTab,
  onUpdateLlmSummary,
  onUpdateLinkedIssue,
  onUpdateChatMessages,
  onUpdateChatSessionKey,
  onUpdateChatModel,
  onConsumeChatDraftInjection,
  onSaveCheckpoint,
  onRestoreLatestCheckpoint,
  projectContextRailVisible,
  sendTerminalAttach,
  sendTerminalInput,
  sendTerminalResize,
  sendTerminalVisibility,
  sendTerminalDetach,
  onInjectChatContext,
  onSelectCommit,
  onLaunchWorkspaceTask,
  restoreSettled,
}: WorkspaceTerminalPanelsProps) {
  // Track whether this workspace has EVER shown a tab. On a fresh mount
  // (page reload) tabs hydrate async, so visibleTabs is momentarily 0 — that's
  // the boot window, NOT a genuinely empty workspace. We only let the
  // "Start a new session" CTA appear once tabs have actually populated and then
  // been closed; during boot we hold the loader so the picker never flickers.
  useEffect(() => {
    const closeEmptyOutsideWorkerHost = (event: Event) => {
      const tabId = (event as CustomEvent<{ tabId?: string }>).detail?.tabId;
      const tab = visibleTabs.find((candidate) => candidate.id === tabId);
      if (tab?.outsideWorkerHost && !tab.orchestratorThreadId) onCloseTab(tab.id);
    };
    window.addEventListener(OUTSIDE_WORKER_HOST_EMPTY_EVENT, closeEmptyOutsideWorkerHost);
    return () => window.removeEventListener(OUTSIDE_WORKER_HOST_EMPTY_EVENT, closeEmptyOutsideWorkerHost);
  }, [onCloseTab, visibleTabs]);
  const visibleTabIdsKey = visibleTabs.map((tab) => tab.id).join('|');
  const residentInputKey = `${visibleTabIdsKey}\u0000${effectiveActiveTabId}`;
  const [residentState, setResidentState] = useState(() => ({
    inputKey: residentInputKey,
    tabIds: updateResidentTabIds([], visibleTabs.map((tab) => tab.id), effectiveActiveTabId),
    hasEverHadTabs: visibleTabs.length > 0,
  }));
  const visibleTabIds = useMemo(
    () => visibleTabIdsKey ? visibleTabIdsKey.split('|') : [],
    [visibleTabIdsKey],
  );
  const nextResidentState = residentState.inputKey === residentInputKey
    ? residentState
    : {
        inputKey: residentInputKey,
        tabIds: updateResidentTabIds(residentState.tabIds, visibleTabIds, effectiveActiveTabId),
        hasEverHadTabs: residentState.hasEverHadTabs || visibleTabIds.length > 0,
      };
  if (nextResidentState !== residentState) {
    setResidentState(nextResidentState);
  }
  const hasEverHadTabs = nextResidentState.hasEverHadTabs;
  const residentTabIdSet = new Set(nextResidentState.tabIds);
  const statusEvidenceByTmuxSession = useMemo(() => new Map(
    attachedTerminalSessions.flatMap((session) => (
      session.statusEvidence ? [[session.tmuxSession, session.statusEvidence] as const] : []
    )),
  ), [attachedTerminalSessions]);
  const effectiveActiveTerminalSession = visibleTabs.find((tab) => (
    tab.id === effectiveActiveTabId && tab.kind === 'terminal'
  ))?.tmuxSession ?? null;
  const unmountedTerminalVisibilityKey = visibleTabs
    .filter((tab) => Boolean(tab.tmuxSession) && !residentTabIdSet.has(tab.id))
    .map((tab) => tab.tmuxSession)
    .join('|');
  useEffect(() => {
    for (const sessionName of unmountedTerminalVisibilityKey.split('|')) {
      if (sessionName) sendTerminalVisibility(sessionName, false);
    }
  }, [sendTerminalVisibility, unmountedTerminalVisibilityKey]);
  useEffect(() => {
    if (!effectiveActiveTerminalSession) return;
    const frame = window.requestAnimationFrame(() => {
      panelRefs.current.get(effectiveActiveTerminalSession)?.fit();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [effectiveActiveTabId, effectiveActiveTerminalSession, panelRefs]);
  // Boot claim while the tab restore is UNSETTLED — even when default tabs
  // already render. The boot restore re-runs when the repo registry hydrates
  // late (restoreKey flips 'no-repo' → repo), and without this hold the
  // splash revealed the default tabs at ~10s and the real restored tabs
  // popped into the strip ~6s later (prod boot recording 2026-07-17). After
  // the boot latch a mid-session restoreKey flip claims into a no-op, so
  // repo switches never re-summon the splash. Fail-open cap mirrors the
  // EmptyWorkspaceState grace so a restore that never settles can't hold
  // boot hostage.
  const [restoreHoldState, setRestoreHoldState] = useState(() => ({
    restoreSettled,
    expired: false,
  }));
  const restoreHoldExpired = restoreHoldState.restoreSettled === restoreSettled
    ? restoreHoldState.expired
    : false;
  if (restoreHoldState.restoreSettled !== restoreSettled) {
    setRestoreHoldState({ restoreSettled, expired: false });
  }
  useEffect(() => {
    if (restoreSettled) return;
    const timer = window.setTimeout(() => {
      setRestoreHoldState((current) => (
        current.restoreSettled === restoreSettled
          ? { ...current, expired: true }
          : current
      ));
    }, 15000);
    return () => window.clearTimeout(timer);
  }, [restoreSettled]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, position: 'relative', overflow: 'hidden', background: 'var(--t-chat-surface-bg, var(--t-panel))' }}>
      {!restoreSettled && !restoreHoldExpired ? <WorkspaceBootLoaderClaim /> : null}
      {visibleTabs.map((tab) => residentTabIdSet.has(tab.id) || tab.kind === 'chatgpt-plan' ? (
        tab.kind === 'orchestrator' ? (
          <OrchestratorResidentPanel
            key={tab.id}
            tab={tab}
            workspaceId={workspaceId}
            active={tab.id === effectiveActiveTabId}
            projectContextRailVisible={projectContextRailVisible}
            onUpdateLlmSummary={onUpdateLlmSummary}
          />
        ) : tab.kind === 'llm-chat' ? (
          <OrchestratorResidentPanel
            key={tab.id}
            tab={tab}
            workspaceId={workspaceId}
            active={tab.id === effectiveActiveTabId}
            projectContextRailVisible={projectContextRailVisible}
            onUpdateLlmSummary={onUpdateLlmSummary}
          />
        ) : tab.kind === 'chatgpt-plan' ? (
          <div key={tab.id} style={{ display: tab.id === effectiveActiveTabId ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
            <Suspense fallback={<div role="status">Opening ChatGPT plan chat…</div>}><LazyChatGPTPlanChat tabId={tab.id} active={tab.id === effectiveActiveTabId} /></Suspense>
          </div>
        ) : tab.kind === 'chat' ? (
          <ChatResidentPanel
            key={tab.id}
            tab={tab}
            active={tab.id === effectiveActiveTabId}
            onUpdateMessages={onUpdateChatMessages}
            onUpdateSessionKey={onUpdateChatSessionKey}
            onRunInTerminal={onRunInTerminal}
            onSelectModel={onUpdateChatModel}
            onConsumeDraftInjection={onConsumeChatDraftInjection}
            onLinkedIssueChange={onUpdateLinkedIssue}
            onSaveCheckpoint={onSaveCheckpoint}
            onRestoreLatestCheckpoint={onRestoreLatestCheckpoint}
          />
        ) : tab.kind === 'fleet-canvas' ? (
          <FleetCanvasResidentPanel key={tab.id} active={tab.id === effectiveActiveTabId} repoPath={tab.repo?.localPath ?? null} />
        ) : tab.kind === 'canvas' && tab.canvasTab ? (
          <CanvasPanel
            key={tab.id}
            tab={tab as TerminalTab & { canvasTab: CanvasTab }}
            active={tab.id === effectiveActiveTabId}
            onCloseTab={onCloseTab}
            onInjectChatContext={onInjectChatContext}
            onSelectCommit={onSelectCommit}
            onLaunchWorkspaceTask={onLaunchWorkspaceTask}
            onOpenWorkspaceCommitTab={onOpenWorkspaceCommitTab}
          />
        ) : tab.tmuxSession ? (
          <TerminalResidentPanel
            key={tab.tmuxSession}
            tabId={tab.id}
            tmuxSession={tab.tmuxSession}
            readOnly={tab.readOnly}
            inputLocked={tab.remoteLaunchPending}
            exitState={tab.terminalExit}
            onNewShell={!tab.readOnly && !tab.remoteMachine && onNewTerminal ? () => onNewTerminal(tab.repo) : undefined}
            onClose={() => onCloseTab(tab.id)}
            panelRefs={panelRefs}
            sendTerminalAttach={sendTerminalAttach}
            sendTerminalInput={sendTerminalInput}
            sendTerminalResize={sendTerminalResize}
            sendTerminalVisibility={sendTerminalVisibility}
            sendTerminalDetach={sendTerminalDetach}
            statusEvidence={tab.id === effectiveActiveTabId
              ? terminalModeStatusEvidence ?? statusEvidenceByTmuxSession.get(tab.tmuxSession)
              : statusEvidenceByTmuxSession.get(tab.tmuxSession)}
            active={tab.id === effectiveActiveTabId}
          />
        ) : (
          <PendingTerminalPanel
            key={tab.id}
            tab={tab}
            termWsConnected={termWsConnected}
            active={tab.id === effectiveActiveTabId}
          />
        )
      ) : null)}

      {visibleTabs.length === 0 ? (
        pendingRemotePane
          ? <RemotePaneState tileId={tileId ?? workspaceId} />
          : <EmptyWorkspaceState hasEverHadTabs={hasEverHadTabs} restoreSettled={restoreSettled} />
      ) : null}
    </div>
  );
}

function RemotePaneState({ tileId }: { tileId: string }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onFailed = (event: Event) => {
      const detail = (event as CustomEvent<{ tileId?: string; message?: string }>).detail;
      if (detail?.tileId === tileId) setError(detail.message || 'Unable to connect to the saved machine.');
    };
    window.addEventListener('o8:remote-pane-open-failed', onFailed);
    const timeout = window.setTimeout(() => setError((previous) => previous ?? 'The connection did not start. Close this pane and try again.'), 15000);
    return () => {
      window.removeEventListener('o8:remote-pane-open-failed', onFailed);
      window.clearTimeout(timeout);
    };
  }, [tileId]);
  return (
    <div role="status" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24, textAlign: 'center', color: 'var(--t-text-muted)' }}>
      <div style={{ fontSize: 13, fontWeight: 400, color: 'var(--t-text)' }}>
        {error ? 'Could not open saved machine' : 'Connecting to saved machine…'}
      </div>
      <div style={{ fontSize: 11, fontWeight: 300, lineHeight: 1.35 }}>
        {error ?? 'Preparing the terminal in this pane.'}
      </div>
    </div>
  );
}

/** What renders when the center workspace has no tabs:
 *  - BOOT / RELOAD: tabs hydrate async, so visibleTabs is briefly 0. This is
 *    NOT a real empty workspace — show the o8 boot loader and NEVER the CTA,
 *    so "Start a new session" never flickers before the tabs arrive. The
 *    moment tabs hydrate this whole branch unmounts.
 *  - GENUINELY EMPTY: tabs existed and were all closed (hasEverHadTabs) — now
 *    the "Start a new session" CTA is the right thing to show.
 *  A long fallback grace covers the rare workspace that truly never spawns a
 *  tab, so we don't sit on the loader forever. */
function EmptyWorkspaceState({ hasEverHadTabs, restoreSettled }: { hasEverHadTabs: boolean; restoreSettled: boolean }) {
  const graceKey = `${hasEverHadTabs}:${restoreSettled}`;
  const [grace, setGrace] = useState<{ key: string; expired: boolean }>({ key: graceKey, expired: false });
  const graceExpired = grace.key === graceKey && grace.expired;
  useEffect(() => {
    if (hasEverHadTabs && restoreSettled) return;
    // While a restore is unsettled, a zero-tab workspace is a boot/re-restore
    // window, NOT genuinely empty — spawns clicked into a premature CTA get
    // clobbered by the landing restore (GQXEZD, wide on Rosetta). Hold the
    // loader with a long fail-open grace so a restore that never settles
    // still surfaces the CTA eventually instead of a forever-spinner.
    const timer = window.setTimeout(
      () => setGrace({ key: graceKey, expired: true }),
      restoreSettled ? 4000 : 15000,
    );
    return () => window.clearTimeout(timer);
  }, [graceKey, hasEverHadTabs, restoreSettled]);
  return ((hasEverHadTabs && restoreSettled) || graceExpired) ? <EmptyWorkspaceCTA /> : <WorkspaceBootLoaderClaim />;
}

/** Centered three-way CTA for the empty workspace state. Operator
 *  dogfood noted the old "Launch workspace" button was opaque — what
 *  is a workspace? Spelling out Orchestrator / Chat / Terminal gives
 *  a first-time user the actual mental model.
 *
 *  Each card dispatches o8:request-spawn-tab — the same event the
 *  global header play button uses — so spawn lands in this workspace. */
function EmptyWorkspaceCTA() {
  const spawn = (kind: 'orchestrator' | 'chat' | 'terminal') => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('o8:request-spawn-tab', { detail: { kind } }));
  };
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingTop: 24, paddingBottom: 24, paddingLeft: 24, paddingRight: 24 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18, textAlign: 'center', width: '100%', maxWidth: 560, minWidth: 0 }}>
        <div style={{ color: 'var(--t-text)', fontSize: 18, fontWeight: 400, letterSpacing: '-0.01em' }}>
          Start a new session
        </div>
        <div style={{ color: 'var(--t-text-muted)', fontSize: 12.5, lineHeight: 1.55, maxWidth: 440 }}>
          Pick how you want to work. You can switch between sessions and spawn more from the play button in the header.
        </div>
        <div style={{ display: 'grid', width: '100%', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 140px), 1fr))', gap: 10, marginTop: 8 }}>
          <EmptyWorkspaceCard
            label="Orchestrator"
            hint="Plan and dispatch work"
            onClick={() => spawn('orchestrator')}
          />
          <EmptyWorkspaceCard
            label="Chat"
            hint="Direct LLM conversation"
            onClick={() => spawn('chat')}
          />
          <EmptyWorkspaceCard
            label="Terminal"
            hint="Plain shell, no chat"
            onClick={() => spawn('terminal')}
          />
        </div>
      </div>
    </div>
  );
}

function EmptyWorkspaceCard({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 4,
        padding: 14,
        borderRadius: 10,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider)',
        background: 'transparent',
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'var(--font-sans-system)',
        transition: 'background 140ms cubic-bezier(0.22, 1, 0.36, 1), border-color 140ms',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--t-hover)';
        e.currentTarget.style.borderColor = 'var(--t-accent-border, rgba(37, 99, 235, 0.3))';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.borderColor = 'var(--t-divider)';
      }}
    >
      <span style={{ color: 'var(--t-text)', fontSize: 12.5, fontWeight: 600, letterSpacing: '-0.005em' }}>
        {label}
      </span>
      <span style={{ color: 'var(--t-text-muted)', fontSize: 11, lineHeight: 1.4 }}>
        {hint}
      </span>
    </button>
  );
}

export const WorkspaceTerminalPanels = memo(WorkspaceTerminalPanelsBase);

const OrchestratorResidentPanel = memo(function OrchestratorResidentPanel({
  tab,
  workspaceId,
  active,
  projectContextRailVisible,
  onUpdateLlmSummary,
}: {
  tab: TerminalTab;
  workspaceId: string;
  active: boolean;
  projectContextRailVisible: boolean;
  onUpdateLlmSummary: (tabId: string, summary: string | null) => void;
}) {
  if (tab.kind === 'llm-chat') {
    return (
      <Suspense fallback={null}>
        <LazyOrchestratorTab
          tabId={tab.id}
          workspaceId={workspaceId}
          active={active}
          repoPath={tab.repo?.localPath ?? null}
          repoLabel={tab.repo?.name ?? null}
          lockedMode="chat"
          initialMode="chat"
          initialChatModelId={tab.chatModelId}
          initialChatOpenrouterModel={tab.chatOpenrouterModel}
          initialThreadId={tab.id}
          projectContextRailVisible={projectContextRailVisible}
          onChatSummary={(text) => onUpdateLlmSummary(tab.id, text)}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={active ? <WorkspaceBootLoaderClaim /> : null}>
      <LazyOrchestratorTab
        tabId={tab.id}
        workspaceId={workspaceId}
        active={active}
        repoPath={tab.repo?.localPath ?? null}
        repoLabel={tab.repo?.name ?? null}
        initialMode={tab.mode}
        initialSingleRuntime={tab.singleRuntime}
        initialChatModelId={tab.chatModelId}
        initialThreadId={tab.orchestratorThreadId ?? (tab.id.startsWith('thoughts-') ? tab.id : undefined)}
        restoringPersistedThread={Boolean(tab.orchestratorThreadId)}
        projectContextRailVisible={projectContextRailVisible}
        onChatSummary={(text) => onUpdateLlmSummary(tab.id, text)}
        restoreLastThread={!tab.freshSpawn}
        suppressRuntimePrewarm={tab.outsideWorkerHost === true}
        turnInjection={tab.orchestratorTurnInjection}
      />
    </Suspense>
  );
});

const ChatResidentPanel = memo(function ChatResidentPanel({
  tab,
  active,
  onUpdateMessages,
  onUpdateSessionKey,
  onRunInTerminal,
  onSelectModel,
  onConsumeDraftInjection,
  onLinkedIssueChange,
  onSaveCheckpoint,
  onRestoreLatestCheckpoint,
}: {
  tab: TerminalTab;
  active: boolean;
  onUpdateMessages: WorkspaceTerminalPanelsProps['onUpdateChatMessages'];
  onUpdateSessionKey: WorkspaceTerminalPanelsProps['onUpdateChatSessionKey'];
  onRunInTerminal: WorkspaceTerminalPanelsProps['onRunInTerminal'];
  onSelectModel: WorkspaceTerminalPanelsProps['onUpdateChatModel'];
  onConsumeDraftInjection: WorkspaceTerminalPanelsProps['onConsumeChatDraftInjection'];
  onLinkedIssueChange: WorkspaceTerminalPanelsProps['onUpdateLinkedIssue'];
  onSaveCheckpoint: WorkspaceTerminalPanelsProps['onSaveCheckpoint'];
  onRestoreLatestCheckpoint: WorkspaceTerminalPanelsProps['onRestoreLatestCheckpoint'];
}) {
  return (
    <div
      aria-hidden={!active}
      style={{
        display: 'flex',
        flexDirection: 'column',
        visibility: active ? 'visible' : 'hidden',
        pointerEvents: active ? 'auto' : 'none',
        position: active ? 'relative' : 'absolute',
        inset: 0,
        flex: active ? 1 : undefined,
        height: '100%',
        minHeight: 0,
      }}
    >
      <WorkspaceChatPane
        tab={tab}
        active={active}
        onUpdateMessages={onUpdateMessages}
        onUpdateSessionKey={onUpdateSessionKey}
        onRunInTerminal={onRunInTerminal}
        onSelectModel={onSelectModel}
        onConsumeDraftInjection={onConsumeDraftInjection}
        onLinkedIssueChange={onLinkedIssueChange}
        onSaveCheckpoint={onSaveCheckpoint}
        onRestoreLatestCheckpoint={onRestoreLatestCheckpoint}
      />
    </div>
  );
});

const FleetCanvasResidentPanel = memo(function FleetCanvasResidentPanel({ active, repoPath }: { active: boolean; repoPath: string | null }) {
  return (
    <Suspense fallback={active ? <WorkspaceBootLoader contained /> : null}>
      <LazyFleetCanvasTab active={active} repoPath={repoPath} />
    </Suspense>
  );
});

export const TerminalResidentPanel = memo(function TerminalResidentPanel({
  tabId,
  tmuxSession,
  readOnly,
  inputLocked,
  exitState,
  onNewShell,
  onClose,
  panelRefs,
  sendTerminalAttach,
  sendTerminalInput,
  sendTerminalResize,
  sendTerminalVisibility,
  sendTerminalDetach,
  statusEvidence,
  active,
}: {
  tabId: string;
  tmuxSession: string;
  readOnly?: boolean;
  inputLocked?: boolean;
  exitState?: TerminalTab['terminalExit'];
  onNewShell?: () => void;
  onClose?: () => void;
  panelRefs: MutableRefObject<Map<string, XtermPanelHandle>>;
  sendTerminalAttach: WorkspaceTerminalPanelsProps['sendTerminalAttach'];
  sendTerminalInput: WorkspaceTerminalPanelsProps['sendTerminalInput'];
  sendTerminalResize: WorkspaceTerminalPanelsProps['sendTerminalResize'];
  sendTerminalVisibility: WorkspaceTerminalPanelsProps['sendTerminalVisibility'];
  sendTerminalDetach: WorkspaceTerminalPanelsProps['sendTerminalDetach'];
  statusEvidence?: TerminalStatusEvidence;
  active: boolean;
}) {
  const { workspaceGlass } = useTheme();
  const connectionEpoch = useWsConnectionEpoch();
  const transparentTerminal = workspaceGlass && !isWebMachineBrowserSurface() && !isNonMacShell();
  useEffect(() => {
    if (window.__o8TerminalBenchEnabled !== true) return;
    console.warn('[workspace-terminal:bench]', JSON.stringify({
      at: performance.now(),
      event: 'terminal-panel-mounted',
      tabId,
      sessionName: tmuxSession,
    }));
    return () => {
      console.warn('[workspace-terminal:bench]', JSON.stringify({
        at: performance.now(),
        event: 'terminal-panel-unmounted',
        tabId,
        sessionName: tmuxSession,
      }));
    };
  }, [tabId, tmuxSession]);
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        display: active ? 'flex' : 'none',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        background: 'var(--t-terminal-bg)',
      }}
    >
      {statusEvidence ? <TerminalStatusEvidenceDisclosure evidence={statusEvidence} /> : null}
      <TerminalLaneApproval terminalSession={tmuxSession} evidence={statusEvidence} active={active} readOnly={readOnly || inputLocked} />
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column', paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12 }}>
        <XtermPanel
          ref={(handle) => {
            if (handle) panelRefs.current.set(tmuxSession, handle);
            else panelRefs.current.delete(tmuxSession);
          }}
          tmuxSession={tmuxSession}
          exitState={exitState}
          onNewShell={onNewShell}
          onClose={onClose}
          readOnly={readOnly}
          inputLocked={inputLocked}
          connectionEpoch={connectionEpoch}
          sendTerminalAttach={sendTerminalAttach}
          sendTerminalInput={sendTerminalInput}
          sendTerminalResize={sendTerminalResize}
          sendTerminalVisibility={sendTerminalVisibility}
          sendTerminalDetach={sendTerminalDetach}
          visible={active}
          transparent={transparentTerminal}
        />
      </div>
    </div>
  );
});

const CanvasPanel = memo(function CanvasPanel({
  tab,
  active,
  onCloseTab,
  onInjectChatContext,
  onSelectCommit,
  onLaunchWorkspaceTask,
  onOpenWorkspaceCommitTab,
}: {
  tab: TerminalTab & { canvasTab: CanvasTab };
  active: boolean;
  onCloseTab: (tabId: string) => void;
  onInjectChatContext?: (payload: import('@/lib/chat/injection').AgentPanelChatInjectionPayload) => void;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onLaunchWorkspaceTask?: (request: import('@/components/desktop/Canvas').CanvasRepoTaskLaunchRequest) => Promise<void>;
  onOpenWorkspaceCommitTab: (hash: string, meta?: Record<string, string>, repo?: RegisteredRepo) => void;
}) {
  return (
    <div
      aria-hidden={!active}
      inert={!active}
      style={{
        display: 'flex',
        flexDirection: 'column',
        visibility: active ? 'visible' : 'hidden',
        pointerEvents: active ? 'auto' : 'none',
        position: active ? 'relative' : 'absolute',
        inset: 0,
        flex: active ? 1 : undefined,
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <Suspense fallback={active ? <WorkspaceBootLoader contained /> : null}>
        <LazyCanvas
          active={active}
          tabs={[tab.canvasTab]}
          activeTabId={tab.canvasTab.id}
          onSelectTab={() => undefined}
          onCloseTab={() => onCloseTab(tab.id)}
          selectedRepo={repoSlugFromRemote(tab.repo?.remoteUrl) ?? null}
          onInjectChatContext={onInjectChatContext}
          onSelectCommit={(hash, meta) => {
            if (tab.repo || meta?.workspace) {
              onOpenWorkspaceCommitTab(hash, meta, tab.repo);
              return;
            }
            onSelectCommit?.(hash, meta);
          }}
          onLaunchWorkspaceTask={onLaunchWorkspaceTask}
          embedded
        />
      </Suspense>
    </div>
  );
});

const PendingTerminalPanel = memo(function PendingTerminalPanel({
  tab,
  termWsConnected,
  active,
}: {
  tab: TerminalTab;
  termWsConnected: boolean;
  active: boolean;
}) {
  const state = tab.remoteMachine ? 'remote-disconnected' : termWsConnected ? 'awaiting-created' : 'ws-disconnected';
  return (
    <div
      data-o8-term-state={state}
      data-o8-term-tab={tab.id}
      style={{
        flex: 1,
        display: active ? 'flex' : 'none',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--t-text-muted)',
        fontSize: 13,
        fontFamily: 'var(--font-sans-system)',
        flexDirection: 'column',
        gap: 8,
        textAlign: 'center',
        paddingTop: 24,
        paddingBottom: 24,
        paddingLeft: 24,
        paddingRight: 24,
      }}
    >
      <TerminalIcon size={14} />
      <div style={{ fontWeight: 600, color: 'var(--t-text-secondary)' }}>
        {tab.remoteMachine ? `${tab.remoteMachine.label} is disconnected` : termWsConnected ? 'Starting workspace lane...' : 'Waiting for the workspace bridge...'}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.5, maxWidth: 420 }}>
        {tab.remoteMachine
          ? 'This saved terminal is read-only until you open a fresh attachment from Saved machine.'
          : tab.repo?.localPath
          ? `Restoring ${tab.repo.name} in ${shortenPath(tab.repo.localPath)} and replaying the saved repo context.`
          : 'This tab will attach automatically as soon as the runtime is available.'}
      </div>
    </div>
  );
});
