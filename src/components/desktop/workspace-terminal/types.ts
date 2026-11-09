import type { CanvasRepoTaskLaunchRequest, CanvasTab } from '@/components/desktop/Canvas';
import type { LinkedIssueRef } from '@/components/desktop/IssueLinkPicker';
import type { ChatModelId } from '@/components/desktop/orchestrator/chat-models';
import type { AgentPanelChatInjectionPayload } from '@/lib/chat/injection';
import type { MobileInboxSnapshot, MobileTranscriptEntry } from '@/lib/mobile/types';
import type { PersistedChatCheckpoint } from '@/lib/terminal/tab-state';
import type { TerminalExitState } from '@/lib/terminal/exit-state';
import type {
  OrchestrationMode,
  OrchestratorLaneSnapshot,
  OrchestratorRuntime,
  WorkspaceLaneState,
  WorkspaceOrchestrationPacketBadge,
} from '@/lib/orchestrator/types';
import type {
  DetectedLocalhostPreview,
  PreviewSelectionPayload,
} from '@/lib/panel/preview';
import type { WorkspaceAttachedTerminalSession } from '@/components/desktop/workspace-terminal/terminal-mode';

import type { RegisteredRepo } from '@/components/desktop/workspace-terminal/registered-repo';
export type { RegisteredRepo };

export interface OrchestratorTurnInjection {
  autoSend?: boolean;
  id: string;
  text: string;
  previewImageDataUri?: string;
}

