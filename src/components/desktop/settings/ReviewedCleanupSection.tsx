'use client';

import { useEffect, useId, useRef, useState, type ComponentProps } from 'react';
import type { WorkspaceCleanupPlan } from '@/lib/worktree/cleanup-plan-types';
import { SettingsRow } from './grouped';
import { RamsButton as SettingsButton } from './RamsButton';

const endpoint = '/api/orchestrator/workspace/maintenance';
const storageKey = 'o8-reviewed-cleanup-plan';
const spacing = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const };
const inset = { paddingTop: 14, paddingRight: 14, paddingBottom: 14, paddingLeft: 14 };
const RamsButton = (props: ComponentProps<typeof SettingsButton>) => <SettingsButton {...props} size="touch" />;

export function ReviewedCleanupSection() {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [repos, setRepos] = useState<Array<{ id: string; name: string; localPath: string }>>([]);
  const [repoPath, setRepoPath] = useState('');
  const [plan, setPlan] = useState<WorkspaceCleanupPlan | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const busy = useRef(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);

  async function request(url: string, body?: unknown) {
    const response = await fetch(url, { cache: 'no-store', ...(body ? { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message ?? 'Cleanup could not be read.');
    return data;
  }

  async function perform(label: string, operation: (current: number) => Promise<void>) {
    if (busy.current) return;
    busy.current = true; setStage(label); setError('');
    const current = ++generation.current;
    try { await operation(current); }
    catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : 'Cleanup is unavailable.'); }
    finally { busy.current = false; if (current === generation.current) setStage(''); }
  }

  function display(next: WorkspaceCleanupPlan) {
    setPlan(next); setRepoPath(next.repositoryPath); setSelected(next.selection ?? []); setConfirming(false);
    try { window.sessionStorage.setItem(storageKey, next.id); } catch { /* Server receipt remains durable. */ }
  }

  const show = () => perform('Reading repositories and saved cleanup…', async current => {
    const data = await request('/api/panel/repos');
    if (current !== generation.current) return;
    setRepos(Array.isArray(data.repos) ? data.repos : []); setOpen(true);
    let previous: string | null = null;
    try { previous = window.sessionStorage.getItem(storageKey); } catch { /* Review can start without browser storage. */ }
    if (previous) {
      try {
        const result = await request(`${endpoint}?planId=${encodeURIComponent(previous)}`);
        if (current === generation.current) display(result.result.plan);
      } catch { if (current === generation.current) setError('Previous cleanup is unavailable in this profile. Preview another plan.'); }
    }
  });
  const preview = () => perform('Checking ownership and completed work…', async current => {
    const data = await request(endpoint, { action: 'preview', repoPath });
    if (current === generation.current) display(data.result.plan);
  });
  const execute = () => {
    if (!plan) return;
    void perform('Checking and retiring the approved selection…', async current => {
      const data = await request(endpoint, { action: 'execute', planId: plan.id,
        fingerprint: plan.fingerprint, selection: plan.selection ?? selected });
      if (current === generation.current) display(data.result.plan);
    });
  };

  return <>
    <SettingsRow label="Finished work" subtitle="Review exact workspaces and retained recovery before cleanup."
      accessory={<RamsButton variant="ghost" busy={Boolean(stage)} aria-expanded={open} aria-controls={id}
        onClick={() => { if (open) setOpen(false); else void show(); }}>Review cleanup</RamsButton>} />
    {open ? <div id={id} style={{ ...inset, fontSize: 13, fontWeight: 300, color: 'var(--t-text)', lineHeight: 1.5 }}>
      <div style={spacing}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, maxWidth: '100%' }}>Repository <select aria-label="Cleanup repository" value={repoPath} disabled={Boolean(stage)}
          onChange={event => { setRepoPath(event.target.value); setPlan(null); setSelected([]); setConfirming(false); }}
          style={{ backgroundColor: 'var(--t-input-bg)', color: 'var(--t-text)', maxWidth: 360, width: '100%', minWidth: 0, minHeight: 44 }}>
          <option value="">Choose a repository</option>
          {repos.map(repo => <option key={repo.id} value={repo.localPath}>{repo.name}</option>)}
        </select></label>
        <RamsButton variant="ghost" disabled={!repoPath || Boolean(stage)} onClick={() => void preview()}>Preview cleanup</RamsButton>
      </div>
      <p style={{ color: 'var(--t-text-faint)' }}>Only selected, completed o8 work is eligible. Held work stays in place. Source branches, recovery packages and receipts are retained.</p>
      {plan ? <>
        {plan.truncated ? <p>Showing the first 50 owned workspaces. New work is never added to this selection.</p> : null}
        {plan.entries.length === 0 ? <p>No managed workspaces in this repository.</p> : null}
        {plan.entries.map(entry => {
          const outcome = plan.outcomes.find(item => item.entryId === entry.id);
          const recovery = outcome?.recovery ?? entry.recovery;
          return <div key={entry.id} style={{ paddingTop: 10, paddingBottom: 10, borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: 'var(--t-border)' }}>
            <label style={{ ...spacing, minHeight: 44, overflowWrap: 'anywhere' }}><input type="checkbox" checked={selected.includes(entry.id)}
              disabled={!entry.eligible || Boolean(stage) || Boolean(plan.selection)}
              onChange={event => { setSelected(previous => event.target.checked ? [...previous, entry.id] : previous.filter(id => id !== entry.id)); setConfirming(false); }} />
              {entry.worktreeId} · {entry.kind === 'workspace' ? 'workspace' : 'generated output'}</label>
            <div>{outcome?.state ?? (entry.eligible ? 'Eligible' : 'Held')}{outcome?.reason || entry.reason ? ` · ${outcome?.reason ?? entry.reason}` : ''}</div>
            <div style={{ overflowWrap: 'anywhere', color: 'var(--t-text-faint)' }}>{entry.workspacePath}{entry.kind === 'generated-output' ? '/.next' : ''}</div>
            {entry.completion ? <div style={{ overflowWrap: 'anywhere' }}>Completed work: {entry.completion.packetId} · {entry.completion.status}</div> : null}
            {entry.head ? <div style={{ overflowWrap: 'anywhere' }}>Source commit: {entry.head}</div> : null}
            {entry.dependencies.length ? <div>Retire the selected generated output first.</div> : null}
            <div>Estimated file size: {entry.estimate.logicalBytes === null ? 'unknown' : `${entry.estimate.logicalBytes} bytes`}. Exclusive disk reclaim is unknown.</div>
            {recovery.ref ? <div style={{ overflowWrap: 'anywhere' }}>Retained source: {recovery.ref}</div> : null}
            {recovery.bankPath ? <div style={{ overflowWrap: 'anywhere' }}>Retained bank: {recovery.bankPath}</div> : null}
            {recovery.recoveryPath ? <div style={{ overflowWrap: 'anywhere' }}>Retained recovery: {recovery.recoveryPath}</div> : null}
            {outcome?.removedPaths?.map(path => <div key={path} style={{ overflowWrap: 'anywhere' }}>Removed: {path}</div>)}
            {outcome?.retainedPaths?.map(path => <div key={path} style={{ overflowWrap: 'anywhere' }}>Retained namespace: {path}</div>)}
          </div>;
        })}
        {plan.status === 'preview' ? confirming ? <div style={spacing}>
          <span>Clean {selected.length} selected {selected.length === 1 ? 'entry' : 'entries'} and retain recovery?</span>
          <RamsButton variant="danger" busy={Boolean(stage)} onClick={execute}>Confirm cleanup</RamsButton>
          <RamsButton variant="ghost" disabled={Boolean(stage)} onClick={() => setConfirming(false)}>Cancel</RamsButton>
        </div> : <RamsButton variant="danger" disabled={!selected.length || Boolean(stage)} onClick={() => setConfirming(true)}>Clean selected</RamsButton>
          : plan.status === 'running' ? <RamsButton variant="danger" busy={Boolean(stage)} onClick={execute}>Continue approved cleanup</RamsButton> : <p>Cleanup settled. Held entries remain retained.</p>}
        {plan.observedFreeSpace.map((observation, index) => <div key={index}>
          {index === 0 ? 'Before cleanup' : 'Latest observation'}: {observation.availableBytes} bytes available on the filesystem.
        </div>)}
        <p style={{ color: 'var(--t-text-faint)' }}>Free-space observations may include other activity and are not exclusive reclaimed bytes.</p>
      </> : null}
    </div> : null}
    {stage ? <div role="status" style={inset}>{stage}</div> : null}
    {error ? <div role="alert" style={inset}>{error}</div> : null}
  </>;
}
