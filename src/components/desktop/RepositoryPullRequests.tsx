'use client';

import Image from 'next/image';
import { useEffect, useId, useMemo, useState } from 'react';
import { ipcFetch } from '@/lib/tauri/ipc-fetch';
import { relativeTimeLabel } from '@/lib/format/relative-time';
import { pullRequestStackRows } from '@/lib/github-broker/pull-request-stacks';
import type { PullRequestListItem, PullRequestListState, PullRequestListSort } from '@/lib/github-broker/pull-request-list.types';
import { ArrowDown, ArrowUp, CheckCircle2, CircleUser, Clock, Eye, GitMerge, GitPullRequest, GitPullRequestDraft, Layers, Pencil, RefreshCw, Search, XCircle } from './lucide-shims';
import { PrLabel } from './pr-panel/PrLabel';
import { EMPTY_PR_FILTERS, PR_CONTROL, PullRequestFilters, PullRequestPicker } from './pull-requests/controls';
import { useRepositoryPullRequests } from './pull-requests/useRepositoryPullRequests';

type DisplayState = PullRequestListState | 'merged';
type PersonalScope = 'all' | 'authored' | 'reviewing' | 'others';
const sortLabels: Record<PullRequestListSort, string> = { updated: 'Recently updated first', oldest: 'Oldest update first', newest: 'Newest created first' };

