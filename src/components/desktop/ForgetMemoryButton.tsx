'use client';

import { useState } from 'react';
import { RamsButton } from './settings/shared';

/** Inline confirmation belongs to the exact retained item, never a bulk reset. */
export function ForgetMemoryButton({ kind, id, label, repoPath, projectId }: { kind: 'directive' | 'outcome' | 'correction'; id: string; label: string; repoPath?: string; projectId?: string | null }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const noun = kind === 'directive' ? 'instruction' : kind === 'correction' ? 'correction' : 'outcome';
  const remove = async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/cortex/${kind === 'directive' ? 'directives' : kind === 'correction' ? 'operator-corrections' : 'recent-outcomes'}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...(kind === 'outcome' ? { repoPath, projectId } : {}) }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || 'Could not delete this item. Try again.');
      window.dispatchEvent(new CustomEvent('o8:cortex-changes', { detail: { data: { scope: kind } } }));
      setConfirming(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not delete this item.'); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
      {confirming ? <div role="group" aria-label={`Delete ${noun} confirmation`} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--t-text-secondary)' }}>Delete “{label}” from recall?</span>
        <RamsButton variant="ghost" disabled={busy} onClick={() => { setConfirming(false); setError(''); }}>Cancel</RamsButton>
        <RamsButton variant="danger" disabled={busy} onClick={() => void remove()}>{busy ? 'Deleting…' : 'Delete'}</RamsButton>
      </div> : <RamsButton variant="danger" aria-label={`Delete ${noun} ${label}`} onClick={() => setConfirming(true)}>Delete</RamsButton>}
      {error ? <span role="alert" style={{ fontSize: 12, color: 'var(--t-text-secondary)' }}>{error}</span> : null}
    </div>
  );
}
