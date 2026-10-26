'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { ipcFetch } from '@/lib/tauri/ipc-fetch';
import { useProjects } from '../repo-registry/useProjects';
import { useOrchestratorData } from '../orchestrator-data-context';
import { AgentStatusDot, agentStatusToDotState } from '../AgentStatusDot';
import { NewTaskComposer } from '../repo-focus/tabs/control-room/NewTaskComposer';
import { createTaskRequest, type TaskExecutionRuntime } from '../repo-focus/tabs/control-room/create-task-request';
import { taskSessionKey, taskTimeLabel } from '../repo-focus/tabs/control-room/helpers';
import type { TaskAction, TaskMutationPayload, TaskPoolTask } from '../repo-focus/tabs/control-room/types';
import { THREAD_GROUPS, resolveThreadProject, scopeThreads, threadModelLabel, threadStatusLine } from './threads-model';
import { useThreadsTasks } from './useThreadsTasks';
import { useThreadDetailNavigation } from './useThreadNavigation';
import { useThreadRepos } from './useThreadRepos';
import { ThreadDetail } from './ThreadDetail';
import { ThreadActions, ThreadActionButton } from './ThreadActions';
import { ThreadActivity } from './ThreadActivity';
import { ThreadProjectView } from './ThreadProjectView';

const smallButtonStyle: React.CSSProperties = { height: 26, border: 0, borderRadius: 7, paddingLeft: 9, paddingRight: 9, fontSize: 12, fontWeight: 300, fontFamily: 'inherit', letterSpacing: '-0.1px', cursor: 'pointer', color: 'var(--t-text-muted)', background: 'transparent' };

