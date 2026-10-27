'use client';

import { useEffect, useState } from 'react';
import type { OperatorCorrection } from '@/lib/cortex/operator-corrections';
import { ForgetMemoryButton } from '../ForgetMemoryButton';
import { RamsButton } from '../settings/shared';
import { DetailLine, Row, SectionHeader } from './shared';

interface MemoryRow { id: string; title: string; reason: string; pill: string; at: string; repoPath: string | null; projectId?: string | null }
interface OutcomeRow { id: string; summary: string | null; outcome: string; runtime: string; completedAt: string; repoPath: string; projectId: string | null }

const PAGE_SIZE = 50;

export function RetainedMemory({ kind, query, repoPaths, projectId }: { kind: 'correction' | 'outcome'; query: string; repoPaths?: string[]; projectId?: string }) {
  const noun = kind === 'correction' ? 'feedback' : 'outcomes';
  const [page, setPage] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const key = JSON.stringify([repoPaths, query, page, kind, projectId]);
  const [loaded, setLoaded] = useState<{ key: string; corrections: MemoryRow[]; hasMore: boolean; error?: string } | null>(null);
  const current = loaded?.key === key ? loaded : null;
  useEffect(() => {
    const changed = () => setRefresh(value => value + 1);
    window.addEventListener('o8:cortex-changes', changed);
    return () => window.removeEventListener('o8:cortex-changes', changed);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const [paths, query, page, kind, projectId] = JSON.parse(key) as [string[] | null, string, number, 'correction' | 'outcome', string | null];
    if (paths?.length === 0) return () => controller.abort();
    const params = new URLSearchParams({ query, offset: String(page * PAGE_SIZE), limit: String(PAGE_SIZE) });
    paths?.forEach(path => params.append('repoPath', path));
    if (projectId) params.set('projectId', projectId);
    if (kind === 'outcome') params.set('inventory', 'true');
    const endpoint = kind === 'correction' ? 'operator-corrections' : 'recent-outcomes';
    void fetch(`/api/cortex/${endpoint}?${params}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        const data = await response.json();
        const records = kind === 'correction' ? data.corrections : data.outcomes;
        if (!response.ok || data.ok !== true || !Array.isArray(records)) throw new Error(data.error || 'Could not load retained memory.');
        const corrections: MemoryRow[] = kind === 'correction'
          ? (records as OperatorCorrection[]).map(row => ({ ...row, pill: row.standing === 'operator' ? 'Operator feedback' : 'Machine steering' }))
          : (records as OutcomeRow[]).map(row => ({ ...row, title: row.summary || `${row.outcome} run`, reason: row.summary || row.outcome, pill: `${row.runtime} · ${row.outcome}`, at: row.completedAt }));
        if (!controller.signal.aborted) setLoaded({ key, corrections, hasMore: data.hasMore === true });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoaded({ key, corrections: [], hasMore: false, error: error instanceof Error ? error.message : 'Could not load retained memory.' });
      });
    return () => controller.abort();
  }, [key, refresh]);
  if (repoPaths?.length === 0) return null;
  const changePage = (next: number) => { setPage(next); setExpanded(null); };
  return (
    <section aria-label={`Retained ${noun}`}>
      <SectionHeader label={`Retained ${noun}`} count={current?.corrections.length ?? 0} />
      <p style={{ marginTop: 0, marginBottom: 12, fontSize: 13, lineHeight: 1.6, color: 'var(--t-text-muted)' }}>
        {kind === 'correction' ? 'Rejections and steering remembered by the Brain and future workers. Deleting removes an item from recall; its original activity record stays available.' : 'All retained run outcomes, including older and expired entries. Open an item to inspect its repository and project or delete it from recall.'}
      </p>
      {!current ? <p role="status">Loading retained {noun}…</p> : current.error ? <div role="alert">
        {current.error} <RamsButton variant="ghost" onClick={() => setRefresh(value => value + 1)}>Retry {noun}</RamsButton>
      </div> : current.corrections.length === 0 ? <p>No retained {noun}{query ? ' matches this search' : ' on this page'}.</p> : null}
      {current?.corrections.map(correction => (
        <Row key={correction.id} title={correction.title} subtitle={correction.reason.replace(/\s+/g, ' ').slice(0, 160)}
          pill={correction.pill}
          expanded={expanded === correction.id} onClick={() => setExpanded(expanded === correction.id ? null : correction.id)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <DetailLine label="Recorded" value={correction.at} />
            {correction.repoPath ? <DetailLine label="Repository" value={correction.repoPath} /> : null}
            <DetailLine label="Project" value={correction.projectId ?? 'Unscoped'} />
            <div style={{ fontSize: 12.5, fontWeight: 300, lineHeight: 1.55, color: 'var(--t-text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{correction.reason}</div>
            <ForgetMemoryButton kind={kind} id={correction.id} label={correction.title} repoPath={correction.repoPath ?? undefined} projectId={correction.projectId} />
          </div>
        </Row>
      ))}
      <nav aria-label={`Retained ${noun} pages`} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginTop: 12 }}>
        <RamsButton variant="ghost" disabled={page === 0} onClick={() => changePage(page - 1)}>Previous {noun}</RamsButton>
        <span role="status" style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>Page {page + 1}</span>
        <RamsButton variant="ghost" disabled={!current?.hasMore} onClick={() => changePage(page + 1)}>Next {noun}</RamsButton>
      </nav>
    </section>
  );
}
