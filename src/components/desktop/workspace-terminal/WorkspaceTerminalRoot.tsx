'use client';


import { forwardRef, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
// RotateCcw shim removed with the in-workspace reconnect banner —
// recovery now lives in the AgentPanel ConnectionPill.
import { registerFreshOrchestratorAction } from '@/lib/desktop/fresh-orchestrator-action';
import { useWorkspaceTerminalController } from '@/components/desktop/workspace-terminal/useWorkspaceTerminalController';
import { WorkspaceTerminalPanels } from '@/components/desktop/workspace-terminal/WorkspaceTerminalPanels';
import { useTerminalMode } from '@/components/desktop/workspace-terminal/use-terminal-mode';
import { useOutsideWorkerSplitMount } from '@/components/desktop/workspace-terminal/use-outside-worker-split-mount';
import { WorkspaceSpawnProvider, type WorkspaceSpawnHandlers } from '@/components/desktop/workspace-terminal/spawn-context';
import { workspaceConversationHeaderLabel } from '@/components/desktop/workspace-terminal/utils';
import { workerTabThreadTitle } from '@/components/desktop/workspace-terminal/worker-pane-chrome';
import type { TerminalTab, TerminalTabHandle, WorkspaceTerminalProps } from '@/components/desktop/workspace-terminal/types';

export const WorkspaceTerminalRoot = forwardRef<TerminalTabHandle, WorkspaceTerminalProps>(
  function WorkspaceTerminalRoot(props, ref) {
    const {
      activeRepo: controllerActiveRepo, activeTab: controllerActiveTab, attachWorkspaceTerminalSession, cleanupFinishedTabs: controllerCleanupFinishedTabs, containerDivRef, getTabInventory, effectiveActiveTabId, finishedTabCount, handleCloseTab: controllerHandleCloseTab, handleConsumeChatDraftInjection, handleReorderTabs, handleNewChatGPTPlanTab: controllerHandleNewChatGPTPlanTab, handleNewLLMChatTab: controllerHandleNewLLMChatTab, handleNewTab: controllerHandleNewTab, openRemoteTerminalTab, handleOpenWorkspaceCommitTab, handleRestoreLatestCheckpoint, handleRunCommandInTerminal, handleSaveCheckpoint, handleSelectTab: controllerHandleSelectTab, handleUpdateChatMessages, handleUpdateChatModel, handleUpdateChatSessionKey, handleUpdateLinkedIssue, handleUpdateLlmSummary, handleUpdateTabLabel: controllerHandleUpdateTabLabel, handleUpdateTabMode, panelRefs, primaryRestoreSettled, spawnChatTab, spawnFleetCanvasTab: controllerSpawnFleetCanvasTab, spawnOrchestratorTab: controllerSpawnOrchestratorTab, spawnSingleRuntimeTab, tabs, termWsConnected, undoCleanup: controllerUndoCleanup, visibleTabs,
    } = useWorkspaceTerminalController(props, ref);
    const controller = { activeRepo: controllerActiveRepo, activeTab: controllerActiveTab, attachWorkspaceTerminalSession, cleanupFinishedTabs: controllerCleanupFinishedTabs, effectiveActiveTabId, finishedTabCount, handleCloseTab: controllerHandleCloseTab, handleConsumeChatDraftInjection, handleReorderTabs, handleNewChatGPTPlanTab: controllerHandleNewChatGPTPlanTab, handleNewLLMChatTab: controllerHandleNewLLMChatTab, handleNewTab: controllerHandleNewTab, openRemoteTerminalTab, handleOpenWorkspaceCommitTab, handleRestoreLatestCheckpoint, handleRunCommandInTerminal, handleSaveCheckpoint, handleSelectTab: controllerHandleSelectTab, handleUpdateChatMessages, handleUpdateChatModel, handleUpdateChatSessionKey, handleUpdateLinkedIssue, handleUpdateLlmSummary, handleUpdateTabLabel: controllerHandleUpdateTabLabel, handleUpdateTabMode, primaryRestoreSettled, spawnChatTab, spawnFleetCanvasTab: controllerSpawnFleetCanvasTab, spawnOrchestratorTab: controllerSpawnOrchestratorTab, spawnSingleRuntimeTab, tabs, termWsConnected, undoCleanup: controllerUndoCleanup, visibleTabs };
    const workspaceInstanceId = useId();
    const handleNewTab = controller.handleNewTab;
    const createTerminalModeShellTab = useCallback(
      (repo?: import('@/components/desktop/workspace-terminal/types').RegisteredRepo) => handleNewTab('shell', repo),
      [handleNewTab],
    );
    const terminalMode = useTerminalMode({
      activeTab: controller.activeTab,
      activeTabId: controller.effectiveActiveTabId,
      attachedSessions: props.attachedTerminalSessions ?? [],
      canCloseTile: props.canCloseTile === true,
      createShellTab: createTerminalModeShellTab,
      attachTerminalSession: controller.attachWorkspaceTerminalSession,
      panelRefs,
      preferredRepo: props.preferredRepo ?? null,
      selectTab: controller.handleSelectTab,
      tabs: controller.visibleTabs,
      workspaceActive: props.activeWorkspaceSurface === true,
      workspaceId: workspaceInstanceId,
    });
    const [cleanupToast, setCleanupToast] = useState<{
      id: number;
      closedCount: number;
      closedTabs: TerminalTab[];
    } | null>(null);
    const spawnHandlers = useMemo<WorkspaceSpawnHandlers>(() => ({
      spawnSingleRuntimeTab: controller.spawnSingleRuntimeTab,
      spawnChatTab: controller.spawnChatTab,
      spawnChatGPTPlanTab: controller.handleNewChatGPTPlanTab,
      spawnOrchestratorTab: controller.spawnOrchestratorTab,
      spawnFleetCanvasTab: controller.spawnFleetCanvasTab,
      updateTabMode: controller.handleUpdateTabMode,
    }), [controller.handleNewChatGPTPlanTab, controller.handleUpdateTabMode, controller.spawnChatTab, controller.spawnFleetCanvasTab, controller.spawnOrchestratorTab, controller.spawnSingleRuntimeTab]);
    const activeTab = terminalMode.terminalTab ?? controller.activeTab;
    // workspaceConversationHeaderLabel only knows chat-shaped tabs
    // (orchestrator / llm-chat / single-runtime chat). For terminals
    // and canvas tabs we fall back to "<repo> / Shell" or "<repo> /
    // Canvas" so the title strip never reads blank.
    const conversationHeaderLabel = (() => {
      if (!activeTab) return null;
      const chatLabel = workspaceConversationHeaderLabel(activeTab);
      if (chatLabel) return chatLabel;
      const repoName = activeTab.repo?.name
        ?? (activeTab.repo?.localPath ? activeTab.repo.localPath.split('/').filter(Boolean).pop() ?? null : null);
      const kindLabel = activeTab.kind === 'chatgpt-plan' ? 'ChatGPT plan' : activeTab.kind === 'terminal'
        ? 'Shell'
        : activeTab.kind === 'canvas' || activeTab.kind === 'fleet-canvas'
          ? 'Canvas'
          : null;
      if (!kindLabel) return null;
      return repoName ? `${repoName} / ${kindLabel}` : kindLabel;
    })();

    // Render-derived active identity for the MCP surface-state reader. Source
    // is the same `activeTab` the header/broadcast use — never a parsed label
    // or an arbitrary button — and the pane marks itself active so a split
    // layout resolves the pane the operator is actually on.
    const activeTabRepoName = activeTab?.repo?.name
      ?? (activeTab?.repo?.localPath ? activeTab.repo.localPath.split('/').filter(Boolean).pop() ?? null : null);
    const activeWorkspaceRepoName = activeTabRepoName
      ?? controller.activeRepo?.name
      ?? (controller.activeRepo?.localPath ? controller.activeRepo.localPath.split('/').filter(Boolean).pop() ?? null : null);

    useOutsideWorkerSplitMount({
      active: props.activeWorkspaceSurface === true,
      activeTabId: controller.activeTab?.id ?? null,
      workspaceId: workspaceInstanceId,
      tabs: controller.tabs,
      selectTab: controller.handleSelectTab,
      spawnOrchestratorTab: controller.spawnOrchestratorTab,
    });

    // Listen for header spawn / close-workspace requests. Events
    // include an optional workspaceId — when set, only the matching
    // pane responds. Untargeted events (single-mode global play) only
    // the lone pane responds (canCloseTile = false). Lets two split
    // panes' header play buttons drive their own spawns.
    const handleNewLLMChatTab = controller.handleNewLLMChatTab;
    const handleNewChatGPTPlanTab = controller.handleNewChatGPTPlanTab;
    const spawnOrchestratorTab = controller.spawnOrchestratorTab;
    const spawnFleetCanvasTab = controller.spawnFleetCanvasTab;
    const activeRepo = controller.activeRepo;
    const preferredRepo = props.preferredRepo;
    const onCloseTile = props.onCloseTile;
    const onSplitVertical = props.onSplitVertical;
    const onSplitHorizontal = props.onSplitHorizontal;
    const attachLiveRun = controller.attachWorkspaceTerminalSession;
    const openRemoteTerminal = props.onOpenRemoteTerminal ?? controller.openRemoteTerminalTab;
    const selectLiveRunTab = controller.handleSelectTab;
    const activeWorkspaceSurface = props.activeWorkspaceSurface === true;
    useEffect(() => {
      if (typeof window === 'undefined') return;
      const matchWorkspace = (eventWorkspaceId: string | null | undefined, eventTileId?: string) => {
        if (eventTileId) return eventTileId === props.stateScope;
        if (!eventWorkspaceId) return props.canCloseTile !== true;
        return eventWorkspaceId === workspaceInstanceId;
      };
      const onSpawn = (event: Event) => {
        const detail = (event as CustomEvent<{ kind?: string; workspaceId?: string; tileId?: string }>).detail;
        if (!matchWorkspace(detail?.workspaceId, detail?.tileId)) return;
        const repo = preferredRepo ?? activeRepo ?? undefined;
        if (detail?.kind === 'orchestrator') spawnOrchestratorTab?.();
        else if (detail?.kind === 'chat') handleNewLLMChatTab(repo ?? undefined);
        else if (detail?.kind === 'chatgpt-plan') handleNewChatGPTPlanTab();
        else if (detail?.kind === 'terminal') handleNewTab('shell', repo ?? undefined);
        else if (detail?.kind === 'fleet-canvas') spawnFleetCanvasTab?.();
      };
      const onCloseWorkspace = (event: Event) => {
        const detail = (event as CustomEvent<{ workspaceId?: string }>).detail;
        if (detail?.workspaceId !== workspaceInstanceId) return;
        onCloseTile?.();
      };
      const onSplitWorkspace = (event: Event) => {
        const detail = (event as CustomEvent<{ workspaceId?: string; direction?: string; kind?: string }>).detail;
        if (detail?.workspaceId !== workspaceInstanceId) return;
        if (detail.kind !== 'chat' && detail.kind !== 'terminal') return;
        if (detail.direction === 'right') onSplitVertical?.(detail.kind);
        if (detail.direction === 'below') onSplitHorizontal?.(detail.kind);
      };
      const onOpenAgentTerminal = (event: Event) => {
        const detail = (event as CustomEvent<{ session?: string; label?: string; workspaceId?: string }>).detail;
        if (detail?.workspaceId ? detail.workspaceId !== workspaceInstanceId : !activeWorkspaceSurface) return;
        if (!detail?.session) return;
        const tabId = attachLiveRun({
          sessionKey: detail.session,
          tmuxSession: detail.session,
          label: detail.label,
          readOnly: true,
        }, preferredRepo ?? activeRepo ?? null);
        if (tabId) selectLiveRunTab(tabId);
      };
      const onOpenRemoteTerminal = (event: Event) => {
        const detail = (event as CustomEvent<{
          workspaceId?: string; command?: string; machineId?: string; machineLabel?: string; sessionId?: string;
        }>).detail;
        if (detail?.workspaceId !== workspaceInstanceId || !detail.command || !detail.machineId
          || !detail.machineLabel || !detail.sessionId) return;
        openRemoteTerminal({
          command: detail.command,
          machineId: detail.machineId,
          machineLabel: detail.machineLabel,
          sessionId: detail.sessionId,
        });
      };
      window.addEventListener('o8:request-spawn-tab', onSpawn as EventListener);
      window.addEventListener('o8:request-close-workspace', onCloseWorkspace as EventListener);
      window.addEventListener('o8:request-split-workspace-tab', onSplitWorkspace as EventListener);
      window.addEventListener('o8:open-agent-terminal', onOpenAgentTerminal as EventListener);
      window.addEventListener('o8:request-open-remote-terminal', onOpenRemoteTerminal as EventListener);
      return () => {
        window.removeEventListener('o8:request-spawn-tab', onSpawn as EventListener);
        window.removeEventListener('o8:request-close-workspace', onCloseWorkspace as EventListener);
        window.removeEventListener('o8:request-split-workspace-tab', onSplitWorkspace as EventListener);
        window.removeEventListener('o8:open-agent-terminal', onOpenAgentTerminal as EventListener);
        window.removeEventListener('o8:request-open-remote-terminal', onOpenRemoteTerminal as EventListener);
      };
    }, [props.canCloseTile, props.stateScope, handleNewTab, handleNewLLMChatTab, handleNewChatGPTPlanTab, spawnOrchestratorTab, spawnFleetCanvasTab, activeRepo, preferredRepo, onCloseTile, onSplitVertical, onSplitHorizontal, workspaceInstanceId, activeWorkspaceSurface, attachLiveRun, selectLiveRunTab, openRemoteTerminal]);

    // Broadcast the active-tab label + tabId + kind + workspaceId + full
    // tabs list so the dashboard can route the title to the column-level
    // header strip (one workspace) or hide it on splits (more than one),
    // surface the multi-tab pill strip when 2+ tabs exist, and drive the
    // `…` / right-click menu actions when applicable.
    const activeTabId = activeTab?.id ?? null;
    const activeTabKind = activeTab?.kind ?? null;
    const freshActionRepo = activeTab?.repo ?? controller.activeRepo;
    useEffect(() => {
      const root = containerDivRef.current;
      if (!root || !freshActionRepo || !activeTabId) return;
      return registerFreshOrchestratorAction(root, {
        workspaceId: workspaceInstanceId,
        activeTabId,
        repo: freshActionRepo,
        tabIds: controller.tabs.map(tab => tab.id),
        getTabIds: getTabInventory,
        enabled: activeWorkspaceSurface && controller.primaryRestoreSettled,
        spawnFresh: repo => spawnOrchestratorTab(repo, true),
      });
    }, [activeTabId, activeWorkspaceSurface, containerDivRef, getTabInventory, controller.primaryRestoreSettled, controller.tabs, freshActionRepo, spawnOrchestratorTab, workspaceInstanceId]);
    const projectContextRailAvailable = activeTabKind === 'orchestrator' || activeTabKind === 'llm-chat';
    const [projectContextRailVisible, setProjectContextRailVisible] = useState(true);
    const tabsForBroadcast = useMemo(() => (
      controller.visibleTabs.map((tab) => ({
        id: tab.id,
        label: tab.label ?? '',
        labelSource: tab.labelSource,
        llmSummary: workerTabThreadTitle(tab),
        orchestrationPacket: tab.orchestrationPacket ? {
          title: tab.orchestrationPacket.title,
          branchTarget: tab.orchestrationPacket.branchTarget,
        } : undefined,
        kind: tab.kind,
        runtime: tab.kind === 'orchestrator'
          ? (tab.singleRuntime ?? 'claude-code')
          : (tab.chatRuntime ?? null),
        packetStatus: tab.orchestrationPacket?.status ?? null,
        orchestratorThreadId: tab.orchestratorThreadId ?? null,
        repoPath: tab.repo?.localPath ?? null,
      }))
    ), [controller.visibleTabs]);

    useEffect(() => {
      if (typeof window === 'undefined') return;
      const onToggle = (event: Event) => {
        const detail = (event as CustomEvent<{ workspaceId?: string | null }>).detail;
        const eventWorkspaceId = detail?.workspaceId;
        if (eventWorkspaceId && eventWorkspaceId !== workspaceInstanceId) return;
        if (!eventWorkspaceId && props.canCloseTile === true) return;
        setProjectContextRailVisible((value) => !value);
      };
      window.addEventListener('o8:request-toggle-context-rail', onToggle as EventListener);
      return () => window.removeEventListener('o8:request-toggle-context-rail', onToggle as EventListener);
    }, [props.canCloseTile, workspaceInstanceId]);

    // Re-broadcast on CONTENT change, not array identity — `tabsForBroadcast`
    // is a fresh array whenever visibleTabs recomputes, and the dashboard
    // listener setStates unconditionally, so an identity dep turns
    // dispatch → setState → render → dispatch into a synchronous cycle
    // ("Maximum update depth exceeded" on /dashboard, 2026-06-12).
    const tabsBroadcastSignature = JSON.stringify(tabsForBroadcast);
    const tabsForBroadcastRef = useRef(tabsForBroadcast);
    useEffect(() => {
      tabsForBroadcastRef.current = tabsForBroadcast;
    });

    useEffect(() => {
      if (typeof window === 'undefined') return;
      window.dispatchEvent(new CustomEvent('o8:workspace-active-label', {
        detail: {
          workspaceId: workspaceInstanceId,
          tileId: props.stateScope,
          label: conversationHeaderLabel,
          tabId: activeTabId,
          kind: activeTabKind,
          tabs: tabsForBroadcastRef.current,
          finishedTabCount: controller.finishedTabCount,
          contextRailAvailable: projectContextRailAvailable,
          contextRailVisible: projectContextRailVisible,
          terminalModeActive: terminalMode.active,
          activeWorkspaceSurface: props.activeWorkspaceSurface === true,
        },
      }));
      return () => {
        window.dispatchEvent(new CustomEvent('o8:workspace-active-label', {
          detail: {
            workspaceId: workspaceInstanceId,
            label: null,
            tabId: null,
            kind: null,
            tabs: [],
            finishedTabCount: 0,
            contextRailAvailable: false,
            contextRailVisible: false,
            terminalModeActive: false,
            activeWorkspaceSurface: false,
            removed: true,
          },
        }));
      };

    }, [conversationHeaderLabel, activeTabId, activeTabKind, workspaceInstanceId, tabsBroadcastSignature, controller.finishedTabCount, projectContextRailAvailable, projectContextRailVisible, terminalMode.active, props.activeWorkspaceSurface, props.stateScope]);

    // Listen for chat-history rename so the workspace tab's label
    // refreshes in sync with the chat-history PATCH. The header strip
    // reads tab.label via workspaceConversationHeaderLabel — without
    // this update the renamed title would lag until a remount.
    const handleUpdateTabLabel = controller.handleUpdateTabLabel;
    useEffect(() => {
      if (typeof window === 'undefined') return;
      const onRename = (event: Event) => {
        const detail = (event as CustomEvent<{
          tabId?: string;
          threadId?: string | null;
          title?: string;
          source?: 'auto' | 'user';
        }>).detail;
        if (!detail?.tabId || typeof detail.title !== 'string') return;
        handleUpdateTabLabel(detail.tabId, detail.title, {
          threadId: detail.threadId ?? null,
          source: detail.source,
        });
      };
      window.addEventListener('o8:chat-history-updated', onRename as EventListener);
      return () => window.removeEventListener('o8:chat-history-updated', onRename as EventListener);
    }, [handleUpdateTabLabel]);

    // Listen for header pill clicks. In single mode (no split) we
    // accept events that omit workspaceId; in split mode each pane
    // claims only events carrying its own workspaceId. Lets two
    // SplitHeaderPillStrips in the global header drive both panes
    // without crosstalk.
    const handleSelectTab = controller.handleSelectTab;
    const handleCloseTab = controller.handleCloseTab;
    const cleanupFinishedTabs = controller.cleanupFinishedTabs;
    useEffect(() => {
      if (typeof window === 'undefined') return;
      const matchWorkspace = (eventWorkspaceId: string | null | undefined) => {
        if (!eventWorkspaceId) {
          // Untargeted event — only the single pane should claim it.
          return props.canCloseTile !== true;
        }
        return eventWorkspaceId === workspaceInstanceId;
      };
      const onSelect = (event: Event) => {
        const detail = (event as CustomEvent<{ tabId?: string; workspaceId?: string }>).detail;
        if (!matchWorkspace(detail?.workspaceId)) return;
        if (detail?.tabId) handleSelectTab(detail.tabId);
      };
      const onClose = (event: Event) => {
        const detail = (event as CustomEvent<{ tabId?: string; workspaceId?: string }>).detail;
        if (!matchWorkspace(detail?.workspaceId)) return;
        if (detail?.tabId) handleCloseTab(detail.tabId);
      };
      const onRename = (event: Event) => {
        const detail = (event as CustomEvent<{ tabId?: string; label?: string; workspaceId?: string }>).detail;
        if (!matchWorkspace(detail?.workspaceId)) return;
        if (detail?.tabId && detail.label) handleUpdateTabLabel(detail.tabId, detail.label, { source: 'user' });
      };
      const onReorder = (event: Event) => {
        const detail = (event as CustomEvent<{ tabId?: string; targetId?: string; after?: boolean; workspaceId?: string }>).detail;
        if (!matchWorkspace(detail?.workspaceId) || !detail.tabId || !detail.targetId) return;
        handleReorderTabs(detail.tabId, detail.targetId, detail.after);
      };
      const onCleanup = (event: Event) => {
        const detail = (event as CustomEvent<{ workspaceId?: string | null }>).detail;
        if (!matchWorkspace(detail?.workspaceId)) return;
        const result = cleanupFinishedTabs();
        if (result.closedCount < 1) return;
        setCleanupToast({
          id: Date.now(),
          closedCount: result.closedCount,
          closedTabs: result.closedTabs,
        });
      };
      window.addEventListener('o8:request-reorder-tabs', onReorder);
      window.addEventListener('o8:request-select-tab', onSelect as EventListener);
      window.addEventListener('o8:request-close-tab', onClose as EventListener);
      window.addEventListener('o8:request-rename-tab', onRename as EventListener);
      window.addEventListener('o8:request-cleanup-tabs', onCleanup as EventListener);
      return () => {
        window.removeEventListener('o8:request-reorder-tabs', onReorder);
        window.removeEventListener('o8:request-select-tab', onSelect as EventListener);
        window.removeEventListener('o8:request-close-tab', onClose as EventListener);
        window.removeEventListener('o8:request-rename-tab', onRename as EventListener);
        window.removeEventListener('o8:request-cleanup-tabs', onCleanup as EventListener);
      };
    }, [props.canCloseTile, handleSelectTab, handleCloseTab, handleReorderTabs, handleUpdateTabLabel, cleanupFinishedTabs, workspaceInstanceId]);

    useEffect(() => {
      if (!cleanupToast) return;
      const timer = window.setTimeout(() => {
        setCleanupToast((current) => current?.id === cleanupToast.id ? null : current);
      }, 5_000);
      return () => window.clearTimeout(timer);
    }, [cleanupToast]);

    const undoCleanup = controller.undoCleanup;
    const handleUndoCleanup = useCallback((closedTabs: TerminalTab[]) => {
      undoCleanup(closedTabs);
      setCleanupToast(null);
    }, [undoCleanup]);

    return (
      <WorkspaceSpawnProvider value={spawnHandlers}>
      <div
        ref={containerDivRef}
        data-vibrancy-passthrough=""
        data-o8-workspace-root="1"
        data-o8-workspace-id={workspaceInstanceId}
        data-o8-workspace-active={props.activeWorkspaceSurface === true ? 'true' : undefined}
        data-o8-active-tab-id={activeTab?.id ?? undefined}
        data-o8-active-tab-kind={activeTab?.kind ?? undefined}
        data-o8-active-repo={activeWorkspaceRepoName ?? undefined}
        data-o8-active-repo-path={freshActionRepo?.localPath ?? undefined}
        data-o8-tab-inventory={JSON.stringify(controller.tabs.map(tab => tab.id))}
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: 'var(--t-bg-gradient)',
          position: 'relative',
        }}
      >
        {/* The full-width "Reconnecting to workspace runtime" banner used
            to live here. It covered the workspace tab strip whenever
            the WS dropped. The same state now surfaces as a compact
            ConnectionPill inside AgentPanel (above UpdateCard) so the
            workspace stays uncovered. The "Restore checkpoint" recovery
            action still exists on each chat tab's header strip. */}

        <WorkspaceTerminalPanels
          workspaceId={workspaceInstanceId}
          tileId={props.stateScope}
          pendingRemotePane={props.autoCreateDefaultTab === false && props.splitCreated === true}
          visibleTabs={controller.visibleTabs}
          attachedTerminalSessions={props.attachedTerminalSessions}
          terminalModeStatusEvidence={terminalMode.statusEvidence}
          restoreSettled={controller.primaryRestoreSettled}
          effectiveActiveTabId={terminalMode.effectiveActiveTabId}
          termWsConnected={controller.termWsConnected}
          panelRefs={panelRefs}
          onCloseTab={controller.handleCloseTab}
          onNewTerminal={createTerminalModeShellTab}
          onRunInTerminal={controller.handleRunCommandInTerminal}
          onOpenWorkspaceCommitTab={controller.handleOpenWorkspaceCommitTab}
          onUpdateLlmSummary={controller.handleUpdateLlmSummary}
          onUpdateLinkedIssue={controller.handleUpdateLinkedIssue}
          onUpdateChatMessages={controller.handleUpdateChatMessages}
          onUpdateChatSessionKey={controller.handleUpdateChatSessionKey}
          onUpdateChatModel={controller.handleUpdateChatModel}
          onConsumeChatDraftInjection={controller.handleConsumeChatDraftInjection}
          onSaveCheckpoint={controller.handleSaveCheckpoint}
          onRestoreLatestCheckpoint={controller.handleRestoreLatestCheckpoint}
          projectContextRailVisible={projectContextRailVisible && props.activeWorkspaceSurface !== false}
          sendTerminalAttach={props.sendTerminalAttach}
          sendTerminalInput={props.sendTerminalInput}
          sendTerminalResize={props.sendTerminalResize}
          sendTerminalVisibility={props.sendTerminalVisibility}
          sendTerminalDetach={props.sendTerminalDetach}
          onInjectChatContext={props.onInjectChatContext}
          onSelectCommit={props.onSelectCommit}
          onLaunchWorkspaceTask={props.onLaunchWorkspaceTask}
        />
        {cleanupToast ? (
          <WorkspaceCleanupUndoToast
            closedCount={cleanupToast.closedCount}
            closedTabs={cleanupToast.closedTabs}
            onDismiss={() => setCleanupToast(null)}
            onUndo={handleUndoCleanup}
          />
        ) : null}
      </div>
      </WorkspaceSpawnProvider>
    );
  },
);