export function O8ThreadsPane({ active, repoPath, repos, allRepos = false, initialView = 'threads', boundSessionKey }: {
  active: boolean;
  repoPath: string | null;
  repos: RepoRegistryEntry[];
  allRepos?: boolean;
  initialView?: 'threads' | 'agents';
  boundSessionKey?: string | null;
}) {
  const context = useOrchestratorData();
  const projects = useProjects();
  const project = resolveThreadProject(projects.ledger?.projects ?? [], projects.activeProject, repoPath, allRepos);
  const paths = useMemo(() => allRepos ? repos.map((repo) => repo.localPath) : repoPath ? [repoPath] : [], [allRepos, repos, repoPath]);
  const scope = useMemo(() => ({ projectId: project?.id ?? null, repoPaths: paths }), [paths, project?.id]);
  const scopeKey = JSON.stringify(scope);
  const pool = useThreadsTasks(active && !projects.loading, scopeKey);
  const registeredRepos = useThreadRepos(active, repoPath, repos);
  const tasks = useMemo(() => scopeThreads(pool.tasks, scope), [pool.tasks, scope]);
  const [view, setView] = useState<'threads' | 'agents' | 'library' | 'merges' | 'history'>(initialView);
  const [selection, setSelection] = useState<{ scopeKey: string; id: string } | null>(null);
  const [collapsed, setCollapsed] = useState<string[]>(['done']);
  const [composerOpen, setComposerOpen] = useState(false);
  const composerOpener = useRef<HTMLButtonElement | null>(null);
  const composerTitle = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => { if (composerOpen) composerTitle.current?.focus(); }, [composerOpen]);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [targetRepo, setTargetRepo] = useState(repoPath ?? repos[0]?.localPath ?? '');
  const [intent, setIntent] = useState('heavy_worker');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ scopeKey: string; task: TaskPoolTask; action: TaskAction; body?: Record<string, unknown> } | null>(null);
  const selected = boundSessionKey ? tasks.find((task) => taskSessionKey(task) === boundSessionKey)
    : selection?.scopeKey === scopeKey ? tasks.find((task) => task.id === selection.id) : null;
  useThreadDetailNavigation({
    active, repoPath, scopeKey, loading: pool.loading || projects.loading,
    taskIds: tasks.map((task) => task.id), selectedId: view === 'threads' ? selected?.id ?? null : null, boundSessionKey,
    select: (id) => { setView('threads'); setSelection({ scopeKey, id }); },
  });
  const missingSession = Boolean(boundSessionKey && !selected);
  const backToThreads = () => {
    if (boundSessionKey) context?.onOpenO8Panel?.({ repoPath, tab: 'threads' });
    else setSelection(null);
  };
  const waiting = tasks.filter((task) => task.group === 'blocked').length;
  const working = tasks.filter((task) => task.group === 'running').length;
  const resolved = tasks.filter((task) => task.group === 'done').length;
  const currentTargetRepo = paths.includes(targetRepo) ? targetRepo : paths[0] ?? '';
  const availableRepos = registeredRepos.filter((repo) => paths.includes(repo.localPath));
  const canCreate = Boolean(project && currentTargetRepo && availableRepos.some((repo) => repo.localPath === currentTargetRepo));

  const create = async (dispatch: boolean, runtime: TaskExecutionRuntime, model: string | null, effort: ThinkingEffort | null) => {
    if (busyKey || !project || !canCreate) return;
    setBusyKey('create');
    setNotice(dispatch ? 'Saving task and requesting an agent…' : 'Saving task…');
    try {
      const result = await createTaskRequest({ title: title.trim(), summary: summary.trim() || null, projectId: project.id, repoPath: currentTargetRepo, workerIntent: intent, requestedRuntime: runtime, model, requestedEffort: effort }, dispatch);
      setNotice(result);
      setTitle(''); setSummary(''); setComposerOpen(false);
      pool.refresh();
    } catch (err) { setNotice(err instanceof Error ? err.message : 'Unable to save this task.'); }
    finally { setBusyKey(null); }
  };

  const mutate = async (task: TaskPoolTask, action: TaskAction, body?: Record<string, unknown>) => {
    if (busyKey) return false;
    setBusyKey(`${action}:${task.id}`);
    setNotice('Updating this thread…');
    try {
      const response = await ipcFetch(`/api/tasks/${encodeURIComponent(task.id)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actor: 'orchestrator', projectId: task.project?.id ?? scope.projectId, repoPath: task.repoPath, ...body }) });
      const payload = await response.json() as Partial<TaskMutationPayload> & { error?: string };
      if (!response.ok || payload.ok === false) throw new Error(payload.error || payload.note || 'Unable to update this thread.');
      setNotice(payload.note || 'Thread updated.');
      pool.refresh();
      return true;
    } catch (err) { setNotice(err instanceof Error ? err.message : 'Unable to update this thread.'); return false; }
    finally { setBusyKey(null); }
  };

  const actOnThread = (task: TaskPoolTask, action: TaskAction, body?: Record<string, unknown>) => {
    if (action === 'archive' || action === 'prune' || action === 'remove') setConfirmation({ scopeKey, task, action, body });
    else void mutate(task, action, body);
  };

  return (
    <div aria-label="Project threads panel" style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', fontFamily: 'var(--font-sans-system)', color: 'var(--t-text)', background: 'transparent' }}>
      <div role={boundSessionKey ? 'group' : 'tablist'} aria-label={boundSessionKey ? 'Thread navigation' : 'Thread panel views'} style={{ display: 'flex', alignItems: 'center', minWidth: 0, gap: 6, paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 12, borderBottom: '1px solid var(--t-divider-subtle)' }}>
        {boundSessionKey ? <>
          <button type="button" onClick={backToThreads} style={{ ...smallButtonStyle, flexShrink: 0 }}>Threads</button>
          <span title={selected?.title} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 300 }}>{selected?.title}</span>
        </> : (['threads', 'library', 'merges', 'history', 'agents'] as const).map((tab) => <button key={tab} role="tab" aria-selected={view === tab} onClick={() => { setView(tab); if (tab === 'threads') backToThreads(); }} style={{ ...smallButtonStyle, background: view === tab ? 'var(--t-input-bg)' : 'transparent', color: view === tab ? 'var(--t-text)' : 'var(--t-text-muted)' }}>{tab[0].toUpperCase() + tab.slice(1)}</button>)}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={pool.refresh} disabled={pool.loading} style={{ ...smallButtonStyle, flexShrink: 0 }}>Refresh</button>
        {!boundSessionKey ? <button type="button" aria-label="Create task" disabled={!canCreate || Boolean(busyKey)} onClick={(event) => { composerOpener.current = event.currentTarget; if (composerOpen) event.currentTarget.focus(); setView('threads'); setSelection(null); setComposerOpen((open) => !open); }} style={smallButtonStyle}>+</button> : null}
      </div>
      {notice ? <div role="status" style={{ paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, fontSize: 11, fontWeight: 300, lineHeight: 1.4, color: 'var(--t-text-muted)' }}>{notice}</div> : null}
      {pool.error ? <div role="alert" style={{ paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, fontSize: 12 }}>{pool.error}</div> : null}
      {view === 'threads' && missingSession ? (
        <p role={pool.error ? 'alert' : 'status'} style={{ paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16, fontSize: 13, color: 'var(--t-text-muted)' }}>
          {pool.loading || projects.loading ? 'Reading this thread…' : pool.error ? 'Unable to read this session. Refresh to try again.' : 'This session is unavailable in this project. Open Threads to find the current attempt.'}
        </p>
      ) : view === 'threads' && selected ? <ThreadDetail key={`detail:${scopeKey}:${selected.id}`} task={selected} active={active} evidenceRevision={pool.evidenceRevision} onBack={backToThreads} showHeader={!boundSessionKey} actions={<ThreadActions task={selected} busy={Boolean(busyKey)} onSelectSession={boundSessionKey ? undefined : context?.onSelectSession} onAction={actOnThread} />} /> : (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollbarWidth: 'none', paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16 }}>
          {view === 'threads' ? <>
            <div style={{ fontSize: 18, fontWeight: 400, letterSpacing: '-0.2px', lineHeight: 1.25 }}>{project?.name || repoPath?.split('/').filter(Boolean).pop() || 'Your threads'}</div>
            <div style={{ marginTop: 6, marginBottom: 20, fontSize: 12, fontWeight: 300, color: 'var(--t-text-muted)' }}>{projects.loading || pool.loading && !tasks.length ? 'Reading project threads…' : waiting ? `${waiting} thread${waiting === 1 ? ' is' : 's are'} waiting on you.` : 'Nothing is waiting on you.'}</div>
            {composerOpen && canCreate ? <NewTaskComposer titleInputRef={composerTitle} repos={availableRepos} selectedRepo={availableRepos.find((repo) => repo.localPath === repoPath)} title={title} summary={summary} repoPath={currentTargetRepo} workerIntent={intent} busy={busyKey === 'create'} onTitleChange={setTitle} onSummaryChange={setSummary} onRepoPathChange={setTargetRepo} onWorkerIntentChange={setIntent} onCancel={() => { setComposerOpen(false); composerOpener.current?.focus(); }} onCreate={(runtime, model, effort) => { void create(false, runtime, model, effort); }} onCreateAndDispatch={(runtime, model, effort) => { void create(true, runtime, model, effort); }} /> : null}
            {pool.loading && !tasks.length ? <p style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>Reading project threads…</p> : null}
            {!pool.loading && !pool.error && !tasks.length ? <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>Start work from your conversation or save a task here. Workers can run commands locally on this machine. Recorded work appears here for review.</p> : null}
            <ThreadActivity tasks={tasks} />
            {THREAD_GROUPS.map((group) => {
              const entries = tasks.filter((task) => task.group === group.id || group.id === 'running' && task.group === 'ready');
              if (!entries.length) return null;
              const open = !collapsed.includes(group.id);
              return <section key={group.id} style={{ marginTop: 14 }}>
                <button type="button" aria-expanded={open} onClick={() => setCollapsed((current) => open ? [...current, group.id] : current.filter((id) => id !== group.id))} style={{ ...smallButtonStyle, width: '100%', textAlign: 'left', height: 30, display: 'flex', alignItems: 'center', gap: 8, background: 'var(--t-hover)' }}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ transform: open ? 'rotate(90deg)' : undefined }}><path d="m9 5 7 7-7 7" /></svg>
                  <span style={{ flex: 1 }}>{group.label}</span><span style={{ color: 'var(--t-text-faint)' }}>{entries.length}</span>
                </button>
                {open ? entries.map((task) => <button key={task.id} type="button" aria-label={`View thread ${task.title}`} onClick={() => setSelection({ scopeKey, id: task.id })} style={{ width: '100%', display: 'flex', gap: 10, alignItems: 'flex-start', border: 0, borderRadius: 7, background: 'transparent', color: 'var(--t-text)', textAlign: 'left', paddingTop: 12, paddingRight: 8, paddingBottom: 12, paddingLeft: 8, fontFamily: 'inherit', cursor: 'pointer' }} onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }} onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}>
                  <span style={{ paddingTop: 3 }}><AgentStatusDot state={agentStatusToDotState(task.status)} /></span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25 }}>{task.title}</span>
                    <span style={{ display: 'block', marginTop: 4, fontSize: 12, lineHeight: 1.4, fontWeight: 300, color: 'var(--t-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{threadStatusLine(task)}</span>
                    <span style={{ display: 'block', marginTop: 4, fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', color: 'var(--t-text-faint)' }}>{threadModelLabel(task)}{task.thread ? ` · ${task.thread.workers.length} workers · ${task.thread.merges.length} PRs` : ''}</span>
                  </span>
                  <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--t-text-faint)', whiteSpace: 'nowrap', paddingTop: 2 }}>{taskTimeLabel(task)}</span>
                </button>) : null}
              </section>;
            })}
          </> : <ThreadProjectView view={view} tasks={tasks} onOpen={(task) => { setSelection({ scopeKey, id: task.id }); setView('threads'); }} />}
        </div>
      )}
      {confirmation?.scopeKey === scopeKey ? <div role="group" aria-label="Confirm thread action" style={{ paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, borderTop: '1px solid var(--t-divider-subtle)', fontSize: 12 }}>
        <p style={{ marginTop: 0 }}>{confirmation.action === 'prune' ? 'Permanently prune' : confirmation.action === 'archive' ? 'Archive' : 'Un-queue'} “{confirmation.task.title}”?</p>
        <div style={{ display: 'flex', gap: 8 }}><ThreadActionButton label="Cancel" disabled={Boolean(busyKey)} onClick={() => setConfirmation(null)} /><ThreadActionButton label={busyKey ? 'Updating…' : confirmation.action === 'prune' ? 'Prune permanently' : confirmation.action === 'archive' ? 'Archive thread' : 'Un-queue thread'} danger={confirmation.action === 'prune'} disabled={Boolean(busyKey)} onClick={() => { void mutate(confirmation.task, confirmation.action, confirmation.body).then((ok) => { if (ok) setConfirmation(null); }); }} /></div>
      </div> : null}
      <div style={{ display: 'flex', gap: 12, paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, fontSize: 10, fontWeight: 260, color: 'var(--t-text-faint)', borderTop: '1px solid var(--t-divider-subtle)' }}><span>{working} working</span><span>{tasks.filter(task => task.group === 'ready').length} queued</span><span>{resolved} resolved</span><span style={{ marginLeft: 'auto' }}>{tasks.length} threads</span></div>
    </div>
  );
}
