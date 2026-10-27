'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatRelative } from './AutomationRow';
import { invalidateConnectedAutomations, loadConnectedAutomations, readConnectedAutomationsSnapshot, type ConnectedJob, type ConnectedResponse } from './connected-cache';

function scheduleLabel(job: ConnectedJob): string {
  const schedule = job.schedule;
  if (schedule.kind === 'cron' && schedule.expr) {
    const daily = /^([0-5]?\d)\s+([01]?\d|2[0-3])\s+\*\s+\*\s+\*$/.exec(schedule.expr);
    if (daily) {
      const hour = Number(daily[2]);
      const minute = daily[1].padStart(2, '0');
      return `Daily at ${hour % 12 || 12}:${minute} ${hour < 12 ? 'AM' : 'PM'}${schedule.tz ? ` · ${schedule.tz}` : ''}`;
    }
    return `${schedule.expr}${schedule.tz ? ` · ${schedule.tz}` : ''}`;
  }
  if (schedule.kind === 'every' && schedule.everyMs) {
    const hours = schedule.everyMs / 3_600_000;
    return Number.isInteger(hours) ? `Every ${hours}h` : `Every ${Math.round(schedule.everyMs / 60_000)}m`;
  }
  if (schedule.kind === 'at' && schedule.at) return `Once · ${schedule.at}`;
  return 'Schedule unavailable';
}

export function ConnectedAgentAutomations({ onActiveCountChange, onTotalCountChange, onLoadingChange }: {
  onActiveCountChange: (count: number | null) => void;
  onTotalCountChange?: (count: number | null) => void;
  onLoadingChange?: (loading: boolean) => void;
}) {
  const [jobs, setJobs] = useState<ConnectedJob[]>(() => readConnectedAutomationsSnapshot()?.jobs ?? []);
  const [loading, setLoading] = useState(() => !readConnectedAutomationsSnapshot());
  const [available, setAvailable] = useState<boolean | null>(() => {
    const cached = readConnectedAutomationsSnapshot();
    return cached ? cached.installed === false ? null : true : null;
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (force = false) => {
    try {
      const result = await loadConnectedAutomations(force);
      if (result.installed === false) {
        setJobs([]);
        setAvailable(null);
        onActiveCountChange(0);
        onTotalCountChange?.(0);
        return;
      }
      const next = result.jobs ?? [];
      setJobs(next);
      setAvailable(true);
      onActiveCountChange(next.filter((job) => job.enabled).length);
      onTotalCountChange?.(next.length);
      setError(null);
    } catch (failure) {
      // Keep a recent, truthful snapshot visible if a background refresh fails.
      if (readConnectedAutomationsSnapshot()) {
        setError(failure instanceof Error ? failure.message : 'Connected agent scheduler unavailable.');
        return;
      }
      setJobs([]);
      setAvailable(false);
      onActiveCountChange(null);
      onTotalCountChange?.(null);
      setError(failure instanceof Error ? failure.message : 'Connected agent scheduler unavailable.');
    } finally {
      setLoading(false);
      onLoadingChange?.(false);
    }
  }, [onActiveCountChange, onTotalCountChange, onLoadingChange]);

  useEffect(() => {
    void refresh();
    const intervalId = window.setInterval(() => { void refresh(true); }, 15_000);
    return () => window.clearInterval(intervalId);
  }, [refresh]);

  const toggle = async (job: ConnectedJob) => {
    setBusyId(job.id);
    setError(null);
    try {
      const response = await fetch('/api/automations/connected', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: job.id, enabled: !job.enabled }),
      });
      const result = await response.json() as ConnectedResponse;
      if (!response.ok || !result.ok || !result.job) throw new Error(result.error ?? 'Could not update the connected job.');
      invalidateConnectedAutomations();
      await refresh(true);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'Could not update the connected job.';
      invalidateConnectedAutomations();
      await refresh(true);
      setError(message);
    } finally {
      setBusyId(null);
    }
  };

  if (loading) return (
    <section aria-busy="true" style={{ paddingTop: 14 }}>
      <span role="status" style={{ color: 'var(--t-text-muted)', fontSize: 11, fontWeight: 300 }}>
        Reading connected schedules…
      </span>
    </section>
  );
  if (available === null || (available && jobs.length === 0)) return null;

  return (
    <section style={{ display: 'flex', flexDirection: 'column', paddingTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, paddingBottom: 4 }}>
        <span style={{ color: 'var(--t-text-faint)', fontSize: 10, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: '14px', textTransform: 'uppercase' }}>
          Connected agent schedules
        </span>
        {available ? <span style={{ color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260 }}>{jobs.length}</span> : null}
      </div>
      {!available ? (
        <span role="status" style={{ paddingTop: 8, color: 'var(--t-text-muted)', fontSize: 12, fontWeight: 300 }}>
          {error}
        </span>
      ) : jobs.map((job) => (
        <div key={job.id} style={{ minHeight: 52, display: 'flex', alignItems: 'center', gap: 9, paddingTop: 7, paddingRight: 10, paddingBottom: 7, paddingLeft: 10, opacity: job.enabled ? 1 : 0.62 }}>
          <span aria-label={job.lastRunStatus ?? 'No runs yet'} title={job.lastRunStatus ?? 'No runs yet'} style={{ width: 6, height: 6, flexShrink: 0, borderRadius: '50%', background: job.lastRunStatus === 'error' ? 'var(--t-brand-red)' : job.lastRunStatus === 'ok' ? 'var(--t-success)' : 'var(--t-text-faint)' }} />
          <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--t-text)', fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25 }}>
              {job.name}
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--t-text-muted)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', lineHeight: 1.25 }}>
              {scheduleLabel(job)} · {job.agentId} · Next {formatRelative(job.nextRunAt, 'unscheduled')} · Last {formatRelative(job.lastRunAt, 'never')} ({job.lastRunStatus ?? 'idle'})
            </span>
          </div>
          <button
            type="button"
            role="switch"
            aria-label={`${job.enabled ? 'Pause' : 'Resume'} ${job.name}`}
            aria-checked={job.enabled}
            disabled={busyId !== null}
            onClick={() => { void toggle(job); }}
            style={{ height: 24, paddingTop: 0, paddingRight: 8, paddingBottom: 0, paddingLeft: 8, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-divider)', borderRadius: 7, background: 'var(--t-input-bg)', color: 'var(--t-text-muted)', fontSize: 11, fontWeight: 300, fontFamily: 'var(--font-sans-system)', cursor: busyId ? 'default' : 'pointer' }}
          >
            {busyId === job.id ? 'Updating…' : job.enabled ? 'Pause' : 'Resume'}
          </button>
        </div>
      ))}
      {available && error ? <span role="alert" style={{ paddingTop: 6, color: 'var(--t-brand-red)', fontSize: 11 }}>{error}</span> : null}
    </section>
  );
}
