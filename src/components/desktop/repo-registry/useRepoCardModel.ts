'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRepoPullRequests } from '@/lib/github-client';
import { requestConfirm, toast } from '@/components/shared/ConfirmToastHost';
import {
  FOCUS_REPO_SETUP_EVENT,
  formatBytes,
  githubSlugFromRemote,
  githubUrlFromRemote,
  normalizeSetupDraft,
  pointWithinRect,
  requestJson,
  shortenPath,
  worktreeStageTone,
  type BranchAgent,
  type BranchInfo,
  type FocusRepoSetupDetail,
  type OrchestratorPacket,
  type RepoPreviewPullRequest,
  type RepoRegistryEntry,
  type RepoSetupConfig,
  type RepoSetupEnvMode,
  type RepoWorktreeSummary,
  type WorktreeInfo,
  type WorkspaceCreateResult,
} from './shared';

export interface RepoCardProps {
  repo: RepoRegistryEntry;
  workspaceNotice: WorkspaceCreateResult | null;
  onLaunchAgent: (repo: RepoRegistryEntry) => void;
  onOpenWorkspace: (repo: RepoRegistryEntry) => void;
  onOpenGitHub: (repo: RepoRegistryEntry) => void;
  onLocate: (repo: RepoRegistryEntry) => void;
  onRemove: (repo: RepoRegistryEntry) => void;
  onSaveSetup: (repoId: string, setup: RepoSetupConfig) => Promise<void>;
  onSelectSession?: (sessionKey: string) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onReviewPR?: (prNumber: number, repo?: string) => void;
  onSelectBranch?: (branch: string, repoPath: string) => void;
  agentsByBranch?: Map<string, BranchAgent[]>;
  orchestratorPackets?: OrchestratorPacket[];
  activePorts?: number[];
  expanded: boolean;
  onToggle: () => void;
  onSelectRepo?: () => void;
  isActive?: boolean;
  activeSessionKey?: string | null;
  activeWorkspacePath?: string | null;
  activeWorkspaceTabKind?: 'terminal' | 'chat' | 'llm-chat' | 'canvas' | 'orchestrator' | null;
  onFocusOrchestratorTab?: () => void;
  onFocusAssistantTab?: () => void;
}

