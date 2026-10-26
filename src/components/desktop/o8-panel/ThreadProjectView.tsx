'use client';
import type { TaskPoolTask } from '../repo-focus/tabs/control-room/types';
import { ThreadArtifacts, ThreadMerges, ThreadWorkers } from './ThreadEvidenceView';
import { ThreadActionButton } from './ThreadActions';
import { redactThreadDisplay } from '@/lib/threads/redaction';
export function ThreadProjectView({ view, tasks: recordedTasks, onOpen }: { view: string; tasks: TaskPoolTask[]; onOpen: (task: TaskPoolTask) => void }) {
  const tasks = recordedTasks.map(redactThreadDisplay);
  const artifacts = [...new Map(tasks.flatMap(task => task.thread?.artifacts ?? []).map(artifact => [artifact.id, artifact])).values()];
  const workers = tasks.flatMap(task => task.thread?.workers ?? []);
  const history = [...new Map(tasks.flatMap(task => (task.thread?.history ?? []).map(event => ({ ...event, task }))).map(event => [event.id, event])).values()].sort((a, b) => b.at.localeCompare(a.at));
  return <div style={{ minWidth: 0 }}>
    <div style={{ fontSize: 18, fontWeight: 400 }}>{view === 'library' ? 'Project library' : view === 'merges' ? 'Project merges' : view === 'history' ? 'Project history' : 'Agents in this scope'}</div>
    {view === 'library' ? <ThreadArtifacts artifacts={artifacts} /> : view === 'agents' ? <ThreadWorkers tasks={tasks} workers={workers} stages={tasks.filter(task => task.thread?.kind === 'mission').flatMap(task => task.thread?.stages ?? [])} />
      : view === 'merges' ? tasks.filter(task => task.thread?.kind !== 'mission' && task.thread?.merges.length).map(task => <section key={task.id}><div style={{ marginTop: 16 }}><ThreadActionButton label={`View thread ${task.title}`} onClick={() => onOpen(task)} /></div><ThreadMerges task={task} merges={task.thread!.merges} /></section>)
        : history.map(event => <div key={event.id} style={{ paddingTop: 12, paddingBottom: 12, borderBottom: '1px solid var(--t-divider-subtle)', overflowWrap: 'anywhere' }}><div style={{ fontSize: 13 }}>{event.label}</div><div style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--t-text-faint)' }}>{event.at} · {event.task.title}</div><ThreadActionButton label={`View thread ${event.task.title}`} onClick={() => onOpen(event.task)} /></div>)}
    {(view === 'merges' && !tasks.some(task => task.thread?.merges.length) || view === 'history' && !history.length) ? <p style={{ fontSize: 13, color: 'var(--t-text-muted)' }}>No recorded {view} in this project.</p> : null}
  </div>;
}
