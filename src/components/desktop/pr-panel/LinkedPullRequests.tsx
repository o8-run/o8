'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ipcFetch } from '@/lib/tauri/ipc-fetch';
import { useGithubWindowHidden } from '@/lib/github-client/visibility';
import { githubRefreshInterval } from '@/lib/github-client/refresh-policy';
import { linkedPullRequestListQuery } from '@/lib/github-client/linked-pr-list';
import { FloatingDialog } from '../FloatingDialog';
import { RamsButton } from '../settings/RamsButton';
import { GitPullRequest, X } from '../lucide-shims';
import { repoSlugFromRemote } from '../canvas-utils';
import { pullRequestStackRows } from '@/lib/github-broker/pull-request-stacks';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { parsePullRequestLink, linkedPrIdentity } from './linked-pr-store';
import { ConversationPullRequests } from '@/components/conversation-prs/ConversationPullRequests';
import { useLinkedPullRequests } from './useLinkedPullRequests';

export function LinkedPullRequests({ context, tabId, repoPath, repos, active, onOpen }: {
  context: string; tabId: string | null; repoPath: string | null; repos: RepoRegistryEntry[]; active: boolean;
  onOpen?: (number: number, repo: string) => void;
}) {
  const { links, link, unlink, persistenceError } = useLinkedPullRequests(context, tabId);
  const [openContext, setOpenContext] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const contextRef = useRef(context); contextRef.current = context;
  const requestRef = useRef<AbortController | null>(null);
  const selectedRepo = repos.find((repo) => repo.localPath === repoPath);
  const slug = repoSlugFromRemote(selectedRepo?.remoteUrl)?.toLowerCase() ?? null;
  const hidden = useGithubWindowHidden();
  const dependencies = useQuery({
    ...linkedPullRequestListQuery(slug ?? ''),
    refetchInterval: githubRefreshInterval(() => hidden),
    enabled: Boolean(active && slug && links.some((entry) => entry.repo === slug)),
  });
  const snapshot = dependencies.data;
  const dependencyError = dependencies.isError ? 'Branch dependencies unavailable. Your saved links are still here.' : null;
  useEffect(() => () => requestRef.current?.abort(), [context, active]);
  const related = useMemo(() => {
    const stackRows = slug && snapshot?.repo === slug ? pullRequestStackRows(snapshot.prs, slug) : [];
    const neighbors = new Map<number, number[]>();
    for (const row of stackRows) if (row.parent) {
      neighbors.set(row.parent, [...(neighbors.get(row.parent) ?? []), row.pull.number]);
      neighbors.set(row.pull.number, [...(neighbors.get(row.pull.number) ?? []), row.parent]);
    }
    const relatedNumbers = new Set(links.filter((entry) => entry.repo === slug).map((entry) => entry.number));
    const queue = [...relatedNumbers];
    for (let index = 0; index < queue.length; index++) for (const number of neighbors.get(queue[index]) ?? []) {
      if (!relatedNumbers.has(number)) { relatedNumbers.add(number); queue.push(number); }
    }
    return stackRows.filter((row) => relatedNumbers.has(row.pull.number));
  }, [slug, snapshot, links]);
  const visible = expanded ? links : links.slice(0, 2);
  const close = () => { requestRef.current?.abort(); setBusy(false); setOpenContext(null); setError(null); };
  const add = async () => {
    const parsed = parsePullRequestLink(value, slug);
    if (!parsed) { setError('Enter a GitHub pull request URL, or a number for this repository.'); return; }
    if (!repos.some((repo) => repoSlugFromRemote(repo.remoteUrl)?.toLowerCase() === parsed.repo)) { setError('Connect this repository in Projects before linking its pull request.'); return; }
    const controller = new AbortController(); requestRef.current = controller;
    const requestedContext = context;
    setBusy(true); setError(null);
    try {
      const response = await ipcFetch(`/api/panel/prs/${parsed.number}?repo=${encodeURIComponent(parsed.repo)}`, { signal: controller.signal });
      const result = await response.json() as { pr?: { number: number; title: string; resolvedRepo: string } };
      if (!response.ok || result.pr?.number !== parsed.number || result.pr.resolvedRepo?.toLowerCase() !== parsed.repo || typeof result.pr.title !== 'string') throw new Error('This pull request could not be verified. Check the URL and repository access.');
      if (controller.signal.aborted || contextRef.current !== requestedContext) return;
      link({ ...parsed, title: result.pr.title, linkedAt: new Date().toISOString() });
      setValue(''); setExpanded(true); close();
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'The pull request could not be linked.'); }
    finally { if (requestRef.current === controller) { requestRef.current = null; setBusy(false); } }
  };
  if (/^thread:thoughts-[A-Za-z0-9_-]{1,120}$/.test(context)) return <ConversationPullRequests threadId={context.slice(7)} active={active} repo={slug} legacyLinks={links} onOpen={onOpen} />;
  return <section aria-label="Linked pull requests" style={{ paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 12, borderBottom: '1px solid var(--t-divider-subtle)', flexShrink: 0 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: 0, border: 0, background: 'transparent', color: 'var(--t-text-muted)', fontFamily: 'inherit', fontSize: 11, fontWeight: 300, cursor: 'pointer' }}><GitPullRequest size={12} />Linked PRs{links.length ? ` · ${links.length}` : ''}</button>
      <span style={{ flex: 1 }} />
      <button type="button" onClick={() => { setBusy(false); setError(null); setValue(''); setOpenContext(context); }} style={{ padding: 0, border: 0, background: 'transparent', color: 'var(--t-text-muted)', fontFamily: 'inherit', fontSize: 11, fontWeight: 300, cursor: 'pointer' }}>Link PR</button>
    </div>
    {visible.map((entry) => <div key={linkedPrIdentity(entry)} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
      <button type="button" onClick={() => onOpen?.(entry.number, entry.repo)} title={`${entry.repo} #${entry.number} · ${entry.title}`} style={{ flex: 1, minWidth: 0, textAlign: 'left', padding: 0, border: 0, background: 'transparent', color: 'var(--t-text)', fontFamily: 'inherit', fontSize: 11, fontWeight: 300, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>#{entry.number} · {entry.title}</button>
      <button type="button" aria-label={`Unlink PR #${entry.number} in ${entry.repo}`} onClick={() => { try { unlink(entry); } catch { setReadError('The saved link could not be removed.'); } }} style={{ width: 22, height: 22, padding: 0, border: 0, borderRadius: 6, display: 'grid', placeItems: 'center', background: 'transparent', color: 'var(--t-text-faint)', cursor: 'pointer' }}><X size={10} /></button>
    </div>)}
    {!expanded && links.length > 2 ? <button type="button" onClick={() => setExpanded(true)} style={{ border: 0, padding: 0, marginTop: 6, background: 'transparent', color: 'var(--t-text-muted)', fontFamily: 'inherit', fontSize: 10, cursor: 'pointer' }}>Show {links.length - 2} more</button> : null}
    {expanded ? <div style={{ marginTop: 8, fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', color: 'var(--t-text-faint)' }}>{context.startsWith('worktree:') ? 'Saved for this worktree' : 'Saved for this conversation'}</div> : null}
    {expanded && related.some((row) => row.parent) ? <div style={{ marginTop: 8 }}>
      <div style={{ color: 'var(--t-text-faint)', fontSize: 10, marginBottom: 4 }}>Branch dependencies{snapshot?.nextPage ? ' · partial list' : ''}</div>
      {related.map((row) => <button key={row.pull.number} type="button" onClick={() => slug && onOpen?.(row.pull.number, slug)} style={{ display: 'block', maxWidth: '100%', textAlign: 'left', paddingTop: 4, paddingBottom: 4, paddingLeft: Math.min(row.depth, 5) * 10, paddingRight: 0, border: 0, background: 'transparent', color: 'var(--t-text-muted)', fontFamily: 'inherit', fontSize: 11, fontWeight: 300, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.depth ? '↳ ' : ''}#{row.pull.number} · {row.pull.headRefName}{row.ambiguous ? ' · dependency unclear' : ''}</button>)}
    </div> : null}
    {expanded && (readError || dependencyError) ? <div role="status" style={{ marginTop: 6, color: 'var(--t-text-muted)', fontSize: 11 }}>{readError || dependencyError}</div> : null}
    {persistenceError ? <div role="alert" style={{ marginTop: 6, color: 'var(--t-warning)', fontSize: 11 }}>{persistenceError}</div> : null}
    {openContext === context && active ? <FloatingDialog title="Link pull request" onClose={close} width={420} overlay>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}><GitPullRequest size={16} /><span style={{ flex: 1, fontSize: 15, fontWeight: 300 }}>Link pull request</span><button type="button" aria-label="Close link pull request" onClick={close} style={{ width: 28, height: 28, border: 0, borderRadius: 7, padding: 0, display: 'grid', placeItems: 'center', background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer' }}><X size={14} /></button></div>
      <form onSubmit={(event) => { event.preventDefault(); if (!busy) void add(); }}>
        <label htmlFor="linked-pr-input" style={{ display: 'block', color: 'var(--t-text-muted)', fontSize: 11, marginBottom: 6 }}>GitHub URL{slug ? ` or PR number in ${slug}` : ''}</label>
        <input id="linked-pr-input" data-dialog-initial-focus value={value} onChange={(event) => setValue(event.target.value)} placeholder={slug ? '#123 or https://github.com/…/pull/123' : 'https://github.com/…/pull/123'} disabled={busy} style={{ boxSizing: 'border-box', width: '100%', height: 34, paddingLeft: 10, paddingRight: 10, border: '1px solid var(--t-divider)', borderRadius: 8, background: 'var(--t-input-bg)', color: 'var(--t-text)', fontFamily: 'inherit', fontSize: 12 }} />
        <p style={{ fontSize: 11, color: 'var(--t-text-muted)', lineHeight: 1.4 }}>Keep related reviews with this {context.startsWith('worktree:') ? 'worktree' : 'conversation'}. Unlinking keeps the pull request on GitHub.</p>
        {error ? <div role="alert" style={{ marginTop: 8, fontSize: 11, lineHeight: 1.4, color: 'var(--t-danger)' }}>{error}</div> : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}><RamsButton variant="ghost" onClick={close}>Cancel</RamsButton><RamsButton type="submit" busy={busy} disabled={!value.trim()}>{busy ? 'Checking pull request…' : 'Link PR'}</RamsButton></div>
      </form>
    </FloatingDialog> : null}
  </section>;
}