export function useRepoCardModel({
  repo,
  workspaceNotice,
  onSaveSetup,
  expanded,
}: RepoCardProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [cardWidth, setCardWidth] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftSetup, setDraftSetup] = useState<RepoSetupConfig>(repo.setup);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchDeleting, setBranchDeleting] = useState<string | null>(null);
  const [branchDeleteConfirm, setBranchDeleteConfirm] = useState<string | null>(null);
  const [hoveredBranchName, setHoveredBranchName] = useState<string | null>(null);
  const [branchHoverRect, setBranchHoverRect] = useState<DOMRect | null>(null);
  const [sessionDisclosureByBranch, setSessionDisclosureByBranch] = useState<Record<string, boolean>>({});
  const [createBranchOpen, setCreateBranchOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [newBranchWorktree, setNewBranchWorktree] = useState(false);
  const [newBranchCreating, setNewBranchCreating] = useState(false);
  const [newBranchError, setNewBranchError] = useState<string | null>(null);
  const [devServerRunning, setDevServerRunning] = useState(false);
  const [devServerStarting, setDevServerStarting] = useState(false);
  const [devServerPort, setDevServerPort] = useState<number | null>(null);
  const [devLogsOpen, setDevLogsOpen] = useState(false);
  const [devLogs, setDevLogs] = useState('');
  const [hoveringHeader, setHoveringHeader] = useState(false);
  const [hoverPreviewRect, setHoverPreviewRect] = useState<DOMRect | null>(null);
  const githubSlug = useMemo(() => githubSlugFromRemote(repo.remoteUrl), [repo.remoteUrl]);
  const prList = useRepoPullRequests(githubSlug, undefined, hoveringHeader);
  const prPreview = useMemo(() => (Array.isArray(prList.data?.prs) ? prList.data.prs : []).filter(pr => pr.state === 'OPEN'), [prList.data?.prs]);
  const prPreviewLoaded = Array.isArray(prList.data?.prs);
  const prPreviewLoading = prList.isFetching && !prPreviewLoaded;
  const [worktreeSummary, setWorktreeSummary] = useState<RepoWorktreeSummary | null>(null);
  const [worktreeSummaryLoading, setWorktreeSummaryLoading] = useState(false);
  const hoverOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const branchHoverOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const branchHoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [checkoutTarget, setCheckoutTarget] = useState<string | null>(null);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutDirty, setCheckoutDirty] = useState<{ files: string[]; fileCount: number } | null>(null);

  useEffect(() => {
    setDraftSetup(repo.setup);
  }, [repo.setup]);

  useEffect(() => {
    const node = cardRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;

    const updateWidth = () => {
      setCardWidth(node.getBoundingClientRect().width);
    };

    updateWidth();
    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width;
      if (typeof nextWidth === 'number') {
        setCardWidth(nextWidth);
      } else {
        updateWidth();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleFocusRepoSetup = (event: Event) => {
      const detail = (event as CustomEvent<FocusRepoSetupDetail>).detail;
      if (!detail || (detail.repoId !== repo.id && detail.repoPath !== repo.localPath)) {
        return;
      }
      setSettingsOpen(true);
      requestAnimationFrame(() => {
        cardRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    };

    window.addEventListener(FOCUS_REPO_SETUP_EVENT, handleFocusRepoSetup as EventListener);
    return () => {
      window.removeEventListener(FOCUS_REPO_SETUP_EVENT, handleFocusRepoSetup as EventListener);
    };
  }, [repo.id, repo.localPath]);

  useEffect(() => {
    if (!expanded) return;
    setBranchesLoading(true);
    fetch(`/api/panel/branches?path=${encodeURIComponent(repo.localPath)}`)
      .then((response) => response.json())
      .then((data) => setBranches(data.branches ?? []))
      .catch(() => setBranches([]))
      .finally(() => setBranchesLoading(false));
  }, [expanded, repo.localPath]);

  useEffect(() => {
    if (!expanded) return;
    fetch('/api/panel/dev-server')
      .then((response) => response.json())
      .then((data: { servers?: { id: string; cwd: string; port: number | null; alive: boolean }[] }) => {
        const resolved = repo.localPath.replace(/^~/, process.env.HOME || '');
        const server = data.servers?.find((entry) => entry.cwd === resolved || entry.id === `dev-${repo.localPath}`);
        if (server?.alive) {
          setDevServerRunning(true);
          setDevServerPort(server.port);
        } else {
          setDevServerRunning(false);
          setDevServerPort(null);
        }
      })
      .catch(() => {});
  }, [expanded, repo.localPath]);

  const handleStartDevServer = useCallback(async () => {
    const command = repo.setup.devCommand;
    if (!command) return;
    setDevServerStarting(true);
    try {
      const response = await fetch('/api/panel/dev-server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoPath: repo.localPath,
          command,
          port: repo.setup.defaultPort,
        }),
      });
      const data = await response.json();
      if (response.ok) {
        setDevServerRunning(true);
        setDevServerPort(data.port);
      }
    } catch {
      // silent
    } finally {
      setDevServerStarting(false);
    }
  }, [repo.localPath, repo.setup.defaultPort, repo.setup.devCommand]);

  const handleStopDevServer = useCallback(async () => {
    try {
      await fetch('/api/panel/dev-server', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPath: repo.localPath }),
      });
      setDevServerRunning(false);
      setDevServerPort(null);
    } catch {
      // silent
    }
  }, [repo.localPath]);

  useEffect(() => {
    if (!devLogsOpen || !devServerRunning) return;
    function fetchLogs() {
      fetch('/api/panel/dev-server')
        .then((response) => response.json())
        .then((data: { servers?: { id: string; lastOutput: string }[] }) => {
          const server = data.servers?.find((entry) => entry.id === `dev-${repo.localPath}`);
          if (server) setDevLogs(server.lastOutput);
        })
        .catch(() => {});
    }
    fetchLogs();
    const id = setInterval(fetchLogs, 5000);
    return () => clearInterval(id);
  }, [devLogsOpen, devServerRunning, repo.localPath]);

  const handleCheckout = useCallback(async (branch: string, opts?: { stash?: boolean; force?: boolean }) => {
    if (branch === branches.find((entry) => entry.current)?.name) return;
    setCheckoutBusy(true);
    setCheckoutDirty(null);
    try {
      const response = await fetch('/api/panel/branches/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoPath: repo.localPath,
          branch,
          stash: opts?.stash,
          force: opts?.force,
        }),
      });
      const data = await response.json();
      if (response.status === 409 && data.dirty) {
        setCheckoutTarget(branch);
        setCheckoutDirty({ files: data.files, fileCount: data.fileCount });
        return;
      }
      if (response.ok) {
        fetch(`/api/panel/branches?path=${encodeURIComponent(repo.localPath)}`)
          .then((result) => result.json())
          .then((data) => setBranches(data.branches ?? []))
          .catch(() => {});
        setCheckoutTarget(null);
      }
    } catch {
      // silent
    } finally {
      setCheckoutBusy(false);
    }
  }, [branches, repo.localPath]);

  const refreshBranches = useCallback(() => {
    fetch(`/api/panel/branches?path=${encodeURIComponent(repo.localPath)}`)
      .then((response) => response.json())
      .then((data) => setBranches(data.branches ?? []))
      .catch(() => {});
  }, [repo.localPath]);

  const refreshWorktreeSummary = useCallback(async () => {
    setWorktreeSummaryLoading(true);
    try {
      const data = await requestJson<RepoWorktreeSummary>(`/api/worktrees?repo=${encodeURIComponent(repo.localPath)}`);
      setWorktreeSummary(data);
    } catch {
      setWorktreeSummary(null);
    } finally {
      setWorktreeSummaryLoading(false);
    }
  }, [repo.localPath]);

  const staleWorktrees = useMemo(
    () => (worktreeSummary?.worktrees ?? []).filter((worktree) => worktree.status === 'stale'),
    [worktreeSummary],
  );

  const handleCleanupWorktree = useCallback(async (worktree: WorktreeInfo) => {
    const confirmed = await requestConfirm({
      title: `Clean up ${worktree.branch}?`,
      message: 'This removes the workspace directory and deletes the branch if possible.',
      confirmLabel: 'Clean up',
      danger: true,
    });
    if (!confirmed) return;

    try {
      await requestJson('/api/worktrees', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: repo.localPath,
          action: 'cleanup',
          worktreeId: worktree.id,
          force: worktree.status === 'stale',
          deleteBranch: true,
        }),
      });
      refreshBranches();
      await refreshWorktreeSummary();
    } catch (error) {
      toast(error instanceof Error ? error.message : `Unable to clean up ${worktree.branch}.`);
    }
  }, [refreshBranches, refreshWorktreeSummary, repo.localPath]);

  const handlePruneStaleWorktrees = useCallback(async () => {
    if (staleWorktrees.length === 0) return;
    const confirmed = await requestConfirm({
      title: `Prune ${staleWorktrees.length} stale workspace${staleWorktrees.length === 1 ? '' : 's'} for ${repo.name}?`,
      message: 'This removes the stale worktree directories and their branches.',
      confirmLabel: 'Prune',
      danger: true,
    });
    if (!confirmed) return;

    try {
      await requestJson('/api/worktrees', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: repo.localPath,
          action: 'prune',
        }),
      });
      refreshBranches();
      await refreshWorktreeSummary();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Unable to prune stale workspaces.');
    }
  }, [refreshBranches, refreshWorktreeSummary, repo.localPath, repo.name, staleWorktrees.length]);

  const handleDeleteBranch = useCallback(async (branchName: string, force?: boolean) => {
    setBranchDeleting(branchName);
    try {
      const response = await fetch('/api/panel/branches', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: repo.localPath, branch: branchName, force }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (data.canForce) {
          setBranchDeleteConfirm(branchName);
        }
        return;
      }
      setBranchDeleteConfirm(null);
      setHoveredBranchName(null);
      setBranchHoverRect(null);
      refreshBranches();
      void refreshWorktreeSummary();
    } catch {
      // silent
    } finally {
      setBranchDeleting(null);
    }
  }, [refreshBranches, refreshWorktreeSummary, repo.localPath]);

  const handleCreateBranch = useCallback(async () => {
    const name = newBranchName.trim();
    if (!name) return;
    setNewBranchCreating(true);
    setNewBranchError(null);
    try {
      const response = await fetch('/api/panel/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: repo.localPath,
          branch: name,
          baseBranch: repo.defaultBranch,
          worktree: newBranchWorktree,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setNewBranchError(data.error ?? 'Failed to create branch');
        return;
      }
      setNewBranchName('');
      setCreateBranchOpen(false);
      setNewBranchWorktree(false);
      refreshBranches();
      if (newBranchWorktree) {
        void refreshWorktreeSummary();
      }
    } catch (error) {
      setNewBranchError(error instanceof Error ? error.message : 'Failed');
    } finally {
      setNewBranchCreating(false);
    }
  }, [newBranchName, newBranchWorktree, refreshBranches, refreshWorktreeSummary, repo.defaultBranch, repo.localPath]);

  const githubUrl = useMemo(() => githubUrlFromRemote(repo.remoteUrl), [repo.remoteUrl]);
  const hasUnsavedChanges = JSON.stringify(draftSetup) !== JSON.stringify(repo.setup);

  useEffect(() => {
    return () => {
      if (hoverOpenTimerRef.current) clearTimeout(hoverOpenTimerRef.current);
      if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
      if (branchHoverOpenTimerRef.current) clearTimeout(branchHoverOpenTimerRef.current);
      if (branchHoverCloseTimerRef.current) clearTimeout(branchHoverCloseTimerRef.current);
    };
  }, []);

  const schedulePreviewHover = useCallback((element: HTMLDivElement, clientX: number, clientY: number) => {
    const rect = element.getBoundingClientRect();
    if (!pointWithinRect(rect, clientX, clientY)) return;

    if (hoverCloseTimerRef.current) {
      clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
    if (hoverOpenTimerRef.current) clearTimeout(hoverOpenTimerRef.current);
    hoverOpenTimerRef.current = setTimeout(() => {
      setHoverPreviewRect(rect);
      setHoveringHeader(true);
      hoverOpenTimerRef.current = null;
    }, 120);
  }, []);

  const closePreviewHover = useCallback(() => {
    if (hoverOpenTimerRef.current) {
      clearTimeout(hoverOpenTimerRef.current);
      hoverOpenTimerRef.current = null;
    }
    if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = setTimeout(() => {
      setHoveringHeader(false);
      setHoverPreviewRect(null);
    }, 140);
  }, []);

  const holdPreviewHover = useCallback(() => {
    if (hoverCloseTimerRef.current) {
      clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  }, []);

  const scheduleBranchHover = useCallback((branchName: string, element: HTMLDivElement, clientX: number, clientY: number) => {
    const rect = element.getBoundingClientRect();
    if (!pointWithinRect(rect, clientX, clientY)) return;

    if (branchHoverCloseTimerRef.current) {
      clearTimeout(branchHoverCloseTimerRef.current);
      branchHoverCloseTimerRef.current = null;
    }
    if (branchHoverOpenTimerRef.current) clearTimeout(branchHoverOpenTimerRef.current);
    branchHoverOpenTimerRef.current = setTimeout(() => {
      setHoveredBranchName(branchName);
      setBranchHoverRect(rect);
      branchHoverOpenTimerRef.current = null;
    }, 90);
  }, []);

  const holdBranchHover = useCallback(() => {
    if (branchHoverCloseTimerRef.current) {
      clearTimeout(branchHoverCloseTimerRef.current);
      branchHoverCloseTimerRef.current = null;
    }
  }, []);

  const closeBranchHover = useCallback(() => {
    if (branchHoverOpenTimerRef.current) {
      clearTimeout(branchHoverOpenTimerRef.current);
      branchHoverOpenTimerRef.current = null;
    }
    if (branchHoverCloseTimerRef.current) clearTimeout(branchHoverCloseTimerRef.current);
    branchHoverCloseTimerRef.current = setTimeout(() => {
      setHoveredBranchName(null);
      setBranchHoverRect(null);
    }, 120);
  }, []);

  const previewChecks = useMemo(() => Array.isArray(prPreview[0]?.statusCheckRollup)
    ? prPreview[0].statusCheckRollup as NonNullable<RepoPreviewPullRequest['statusCheckRollup']>
    : [], [prPreview]);
  const previewCheckCounts = useMemo(() => {
    const checks = previewChecks;
    return {
      passed: checks.filter((check) => check.conclusion?.toLowerCase() === 'success').length,
      failed: checks.filter((check) => check.conclusion?.toLowerCase() === 'failure').length,
      pending: checks.filter((check) => !check.conclusion || check.status?.toLowerCase() !== 'completed').length,
    };
  }, [previewChecks]);
  const previewFailingChecks = useMemo(
    () => previewChecks
      .filter((check) => check.conclusion?.toLowerCase() === 'failure')
      .map((check) => check.name || 'Unknown check')
      .slice(0, 3),
    [previewChecks],
  );

  useEffect(() => {
    if (!expanded) return;
    void refreshWorktreeSummary();
  }, [expanded, refreshWorktreeSummary]);

  // #532 — refetch branches + worktree summary whenever a lane lifecycle event
  // fires while this card is expanded. Without this the sidebar keeps showing
  // merged/archived branches until the operator manually collapses and
  // re-expands the card. Subscription is gated on `expanded` so collapsed
  // cards don't subscribe to events they won't render.
  useEffect(() => {
    if (!expanded) return;
    const handleLifecycle = () => {
      fetch(`/api/panel/branches?path=${encodeURIComponent(repo.localPath)}`)
        .then((response) => response.json())
        .then((data) => setBranches(data.branches ?? []))
        .catch(() => {});
      void refreshWorktreeSummary();
    };
    window.addEventListener('o8:lifecycle-reconcile', handleLifecycle);
    return () => {
      window.removeEventListener('o8:lifecycle-reconcile', handleLifecycle);
    };
  }, [expanded, refreshWorktreeSummary, repo.localPath]);

  useEffect(() => {
    if (!expanded || !workspaceNotice) return;
    void refreshWorktreeSummary();
  }, [expanded, refreshWorktreeSummary, workspaceNotice]);

  const worktreesByBranch = useMemo(
    () => new Map((worktreeSummary?.worktrees ?? []).map((worktree) => [worktree.branch, worktree])),
    [worktreeSummary],
  );
  const worktreeHealthBanner = useMemo(() => {
    if (worktreeSummaryLoading) {
      return {
        tone: worktreeStageTone('setup'),
        title: 'Checking workspace health',
        detail: 'Refreshing isolated workspace status for this repo.',
      };
    }
    if (worktreeSummary && worktreeSummary.conflicts.count > 0) {
      return {
        tone: worktreeStageTone('stale'),
        title: 'Blocked',
        detail: `${worktreeSummary.conflicts.count} overlapping worktree file${worktreeSummary.conflicts.count === 1 ? '' : 's'} need operator attention before stacking more work.`,
      };
    }
    if (staleWorktrees.length > 0) {
      return {
        tone: worktreeStageTone('cleaning'),
        title: 'Waiting',
        detail: `${staleWorktrees.length} stale workspace${staleWorktrees.length === 1 ? '' : 's'} can be cleaned up now. ${worktreeSummary ? `${worktreeSummary.worktrees.length} tracked · ${formatBytes(worktreeSummary.totalDiskUsage)}.` : ''}`,
      };
    }
    return null;
  }, [staleWorktrees.length, worktreeSummary, worktreeSummaryLoading]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await onSaveSetup(repo.id, normalizeSetupDraft(draftSetup));
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Unable to save setup profile.');
    } finally {
      setSaving(false);
    }
  }, [draftSetup, onSaveSetup, repo.id]);

  const updateEnvMode = useCallback((envMode: RepoSetupEnvMode) => {
    setDraftSetup((current) => ({
      ...current,
      envMode,
    }));
  }, []);

  const handleOpenDesktopPath = useCallback(async (editor: 'finder' | 'terminal', targetPath: string) => {
    try {
      await requestJson('/api/panel/open-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ editor, repo: targetPath }),
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : `Unable to open ${shortenPath(targetPath)}.`);
    }
  }, []);

  const handleCopyPath = useCallback(async (targetPath: string, label: string) => {
    try {
      await navigator.clipboard.writeText(targetPath);
    } catch {
      toast(`Unable to copy the ${label}.`);
    }
  }, []);

  return {
    cardRef,
    cardWidth,
    settingsOpen,
    setSettingsOpen,
    draftSetup,
    setDraftSetup,
    saving,
    saveError,
    setSaveError,
    branches,
    branchesLoading,
    branchDeleting,
    branchDeleteConfirm,
    setBranchDeleteConfirm,
    hoveredBranchName,
    branchHoverRect,
    sessionDisclosureByBranch,
    setSessionDisclosureByBranch,
    createBranchOpen,
    setCreateBranchOpen,
    newBranchName,
    setNewBranchName,
    newBranchWorktree,
    setNewBranchWorktree,
    newBranchCreating,
    newBranchError,
    setNewBranchError,
    devServerRunning,
    devServerStarting,
    devServerPort,
    devLogsOpen,
    setDevLogsOpen,
    devLogs,
    hoveringHeader,
    hoverPreviewRect,
    prPreviewLoading,
    prPreview,
    prPreviewLoaded,
    prPreviewError: prList.error || prList.data?.error,
    prPreviewUpdatedAt: prList.dataUpdatedAt,
    worktreeSummary,
    worktreeSummaryLoading,
    checkoutTarget,
    setCheckoutTarget,
    checkoutBusy,
    checkoutDirty,
    setCheckoutDirty,
    staleWorktrees,
    handleStartDevServer,
    handleStopDevServer,
    handleCheckout,
    refreshBranches,
    refreshWorktreeSummary,
    handleCleanupWorktree,
    handlePruneStaleWorktrees,
    handleDeleteBranch,
    handleCreateBranch,
    githubUrl,
    githubSlug,
    hasUnsavedChanges,
    schedulePreviewHover,
    holdPreviewHover,
    closePreviewHover,
    scheduleBranchHover,
    holdBranchHover,
    closeBranchHover,
    previewCheckCounts,
    previewFailingChecks,
    worktreesByBranch,
    worktreeHealthBanner,
    handleSave,
    updateEnvMode,
    handleOpenDesktopPath,
    handleCopyPath,
  };
}

export type RepoCardModel = ReturnType<typeof useRepoCardModel>;
