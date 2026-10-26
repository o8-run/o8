'use client';
import Image from 'next/image';
import { useEffect, useState } from 'react';
import type { ThreadEvidence, ThreadWorker } from '@/lib/threads/types';
import { ipcFetch } from '@/lib/tauri/ipc-fetch';
import { useOrchestratorData } from '../orchestrator-data-context';
import { useThreadEvidence } from './useThreadEvidence';
import { ThreadActionButton } from './ThreadActions';
import type { TaskPoolTask } from '../repo-focus/tabs/control-room/types';
import { redactThreadEvidence, redactThreadText } from '@/lib/threads/redaction';

const section = { marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--t-divider-subtle)', minWidth: 0 };
const label = { fontSize: 10, fontWeight: 300, color: 'var(--t-text-faint)', marginBottom: 8 };
const row = { paddingTop: 8, paddingBottom: 8, fontSize: 13, fontWeight: 300, lineHeight: 1.5, overflowWrap: 'anywhere' as const };
function ArtifactPreview({ artifact }: { artifact: ThreadEvidence['artifacts'][number] }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<{ id: string; text?: string; html?: string; mediaUrl?: string; error?: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let mediaUrl: string | undefined;
    if (!artifact.href.startsWith('/api/')) return;
    void ipcFetch(artifact.href, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Artifact unavailable.');
      if (artifact.kind === 'screenshot' || artifact.kind === 'video') {
        const blob = await response.blob();
        const type = artifact.kind === 'screenshot' ? 'image/' : 'video/';
        if (!blob.type.startsWith(type) || blob.size > 25 * 1024 * 1024) throw new Error('Media unavailable.');
        if (!controller.signal.aborted) {
          mediaUrl = URL.createObjectURL(blob);
          setContent({ id: artifact.id, mediaUrl });
        }
      } else if (artifact.interactive) {
        const body = await response.json();
        if (body?.result?.artifact?.id !== artifact.id || typeof body.result.artifact.html !== 'string') throw new Error('Artifact identity changed.');
        if (!controller.signal.aborted) setContent({ id: artifact.id, html: redactThreadText(body.result.artifact.html) });
      } else if (artifact.kind === 'file') {
        const body = await response.json();
        if (typeof body.content !== 'string') throw new Error('File unavailable.');
        if (!controller.signal.aborted) setContent({ id: artifact.id, text: redactThreadText(body.content).slice(0, 64 * 1024) });
      } else {
        const text = redactThreadText(await response.text()).slice(0, 64 * 1024);
        if (!controller.signal.aborted) setContent({ id: artifact.id, text });
      }
    }).catch(() => { if (!controller.signal.aborted) setContent({ id: artifact.id, error: 'Artifact unavailable. Return to its thread and refresh.' }); });
    return () => { controller.abort(); if (mediaUrl) URL.revokeObjectURL(mediaUrl); };
  }, [open, artifact.href, artifact.id, artifact.interactive, artifact.kind]);
  const current = content?.id === artifact.id ? content : null;
  const title = redactThreadText(artifact.title);
  return <div style={row}>
    <button type="button" aria-expanded={open} onClick={() => { setOpen(value => !value); setContent(null); }} style={{ border: 0, background: 'transparent', color: 'var(--t-accent)', fontFamily: 'inherit', fontSize: 'inherit', fontWeight: 'inherit', cursor: 'pointer', paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, textAlign: 'left', overflowWrap: 'anywhere' }}>{title}</button>
    {open ? <div style={{ marginTop: 8 }}>
      {artifact.kind === 'file' ? <p style={label}>Current working copy · bounded read-only preview</p> : null}
      {artifact.kind === 'screenshot' && current?.mediaUrl ? <Image unoptimized width={1200} height={900} src={current.mediaUrl} alt={title} style={{ maxWidth: '100%', height: 'auto' }} />
        : artifact.kind === 'video' && current?.mediaUrl ? <video src={current.mediaUrl} controls preload="metadata" aria-label={title} style={{ maxWidth: '100%' }} />
          : current?.html ? <><p style={label}>Read-only artifact preview. Actions remain in the original artifact.</p><iframe title={title} sandbox="" srcDoc={current.html} style={{ width: '100%', height: 320, border: '1px solid var(--t-divider-subtle)' }} /></>
            : <pre role={current?.error ? 'alert' : undefined} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{current?.error || current?.text || 'Reading artifact…'}</pre>}
    </div> : null}
  </div>;
}
export function ThreadArtifacts({ artifacts }: { artifacts: ThreadEvidence['artifacts'] }) {
  return <section aria-label="Thread artifacts" style={section}><div style={label}>Artifacts</div>
    {artifacts.length ? artifacts.map(artifact => <ArtifactPreview key={artifact.id} artifact={artifact} />) : <p style={row}>No artifacts recorded.</p>}
  </section>;
}
function RecordedWorker({ worker, task }: { worker: ThreadWorker; task?: TaskPoolTask }) {
  const [read, setRead] = useState(false);
  const detail = useThreadEvidence(task ?? { id: worker.sessionKey, repoPath: null } as TaskPoolTask, read, 0);
  const current = read ? detail.evidence?.workers.find(item => item.sessionKey === worker.sessionKey) ?? worker : worker;
  return <div style={row}><div>{current.name} · {current.runtime} · {current.model || 'Model not recorded'}</div>
    <div style={{ ...label, marginBottom: 0 }}>{current.stage || worker.stage || 'Direct spawn'} · {current.status} · {current.tokens === null ? 'Tokens not recorded' : `${current.tokens.toLocaleString()} tokens`} · {current.tools === null ? 'Tools not recorded' : `${current.toolsTruncated ? 'At least ' : ''}${current.tools} tools`}</div>
    {worker.tools === null && task ? <ThreadActionButton label="Read recorded tools" onClick={() => setRead(true)} disabled={read} /> : null}
    {detail.error ? <p role="alert" style={label}>{detail.error}</p> : null}
  </div>;
}
export function ThreadWorkers({ workers, stages = [], tasks = [] }: { tasks?: TaskPoolTask[]; workers: ThreadWorker[]; stages?: ThreadEvidence['stages'] }) {
  const unique = [...new Map(workers.map(worker => [worker.sessionKey, worker])).values()];
  const working = unique.filter(worker => ['working', 'running', 'launching', 'busy'].includes(worker.status)).length;
  const settled = unique.filter(worker => ['completed', 'archived', 'released', 'idle', 'finished', 'done'].includes(worker.status)).length;
  const known = unique.filter(worker => worker.tokens !== null);
  return <section aria-label="Thread agents" style={section}>
    <div style={label}>Agents</div>
    {stages.map(stage => <div key={stage.name} style={row}>{stage.name} · {stage.done}/{stage.total} settled {stage.done === stage.total ? '✓' : ''}</div>)}
    {unique.map(worker => <RecordedWorker key={worker.sessionKey} worker={worker} task={tasks.find(task => task.thread?.kind !== 'mission' && task.thread?.sessionKey === worker.sessionKey)} />)}
    <div style={row}>{working} working · {settled} settled{unique.length > working + settled ? ` · ${unique.length - working - settled} waiting or unknown` : ''} · Σ {known.reduce((sum, worker) => sum + worker.tokens!, 0).toLocaleString()} tok{known.length < unique.length ? ' (recorded usage only)' : ''}</div>
  </section>;
}
export function ThreadMerges({ task, merges }: { task: TaskPoolTask; merges: ThreadEvidence['merges'] }) {
  const context = useOrchestratorData();
  return <section aria-label="Thread merges" style={section}><div style={label}>Merges and branches{task.branch ? ` · ${task.branch}` : ''}</div>
    {merges.length ? merges.map(pr => <div key={pr.id} style={row}><div>{pr.title} · {pr.state} · Checks {pr.checks}</div>
      {pr.head ? <div style={label}>HEAD {pr.head.slice(0, 12)}</div> : null}
      {task.laneId && context?.onOpenO8Panel ? <ThreadActionButton label={`Review ${pr.title}`} onClick={() => context.onOpenO8Panel!({ repoPath: task.repoPath, tab: 'review', reviewLaneId: task.laneId! })} /> : null}
    </div>) : <p style={row}>No pull request identity recorded.</p>}
  </section>;
}
export function ThreadEvidenceView({ task, evidence: recorded }: { task: TaskPoolTask; evidence: ThreadEvidence }) {
  const evidence = redactThreadEvidence(recorded);
  return <>
    <section aria-label="Thread requirements" style={section}><div style={label}>Requirements · {evidence.requirements.filter(item => item.covered).length}/{evidence.requirements.length} evidenced</div>
      {evidence.requirements.length ? evidence.requirements.map(item => <label key={item.id} style={{ ...row, display: 'block' }}><input type="checkbox" checked={item.covered} readOnly disabled /> {item.text}<div style={label}>{item.covered ? 'Current review evidence' : 'Awaiting current review evidence'} · {item.verification}</div></label>) : <p style={row}>No task contract recorded.</p>}
    </section>
    <ThreadArtifacts artifacts={evidence.artifacts} /><ThreadMerges task={task} merges={evidence.merges} /><ThreadWorkers workers={evidence.workers} stages={evidence.stages} />
    {evidence.truncated ? <p style={label}>Showing bounded recorded evidence. Older details remain in the source session and activity history.</p> : null}
  </>;
}