export function RepositoryPullRequests({ repoPath, active = true }: { repoPath: string | null; active?: boolean }) {
  const [state, setState] = useState<DisplayState>('open');
  const [personalScope, setPersonalScope] = useState<PersonalScope>('all');
  const [layout, setLayout] = useState<'authors' | 'stacks'>('authors');
  const [sort, setSort] = useState<PullRequestListSort>('updated');
  const [filters, setFilters] = useState(EMPTY_PR_FILTERS);
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<{ repoPath: string | null; number: number } | null>(null);
  const selected = selection && selection.repoPath === repoPath ? selection.number : null;
  const [viewer, setViewer] = useState<string | null>(null);
  const [, setClockTick] = useState(0);
  const listId = useId();
  const apiState = state === 'merged' ? 'closed' : state;
  const { data, loading, error, refresh, retry, loadMore } = useRepositoryPullRequests(repoPath, apiState, sort, active);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setClockTick((tick) => tick + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [active]);

  useEffect(() => {
    const onSelection = (event: Event) => {
      const next = (event as CustomEvent<{ prNumber: number; repo?: string; repoPath?: string }>).detail;
      if (!next || (next.repoPath ? next.repoPath !== repoPath : next.repo !== data?.repo)) return;
      setSelection({ repoPath, number: next.prNumber });
    };
    window.addEventListener('o8:pr-selected', onSelection);
    return () => window.removeEventListener('o8:pr-selected', onSelection);
  }, [data?.repo, repoPath]);

  useEffect(() => {
    if (!active || viewer || !data?.repo) return;
    const controller = new AbortController();
    void ipcFetch('/api/panel/github-status', { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((status: { authenticated?: boolean; username?: string } | null) => {
        if (!controller.signal.aborted && status?.authenticated && status.username) setViewer(status.username.toLowerCase());
      }).catch(() => undefined);
    return () => controller.abort();
  }, [active, viewer, data?.repo]);

  const visible = useMemo(() => (data?.prs ?? []).filter((pr) => {
    const mine = Boolean(viewer && pr.author.toLowerCase() === viewer);
    if (state !== 'all' && pr.state !== state) return false;
    if (personalScope === 'authored' && !mine || personalScope === 'others' && mine) return false;
    if (personalScope === 'reviewing' && !pr.requestedReviewers?.some((login) => login.toLowerCase() === viewer)) return false;
    if (filters.author && pr.author !== filters.author || filters.label && !pr.labels.includes(filters.label) || filters.base && pr.baseRefName !== filters.base) return false;
    if (filters.draft === 'draft' && !pr.draft || filters.draft === 'ready' && pr.draft) return false;
    if (filters.checks && (pr.checks ?? 'unknown') !== filters.checks) return false;
    const text = `${pr.number} ${pr.title} ${pr.author} ${pr.headRefName} ${pr.labels.join(' ')}`.toLowerCase();
    return (query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).every((term) => {
      const token = term.replaceAll('"', '').toLowerCase();
      if (token.startsWith('label:')) return pr.labels.some((label) => label.toLowerCase() === token.slice(6));
      if (token.startsWith('author:')) return pr.author.toLowerCase() === (token.slice(7) === 'me' ? viewer : token.slice(7));
      return text.includes(token);
    });
  }), [data, filters, personalScope, query, state, viewer]);

  const options = useMemo(() => ({
    authors: [...new Set(data?.prs.map((pr) => pr.author) ?? [])].sort(),
    labels: [...new Set(data?.prs.flatMap((pr) => pr.labels) ?? [])].sort(),
    bases: [...new Set(data?.prs.map((pr) => pr.baseRefName) ?? [])].sort(),
  }), [data]);
  const stackRows = useMemo(() => {
    const shown = new Set(visible.map((pr) => pr.number));
    return pullRequestStackRows(data?.prs ?? [], data?.repo ?? '').filter((row) => shown.has(row.pull.number));
  }, [data, visible]);
  const groupAuthor = viewer || data?.repo?.split('/')[0]?.toLowerCase();
  const groups = groupAuthor ? [
    { label: viewer ? 'Authored' : 'Repository owner', icon: <Pencil size={14} />, prs: visible.filter((pr) => pr.author.toLowerCase() === groupAuthor) },
    { label: 'Others', icon: <CircleUser size={14} />, prs: visible.filter((pr) => pr.author.toLowerCase() !== groupAuthor) },
  ] : [{ label: 'Pull requests', icon: <GitPullRequest size={14} />, prs: visible }];
  const pick = (pr: PullRequestListItem) => {
    setSelection({ repoPath, number: pr.number });
    window.dispatchEvent(new CustomEvent('o8:open-pr', { detail: { prNumber: pr.number, repo: data?.repo, repoPath } }));
  };

  return <section aria-label="Repository pull requests" data-pull-requests-list="true" data-repo-path={repoPath ?? undefined} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0, color: 'var(--t-text)' }}>
    <header style={{ paddingTop: 20, paddingRight: 24, paddingBottom: 14, paddingLeft: 24, flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Pull requests</h1>
        <span style={{ fontSize: 12, color: 'var(--t-text-secondary)', overflowWrap: 'anywhere' }}>{data?.repo ?? (repoPath ? 'Current repository' : 'Choose a repository in Projects')}</span>
      </div>
      <div aria-label="Pull request controls" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <label style={{ ...PR_CONTROL, flex: '1 1 220px', justifyContent: 'flex-start', flexShrink: 1 }}>
          <Search size={15} aria-hidden="true" /><input aria-label="Search pull requests shown" placeholder="Search pull requests, or label:bug" value={query} onChange={(event) => setQuery(event.target.value)} style={{ flex: 1, minWidth: 0, border: 0, background: 'transparent', color: 'inherit', font: 'inherit', height: 30 }} />
        </label>
        <PullRequestPicker label="Sort pull requests" value={sort} onChange={setSort} active={active} icon={sort === 'oldest' ? <ArrowUp size={15} /> : <ArrowDown size={15} />} options={[{ value: 'updated', label: 'Updated' }, { value: 'oldest', label: 'Oldest' }, { value: 'newest', label: 'Newest' }]} />
        <PullRequestFilters value={filters} onChange={setFilters} active={active} {...options} />
        <PullRequestPicker label="Pull request state" value={state} onChange={setState} active={active} icon={state === 'merged' ? <GitMerge size={15} /> : state === 'all' ? <Layers size={15} /> : <GitPullRequest size={15} />} options={[{ value: 'open', label: 'Open', icon: <GitPullRequest size={16} /> }, { value: 'closed', label: 'Closed', icon: <GitPullRequest size={16} /> }, { value: 'merged', label: 'Merged', icon: <GitMerge size={16} /> }, { value: 'all', label: 'All', icon: <Layers size={16} /> }]} />
        <PullRequestPicker label="Pull request involvement" value={personalScope} onChange={setPersonalScope} active={active} icon={personalScope === 'authored' ? <Pencil size={15} /> : personalScope === 'reviewing' ? <Eye size={15} /> : <Layers size={15} />} disabled={!viewer} options={[{ value: 'all', label: 'All authors', icon: <Layers size={16} /> }, { value: 'authored', label: 'Authored', icon: <Pencil size={16} /> }, { value: 'reviewing', label: 'Review requested', icon: <Eye size={16} /> }, { value: 'others', label: 'Others', icon: <CircleUser size={16} /> }]} />
        <PullRequestPicker label="Pull request layout" value={layout} onChange={setLayout} active={active} icon={layout === 'stacks' ? <Layers size={15} /> : <CircleUser size={15} />} options={[{ value: 'authors', label: 'By author' }, { value: 'stacks', label: 'Branch stacks' }]} />
        <button type="button" aria-label="Refresh pull requests" disabled={loading || !repoPath} onClick={() => void refresh()} style={{ ...PR_CONTROL, width: 36, padding: 0, cursor: loading ? 'wait' : 'pointer', opacity: loading ? 0.5 : 1 }}><RefreshCw size={15} /></button>
      </div>
      <div role="status" aria-live="polite" style={{ marginTop: 12, fontSize: 12, color: 'var(--t-text-muted)' }}>{loading ? data ? 'Refreshing pull requests…' : 'Reading pull requests from GitHub…' : data ? `${visible.length} shown · ${sortLabels[sort]}` : 'Pull requests for this workspace'}</div>
      {data?.nextPage ? <p style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 6, marginRight: 0, marginBottom: 0, marginLeft: 0 }}>Filters apply to the PRs shown. Load more to include older PRs.</p> : null}
      {data?.statsUnavailable ? <p style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 6, marginRight: 0, marginBottom: 0, marginLeft: 0 }}>Some diff totals or review requests are unavailable. Refresh to try again.</p> : null}
      {layout === 'stacks' ? <p style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 6, marginRight: 0, marginBottom: 0, marginLeft: 0 }}>Dependencies follow branches in the loaded PRs. This view does not change or merge them.</p> : null}
    </header>
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingTop: 0, paddingRight: 12, paddingBottom: 20, paddingLeft: 12, overscrollBehavior: 'contain' }}>
      {error ? <div role="alert" style={{ marginTop: 8, marginRight: 12, marginBottom: 16, marginLeft: 12, fontSize: 13, lineHeight: 1.6 }}><p style={{ marginTop: 0, marginRight: 0, marginBottom: 8, marginLeft: 0 }}>{error}</p><button type="button" onClick={() => void retry()} style={PR_CONTROL}>Retry</button></div> : null}
      {!repoPath || data?.unavailable ? <p style={{ marginTop: 28, marginRight: 12, marginBottom: 28, marginLeft: 12, fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.6 }}>{!repoPath ? 'Choose a repository in Projects to see its pull requests.' : 'This repository needs a GitHub origin to show pull requests.'}</p> : null}
      {data && !data.unavailable && !loading && !error && visible.length === 0 ? <p style={{ marginTop: 20, marginRight: 12, marginBottom: 20, marginLeft: 12, fontSize: 13, color: 'var(--t-text-secondary)' }}>{query || personalScope !== 'all' || Object.values(filters).some(Boolean) ? 'No pull requests shown match these filters.' : `No ${state === 'all' ? '' : `${state} `}pull requests.`}</p> : null}
      {data && !data.unavailable && layout === 'stacks' ? <ul aria-label="Inferred branch dependencies" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {stackRows.map((row) => <li key={row.pull.number} style={{ paddingLeft: Math.min(row.depth, 4) * 12 }}>
          <div style={{ paddingTop: 8, paddingRight: 12, paddingBottom: 0, paddingLeft: 12, fontSize: 11, color: 'var(--t-text-muted)', overflowWrap: 'anywhere' }}>{row.pull.headRefName} → {row.pull.baseRefName}{row.parent ? ` · Inferred dependency on #${row.parent}` : row.unsupportedCrossFork ? ' · Cross-fork dependency unsupported' : row.ambiguous ? ' · Dependency unclear' : ''}</div>
          <PullRequestRow pr={row.pull} repo={data.repo} selected={selected === row.pull.number} metadataId={`${listId}-${row.pull.number}`} onPick={() => pick(row.pull)} />
        </li>)}
      </ul> : null}
      {data && !data.unavailable && layout === 'authors' ? groups.filter((group) => group.prs.length > 0 || personalScope === 'all').map((group) => <div key={group.label}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, marginRight: 12, marginBottom: 4, marginLeft: 12, fontSize: 12, fontWeight: 500, color: 'var(--t-text-muted)' }}>{group.icon}<span>{group.label}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{group.prs.length}</span><span style={{ height: 1, flex: 1, background: 'var(--t-divider)', marginLeft: 4 }} /></h2>
        <ul aria-label={group.label} style={{ listStyle: 'none', padding: 0, margin: 0 }}>{group.prs.map((pr) => <li key={pr.number}><PullRequestRow pr={pr} repo={data.repo} selected={selected === pr.number} metadataId={`${listId}-${pr.number}`} onPick={() => pick(pr)} /></li>)}</ul>
        {!group.prs.length && group.label === 'Others' ? <p style={{ marginTop: 10, marginRight: 12, marginBottom: 12, marginLeft: 12, fontSize: 12, color: 'var(--t-text-muted)' }}>No other pull requests shown.</p> : null}
      </div>) : null}
      {data?.nextPage ? <button type="button" disabled={loading} onClick={() => void loadMore()} style={{ ...PR_CONTROL, display: 'flex', marginTop: 16, marginRight: 'auto', marginBottom: 0, marginLeft: 'auto', cursor: 'pointer' }}>{loading ? 'Loading…' : 'Load more pull requests'}</button> : null}
    </div>
  </section>;
}

