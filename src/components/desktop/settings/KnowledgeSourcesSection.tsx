'use client';
import { useEffect, useState } from 'react';
import { RamsButton } from './shared';
import { SettingsGroup } from './grouped';
import type { KnowledgeSource } from '@/lib/operator/knowledge-source-defaults';
type Source = KnowledgeSource & { state: string; facts: number; error?: string };
const inputStyle = { width: '100%', border: '1px solid var(--t-border)', borderRadius: 8, background: 'var(--t-bg-card)', color: 'var(--t-text)', font: 'inherit', padding: 8 };
export function KnowledgeSourcesSection() {
  const [sources, setSources] = useState<Source[]>([]);
  const [folder, setFolder] = useState(''); const [include, setInclude] = useState('**/*.md'); const [exclude, setExclude] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const response = await fetch('/api/cortex/sources', { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error('Knowledge sources could not be read.');
        if (!active) return;
        setSources(data.sources);
        if ((data.sources as Source[]).some(s => s.state === 'indexing')) timer = setTimeout(() => { void poll(); }, 2_000);
      } catch { if (active) setError('Knowledge sources could not be read. Reopen this page to retry.'); }
    }
    void poll();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [busy]);
  async function change(body: Record<string, unknown>) {
    if (busy) return; setBusy(true); setError(null);
    try { const response = await fetch('/api/cortex/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Knowledge source could not be updated.');
      setSources(data.sources); if (body.action === 'add') setFolder('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Knowledge source could not be updated.'); }
    finally { setBusy(false); }
  }
  return <SettingsGroup header="Knowledge sources" footnote="Read-only markdown folders for the Brain. Sources never become workspaces. Credential-shaped chunks are excluded before distillation; your connected Brain runtime handles the remaining text.">
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12 }}>
      {sources.map(source => <div key={source.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}><span>{source.name}</span><div style={{ color: 'var(--t-text-muted)', fontSize: 11 }}>{source.path} · {source.state} · {source.facts} facts</div>{source.error ? <div role="alert">{source.error}</div> : null}</div>
        <RamsButton disabled={busy} onClick={() => { void change({ action: 'remove', id: source.id }); }} aria-label={`Remove ${source.name} and its facts`}>Remove</RamsButton>
      </div>)}
      <label>Folder<input aria-label="Knowledge folder path" style={inputStyle} value={folder} disabled={busy} onChange={event => setFolder(event.target.value)} placeholder="Absolute path to a notes folder" /></label>
      <label>Include patterns<input aria-label="Knowledge include patterns" style={inputStyle} value={include} disabled={busy} onChange={event => setInclude(event.target.value)} /></label>
      <label>Exclude patterns<input aria-label="Knowledge exclude patterns" style={inputStyle} value={exclude} disabled={busy} onChange={event => setExclude(event.target.value)} placeholder="archive/**, attachments/**" /></label>
      <div style={{ color: 'var(--t-text-muted)', fontSize: 11 }}>Separate patterns with commas. Use *, ** or ?. Hidden folders and links are always skipped. Removing a source deletes its derived facts and leaves its files alone.</div>
      {error ? <div role="alert" style={{ color: 'var(--t-danger)' }}>{error}</div> : null}
      <div><RamsButton disabled={busy || !folder.trim()} busy={busy} onClick={() => { void change({ action: 'add', path: folder, include: include.split(',').map(p => p.trim()).filter(Boolean), exclude: exclude.split(',').map(p => p.trim()).filter(Boolean) }); }}>Add knowledge folder</RamsButton></div>
    </div>
  </SettingsGroup>;
}
