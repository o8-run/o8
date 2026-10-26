'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { requestJson, type RepoRegistryEntry } from './shared';
import { broadcastProjectsUpdated, type ProjectRecord } from './useProjects';
import { pickRepoFolder } from './pickRepoFolder';
import { isRepoUrl, recentRepoFolders, rememberRepoFolder, repoOpenError, type RecentRepoFolder } from './recent-repo-folders';

class RegistrationError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function register(value: string, cloning: boolean): Promise<RepoRegistryEntry> {
  const response = await fetch('/api/panel/repos', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cloning ? { action: 'clone', cloneUrl: value } : { action: 'add', localPath: value }),
  });
  const data = await response.json() as { repo: RepoRegistryEntry; error?: string };
  if (!response.ok) throw new RegistrationError(data.error || 'Could not open this folder. Try again.', response.status);
  return data.repo;
}

export interface AddRepoOptions {
  open: boolean;
  projects: ProjectRecord[];
  activeProjectId: string | null;
  initialMode?: 'scratch' | 'existing';
  initialPath?: string;
  onClose: () => void;
  onRepoAdded?: (repo: RepoRegistryEntry) => void | Promise<void>;
  onProjectsChanged?: () => void | Promise<void>;
}

export function useAddRepo(options: AddRepoOptions) {
  const { open, projects, activeProjectId, initialMode, initialPath, onClose, onRepoAdded, onProjectsChanged } = options;
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryState, setRetryState] = useState<string | null>(null);
  const [stage, setStage] = useState('');
  const [repos, setRepos] = useState<RepoRegistryEntry[]>([]);
  const [recents, setRecents] = useState<RecentRepoFolder[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const pending = useRef(false);
  const browsing = useRef(false);
  const opened = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const recovery = useRef<{ value: string; repo: RepoRegistryEntry; linked: boolean } | null>(null);
  const selectedProjectId = projectId ?? activeProjectId ?? 'none';
  const project = projects.find(row => row.id === selectedProjectId);

  const close = useCallback(() => {
    if (pending.current) return;
    generation.current += 1;
    setValue(''); setError(null); setRetryState(null); setProjectId(null); setBusy(false); setStage('');
    recovery.current = null;
    onClose();
  }, [onClose]);

  const submit = useCallback(async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed || pending.current) return;
    pending.current = true;
    setBusy(true); setError(null); setRetryState(null); setValue(trimmed);
    const cloning = isRepoUrl(trimmed);
    let cloningPending = cloning;
    const current = generation.current;
    const live = () => mounted.current && current === generation.current;
    try {
      let attempt = recovery.current?.value === trimmed ? recovery.current : null;
      if (!attempt) {
        setStage(cloning ? 'Cloning repository…' : 'Opening folder…');
        let repo: RepoRegistryEntry;
        try {
          repo = await register(trimmed, cloning);
        } catch (cause) {
          // A lost response may follow a durable write. Reconcile before retrying.
          if (cloning || (cause instanceof RegistrationError && cause.status < 500)) throw cause;
          const data = await requestJson<{ repos: Array<RepoRegistryEntry & { exists?: boolean }> }>('/api/panel/repos').catch(() => ({ repos: [] }));
          const saved = data.repos?.find(row => row.localPath === trimmed && row.exists !== false);
          if (!saved) throw cause;
          repo = saved;
        }
        if (!live()) return;
        attempt = { value: trimmed, repo, linked: false };
        recovery.current = attempt;
      }
      cloningPending = false;
      if (!attempt.linked && project && !project.repoPaths.includes(attempt.repo.localPath)) {
        setStage('Opening project…');
        // The membership API also maintains the stored project's repo links.
        const link = () => requestJson(`/api/panel/projects/${encodeURIComponent(project.id)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoPaths: [...new Set([...project.repoPaths, attempt.repo.localPath])] }),
        });
        try {
          await link();
        } catch {
          if (!cloning) throw new Error('Folder added, but the project could not be updated. Try again to finish opening it.');
          if (!live()) return;
          try {
            await link();
          } catch {
            if (live()) setRetryState('Cloned. Link pending.');
            return;
          }
        }
      }
      attempt.linked = true;
      if (!live()) return;
      setStage('Opening workspace…');
      try {
        broadcastProjectsUpdated();
        await onProjectsChanged?.();
        await onRepoAdded?.(attempt.repo);
      } catch {
        throw new Error('Folder added, but the workspace could not open. Try again to open it.');
      }
      if (!live()) return;
      rememberRepoFolder(attempt.repo);
      pending.current = false;
      close();
    } catch (cause) {
      if (live()) setError(repoOpenError(cause, cloningPending));
    } finally {
      pending.current = false;
      if (live()) { setBusy(false); setStage(''); }
    }
  }, [close, onProjectsChanged, onRepoAdded, project]);

  const browse = useCallback(async () => {
    if (pending.current || browsing.current) return;
    browsing.current = true;
    const current = generation.current;
    try {
      const path = await pickRepoFolder('Open repository', 'Enter a folder path or Git URL.', false);
      if (path && mounted.current && current === generation.current) await submit(path);
    } catch {
      if (mounted.current && current === generation.current) setError('Could not open the folder picker. Paste a folder path or Git URL, then choose Open.');
    } finally { browsing.current = false; }
  }, [submit]);

  useEffect(() => {
    if (!open) {
      if (opened.current) {
        generation.current += 1;
        pending.current = false;
        recovery.current = null;
        setValue(''); setError(null); setRetryState(null); setBusy(false); setStage(''); setProjectId(null);
      }
      opened.current = false;
      return;
    }
    if (opened.current) return;
    opened.current = true;
    setRecents(recentRepoFolders([]));
    const current = generation.current;
    void requestJson<{ repos: RepoRegistryEntry[] }>('/api/panel/repos').then(data => {
      if (!mounted.current || current !== generation.current) return;
      const entries = Array.isArray(data.repos) ? data.repos : [];
      setRepos(entries); setRecents(recentRepoFolders(entries));
    }).catch(() => { /* Manual entry and saved recents remain available. */ });
    if (initialPath) void submit(initialPath);
    else if (initialMode !== 'scratch') void browse();
  }, [open, initialMode, initialPath, browse, submit]);

  const changeValue = (next: string) => { setValue(next); setError(null); setRetryState(null); };
  const registered = recovery.current?.value === value.trim();
  return { value, changeValue, busy, error, setError, retryState, registered, stage, recents, repos, projectId: selectedProjectId, setProjectId, submit, browse, close };
}
