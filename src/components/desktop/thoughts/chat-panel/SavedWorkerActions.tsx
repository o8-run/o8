'use client';

import { useEffect, useState } from 'react';
import type { WorkerRecovery } from '@/lib/agent-control/types';
import { DEGRADED_FALLBACK_REFRESH_MS, startDurableRefresh } from '@/lib/panel/durable-refresh';
import { ThreadActionButton } from '../../o8-panel/ThreadActions';
import { InterruptedWorkerActions } from './InterruptedWorkerActions';

/** Packet rows retain recovery even when they have no Shared-team membership. */
export function SavedWorkerActions({ sessionKey, name, status, unavailableNote }: {
  sessionKey: string; name: string; status: string;
  /** Shown once the saved record loads without any recovery action, instead of rendering nothing. */
  unavailableNote?: string;
}) {
  const [saved, setSaved] = useState<{ sessionKey: string; status: string; recovery: WorkerRecovery | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!sessionKey.includes('-owned:')) return;
    const controller = new AbortController();
    let generation = 0;
    const refresh = async () => {
      const current = ++generation;
      try {
        const response = await fetch(`/api/runtime/session-summary?sessionKey=${encodeURIComponent(sessionKey)}`, { signal: controller.signal, cache: 'no-store' });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? 'Unable to read saved worker recovery.');
        if (controller.signal.aborted || current !== generation) return;
        setSaved({ sessionKey, status: payload.session.status, recovery: payload.recovery ?? null }); setError(null);
      } catch (cause) {
        if (!controller.signal.aborted && current === generation) setError(cause instanceof Error ? cause.message : 'Saved worker recovery is unavailable.');
      }
    };
    void refresh();
    const stop = startDurableRefresh({ refresh, intervalMs: DEGRADED_FALLBACK_REFRESH_MS, events: ['o8:lifecycle-reconcile', 'cortex:agent-supervisor-update'] });
    return () => { controller.abort(); stop(); };
  }, [sessionKey, status, revision]);
  const current = saved?.sessionKey === sessionKey ? saved : null;
  return <>
    {current?.recovery && (current.recovery.actions.length || current.recovery.retired) ? <div style={{ paddingTop: 4, paddingRight: 12, paddingBottom: 10, paddingLeft: 12 }}>
      <InterruptedWorkerActions key={current.recovery.runId} sessionKey={sessionKey} name={name} recovery={current.recovery} status={current.status} />
    </div> : current && unavailableNote ? <div role="status" style={{ paddingTop: 4, paddingRight: 12, paddingBottom: 10, paddingLeft: 12, color: 'var(--t-text-muted)', fontSize: 11, fontWeight: 300 }}>
      {name} · {unavailableNote}
    </div> : null}
    {error ? <div role="status" style={{ padding: 12, color: 'var(--t-text-muted)', fontSize: 11 }}>{error} <ThreadActionButton label="Refresh worker recovery" onClick={() => setRevision(value => value + 1)} /></div> : null}
  </>;
}