function PullRequestRow({ pr, repo, selected, metadataId, onPick }: { pr: PullRequestListItem; repo: string | null; selected: boolean; metadataId: string; onPick: () => void }) {
  const Icon = pr.state === 'merged' ? GitMerge : pr.draft ? GitPullRequestDraft : GitPullRequest;
  const StatusIcon = pr.checks === 'success' ? CheckCircle2 : pr.checks === 'failure' ? XCircle : Clock;
  const timestamp = Date.parse(pr.updatedAt);
  const time = Number.isFinite(timestamp) ? relativeTimeLabel(timestamp, { subMinute: 'just-now-lower', overflow: 'days' }) : 'Time unavailable';
  return <button type="button" data-pr-number={pr.number} aria-label={`PR #${pr.number}: ${pr.title}`} aria-describedby={metadataId} aria-current={selected ? 'true' : undefined} onClick={onPick} onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }} onMouseLeave={(event) => { event.currentTarget.style.background = selected ? 'var(--t-hover)' : 'transparent'; }} style={{ width: '100%', display: 'flex', gap: 12, alignItems: 'flex-start', textAlign: 'left', paddingTop: 15, paddingRight: 12, paddingBottom: 15, paddingLeft: 12, minHeight: 72, border: 0, borderRadius: 12, background: selected ? 'var(--t-hover)' : 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' }}>
    <Icon size={18} aria-hidden="true" style={{ marginTop: 2, flexShrink: 0, color: pr.state === 'merged' ? 'var(--t-accent)' : pr.state === 'open' && !pr.draft ? 'var(--t-success)' : 'var(--t-text-muted)' }} />
    <span style={{ flex: 1, minWidth: 0 }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, lineHeight: 1.45 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><span style={{ color: 'var(--t-text-muted)', fontVariantNumeric: 'tabular-nums' }}>#{pr.number} </span>{pr.title}</span>
        {pr.checks ? <StatusIcon size={14} aria-label={`Checks ${pr.checks}`} style={{ flexShrink: 0, color: pr.checks === 'success' ? 'var(--t-success)' : pr.checks === 'failure' ? 'var(--t-danger)' : 'var(--t-text-muted)' }} /> : null}
      </span>
      <span id={metadataId} style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap', marginTop: 5, fontSize: 12, color: 'var(--t-text-secondary)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>{pr.avatarUrl ? <Image src={pr.avatarUrl} alt="" width={18} height={18} unoptimized style={{ borderRadius: '50%', flexShrink: 0 }} /> : <CircleUser size={18} aria-hidden="true" />}{pr.author}</span>
        <span style={{ color: 'var(--t-text-muted)' }} title={`${pr.baseRefName} ← ${pr.headRefName}`}>{repo}</span>
        {pr.draft ? <span style={{ color: 'var(--t-text-muted)' }}>Draft</span> : null}
        {pr.labels.slice(0, 3).map((label) => <PrLabel key={label} label={label} />)}
        {pr.labels.length > 3 ? <span title={pr.labels.slice(3).join(', ')} style={{ color: 'var(--t-text-muted)' }}>+{pr.labels.length - 3}</span> : null}
      </span>
    </span>
    <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5, flexShrink: 0, fontSize: 12, minWidth: 64, paddingTop: 2, fontVariantNumeric: 'tabular-nums' }}>
      <span aria-label={pr.additions === null || pr.deletions === null ? 'Diff totals unavailable' : `${pr.additions} additions, ${pr.deletions} deletions`}>
        {pr.additions === null || pr.deletions === null ? <span style={{ color: 'var(--t-text-muted)' }}>—</span> : <><span style={{ color: 'var(--t-success)' }}>+{pr.additions.toLocaleString()}</span> <span style={{ color: 'var(--t-danger)' }}>−{pr.deletions.toLocaleString()}</span></>}
      </span>
      <time dateTime={pr.updatedAt} title={Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : undefined} style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{time}</time>
    </span>
  </button>;
}
