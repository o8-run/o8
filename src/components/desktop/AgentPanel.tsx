'use client';
/* eslint-disable @typescript-eslint/no-unused-vars -- AgentPanel keeps a stable prop surface during the refactor */
import { memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { motion } from 'framer-motion';
import { AgentPanelExtraAgents } from './AgentPanelExtraAgents';
import { WorkspaceBootLoaderClaim } from './workspace-terminal/workspace-boot-loader-claim';
import { ConnectionPill } from './ConnectionPill';
import { UpdateCard } from './UpdateCard';
import { AccountBlock } from './account-block/AccountBlock';
import { FixedReportCard } from './FixedReportCard';
import { retryingLazy } from '@/lib/react/retrying-lazy';
import { ChatsTab } from './repo-focus/tabs/ChatsTab';
import { useLeftPanelProjectFocus } from './repo-focus/useLeftPanelProjectFocus';
import { toRepoFocusRepo, type RepoFocusRepo } from './repo-focus/types';
import { RepoStatusHover } from './repo-registry/RepoStatusHover';
import type { RepoRegistryEntry } from './repo-registry/shared';
import { refreshProjectsFromExternalMutation, useProjects, type ProjectRecord } from './repo-registry/useProjects';
import { MessageSquare, Play, Plus, Terminal } from './lucide-shims';
import { MiniAgentPanelAction } from './MiniAgentPanelAction';
import { MiniSessionMenu } from './agent-panel/MiniSessionMenu';
import { MiniAgentPanelNavigation } from './agent-panel/MiniAgentPanelNavigation';
import { ProjectIcon as FolderIcon } from './agent-panel/SidebarActionIcons';
import { repoSlugFromRemote } from './canvas-utils';
import { canCreateOrchestratorForRepo, deriveActiveProjectRepos, deriveAgentPanelRailRepos, resolveGlobalNewSessionRepo } from './agent-panel-repo-selection';
import { selectWorkingRepository } from './agent-panel/project-navigation';
import { ProjectsSwitcher } from './agent-panel/ProjectsSwitcher';
import { dispatchFocusRepoWorkspaceTab } from '@/lib/desktop/events';

import {
  AgentPanelEmptyState,
  SidebarSection,
  THEME_ACCENT,
  type AgentPanelProps,
  useAgentPanelState,
} from './agent-panel';

const LazyLeftPanelProjectFocus = retryingLazy(() => import('./repo-focus/LeftPanelProjectFocus').then(module => ({ default: module.LeftPanelProjectFocus })), { label: 'Project focus' });

const PROJECT_HISTORY_SECTIONS = ['orchestrator', 'chat'] as const;
const MINI_FLAT_BUTTON_BG = 'transparent';
const MINI_ROW_DIVIDER = '1px solid color-mix(in srgb, var(--t-divider-subtle) 62%, transparent)';

export const AgentPanel = memo<AgentPanelProps>(function AgentPanel(props: AgentPanelProps = {}) {
  const {
    activeSessionKey,
    navigationRail = false,
    selectedRepo,
    selectedRepoLocalPath,
    workingRepoPath,
    onLaunchWorkspaceAgent,
    onLaunchWorkspaceTask,
    onSelectSession,
    onOpenHistoryChat,
    onSelectIssue,
    onSelectCommit,
    onSelectPR,
    onReviewPR,
    onSelectRepo,
    onFocusAssistantTab,
    onCreateWorkspaceOrchestrator,
    onCreateWorkspaceChat,
    onCreateWorkspaceTerminal,
    onRepoRemoved,
    onOpenSpecInWorkspace,
    orchestratorPackets = [],
    orchestratorMissionState,
    registeredRepos = [],
    ideWorkspaceSessions,
    onOpenCommandPalette,
    onOpenProjectManagement,
    onOpenSettings,
    onOpenMobilePairing,
    leftPanelFocus: liftedLeftPanelFocus,
  } = props;

  const {
    agents,
    inventoryLoading,
    gatewayReachable,
    gatewayWarming,
    fleetMeta,
    reposOpen,
    setReposOpen,
    repoRegistryState,
    setRepoRegistryState,
    effectiveScopedRepo,
    currentLaunchRepoPath,
    workspacesSummary,
    titlebarSpacerHeight,
    refreshNow,
    launchRepoTask,
  } = useAgentPanelState({
    selectedRepo,
    selectedRepoLocalPath,
    onLaunchWorkspaceTask,
    onSelectSession,
    onAgentsUpdate: props.onAgentsUpdate,
  });
  // Projects ledger groups repos and drives the compact Projects dropdown.
  // The old footer dot switcher is retired so project navigation lives in
  // one place instead of competing with the bottom utility buttons.
  const projects = useProjects();

  // Boot claim — the left rail's first data (projects ledger + agent
  // inventory) landed ~3s AFTER the boot loader revealed the UI, so the
  // sidebar popped in with a layout shift (prod boot recording 2026-07-17).
  // Hold the shared boot loader until both first loads resolve, with a
  // fail-open cap so a dead API can't hold boot hostage. claimBootLoader is a
  // no-op after the boot latch, so later refetches never re-summon the splash.
  const [sidebarBootHoldExpired, setSidebarBootHoldExpired] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSidebarBootHoldExpired(true), 12000);
    return () => window.clearTimeout(timer);
  }, []);
  const sidebarBootHold = !sidebarBootHoldExpired && (projects.loading || inventoryLoading);

  // Prefer the lifted focus state when the dashboard supplies it, so column
  // width and panel content share a single source of truth. Falls back to a
  // local hook for legacy callers that mount AgentPanel without the prop.
  const localLeftPanelFocus = useLeftPanelProjectFocus({
    registeredRepos,
    ledger: projects.ledger,
  });
  const leftPanelFocus = liftedLeftPanelFocus ?? localLeftPanelFocus;
  const focusActive = leftPanelFocus.active;
  const [projectsMenuOpen, setProjectsMenuOpen] = useState(false);
  const registeredRepoByPath = useMemo(() => new Map(registeredRepos.map((repo) => [repo.localPath, repo])), [registeredRepos]);
  const registeredFocusRepos = useMemo(() => registeredRepos.map(toRepoFocusRepo), [registeredRepos]);
  const activeProjectReposForChats = useMemo(() => deriveActiveProjectRepos(
    projects.activeProject?.repoPaths ?? null,
    registeredFocusRepos,
  ), [projects.activeProject?.repoPaths, registeredFocusRepos]);
  const railReposForChats = useMemo(() => deriveAgentPanelRailRepos(
    activeProjectReposForChats,
    registeredFocusRepos,
    (projects.ledger?.projects ?? []).flatMap((project) => project.repoPaths),
  ), [activeProjectReposForChats, projects.ledger?.projects, registeredFocusRepos]);

  const activeProjectId = projects.activeProject?.id ?? null;
  const handleWorkInFocusedRepo = useCallback((repo: RepoFocusRepo) => {
    selectWorkingRepository(repo, onSelectRepo);
  }, [onSelectRepo]);
  const effectiveTitlebarSpacerHeight = Math.min(titlebarSpacerHeight, 10);
  const handleCreateOrchestrator = useCallback(() => {
    // #1572: the global New session must inherit what the rail is looking at.
    // Spawning repo-less fell back to the last-used workspace — with another project selected in the rail, the thread bound to the WRONG repo and a
    // "build this" turn dispatched a worker into it before the tiny breadcrumb
    // gave the mismatch away. Prefer the rail's selected repo, then the active
    // project's first repo; only a truly project-less rail spawns unbound.
    const selectedRepo = leftPanelFocus.view?.selectedRepo ?? null;
    const target = resolveGlobalNewSessionRepo(selectedRepo, activeProjectReposForChats);
    if (target && !canCreateOrchestratorForRepo(target)) return;
    if (target) {
      onCreateWorkspaceOrchestrator?.({
        name: target.name,
        localPath: target.localPath,
        remoteUrl: target.remoteUrl ?? undefined,
        branch: target.defaultBranch ?? null,
      });
      return;
    }
    onCreateWorkspaceOrchestrator?.();
  }, [onCreateWorkspaceOrchestrator, leftPanelFocus.view, activeProjectReposForChats]);
  // Repo-header [+] — spawn a fresh orchestrator bound to that repo
  // (Cursor's contextual New Agent pattern).
  const handleCreateOrchestratorForRepo = useCallback((repo: RepoFocusRepo) => {
    onCreateWorkspaceOrchestrator?.({
      name: repo.name,
      localPath: repo.localPath,
      remoteUrl: repo.remoteUrl ?? undefined,
      branch: repo.defaultBranch ?? null,
    });
  }, [onCreateWorkspaceOrchestrator]);
  const handleCreateChat = useCallback(() => {
    if (onCreateWorkspaceChat) {
      onCreateWorkspaceChat();
      return;
    }
    onFocusAssistantTab?.();
  }, [onCreateWorkspaceChat, onFocusAssistantTab]);
  const handleCreateTerminal = useCallback(() => {
    onCreateWorkspaceTerminal?.();
  }, [onCreateWorkspaceTerminal]);
  const handleOpenProjectManagement = useCallback(() => {
    setProjectsMenuOpen(false);
    onOpenProjectManagement?.();
  }, [onOpenProjectManagement]);
  const handleOpenAddRepoDialog = useCallback((localPath?: string) => {
    setProjectsMenuOpen(false);
    window.dispatchEvent(new CustomEvent('o8:open-add-repo-flow', { detail: { localPath } }));
  }, []);
  // Clicking a repo selects that specific repo so the right side shows it — no
  // auto control room, and the drawer stays open for repo-to-repo navigation.
  const handleMiniRepoSelect = useCallback((project: ProjectRecord, repoPath: string) => {
    const repo = registeredRepoByPath.get(repoPath);
    if (activeProjectId !== project.id) void projects.switchActive(project.id);
    if (dispatchFocusRepoWorkspaceTab({ repoId: repo?.id, repoPath })) return;
    onSelectRepo?.(repo?.id ?? repoPath);
  }, [activeProjectId, onSelectRepo, projects, registeredRepoByPath]);
  // The project name is the primary route into its overview. Repo disclosure
  // stays a separate control so expanding the tree never changes work context.
  const handleMiniProjectSelect = useCallback(async (project: ProjectRecord) => {
    const saved = await projects.switchActive(project.id);
    if (!saved) return false;
    const repoPath = project.repoPaths.includes(selectedRepoLocalPath ?? '') ? selectedRepoLocalPath : project.repoPaths[0];
    if (repoPath) {
      const repo = registeredRepoByPath.get(repoPath);
      if (!dispatchFocusRepoWorkspaceTab({ repoId: repo?.id, repoPath })) onSelectRepo?.(repo?.id ?? repoPath);
    }
    return true;
  }, [projects, selectedRepoLocalPath, registeredRepoByPath, onSelectRepo]);
  const onRepoAdded = props.onRepoAdded;
  const handleRepositoryConnected = useCallback(async (repo: RepoRegistryEntry) => {
    await onRepoAdded?.(repo);
    if (!dispatchFocusRepoWorkspaceTab({ repoId: repo.id, repoPath: repo.localPath })) onSelectRepo?.(repo.id);
  }, [onRepoAdded, onSelectRepo]);
  const handleMiniProjectOpen = useCallback((project: ProjectRecord) => {
    setProjectsMenuOpen(false);
    onOpenProjectManagement?.(project.id);
  }, [onOpenProjectManagement]);

  // When focus is active, the column itself widened — render the focus
  // surface inline so it occupies the whole AgentPanel column and keeps
  // the TitleBar + DesktopStatusBar visible above and below.
  if (focusActive && leftPanelFocus.view) {
    return (
      <div
        suppressHydrationWarning
        data-o8-agent-panel="true"
        style={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          // Match the unfocused AgentPanel — transparent over the macOS
          // vibrancy backdrop, no solid paper here. The focused drawer is
          // the same glass surface, just wider.
          background: 'transparent',
        } as CSSProperties}
      >
        <div
          suppressHydrationWarning
          style={{
            height: effectiveTitlebarSpacerHeight,
            flexShrink: 0,
            WebkitAppRegion: 'drag' as unknown as string,
          } as CSSProperties}
        />
        <Suspense fallback={null}>
          <LazyLeftPanelProjectFocus
            project={leftPanelFocus.view.project}
            repos={leftPanelFocus.view.repos}
            selectedRepoPath={leftPanelFocus.view.selectedRepo?.localPath ?? null}
            workingRepoPath={workingRepoPath ?? null}
            onSelectRepoPath={leftPanelFocus.setSelectedRepoPath}
            onWorkInRepo={handleWorkInFocusedRepo}
            onBack={leftPanelFocus.clearFocus}
            packets={orchestratorPackets}
            missionState={orchestratorMissionState}
            ideWorkspaceSessions={ideWorkspaceSessions}
            activeSessionKey={activeSessionKey}
            onSelectSession={onSelectSession}
            onOpenHistoryChat={onOpenHistoryChat}
            onOpenSpecInWorkspace={onOpenSpecInWorkspace}
          />
        </Suspense>
        <ConnectionPill />
        <FixedReportCard />
        <UpdateCard quiet={navigationRail} />
        {!navigationRail ? <AccountBlock onOpenSettings={onOpenSettings} onOpenMobilePairing={onOpenMobilePairing} /> : null}
      </div>
    );
  }

  return (
    <div
      suppressHydrationWarning
      data-o8-agent-panel="true"
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'transparent',
      } as CSSProperties}
    >
      {sidebarBootHold ? <WorkspaceBootLoaderClaim /> : null}
      <div
        suppressHydrationWarning
        style={{
          height: effectiveTitlebarSpacerHeight,
          flexShrink: 0,
          WebkitAppRegion: 'drag' as unknown as string,
        } as CSSProperties}
      />

      {projects.activeProject ? (
        <MiniAgentPanelHeader
          navigationRail={navigationRail}
          onCreateOrchestrator={handleCreateOrchestrator}
          onCreateChat={handleCreateChat}
          onCreateTerminal={handleCreateTerminal}
          onSearch={onOpenCommandPalette}
          projects={projects.ledger?.projects ?? []}
          projectsLoading={projects.loading || Boolean(projects.error)}
          activeProjectId={projects.ledger?.activeProjectId ?? null}
          selectedRepoPath={selectedRepoLocalPath ?? null}
          registeredRepoByPath={registeredRepoByPath}
          projectsOpen={projectsMenuOpen}
          onProjectsOpenChange={setProjectsMenuOpen}
          onRepoSelect={handleMiniRepoSelect}
          onProjectSelect={handleMiniProjectSelect}
          onOpenProject={handleMiniProjectOpen}
          onManageProjects={handleOpenProjectManagement}
          onAddRepo={handleOpenAddRepoDialog}
          onRepositoryConnected={handleRepositoryConnected}
        />
      ) : null}

      <div
        suppressHydrationWarning
        style={{
          flex: 1,
          overflowY: 'auto',
          position: 'relative',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          WebkitOverflowScrolling: 'touch',
          paddingTop: 4,
          paddingBottom: 18,
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
          // Symmetric fade — top edge softens against the navigation
          // section above, bottom edge fades into the button dock below.
          // Matches the o8.md panel pattern; 4px top + 32px bottom keeps
          // the bottom dock visually anchored while letting the top blend.
          maskImage: 'linear-gradient(to bottom, transparent 0px, black 4px, black calc(100% - 32px), transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent 0px, black 4px, black calc(100% - 32px), transparent 100%)',
        } as CSSProperties}
        className="hide-scrollbar"
      >
        {/* Workspaces section — the minimal panel is a project conversation
            stream with the repo context kept close to the project label. */}
        <section style={{ display: 'flex', flexDirection: 'column' }}>
          {fleetMeta?.mode === 'stale' ? (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: 'spring', stiffness: 380, damping: 32, mass: 0.6 }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                paddingTop: 10,
                paddingRight: 12,
                paddingBottom: 10,
                paddingLeft: 12,
                borderRadius: 14,
                background: 'var(--t-panel)',
                backdropFilter: 'saturate(180%) blur(20px)',
                WebkitBackdropFilter: 'saturate(180%) blur(20px)',
                border: '0.5px solid rgba(249, 115, 22, 0.22)',
                fontSize: 11.5,
                color: 'var(--t-text)',
                fontWeight: 500,
                letterSpacing: '-0.005em',
                fontFamily: 'var(--font-sans-system)',
              }}
            >
              <StaleStatusDot />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  lineHeight: 1.35,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                <strong style={{ fontWeight: 600 }}>Showing cached state</strong>
                <span style={{ color: 'var(--t-text-muted)', fontWeight: 400 }}> · gateway reconnecting</span>
              </span>
              <motion.button
                type="button"
                onClick={() => window.location.reload()}
                whileHover={{ backgroundColor: 'rgba(249, 115, 22, 0.14)' }}
                transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  border: '0.5px solid rgba(249, 115, 22, 0.32)',
                  borderRadius: 9,
                  background: 'rgba(249, 115, 22, 0.10)',
                  color: '#f97316',
                  paddingTop: 4,
                  paddingRight: 10,
                  paddingBottom: 4,
                  paddingLeft: 10,
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: '-0.005em',
                  fontFamily: 'var(--font-sans-system)',
                  flexShrink: 0,
                }}
              >
                Reload
              </motion.button>
            </motion.div>
          ) : gatewayReachable && gatewayWarming ? (
            <div
              style={{
                paddingTop: 14,
                paddingRight: 14,
                paddingBottom: 8,
                paddingLeft: 14,
                fontSize: 11.5,
                fontWeight: 300,
                color: 'var(--t-text-faint)',
                letterSpacing: '-0.005em',
                fontFamily: 'var(--font-sans-system)',
              }}
            >
              Loading workspaces...
            </div>
          ) : null}

          <AgentPanelExtraAgents onOpenChatReview={props.onOpenChatReview} activeSessionKey={activeSessionKey} onSelectSession={onSelectSession}
            packets={orchestratorMissionState?.packets ?? orchestratorPackets}
            renderContent={(agentEntries, agentViewActions) => <ChatsTab
            repos={railReposForChats}
            ideWorkspaceSessions={ideWorkspaceSessions}
            activeSessionKey={activeSessionKey}
            onSelectSession={onSelectSession}
            onOpenHistoryChat={onOpenHistoryChat}
            variant="mini"
            hideWhenEmpty={false}
            sectionLabel={null}
            sections={PROJECT_HISTORY_SECTIONS}
            showLiveSessions={false}
            groupMode="flat"
            showKindInMeta
            onCreateOrchestratorForRepo={handleCreateOrchestratorForRepo}
            emptyActions={navigationRail && !projects.loading && !projects.error ? <>
              <MiniAgentPanelAction icon={Play} label="New orchestrator" onClick={handleCreateOrchestrator} />
              <MiniAgentPanelAction icon={Terminal} label="New terminal" onClick={handleCreateTerminal} />
            </> : undefined}
            packets={orchestratorMissionState?.packets ?? orchestratorPackets}
            agentEntries={agentEntries}
            agentViewActions={agentViewActions}
          />} />
        </section>

        {/* AgentPanelEmptyState ("No active agents") removed — it tracked
            runtime-discovered CLI sessions, not workspace chat tabs, so it
            was misleading when the user had an Orchestrator or Assistant
            tab open. The repo list above is the primary panel content;
            discovered agent sessions appear inline on branch rows when
            they exist. */}

        {/* Repo focus is no longer an overlay — when focusActive, the
            AgentPanel returns LeftPanelRepoFocus inline above (the column
            widens). Nothing else to render here. */}

      </div>
      <ConnectionPill />
      <FixedReportCard />
      <UpdateCard quiet={navigationRail} />
      {!navigationRail ? <AccountBlock onOpenSettings={onOpenSettings} onOpenMobilePairing={onOpenMobilePairing} /> : null}
    </div>
  );
});

