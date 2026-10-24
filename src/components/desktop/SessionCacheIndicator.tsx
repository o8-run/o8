'use client';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { cacheObservations, dailyCacheStats, emptyCacheObservations, recordCacheTranscript,
  sessionCacheEstimate, subscribeCacheObservations } from '@/lib/prompt-cache/observations';

function useCacheClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  return now;
}
export function SessionCacheIndicator({ session, runtime, model, entries, running }: {
  session: string | null; runtime: string | null; model?: string | null; entries: MobileTranscriptEntry[]; running: boolean;
}) {
  const rows = useSyncExternalStore(subscribeCacheObservations, cacheObservations, emptyCacheObservations);
  const previous = useRef({ session, running });
  const now = useCacheClock();
  useEffect(() => {
    const completed = previous.current.session === session && previous.current.running && !running;
    previous.current = { session, running };
    if (session && runtime) recordCacheTranscript({ session, runtime, model, entries, running,
      ...(completed ? { completedAt: Date.now() } : {}) });
  }, [session, runtime, model, entries, running]);
  const estimate = useMemo(() => session && runtime ? sessionCacheEstimate(rows, session, runtime, model, now) : null, [rows, session, runtime, model, now]);
  const text = estimate ? estimate.remainingMs > 0 ? `Cache warm · about ${Math.ceil(estimate.remainingMs / 60_000)} min left · estimate`
    : 'Cache likely cold · estimate' : 'Cache unknown · estimate';
  return <span data-session-cache={session ?? ''} title={`Estimate from ${estimate?.source === 'requested' ? 'the reported cache lifetime' : 'observed cache reads and idle gaps'} on this device. Sending within this window may reuse cached context; reuse is not guaranteed. No keep-alive requests are sent.`}
    style={{ display: 'block', color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', lineHeight: 1.25, paddingLeft: 8, paddingRight: 8, paddingTop: 2, paddingBottom: 2 }}>{text}</span>;
}
export function ProviderCacheStats({ runtime }: { runtime: string }) {
  const rows = useSyncExternalStore(subscribeCacheObservations, cacheObservations, emptyCacheObservations);
  const now = useCacheClock();
  const stats = useMemo(() => dailyCacheStats(rows, runtime, now), [rows, runtime, now]);
  if (runtime !== 'codex' && runtime !== 'claude-code') return null;
  return <div data-provider-cache={runtime} title="Local observations only; missing cache counters are excluded. A cold resume is an observed idle gap followed by at least 10,000 fresh input tokens and zero reported cache reads."
    style={{ color: 'var(--t-text-muted)', fontSize: 9.5, fontWeight: 260, lineHeight: 1.25 }}>
    Observed today · {stats.share === null ? 'cache share unknown' : `${Math.round(stats.share * 100)}% of input from cache`} · {stats.coldResumes} cold resumes · {stats.measured}/{stats.observed} turns measured
  </div>;
}
