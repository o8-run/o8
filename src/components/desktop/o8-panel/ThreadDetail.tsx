'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ipcFetch } from '@/lib/tauri/ipc-fetch';
import { fetchCorrelatedActionReceipt } from '@/lib/orchestrator/action-receipt';
import type { TaskPoolTask } from '../repo-focus/tabs/control-room/types';
import { ActionButton } from '../repo-focus/tabs/control-room/shared';
import { RemoteTaskPreview } from '../repo-focus/tabs/control-room/RemoteTaskPreview';
import { THREAD_GROUPS, threadModelLabel, threadStatusLine } from './threads-model';
import { useOrchestratorData } from '../orchestrator-data-context';
import { usePendingThreadSteer } from './thread-steer-state';
import { ThreadActionButton } from './ThreadActions';
import { useWorkspaceChatDraftRetention } from '../workspace-terminal/workspace-chat-drafts';
import { useThreadEvidence } from './useThreadEvidence';
import { ThreadEvidenceView } from './ThreadEvidenceView';
import { redactThreadText } from '@/lib/threads/redaction';

interface Evidence {
  jobId: string;
  attempt: number;
  logs: { id: number; text: string }[];
  files: { path: string; status: string; additions: number; deletions: number }[];
  logsTruncated: boolean;
  filesTruncated: boolean;
}

function ThreadPreview({ taskId, jobId, attempt }: { taskId: string; jobId: string; attempt: number }) {
  const [open, setOpen] = useState(false);
  return <div aria-label="Thread preview" style={{ marginBottom: 16 }}>
    {open ? <RemoteTaskPreview taskId={taskId} jobId={jobId} attempt={attempt} onBack={() => setOpen(false)} />
      : <ThreadActionButton label="Remote preview" onClick={() => setOpen(true)} />}
  </div>;
}