function MiniAgentPanelHeader({
  navigationRail,
  onCreateOrchestrator,
  onCreateChat,
  onCreateTerminal,
  onSearch,
  projects,
  projectsLoading,
  activeProjectId,
  selectedRepoPath,
  registeredRepoByPath,
  projectsOpen,
  onProjectsOpenChange,
  onRepoSelect,
  onProjectSelect,
  onOpenProject,
  onManageProjects,
  onAddRepo,
  onRepositoryConnected,
}: {
  onCreateOrchestrator?: () => void;
  onCreateChat?: () => void;
  onCreateTerminal?: () => void;
  navigationRail: boolean;
  onSearch?: () => void;
  projects: ProjectRecord[];
  projectsLoading: boolean;
  activeProjectId: string | null;
  selectedRepoPath: string | null;
  registeredRepoByPath: Map<string, RepoRegistryEntry>;
  projectsOpen: boolean;
  onProjectsOpenChange: (open: boolean) => void;
  onRepoSelect: (project: ProjectRecord, repoPath: string) => void;
  onProjectSelect: (project: ProjectRecord) => Promise<boolean>;
  onOpenProject: (project: ProjectRecord) => void;
  onManageProjects: () => void;
  onAddRepo: (localPath?: string) => void;
  onRepositoryConnected: (repo: RepoRegistryEntry) => Promise<void>;
}) {
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const runSessionAction = useCallback((action?: () => void) => {
    setSessionMenuOpen(false);
    action?.();
  }, []);

  return (
    <div
      style={{
        flexShrink: 0,
        paddingTop: 3,
        paddingRight: 0,
        paddingBottom: 4,
        paddingLeft: 0,
        borderBottom: '1px solid var(--t-divider-subtle)',
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {!navigationRail ? <MiniAgentPanelAction
          icon={Play}
          label="New session"
          active={sessionMenuOpen}
          disclosure="menu"
          onClick={() => {
            onProjectsOpenChange(false);
            setSessionMenuOpen((open) => !open);
          }}
        /> : null}
        {!navigationRail && sessionMenuOpen ? (
          <MiniSessionMenu
            onCreateOrchestrator={() => runSessionAction(onCreateOrchestrator)}
            onCreateTerminal={() => runSessionAction(onCreateTerminal)}
          />
        ) : null}
        {!navigationRail ? <MiniAgentPanelNavigation onCreateTerminal={onCreateTerminal} onSearch={onSearch} onBeforeNavigate={() => setSessionMenuOpen(false)} /> : null}
        {navigationRail ? <ProjectsSwitcher loading={projectsLoading} projects={projects} activeProjectId={activeProjectId} selectedRepoPath={selectedRepoPath} registeredRepoByPath={registeredRepoByPath} onProjectSelect={onProjectSelect} onRepoSelect={onRepoSelect} onManageProjects={onManageProjects} onAddRepo={onAddRepo} onRepositoryConnected={onRepositoryConnected} /> : <div style={{ display: 'flex', alignItems: 'center' }}>
          <MiniAgentPanelAction icon={FolderIcon} label="Projects" onClick={onManageProjects} />
          <button type="button" aria-label="Add repository" onClick={(event) => { event.currentTarget.focus(); onAddRepo(); }} onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onAddRepo(); }
          }} style={{ width: 28, height: 28, flexShrink: 0, border: 0, borderRadius: 7, background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer' }}><Plus size={14} /></button>
        </div>}

      </div>
    </div>
  );
}

function StaleStatusDot() {
  return (
    <span style={{ position: 'relative', width: 10, height: 10, flexShrink: 0 }}>
      <motion.span
        aria-hidden
        animate={{ scale: [1, 1.9, 1], opacity: [0.45, 0, 0.45] }}
        transition={{ duration: 1.6, ease: 'easeOut', repeat: Infinity }}
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 999,
          background: '#f97316',
        }}
      />
      <span
        style={{
          position: 'absolute',
          inset: 1,
          borderRadius: 999,
          background: '#f97316',
          boxShadow: '0 0 0 0.5px rgba(249, 115, 22, 0.55) inset',
        }}
      />
    </span>
  );
}

