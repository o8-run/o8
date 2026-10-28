'use client';
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { cacheObservations, dailyCacheStats, emptyCacheObservations, recordCacheTranscript,
  sessionCacheEstimate, subscribeCacheObservations } from '@/lib/prompt-cache/observations';

function useCacheClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  return now;
}
interface SessionCacheInput {
  session: string | null; runtime: string | null; model?: string | null; entries: MobileTranscriptEntry[]; running: boolean;
}
function useSessionCachePresentation({ session, runtime, model, entries, running }: SessionCacheInput) {
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
  const available = runtime === 'codex' || runtime === 'claude-code';
  const label = !available ? 'Cache n/a' : !estimate ? 'Cache ?' : estimate.remainingMs > 0
    ? `Warm ~${Math.ceil(estimate.remainingMs / 60_000)}m` : 'Cold · est.';
  const compactLabel = !available ? 'n/a' : !estimate ? '?' : estimate.remainingMs > 0
    ? `~${Math.ceil(estimate.remainingMs / 60_000)}m` : '~cold';
  const description = available ? text : 'Cache estimate unavailable for this runtime';
  const detail = `Estimate from ${estimate?.source === 'requested' ? 'the reported cache lifetime' : 'observed cache reads and idle gaps'} on this device. Sending within this window may reuse cached context; reuse is not guaranteed. No keep-alive requests are sent.`;
  return useMemo(() => ({ session, label, compactLabel, text: description, paneText: text, detail }), [session, label, compactLabel, description, text, detail]);
}
const SessionCacheContext = createContext<ReturnType<typeof useSessionCachePresentation> | null>(null);
export const useComposerSessionCache = () => useContext(SessionCacheContext);

/** Scope the existing estimate to this composer's conversation, without adding a status row. */
export function SessionCacheProvider({ children, enabled = true, ...input }: SessionCacheInput & { children?: ReactNode; enabled?: boolean }) {
  const status = useSessionCachePresentation(input);
  return <SessionCacheContext value={enabled ? status : null}>{children}</SessionCacheContext>;
}

export function SessionCacheIndicator(input: SessionCacheInput) {
  const status = useSessionCachePresentation(input);
  return <span data-session-cache={input.session ?? ''} title={status.detail}
    style={{ display: 'block', color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', lineHeight: 1.25, paddingLeft: 8, paddingRight: 8, paddingTop: 2, paddingBottom: 2 }}>{status.paneText}</span>;
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