// WorkspaceReconnectDot retired — see comment above where the
// in-workspace reconnect banner used to render.

function WorkspaceCleanupUndoToast({
  closedCount,
  closedTabs,
  onDismiss,
  onUndo,
}: {
  closedCount: number;
  closedTabs: TerminalTab[];
  onDismiss: () => void;
  onUndo: (closedTabs: TerminalTab[]) => void;
}) {
  return (
    <div
      data-no-drag
      role="status"
      aria-live="polite"
      style={{
        position: 'absolute',
        right: 14,
        bottom: 14,
        zIndex: 40,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        minHeight: 36,
        paddingLeft: 12,
        paddingRight: 8,
        borderRadius: 9,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider-subtle)',
        background: 'var(--t-panel)',
        color: 'var(--t-text)',
        boxShadow: 'var(--t-panel-shadow)',
        fontFamily: 'var(--font-sans-system)',
        fontSize: 12,
        fontWeight: 400,
        pointerEvents: 'auto',
      }}
    >
      <span>
        Closed {closedCount} finished {closedCount === 1 ? 'tab' : 'tabs'}
      </span>
      <span style={{ color: 'var(--t-text-muted)' }}>·</span>
      <button
        type="button"
        onClick={() => onUndo(closedTabs)}
        style={{
          borderWidth: 0,
          background: 'transparent',
          color: 'var(--t-accent)',
          cursor: 'pointer',
          paddingTop: 4,
          paddingBottom: 4,
          paddingLeft: 2,
          paddingRight: 2,
          fontFamily: 'var(--font-sans-system)',
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        Undo
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss cleanup message"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          borderRadius: 6,
          borderWidth: 0,
          background: 'transparent',
          color: 'var(--t-text-muted)',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}