function ProjectRepoContext({
  repos,
  onSelectRepo,
}: {
  repos: RepoFocusRepo[];
  onSelectRepo: (repo: RepoFocusRepo) => void;
}) {
  if (repos.length === 0) return null;

  return (
    <div
      style={{
        paddingTop: 0,
        paddingRight: 10,
        paddingBottom: 8,
        paddingLeft: 10,
        borderBottom: '1px solid var(--t-divider-subtle)',
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <div
        style={{
          marginBottom: 6,
          fontSize: 9.5,
          lineHeight: '12px',
          fontWeight: 500,
          color: 'var(--t-text-faint)',
          letterSpacing: 0,
        }}
      >
        {repos.length} repo{repos.length === 1 ? '' : 's'} in this project
      </div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 5,
        }}
      >
        {repos.map((repo) => {
          const tone = projectRepoChipTone(repo);
          return (
            <button
              key={repo.localPath}
              type="button"
              onClick={() => onSelectRepo(repo)}
              aria-label={`Open ${repo.name}`}
              style={{
                minWidth: 0,
                maxWidth: '100%',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                paddingTop: 3,
                paddingRight: 7,
                paddingBottom: 3,
                paddingLeft: 7,
                borderRadius: 999,
                border: `1px solid ${tone.border}`,
                background: tone.background,
                color: 'var(--t-text)',
                cursor: 'pointer',
                fontFamily: 'var(--font-sans-system)',
                fontSize: 10.5,
                lineHeight: '14px',
                fontWeight: 500,
                letterSpacing: 0,
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = tone.hoverBackground;
                event.currentTarget.style.borderColor = tone.hoverBorder;
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = tone.background;
                event.currentTarget.style.borderColor = tone.border;
              }}
            >
              {tone.dot !== 'transparent' ? (
                <span
                  aria-hidden
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: '50%',
                    background: tone.dot,
                    flexShrink: 0,
                  }}
                />
              ) : null}
              <span
                style={{
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {repo.name}
              </span>
              <span
                style={{
                  flexShrink: 0,
                  color: tone.meta,
                  fontSize: 9.5,
                  fontWeight: 500,
                }}
              >
                {repo.readiness?.state === 'missing' ? 'folder missing' : repo.readiness?.state === 'blocked' ? 'attention' : repo.defaultBranch || 'main'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function projectRepoChipTone(repo: RepoFocusRepo): {
  dot: string;
  meta: string;
  border: string;
  background: string;
  hoverBorder: string;
  hoverBackground: string;
} {
  switch (repo.readiness?.state) {
    case 'missing': return { dot: 'var(--t-danger)', meta: 'var(--t-danger)', border: 'var(--t-danger-border)', background: 'var(--t-danger-soft)', hoverBorder: 'var(--t-danger)', hoverBackground: 'var(--t-danger-soft)' };
    case 'blocked': case 'needs_setup':
      return {
        dot: '#FF5A1F',
        meta: '#FF5A1F',
        border: 'rgba(255, 90, 31, 0.18)',
        background: 'rgba(255, 90, 31, 0.055)',
        hoverBorder: 'rgba(255, 90, 31, 0.28)',
        hoverBackground: 'rgba(255, 90, 31, 0.08)',
      };
    default:
      return {
        dot: 'transparent',
        meta: 'var(--t-text-faint)',
        border: 'var(--t-divider-subtle)',
        background: 'var(--t-input-bg)',
        hoverBorder: 'var(--t-border-strong, rgba(148,163,184,0.22))',
        hoverBackground: 'var(--t-hover, rgba(148,163,184,0.12))',
      };
  }
}