export interface TerminalTab {
  id: string;
  label: string;
  /**
   * Provenance of `label`. 'auto' (the default — ABSENT is treated as 'auto',
   * so every persisted tab from before this field needs no migration) means the
   * label is a cache the self-heal effect may overwrite when fresher canonical
   * title data arrives. 'user' means the operator renamed the tab — it is then
   * frozen and NEVER re-derived. This is what makes the wrong-label race
   * impossible-by-construction while preserving renames. See the self-heal
   * effect in dashboard/hooks/useWorkspaceTerminal.ts (twin of the packet-badge
   * rebind) and setTabLabelIfAuto in terminal-imperative-handle.ts.
   */
  labelSource?: 'auto' | 'user';
  /**
   * NAMING GOTCHA — read carefully:
   *   - 'orchestrator'  → Fleet/Claude orchestrator tab (planning + dispatch)
   *   - 'llm-chat'      → casual o8 Chat tab (the user-facing "Chat")
   *   - 'chat'          → SINGLE-RUNTIME CLI session (Codex / Gemini / opencode).
   *                       NOT the casual chat tab — that's 'llm-chat'.
   *                       Confusing; left as-is to avoid a 75-site rename
   *                       + persisted-state migration. Future cleanup:
   *                       rename 'chat' → 'session'.
   *   - 'terminal'      → tmux/PTY shell tab
   *   - 'canvas'        → file/diff viewer tab (agent-created inspector)
   *   - 'fleet-canvas'  → spatial fleet overview — live packet cards on a
   *                       canvas (experimentalCanvas flag).
   *                       NOT the same as 'canvas'.
   */
  kind: 'terminal' | 'chat' | 'llm-chat' | 'chatgpt-plan' | 'canvas' | 'orchestrator' | 'fleet-canvas';
  tmuxSession: string | null;
  terminalExit?: TerminalExitState;
  /** Live run views attach to an existing PTY but must never send it input. */
  readOnly?: boolean;
  /** Prevent typing into a new local shell until its remote control starts. */
  remoteLaunchPending?: boolean;
  /** Saved SSH target behind a local control shell. Retained after exit or reload. */
  remoteMachine?: { id: string; label: string; sessionId: string };
  cliAgent?: string;
  repo?: RegisteredRepo;
  createdAt: number;
  lastActivity: number;
  chatRuntime?: OrchestratorRuntime;
  chatSessionKey?: string;
  /**
   * #1553 — the STABLE lane identity behind a dispatched chat tab. A lane
   * relaunch/retry mints a fresh sessionKey per attempt, so sessionKey-based
   * reuse minted a new tab per attempt (Polish ×5 / Huddle ×5 zombies). The
   * lane id never changes across relaunches; computeCliChatSession retargets
   * the existing tab for the same lane instead of stacking duplicates.
   */
  laneId?: string | null;
  claudeSessionId?: string;
  chatModel?: string;
  chatContinueLatest?: boolean;
  chatDraftInjection?: { id: string; text: string; autoSend?: boolean; reason?: string; previewImageDataUri?: string };
  llmDraftInjection?: { id: string; text: string; autoSend?: boolean; reason?: string; previewImageDataUri?: string };
  orchestratorTurnInjection?: OrchestratorTurnInjection;
  chatMessages?: MobileTranscriptEntry[];
  llmSummary?: string | null;
  chatCheckpoints?: PersistedChatCheckpoint[];
  linkedIssue?: LinkedIssueRef | null;
  canvasTab?: CanvasTab;
  unseen?: boolean;
  orchestrationPacket?: WorkspaceOrchestrationPacketBadge | null;
  supervisorStatus?: string | null;
  autoArchiveOnIdle?: boolean;
  // Sticky mode for the chooser surface. orchestrator-kind tabs default to
  // 'fleet' and may be 'single' when spawned from the chooser. llm-chat
  // kind tabs are always implicitly chat mode (the field is unset there).
  mode?: OrchestrationMode;
  // When mode === 'single', which runtime this tab dispatches to.
  singleRuntime?: OrchestratorRuntime;
  // Chat-mode model selection (o8 free-tier OpenRouter pool vs BYOK
  // DeepSeek). Used by mode === 'chat' on orchestrator tabs and by all
  // llm-chat tabs.
  chatModelId?: ChatModelId;
  // When set, overrides the server-side OpenRouter fallback chain for
  // chat-mode requests on this tab. Lets the operator pin a specific
  // OpenRouter model slug (e.g. 'openai/gpt-oss-120b:free') for testing
  // or model-tier preference. Empty/undefined = use the env-configured
  // chain.
  chatOpenrouterModel?: string;
  // The chat-history thread id (`thoughts-…`) this orchestrator tab is
  // showing. Captured from the tab's `o8:workspace-thread-id` broadcast and
  // persisted so the EXACT conversation reopens on reload — instead of every
  // orchestrator tab collapsing onto the global last-active thread. Distinct
  // from `id`, which is `orchestrator-<uuid>` for spawned tabs.
  orchestratorThreadId?: string;
  // True for tabs spawned via "+ New session" (a deliberate user action).
  // The boot-restore path leaves this undefined so the saved last-thread
  // gets re-loaded; fresh user-spawned tabs skip the restore and start
  // with the spawn-default label so two clicks on "+ New session" don't
  // produce two tabs named after the operator's previous thread.
  freshSpawn?: boolean;
  // Outside CLI/MCP workers need an orchestrator-shaped host so their live
  // transcript can split beside the workspace. The host is not itself an
  // orchestrator request, so mounting it must not pre-warm another runtime.
  outsideWorkerHost?: boolean;
  // Empty-state Worktree chip choice — persisted on the tab so the
  // operator's pick survives reloads while the chat is still empty.
  // 'local' = work directly against the repo's main checkout; 'new-
  // worktree' = provision a fresh git worktree at first dispatch.
  // Read by the dispatch path to decide whether to call POST /api/
  // worktrees when an agent is spawned from this orchestrator chat.
  worktreeMode?: 'local' | 'new-worktree';
  // When `worktreeMode === 'new-worktree'` AND the operator has sent
  // the first message, the orchestrator chat provisions a worktree
  // upfront and stores its absolute path here. Downstream dispatches
  // from this tab can read `worktreePath` and route the agent's cwd
  // into the worktree, so all the chat's work stays on one branch.
  worktreePath?: string;
}

export interface RemoteTerminalDetails {
  command: string;
  machineId: string;
  machineLabel: string;
  sessionId: string;
}

export type LocalhostPreview = DetectedLocalhostPreview;
export type { PreviewSelectionPayload };
export type WorkspaceChatRuntime = OrchestratorRuntime | 'chat';

