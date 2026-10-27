import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { requestConfirm, requestPrompt, toast } from '@/components/shared/ConfirmToastHost';
import type { NavSection } from '@/app/dashboard/types';
import { FOCUS_REPO_SETUP_EVENT, OPEN_REPO_WORKSPACE_EVENT } from '@/lib/desktop/events';
import type { OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';
import { fetchSWRJson, getSWR } from '@/lib/panel/fetch-cache';
import { ipcFetch } from '@/lib/tauri/ipc-fetch';
import { isAbortError } from '@/lib/active-long-lived-request';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { WorktreeInfo } from '@/lib/worktree/types';
import type {
  RepoWorktreeSummary,
  WorkspaceScopeEntry,
} from '../types';
import {
  repoEntryToWorkspaceScope,
  repoSlugFromRemote,
} from '../utils';

interface UseGlobalRepoStateArgs {
  activeWorkspace: string | undefined;
  setActiveNavSection: Dispatch<SetStateAction<NavSection>>;
  setSidebarVisible: Dispatch<SetStateAction<boolean>>;
  sidebarVisible: boolean;
}

export function useGlobalRepoState({
  activeWorkspace,
  setActiveNavSection,
  setSidebarVisible,
  sidebarVisible,
}: UseGlobalRepoStateArgs) {
  // Global repo state (shared between TitleBar and AgentPanel)
  const [globalRepoId, setGlobalRepoId] = useState<string | null>(null);
  const [globalRepoBranch, setGlobalRepoBranch] = useState<string>('main');
  const [globalRepoEntries, setGlobalRepoEntries] = useState<RepoRegistryEntry[]>([]);
  const [allRepoWorktrees, setAllRepoWorktrees] = useState<Record<string, WorktreeInfo[]>>({});
  const globalRepoEntry = useMemo(
    () => globalRepoEntries.find((repo) => repo.id === globalRepoId) ?? null,
    [globalRepoEntries, globalRepoId],
  );
  const workspaceScopeEntries = useMemo<WorkspaceScopeEntry[]>(() => {
    const entries: WorkspaceScopeEntry[] = [];
    for (const repo of globalRepoEntries) {
      entries.push(repoEntryToWorkspaceScope(repo));
      for (const worktree of allRepoWorktrees[repo.localPath] ?? []) {
        entries.push({
          registryRepoId: repo.id,
          name: repo.name,
          localPath: worktree.path,
          branch: worktree.branch,
          readiness: null,
          remoteUrl: repo.remoteUrl ?? undefined,
          isWorktree: true,
          worktreeStatus: worktree.status,
        });
      }
    }
    return entries;
  }, [allRepoWorktrees, globalRepoEntries]);
  const orchestratorWorkspaceTargets = useMemo<OrchestratorWorkspaceTarget[]>(
    // Orchestrator packets dispatch against each repo's main checkout — never
    // against a worktree — so the picker only surfaces base-repo entries. Agent
    // worktrees (.claude/worktrees/*) and any branch-worktrees would otherwise
    // appear as duplicate "main" rows here.
    () => workspaceScopeEntries
      .filter((entry) => !entry.isWorktree)
      .map((entry) => ({
        id: entry.localPath,
        label: entry.name,
        repoName: entry.name,
        localPath: entry.localPath,
        branch: entry.branch ?? null,
        isWorktree: false,
        worktreeStatus: entry.worktreeStatus ?? null,
      })),
    [workspaceScopeEntries],
  );
  const workspaceTerminalPreferredRepo = useMemo(() => {
    const activeWorkspaceRepo = activeWorkspace
      ? globalRepoEntries.find((repo) => (
        activeWorkspace === repo.localPath
        || activeWorkspace.startsWith(`${repo.localPath}/`)
      )) ?? null
      : null;
    const source =
      (globalRepoEntry ? repoEntryToWorkspaceScope(globalRepoEntry) : null)
      ?? (activeWorkspace
        ? workspaceScopeEntries.find((entry) => entry.localPath === activeWorkspace)
          ?? (activeWorkspaceRepo ? repoEntryToWorkspaceScope(activeWorkspaceRepo) : null)
        : null)
      ?? (globalRepoEntries.length === 1 ? repoEntryToWorkspaceScope(globalRepoEntries[0]) : null);
    return source ? {
      name: source.name,
      localPath: source.localPath,
      branch: source.branch ?? source.readiness?.currentBranch ?? 'main',
      readiness: source.readiness ?? null,
      ...(source.remoteUrl ? { remoteUrl: source.remoteUrl } : {}),
      ...(source.registryRepoId ? { registryRepoId: source.registryRepoId } : {}),
      ...(source.isWorktree ? { isWorktree: true, worktreeStatus: source.worktreeStatus ?? null } : {}),
    } : null;
  }, [activeWorkspace, globalRepoEntries, globalRepoEntry, workspaceScopeEntries]);
  const globalRepo = useMemo(
    () => repoSlugFromRemote(globalRepoEntry?.remoteUrl),
    [globalRepoEntry],
  );
  const [selectedRepoWorktrees, setSelectedRepoWorktrees] = useState<RepoWorktreeSummary | null>(null);
  const [selectedRepoWorktreesLoading, setSelectedRepoWorktreesLoading] = useState(false);
  const [selectedRepoWorktreeRefreshNonce, setSelectedRepoWorktreeRefreshNonce] = useState(0);
  const selectedRepoWorktreeSnapshotsRef = useRef(new Map<string, RepoWorktreeSummary>());
  const selectedRepoWorktreeGenerationRef = useRef(0);
  const branchGenerationRef = useRef(0);
  // Shared across loadRegisteredRepos and refreshRestoredRepoState so the
  // most-recently-STARTED authoritative repo-inventory fetch always wins,
  // regardless of which one resolves first. A repos-changed/add/remove/touch
  // refresh that starts while a recovery refresh is still fanning out
  // worktree lookups must never be clobbered by that older, slower refresh
  // finishing later.
  const repoInventoryGenerationRef = useRef(0);
  // Counts completed, non-superseded inventory loads. Saved-scope restore
  // watches it to re-validate a failed scope once the inventory is in.
  const [repoInventoryRevision, setRepoInventoryRevision] = useState(0);
  // A confirmed mutation (a completed remove/touch response, or any other
  // caller-side authoritative rewrite of the repo list — see
  // page.tsx's handleRepoRemoved) is newer truth than anything currently in
  // flight. Bump the epoch so a loadRegisteredRepos/refreshRestoredRepoState
  // call that started BEFORE this mutation can never overwrite it with
  // pre-mutation data once that older, slower call finally resolves.
  const bumpRepoInventoryGeneration = useCallback(() => {
    repoInventoryGenerationRef.current += 1;
  }, []);

  const loadRepoWorktrees = useCallback(async (
    repoPath: string,
    signal?: AbortSignal,
    commit = true,
  ): Promise<RepoWorktreeSummary> => {
    const url = `/api/worktrees?repo=${encodeURIComponent(repoPath)}`;
    const response = signal ? await ipcFetch(url, { signal }) : await ipcFetch(url);
    const data = await response.json() as RepoWorktreeSummary & { error?: string };
    if (!response.ok) {
      throw new Error(data.error || 'Unable to load worktree summary.');
    }
    if (signal?.aborted) throw new DOMException('Request was aborted.', 'AbortError');
    const worktrees = Array.isArray(data.worktrees) ? data.worktrees : [];
    if (commit) {
      setAllRepoWorktrees((current) => ({
        ...current,
        [repoPath]: worktrees,
      }));
    }
    return { ...data, worktrees };
  }, []);

  const refreshSelectedRepoWorktrees = useCallback(async () => {
    if (!globalRepoEntry?.localPath) {
      setSelectedRepoWorktrees(null);
      return;
    }
    const repoPath = globalRepoEntry.localPath;
    const generation = ++selectedRepoWorktreeGenerationRef.current;
    setSelectedRepoWorktreesLoading(true);
    try {
      const data = await loadRepoWorktrees(repoPath);
      if (generation !== selectedRepoWorktreeGenerationRef.current) return;
      selectedRepoWorktreeSnapshotsRef.current.set(repoPath, data);
      setSelectedRepoWorktrees(data);
    } catch {
      if (generation === selectedRepoWorktreeGenerationRef.current) setSelectedRepoWorktrees(null);
    } finally {
      if (generation === selectedRepoWorktreeGenerationRef.current) setSelectedRepoWorktreesLoading(false);
    }
  }, [globalRepoEntry?.localPath, loadRepoWorktrees]);

  const loadRegisteredRepos = useCallback(async () => {
    const generation = ++repoInventoryGenerationRef.current;
    const cacheKey = 'panel:repos';
    const cached = getSWR<{ repos?: RepoRegistryEntry[] }>(cacheKey);
    if (cached.data && generation === repoInventoryGenerationRef.current) {
      setGlobalRepoEntries(cached.data.repos ?? []);
    }
    const data = await fetchSWRJson<{ repos?: RepoRegistryEntry[] }>(cacheKey, '/api/panel/repos');
    const repos = data.repos ?? [];
    // A fresher inventory fetch (this same function re-entered, or a
    // recovery refresh) may have already started and must win even if it
    // resolves later — never let a superseded fetch overwrite it.
    if (generation === repoInventoryGenerationRef.current) {
      setGlobalRepoEntries(repos);
      setRepoInventoryRevision((revision) => revision + 1);
    }
    return repos;
  }, []);

  // A saved workspace may finish its path validation after the initial repo
  // inventory request failed. Re-read the authoritative inventory and only
  // report recovery when every validated scope is present in that inventory
  // (or its authoritative worktree list). This is deliberately an explicit
  // retry path, not a second registry or a polling loop.
  const refreshRestoredRepoState = useCallback(async (validatedPaths: readonly string[], signal?: AbortSignal) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      if (signal?.aborted) return false;
      signal?.addEventListener('abort', abort, { once: true });
      const refresh = (async () => {
        try {
          const generation = ++repoInventoryGenerationRef.current;
          const response = await ipcFetch('/api/panel/repos', {
            cache: 'no-store',
            headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
            signal: controller.signal,
          });
          const data = await response.json().catch(() => null) as { repos?: unknown } | null;
          if (controller.signal.aborted || !response.ok || !Array.isArray(data?.repos)) return false;
          const repos = data.repos.filter((entry): entry is RepoRegistryEntry => (
            typeof entry === 'object'
            && entry !== null
            && typeof (entry as { id?: unknown }).id === 'string'
            && typeof (entry as { localPath?: unknown }).localPath === 'string'
          ));
          if (repos.length !== data.repos.length) return false;
          const needsWorktreeProof = validatedPaths.some((path) => !repos.some((repo) => (
            path === repo.localPath || path.startsWith(`${repo.localPath}/`)
          )));
          // Registered roots already establish scope for validated paths.
          // External paths still require exact authoritative worktree membership.
          const reposToLoad = needsWorktreeProof ? repos : [];
          const summaries: Array<readonly [string, RepoWorktreeSummary]> = [];
          let nextRepoIndex = 0;
          const workerCount = Math.min(8, reposToLoad.length);
          await Promise.all(Array.from({ length: workerCount }, async () => {
            while (!controller.signal.aborted) {
              const repo = reposToLoad[nextRepoIndex++];
              if (!repo) return;
              try {
                const summary = await loadRepoWorktrees(repo.localPath, controller.signal, false);
                summaries.push([repo.localPath, summary]);
              } catch {
                // An unrelated repo's worktree lookup failing (e.g. a 500)
                // must not sink recovery for every other repo. A path that
                // genuinely depends on THIS repo's worktree list stays
                // blocked below via hasAuthoritativeScope — absence never
                // becomes permission — but paths proven by other repos, or
                // root-owned, still go through.
              }
            }
          }));
          if (controller.signal.aborted) return false;
          const authoritativeWorktreePaths = new Set<string>();
          for (const [, summary] of summaries) {
            for (const worktree of summary.worktrees) authoritativeWorktreePaths.add(worktree.path);
          }
          const hasAuthoritativeScope = (path: string) => (
            repos.some((repo) => path === repo.localPath || path.startsWith(`${repo.localPath}/`))
            || authoritativeWorktreePaths.has(path)
          );
          if (!validatedPaths.every(hasAuthoritativeScope)) return false;
          // A newer inventory fetch (repos-changed/add/remove/touch, or
          // another recovery attempt) started while worktrees were still
          // loading — it may already have committed fresher state. Never let
          // this older, slower refresh overwrite it.
          if (generation !== repoInventoryGenerationRef.current) return false;

          setGlobalRepoEntries(repos);
          setAllRepoWorktrees((current) => {
            const next = Object.fromEntries(Object.entries(current)
              .filter(([repoPath]) => repos.some((repo) => repo.localPath === repoPath)));
            for (const [repoPath, summary] of summaries) next[repoPath] = summary.worktrees;
            return next;
          });
          return true;
        } catch {
          return false;
        }
      })();
      return await Promise.race([
        refresh,
        new Promise<false>((resolve) => {
          timeoutId = setTimeout(() => {
            controller.abort();
            resolve(false);
          }, 2_000);
        }),
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abort);
    }
  }, [loadRepoWorktrees]);

  // Fetch registered repos on mount — prefer saved repo, otherwise restore the first registered repo
  useEffect(() => {
    loadRegisteredRepos()
      .then((repos) => {
        const savedId = typeof window !== 'undefined' ? sessionStorage.getItem('cortex-global-repo-id') : null;
        if (savedId && repos.some((repo) => repo.id === savedId)) {
          setGlobalRepoId(savedId);
          return;
        }
        const fallbackRepo = repos[0] ?? null;
        if (!fallbackRepo) return;
        setGlobalRepoId(fallbackRepo.id);
        setGlobalRepoBranch(fallbackRepo.defaultBranch || 'main');
        if (typeof window !== 'undefined') {
          sessionStorage.setItem('cortex-global-repo-id', fallbackRepo.id);
        }
      })
      .catch(() => {
        // A failed startup request does not invalidate a newer successful
        // recovery or the last known inventory.
      });
  }, [loadRegisteredRepos]);

  // Refetch when a repo is added/removed anywhere (the add-repo dialog, etc.)
  // so the workspace targets show the new repo WITHOUT a manual reload —
  // operator-hit 2026-06-22: adding a repo didn't refresh the workspace.
  // loadRegisteredRepos refreshes globalRepoEntries → orchestratorWorkspaceTargets
  // re-derives.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => {
      void loadRegisteredRepos().catch((error: unknown) => {
        if (!isAbortError(error)) toast('Could not refresh repositories. Try opening the project again.');
      });
    };
    window.addEventListener('o8:repos-changed', handler);
    return () => window.removeEventListener('o8:repos-changed', handler);
  }, [loadRegisteredRepos]);

  const handleSelectRegisteredRepo = useCallback(async (repoId: string | null) => {
    setGlobalRepoId(repoId);
    if (!repoId) {
      setGlobalRepoBranch('main');
      if (typeof window !== 'undefined') {
        sessionStorage.removeItem('cortex-global-repo-id');
      }
      return;
    }

    if (typeof window !== 'undefined') {
      sessionStorage.setItem('cortex-global-repo-id', repoId);
    }

    const selected = globalRepoEntries.find((repo) => repo.id === repoId) ?? null;
    if (!selected) return;

    setGlobalRepoBranch(selected.defaultBranch || 'main');

    void fetch('/api/panel/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'touch', id: repoId }),
    })
      .then(async (response) => {
        const data = await response.json() as { repo?: RepoRegistryEntry };
        if (data.repo) {
          bumpRepoInventoryGeneration();
          setGlobalRepoEntries((current) => {
            const next = current.map((repo) => (repo.id === data.repo?.id ? data.repo : repo));
            return next;
          });
        }
      })
      .catch(() => null);
  }, [bumpRepoInventoryGeneration, globalRepoEntries]);

  const handleRemoveRegisteredRepo = useCallback(async (repoId: string) => {
    const target = globalRepoEntries.find((repo) => repo.id === repoId);
    if (!target) return;

    const confirmed = await requestConfirm({
      title: `Remove ${target.name} from o8?`,
      message: 'This only removes it from the local repo list. It does not delete the folder on disk.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) return;

    const response = await fetch('/api/panel/repos', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: repoId }),
    });
    const data = await response.json() as { error?: string };
    if (!response.ok) {
      throw new Error(data.error ?? 'Unable to remove repository.');
    }

    bumpRepoInventoryGeneration();
    setGlobalRepoEntries((current) => current.filter((repo) => repo.id !== repoId));
    if (globalRepoId === repoId) {
      setGlobalRepoId(null);
      setGlobalRepoBranch('main');
      if (typeof window !== 'undefined') {
        sessionStorage.removeItem('cortex-global-repo-id');
      }
    }
  }, [bumpRepoInventoryGeneration, globalRepoEntries, globalRepoId]);

  // Fetch branch when selected repo changes
  useEffect(() => {
    const generation = ++branchGenerationRef.current;
    if (!globalRepoEntry?.localPath) return;
    const controller = new AbortController();
    fetch(`/api/panel/branches?path=${encodeURIComponent(globalRepoEntry.localPath)}`, { signal: controller.signal })
      .then(r => r.json())
      .then(bData => {
        const current = (bData.branches ?? []).find((b: { current: boolean; name: string }) => b.current);
        if (current?.name && generation === branchGenerationRef.current) setGlobalRepoBranch(current.name);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [globalRepoEntry?.localPath]);

  useEffect(() => {
    const repoPath = globalRepoEntry?.localPath;
    ++selectedRepoWorktreeGenerationRef.current;
    setSelectedRepoWorktrees(repoPath ? selectedRepoWorktreeSnapshotsRef.current.get(repoPath) ?? null : null);
    setSelectedRepoWorktreesLoading(false);
    // Defer worktree refresh — not needed for initial shell paint
    const initTimer = setTimeout(() => { void refreshSelectedRepoWorktrees(); }, 1_500);
    if (!repoPath) {
      return () => clearTimeout(initTimer);
    }
    // WS-driven: instant refresh on lifecycle events instead of 30s polling
    const handler = () => { void refreshSelectedRepoWorktrees(); };
    const wsEvents = ['o8:lifecycle-reconcile'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = window.setInterval(handler, 300_000);
    return () => {
      clearTimeout(initTimer);
      for (const e of wsEvents) window.removeEventListener(e, handler);
      window.clearInterval(fallbackId);
    };
  }, [globalRepoEntry?.localPath, refreshSelectedRepoWorktrees, selectedRepoWorktreeRefreshNonce]);

  const handleOpenFolder = useCallback(async () => {
    let folderPath: string | null = null;

    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const result = await open({ directory: true, title: 'Select project folder' });
      if (typeof result === 'string') folderPath = result;
    } catch {
      try {
        const response = await fetch('/api/panel/browse-folder', { method: 'POST' });
        const data = await response.json() as { path?: string | null; unavailable?: boolean };
        // No picker program on this host: fall through to typed path entry.
        if (data.unavailable) throw new Error('native picker unavailable');
        if (data.path) folderPath = data.path;
      } catch {
        folderPath = await requestPrompt({ title: 'Open folder', message: 'Enter the folder path to add as a repository.', placeholder: '/path/to/folder' });
      }
    }

    if (!folderPath) return;

    try {
      const response = await fetch('/api/panel/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', localPath: folderPath }),
      });
      const data = await response.json() as {
        error?: string;
        repo?: RepoRegistryEntry;
      };

      if (!response.ok || !data.repo) {
        throw new Error(data.error ?? 'Unable to add repository.');
      }

      const repos = await loadRegisteredRepos();
      const selected = repos.find((repo) => repo.id === data.repo?.id) ?? data.repo;
      setGlobalRepoId(selected.id);
      if (data.repo.defaultBranch) {
        setGlobalRepoBranch(data.repo.defaultBranch);
      }
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('cortex-global-repo-id', selected.id);
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Unable to open folder.');
    }
  }, [loadRegisteredRepos]);

  const focusRepoSetup = useCallback((repoEntry: RepoRegistryEntry) => {
    setGlobalRepoId(repoEntry.id);
    setGlobalRepoBranch(repoEntry.defaultBranch || 'main');
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('cortex-global-repo-id', repoEntry.id);
    }
    setSidebarVisible(true);
    setActiveNavSection('agents');

    const dispatch = () => {
      window.dispatchEvent(new CustomEvent(FOCUS_REPO_SETUP_EVENT, {
        detail: {
          repoId: repoEntry.id,
          repoPath: repoEntry.localPath,
        },
      }));
    };

    if (sidebarVisible) {
      dispatch();
      return;
    }

    window.setTimeout(dispatch, 120);
  }, [setActiveNavSection, setSidebarVisible, sidebarVisible]);

  const handleFocusCurrentRepoSetup = useCallback(() => {
    if (!globalRepoEntry) {
      throw new Error('Select a repository before opening its setup profile.');
    }
    focusRepoSetup(globalRepoEntry);
  }, [focusRepoSetup, globalRepoEntry]);

  const openRepoWorkspaceModal = useCallback((repoEntry: RepoRegistryEntry) => {
    setGlobalRepoId(repoEntry.id);
    setGlobalRepoBranch(repoEntry.defaultBranch || 'main');
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('cortex-global-repo-id', repoEntry.id);
    }
    setSidebarVisible(true);
    setActiveNavSection('agents');

    const dispatch = () => {
      window.dispatchEvent(new CustomEvent(OPEN_REPO_WORKSPACE_EVENT, {
        detail: {
          repoId: repoEntry.id,
          repoPath: repoEntry.localPath,
        },
      }));
    };

    if (sidebarVisible) {
      dispatch();
      return;
    }

    window.setTimeout(dispatch, 120);
  }, [setActiveNavSection, setSidebarVisible, sidebarVisible]);

  const handleOpenRepoInDesktop = useCallback(async (editor: 'finder' | 'terminal') => {
    if (!globalRepoEntry?.localPath) {
      throw new Error('Select a repository before opening it outside Cortex.');
    }

    const response = await fetch('/api/panel/open-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editor, repo: globalRepoEntry.localPath }),
    });
    const data = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) {
      throw new Error(data.error || `Unable to open the repo in ${editor}.`);
    }
  }, [globalRepoEntry]);

  const staleSelectedRepoWorktrees = useMemo(
    () => (selectedRepoWorktrees?.worktrees ?? []).filter((worktree) => worktree.status === 'stale'),
    [selectedRepoWorktrees],
  );

  return {
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
    handleRemoveRegisteredRepo,
    handleSelectRegisteredRepo,
    loadRegisteredRepos,
    loadRepoWorktrees,
    refreshRestoredRepoState,
    repoInventoryRevision,
    openRepoWorkspaceModal,
    orchestratorWorkspaceTargets,
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
  };
}
