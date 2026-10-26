'use client';

import { useState } from 'react';
import type { TaskAction, TaskPoolTask } from '../repo-focus/tabs/control-room/types';
import { taskSessionKey } from '../repo-focus/tabs/control-room/helpers';

export function ThreadActionButton({ label, danger = false, disabled = false, onClick }: {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return <button type="button" disabled={disabled} onClick={onClick} style={{
    minHeight: 28, borderRadius: 9, border: '1px solid var(--t-divider-subtle)',
    background: 'transparent', color: danger ? 'var(--t-danger, #dc2626)' : 'var(--t-text-muted)',
    paddingTop: 0, paddingRight: 10, paddingBottom: 0, paddingLeft: 10,
    fontFamily: 'inherit', fontSize: 11, fontWeight: 300,
    cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.58 : 1,
  }}>{label}</button>;
}

export function ThreadActions({ task, busy, onSelectSession, onAction }: {
  task: TaskPoolTask;
  busy: boolean;
  onSelectSession?: (key: string) => void;
  onAction: (task: TaskPoolTask, action: TaskAction, body?: Record<string, unknown>) => void;
}) {
  const [mode, setMode] = useState<'report' | 'block' | null>(null);
  const [message, setMessage] = useState('');
  const session = taskSessionKey(task);
  if (task.thread && !['packet', 'lane'].includes(task.thread.kind)) return <section aria-label="Thread actions" style={{ marginBottom: 16 }}>
    {task.thread.sessionKey && onSelectSession ? <ThreadActionButton label="Open session" disabled={busy} onClick={() => onSelectSession(task.thread!.sessionKey!)} /> : null}
  </section>;
  const queued = task.group === 'ready' || task.group === 'blocked';
  const done = task.group === 'done';
  return <section aria-label="Thread actions" style={{ marginBottom: 16 }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {session && onSelectSession ? <ThreadActionButton label="Open session" disabled={busy} onClick={() => onSelectSession(session)} /> : null}
      {queued ? <>
        <ThreadActionButton label="Claim" disabled={busy} onClick={() => onAction(task, 'claim')} />
        <ThreadActionButton label="Dispatch" disabled={busy} onClick={() => onAction(task, 'dispatch')} />
      </> : null}
      {!done ? <>
        <ThreadActionButton label="Report progress" disabled={busy} onClick={() => { setMode('report'); setMessage(''); }} />
        <ThreadActionButton label="Block" disabled={busy} onClick={() => { setMode('block'); setMessage(''); }} />
      </> : null}
      <ThreadActionButton label={done ? 'Prune permanently' : 'Archive'} danger={done} disabled={busy} onClick={() => onAction(task, done ? 'prune' : 'archive')} />
      {queued ? <ThreadActionButton label="Un-queue / remove" disabled={busy} onClick={() => onAction(task, 'remove')} /> : null}
    </div>
    {mode ? <div style={{ marginTop: 8 }}>
      <textarea aria-label={mode === 'report' ? 'Progress report' : 'Block reason'} rows={2} value={message} disabled={busy} onChange={(event) => setMessage(event.currentTarget.value)} style={{
        width: '100%', boxSizing: 'border-box', resize: 'none', border: '1px solid var(--t-divider-subtle)', borderRadius: 10,
        background: 'var(--t-input-bg)', color: 'var(--t-text)', fontFamily: 'inherit', fontSize: 13,
        paddingTop: 10, paddingRight: 10, paddingBottom: 10, paddingLeft: 10,
      }} />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <ThreadActionButton label="Cancel report" disabled={busy} onClick={() => setMode(null)} />
        <ThreadActionButton label={mode === 'report' ? 'Save progress' : 'Save block reason'} disabled={busy || !message.trim()} onClick={() => {
          onAction(task, mode, mode === 'report' ? { event: 'progress', message: message.trim() } : { reason: message.trim(), code: 'needs_clarification' });
          setMode(null);
        }} />
      </div>
    </div> : null}
  </section>;
}