export interface TerminalTabHandle {
  writeToTerminal: (sessionName: string, data: string, historical?: boolean) => void;
  setTerminalSourceDimensions?: (sessionName: string, cols: number, rows: number) => void;
  writeRaw: (sessionName: string, data: string) => void;
  terminalVisibilityReady?: (sessionName: string, epoch: number) => void;
  applyTerminalResync?: (sessionName: string, data: string, epoch: number, historyTruncated: boolean, source: 'tmux' | 'scrollback') => void;
  recordTerminalDiagnostic?: (diagnostic: Record<string, unknown>) => void;
  showImage: (sessionName: string, imageB64: string, filename: string) => void;
  setTermError: (sessionName: string, error: string) => void;
  setTermExited: (sessionName: string, exitCode?: number | null) => void;
  onSessionCreated: (sessionName: string, requestId?: string) => boolean;
  clearDetectedPreview: (port: number) => void;
  isRestoreSettled: () => boolean;
  openCliChatSession: (options: {
    runtime?: Exclude<WorkspaceChatRuntime, 'chat'>;
    repo?: RegisteredRepo;
    modelId?: string;
    initialText?: string;
    draftReason?: string;
    previewImageDataUri?: string;
    autoSend?: boolean;
    createNew?: boolean;
    label?: string;
    targetSessionKey?: string;
    /** Stable lane identity — lets a relaunch with a fresh sessionKey retarget
     *  the lane's existing tab instead of minting a duplicate (#1553). */
    laneId?: string | null;
    orchestrationPacket?: WorkspaceOrchestrationPacketBadge | null;
    supervisorStatus?: string | null;
    autoArchiveOnIdle?: boolean;
    /** Agent-originated launch (Symon / supervisor auto-open): create the tab
     *  and surface it in the rail WITHOUT switching the active tab or
     *  stealing the operator's screen (Q ruling 2026-07-17). */
    background?: boolean;
  }) => string;
  openLlmChatSession: (options?: {
    repo?: RegisteredRepo;
    initialText?: string;
    draftReason?: string;
    previewImageDataUri?: string;
    autoSend?: boolean;
    createNew?: boolean;
    label?: string;
    targetSessionKey?: string;
  }) => string;
  openOrchestratorTab: (repo?: RegisteredRepo | null) => string;
  openTerminalTab: (repo?: RegisteredRepo) => string;
  openRemoteTerminalTab: (details: RemoteTerminalDetails) => string;
  focusTerminalSession: (sessionName: string) => boolean;
  openAttachedTerminalSession: (session: WorkspaceAttachedTerminalSession, repo: RegisteredRepo | null) => string;
  openHistoryChat: (
    historyTabId: string,
    title: string,
    repo?: { name?: string; localPath?: string; branch?: string | null; remoteUrl?: string | null } | null,
  ) => string;
  injectIntoCliChat: (text: string, options?: {
    runtime?: Exclude<WorkspaceChatRuntime, 'chat'>;
    repo?: RegisteredRepo;
    modelId?: string;
    draftReason?: string;
    previewImageDataUri?: string;
    autoSend?: boolean;
    createNew?: boolean;
    label?: string;
    targetSessionKey?: string;
    orchestrationPacket?: WorkspaceOrchestrationPacketBadge | null;
    supervisorStatus?: string | null;
    autoArchiveOnIdle?: boolean;
  }) => string;
  injectIntoOrchestrator: (tabId: string, text: string, options?: {
    autoSend?: boolean;
    previewImageDataUri?: string;
  }) => boolean;
  focusTab: (tabId: string) => boolean;
  focusTabRelative: (delta: number) => boolean;
  focusTabAtIndex: (oneBasedIndex: number) => boolean;
  closeActiveTab: () => boolean;
  /** Close remote control tabs before their containing pane unmounts. */
  closeRemoteTerminalTabs: () => void;
  getTabsSnapshot: () => {
    tabs: Array<{
      id: string;
      label: string;
      kind: TerminalTab['kind'];
      canvasKind?: CanvasTab['kind'];
      sessionKey?: string;
      terminalExited?: boolean;
      laneId?: string | null;
      packetId?: string | null;
      orchestratorThreadId?: string;
      repoPath?: string;
      lastActivity: number;
      mode?: OrchestrationMode;
    }>;
    activeTabId: string;
  };
  setOrchestrationPacket: (tabId: string, packet: WorkspaceOrchestrationPacketBadge | null) => boolean;
  /** Self-heal the auto-derived tab label — the twin of setOrchestrationPacket.
   *  Writes `label` ONLY when the tab's labelSource !== 'user' (renames are
   *  preserved) AND the value actually changed (guards re-render churn). Matched
   *  by sessionKey or packetId. Returns true if a tab was updated. Option D. */
  setTabLabelIfAuto: (match: { sessionKey?: string | null; packetId?: string | null }, label: string) => boolean;
  updateChatRuntimeStatus: (sessionKey: string, status: string, label?: string) => boolean;
  getChatTabSnapshots: () => OrchestratorLaneSnapshot[];
  /** Close the chat tab bound to a now-retired lane (matched by sessionKey or
   *  packetId), so reset/archive/merge doesn't leave an orphaned ghost tab. #1293 */
  closeChatTabForRetiredLane: (match: { sessionKey?: string | null; packetId?: string | null }) => boolean;
  /** #1293 Part C — sweep: close every chat tab whose lane is ALREADY retired
   *  (cleans pre-existing zombies, not just live retires). tab.id /
   *  chatSessionKey match the archived sessionKeys; the bound packetId matches
   *  the archived packetIds (a packet tab is keyed by packetId, never a
   *  sessionKey — matching only sessionKeys missed every dispatched tab). */
  closeRetiredChatTabs: (archived: { sessionKeys: Set<string>; packetIds: Set<string> }) => number;
  openWorkspaceDiff: () => void;
  openInspectorTab: (tab: CanvasTab, options?: { repo?: RegisteredRepo; createNew?: boolean }) => string;
}