export function ThreadDetail({ task, active, evidenceRevision, onBack, actions, showHeader = true }: {
  task: TaskPoolTask;
  active: boolean;
  evidenceRevision: number;
  onBack: () => void;
  actions: ReactNode;
  showHeader?: boolean;
}) {
  const context = useOrchestratorData();
  const threadEvidence = useThreadEvidence(task, active, evidenceRevision);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const pending = usePendingThreadSteer(task.packetId);
  const pendingSteer = pending.request;
  const { draft: message, setDraft: setMessage, retentionWarning } = useWorkspaceChatDraftRetention(
    JSON.stringify(['thread-steer', task.packetId ?? task.id]),
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const sendController = useRef<AbortController | null>(null);
  useEffect(() => () => sendController.current?.abort(), []);
  const jobId = task.execution?.jobId;
  const attempt = task.execution?.attempt;
  const evidenceKey = `${task.id}:${jobId}:${attempt}`;
  const currentError = error?.key === evidenceKey ? error.message : null;
  const packet = context?.missionState?.packets.find((entry) => entry.id === task.packetId);
  const currentEvidence = evidence && evidence.jobId === jobId && evidence.attempt === attempt ? evidence : null;

  useEffect(() => {
    if (!active || document.visibilityState === 'hidden' || !jobId || attempt === undefined) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ jobId, attempt: String(attempt) });
    void ipcFetch(`/api/tasks/${encodeURIComponent(task.id)}/evidence?${params}`, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json() as Evidence & { error?: string };
        if (!response.ok) throw new Error(payload.error || 'The current attempt is unavailable.');
        if (!controller.signal.aborted) { setEvidence(payload); setError(null); }
      })
      .catch((err) => { if (!controller.signal.aborted) setError({ key: evidenceKey, message: err instanceof Error ? err.message : 'Unable to read this attempt.' }); });
    return () => controller.abort();
  }, [active, evidenceRevision, task.id, jobId, attempt, evidenceKey]);

  const send = async () => {
    if (sendController.current || !task.packetId || (!pendingSteer && !message.trim())) return;
    const request = pending.readCurrent() ?? { id: crypto.randomUUID(), message: message.trim() };
    const controller = new AbortController();
    sendController.current = controller;
    setBusy(true);
    setNotice('Sending to this thread…');
    try {
      pending.save(request);
      const { response, payload } = await fetchCorrelatedActionReceipt<{
        ok?: boolean; error?: string | { code?: string; message?: string }; message?: string; outcomeUnknown?: boolean;
        result?: { note?: string; status?: string; inProgress?: boolean };
      }>('/api/orchestrator/steer-packet', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ packetId: task.packetId, message: request.message, source: 'operator', idempotencyKey: request.id }),
      }, { fetch: ipcFetch });
      if (!response.ok || payload?.ok !== true) {
        const failure = typeof payload?.error === 'object' ? payload.error : null;
        const unknown = response.headers.get('x-o8-steer-outcome') === 'unknown'
          || payload?.outcomeUnknown === true
          || failure?.code === 'steer_outcome_unknown' || failure?.code === 'outcome_unknown';
        if (payload?.ok === false && !unknown) pending.clear(request.id);
        throw new Error(payload?.message || failure?.message || (typeof payload?.error === 'string' ? payload.error : null) || 'The thread could not accept this message.');
      }
      const matchesPending = pending.readCurrent()?.id === request.id;
      pending.clear(request.id);
      if (matchesPending) setMessage((current) => current.trim() === request.message ? '' : current);
      setNotice(payload.result?.note || 'Message accepted by this thread.');
    } catch (err) {
      if (!controller.signal.aborted) setNotice(err instanceof Error ? err.message : 'Delivery is unconfirmed. Retry to check the same message.');
    } finally {
      sendController.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {showHeader ? <div style={{ display: 'flex', gap: 8, alignItems: 'center', paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, borderBottom: '1px solid var(--t-divider-subtle)' }}>
        <ActionButton label="Threads" onClick={onBack} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 300, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{redactThreadText(task.title)}</span>
      </div> : null}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollbarWidth: 'none', paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16 }}>
        <div style={{ fontSize: 10, fontWeight: 260, color: 'var(--t-text-faint)', overflowWrap: 'anywhere' }}>{THREAD_GROUPS.find((group) => group.id === task.group)?.label ?? task.status} · {threadModelLabel(task)} · {task.execution || (task.workerRouting?.selectedRuntime ?? task.runtime) === 'cloud' ? 'Remote worker' : 'Local worker'}{task.branch ? ` · ${task.branch}` : ''}</div>
        <p style={{ fontSize: 13.5, fontWeight: 300, lineHeight: 1.5, overflowWrap: 'anywhere' }}>{redactThreadText(threadStatusLine(task))}</p>
        {actions}
        {/* Only the visible current attempt owns this entry. Hiding the panel
            unmounts its resource and returns to an explicit open on re-entry. */}
        {active && task.group !== 'done' && task.execution?.previewAccess === 'requestable' && jobId && attempt !== undefined && attempt > 0
          ? <ThreadPreview key={evidenceKey} taskId={task.id} jobId={jobId} attempt={attempt} /> : null}
        {task.summary && task.summary !== threadStatusLine(task) ? <details style={{ marginBottom: 16 }}>
          <summary style={{ fontSize: 12, color: 'var(--t-text-muted)', cursor: 'pointer' }}>Task brief</summary>
          <p style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{redactThreadText(task.summary)}</p>
        </details> : null}
        {threadEvidence.error ? <p role="alert" style={{ fontSize: 12 }}>{threadEvidence.error}</p> : null}
        {threadEvidence.evidence ? <ThreadEvidenceView task={task} evidence={threadEvidence.evidence} /> : null}
        {!threadEvidence.evidence && packet?.taskContract ? (
          <section aria-label="Thread requirements" style={{ borderTop: '1px solid var(--t-divider-subtle)', paddingTop: 12 }}>
            <div style={{ fontSize: 10, color: 'var(--t-text-faint)' }}>Requirements</div>
            {packet.taskContract.requirements.map((requirement) => <p key={requirement.id} style={{ fontSize: 13, lineHeight: 1.5 }}>{redactThreadText(requirement.expectedBehavior)}</p>)}
          </section>
        ) : null}
        {jobId ? (
          <section aria-label="Thread output" style={{ borderTop: '1px solid var(--t-divider-subtle)', paddingTop: 12 }}>
            <div style={{ fontSize: 10, color: 'var(--t-text-faint)' }}>Attempt {attempt} · logs and files</div>
            {currentError ? <p role="alert">{currentError}</p> : !currentEvidence ? <p style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>Reading this attempt…</p> : null}
            {currentEvidence ? <>
              {currentEvidence.files.map((file) => <div key={file.path} style={{ paddingTop: 8, fontSize: 12, overflowWrap: 'anywhere' }}>{redactThreadText(file.path)} <span style={{ color: 'var(--t-text-faint)' }}>+{file.additions} −{file.deletions}</span></div>)}
              <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--t-text-secondary)' }}>{redactThreadText(currentEvidence.logs.map((log) => log.text).join('\n'))}</pre>
              {!currentEvidence.logs.length && !currentEvidence.files.length ? <p style={{ fontSize: 12 }}>No output recorded for this attempt yet.</p> : null}
              {currentEvidence.logsTruncated || currentEvidence.filesTruncated ? <p style={{ fontSize: 11, color: 'var(--t-text-faint)' }}>Showing the bounded output saved for this attempt.</p> : null}
            </> : null}
          </section>
        ) : null}
      </div>
      <div style={{ paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, borderTop: '1px solid var(--t-divider-subtle)' }}>
        <textarea aria-label="Steer this thread" placeholder="Steer this thread…" rows={2} value={pendingSteer?.message ?? message} disabled={busy || Boolean(pendingSteer) || !task.packetId || task.group === 'done'} onChange={(event) => setMessage(event.currentTarget.value)} style={{ width: '100%', boxSizing: 'border-box', resize: 'none', border: '1px solid var(--t-divider-subtle)', borderRadius: 10, background: 'var(--t-input-bg)', color: 'var(--t-text)', fontFamily: 'inherit', fontSize: 13, paddingTop: 10, paddingRight: 10, paddingBottom: 10, paddingLeft: 10 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <span role="status" style={{ flex: 1, fontSize: 11, lineHeight: 1.35, color: 'var(--t-text-muted)' }}>{retentionWarning || notice || (pendingSteer ? 'Delivery is unconfirmed. Check this message before sending another.' : task.group === 'done' ? 'This thread has finished.' : threadModelLabel(task))}</span>
          <ActionButton label={busy ? 'Sending…' : pendingSteer ? 'Check delivery' : 'Send'} primary disabled={busy || !task.packetId || task.group === 'done' && !pendingSteer || (!pendingSteer && !message.trim())} onClick={() => { void send(); }} />
        </div>
      </div>
    </div>
  );
}
