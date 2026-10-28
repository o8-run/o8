'use client';

import { useEffect, useState } from 'react';
import { RamsButton } from '../settings/shared';
import { broadcastProjectsUpdated, type ProjectRecord } from '../repo-registry/useProjects';
import type { ProjectContextApiResponse } from '../settings/projects/shared';

/** Edit the existing project description, not a second instructions store. */
export function ProjectInstructions({ project }: { project: ProjectRecord }) {
  const [result, setResult] = useState<ProjectContextApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/projects/context?projectId=${encodeURIComponent(project.id)}`, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json() as ProjectContextApiResponse;
        if (!response.ok || !data.context || data.context.runtimeProjectId !== project.id) throw new Error(data.error ?? 'Could not load this project’s instructions.');
        if (!controller.signal.aborted) { setResult(data); setError(null); }
      })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load project instructions.'); });
    return () => controller.abort();
  }, [project.id, refresh]);

  const save = async () => {
    if (!result?.context?.settingsProjectId || busy) return;
    setBusy(true); setError(null); setNotice('');
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(result.context.settingsProjectId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: draft.trim() || null }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? 'Instructions were not saved.');
      setEditing(false); setNotice('Saved. Future orchestrator turns and new worker tasks will receive these instructions.');
      setResult(null); setRefresh((value) => value + 1); broadcastProjectsUpdated();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Instructions were not saved.'); }
    finally { setBusy(false); }
  };
  const text = { fontSize: 13, lineHeight: 1.6, color: 'var(--t-text-secondary)' };
  return <section aria-label="Shared project instructions" style={{ border: '1px solid var(--t-divider)', borderRadius: 12, paddingTop: 20, paddingBottom: 20, paddingLeft: 20, paddingRight: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <h2 style={{ marginTop: 0, marginBottom: 0, fontSize: 18, fontWeight: 400, color: 'var(--t-text)' }}>Project instructions</h2>
      {!editing && result?.context?.settingsProjectId ? <RamsButton variant="ghost" onClick={() => { setDraft(result.context?.instructions ?? ''); setEditing(true); setNotice(''); }}>Edit instructions</RamsButton> : null}
    </div>
    {error ? <div role="alert" style={text}>{error} {!editing ? <RamsButton variant="ghost" onClick={() => setRefresh((value) => value + 1)}>Retry</RamsButton> : null}</div> : null}
    {notice ? <div role="status" style={text}>{notice}</div> : null}
    {editing ? <>
      <textarea aria-label="Project instructions" value={draft} onChange={(event) => setDraft(event.target.value)} disabled={busy} rows={5} style={{ ...text, width: '100%', resize: 'vertical', fontFamily: 'inherit', background: 'var(--t-input-bg)', border: '1px solid var(--t-divider)', borderRadius: 8, paddingTop: 12, paddingBottom: 12, paddingLeft: 12, paddingRight: 12 }} />
      <div style={{ display: 'flex', gap: 10 }}><RamsButton onClick={() => { void save(); }} busy={busy} disabled={busy}>Save instructions</RamsButton><RamsButton variant="ghost" disabled={busy} onClick={() => setEditing(false)}>Cancel</RamsButton></div>
    </> : result ? <div style={{ ...text, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{result.context?.instructions || 'None yet.'}</div> : !error ? <div style={text}>Reading project instructions…</div> : null}
    {result?.taskBrief ? <details><summary style={{ ...text, cursor: 'pointer', minHeight: 32 }}>Preview project context for agents</summary>
      <pre style={{ ...text, marginTop: 12, marginBottom: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{result.taskBrief}</pre>
    </details> : null}
  </section>;
}