export interface WorkspaceTerminalProps {
  stateScope: string;
  activeWorkspaceSurface?: boolean;
  defaultTab: 'orchestrator' | 'llm-chat' | 'terminal';
  autoCreateDefaultTab?: boolean;
  preferredRepo?: RegisteredRepo | null;
  /** Current Projects/sidebar selection. New sessions inherit this before
   *  falling back to the focused lane or the tile's persisted repo scope. */
  selectedRepo?: RegisteredRepo | null;
  splitCreated?: boolean;
  availableRepos?: RegisteredRepo[];
  openRepoPaths?: string[];
  /** Live runtime terminals available for exact session-key attachment. */
  attachedTerminalSessions?: WorkspaceAttachedTerminalSession[];
  onActiveChatSessionChange?: (sessionKey: string | null) => void;
  onActiveTabKindChange?: (kind: TerminalTab['kind'] | null, tabId: string) => void;
  onChatSessionsChange?: (sessions: MobileInboxSnapshot['sessions']) => void;
  onActiveLaneChange?: (lane: WorkspaceLaneState | null) => void;
  onRepoScopeChange?: (repoPath: string | null) => void;
  onActiveRepoContextChange?: (repo: RegisteredRepo | null) => void;
  onSelectRepoScope?: (repo: RegisteredRepo) => void;
  onLaunchRepoAgent?: (repo: RegisteredRepo) => void | Promise<void>;
  onOpenRepoGitLog?: (repo: RegisteredRepo) => void;
  onOpenRepoCI?: (repo: RegisteredRepo) => void;
  onOpenRepoDiff?: (repo: RegisteredRepo | null) => void;
  onInjectChatContext?: (payload: AgentPanelChatInjectionPayload) => void;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onLaunchWorkspaceTask?: (request: CanvasRepoTaskLaunchRequest) => Promise<void>;
  onSplitVertical?: (initialTab?: 'chat' | 'terminal') => void;
  onSplitHorizontal?: (initialTab?: 'chat' | 'terminal') => void;
  onOpenRemoteTerminal?: (details: RemoteTerminalDetails) => void;
  canCloseTile?: boolean;
  onCloseTile?: () => void;
  conversationNavigation?: 'tabs' | 'sidebar';
  sendTerminalCreate: (cols: number, rows: number, requestId?: string, cwd?: string, ownerKey?: string, directPty?: boolean) => void;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number, readOnly?: boolean) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalVisibility: (sessionName: string, visible: boolean, options?: { epoch?: number; needsResync?: boolean; cols?: number; rows?: number }) => void;
  sendTerminalDetach: (sessionName: string) => void;
  termWsConnected: boolean;
  onPreviewDetected?: (preview: DetectedLocalhostPreview) => void;
  onPreviewSelection?: (selection: PreviewSelectionPayload) => void;
  showPreviewPane?: boolean;
}

export interface WorkspaceCliModelOption {
  id: string;
  label: string;
  color: string;
}

export interface QueuedContextCard {
  id: string;
  reason?: string;
  text: string;
  title: string;
  meta: string[];
  preview?: string;
  previewImageDataUri?: string;
}
