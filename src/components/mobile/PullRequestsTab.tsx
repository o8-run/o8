'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { pullRequestListQuery } from '@/lib/github-client';
import { useMobileGithubContext } from '@/lib/mobile/github-cache';
import { mergeMobilePullRequest, mobileMergeAvailable, mobilePullRequestQuery } from '@/lib/mobile/pull-requests';
import { useTheme } from './ThemeContext';

export function PullRequestsTab({ repoPath, onBack, refreshSignal = 0 }: { repoPath: string | null; onBack: () => void; refreshSignal?: number }) {
  const context = useMobileGithubContext();
  // Remount the selection and confirmation whenever the project or read context changes.
  return <ProjectPullRequests key={`${context.epoch}:${repoPath}`} repoPath={repoPath} onBack={onBack} context={context} refreshSignal={refreshSignal} />;
}

function ProjectPullRequests({ repoPath, onBack, context, refreshSignal }: {
  repoPath: string | null; onBack: () => void; refreshSignal: number; context: ReturnType<typeof useMobileGithubContext>;
}) {
  const { colors } = useTheme();
  const [number, setNumber] = useState<number | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const merging = useRef(false);
  const [result, setResult] = useState<string | null>(null);
  const list = useQuery({ ...pullRequestListQuery('', { ...context, repoPath }), enabled: Boolean(repoPath) }, context.client);
  const repo = list.data?.repo ?? '';
  const detail = useQuery({ ...mobilePullRequestQuery(repo, number ?? 0, context), enabled: Boolean(repo && number) }, context.client);
  const refreshDetail = detail.refetch;
  const refreshList = list.refetch;
  const previousRefresh = useRef(refreshSignal);
  useEffect(() => {
    if (previousRefresh.current === refreshSignal) return;
    previousRefresh.current = refreshSignal;
    void (number ? refreshDetail() : refreshList());
  }, [refreshSignal, number, refreshDetail, refreshList]);
  const pr = detail.data?.pr;
  const identity = pr ? `${pr.number}:${pr.headSha}:${pr.mergeGate?.snapshot}:${pr.reviewDecision}:${refreshSignal}` : '';
  const button: CSSProperties = { minHeight: 44, paddingTop: 8, paddingBottom: 8, paddingLeft: 12, paddingRight: 12, borderRadius: 7, border: `1px solid ${colors.cardBorder}`,
    background: colors.cardBg, color: colors.text, fontSize: 12, fontWeight: 300, cursor: 'pointer' };
  const select = (value: number | null) => { setNumber(value); setConfirmation(null); setResult(null); };
  const merge = async () => {
    if (!pr || merging.current) return;
    if (pr.reviewDecision !== 'APPROVED' && confirmation !== identity) { setConfirmation(identity); return; }
    merging.current = true; setBusy(true); setResult(null);
    try {
      await mergeMobilePullRequest(context, repo, pr, confirmation === identity);
      setResult('Merged');
    } catch (error) { setResult(error instanceof Error ? error.message : 'Merge failed'); }
    finally { setConfirmation(null); merging.current = false; setBusy(false); }
  };
  const checks = pr?.statusCheckRollup ?? [];
  const passed = checks.filter(check => check.status?.toLowerCase() === 'completed' && check.conclusion?.toLowerCase() === 'success').length;
  const pending = checks.filter(check => !check.conclusion || check.status?.toLowerCase() !== 'completed').length;
  const failed = checks.length - passed - pending;
  return <section aria-label="Pull requests" style={{ padding: 12, color: colors.text, fontSize: 13.5, fontWeight: 300, lineHeight: 1.5 }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <button type="button" style={button} disabled={busy} onClick={() => number ? select(null) : onBack()}>Back</button>
      <h1 style={{ fontSize: 18, fontWeight: 400, flex: 1 }}>PRs</h1>
      <button type="button" style={button} disabled={busy || !repoPath} onClick={() => {
        setConfirmation(null); setResult(null); void (number ? detail.refetch() : list.refetch());
      }}>Refresh</button>
    </div>
    {!repoPath ? <p>Select a project to view its pull requests.</p> : number ? <>
      {detail.isPending ? <p role="status">Loading pull request…</p> : detail.error || !pr ? <p role="alert">Pull request could not be loaded. Retry with Refresh.</p> : <>
        <h2 style={{ fontSize: 18, fontWeight: 400 }}>{pr.title}</h2>
        <p>{pr.changedFiles} files changed · {pr.mergeable ? 'Mergeable' : 'Not mergeable'}</p>
        <p>Checks: {checks.length ? `${passed} passed · ${failed} failed · ${pending} pending` : 'No checks'}</p>
        <p>Review: {pr.reviewDecision === 'APPROVED' ? 'Approved' : pr.reviewDecision || 'No reviews'}</p>
        {!mobileMergeAvailable(pr) ? <p role="status">{pr.mergeGate?.checks.find(check => check.verdict === 'fail')?.detail || 'Merge is unavailable. Refresh after resolving the merge gates.'}</p> : null}
        {result ? <p role="status">{result}</p> : null}
        {confirmation === identity ? <div role="group" aria-label="Confirm merge">
          <p>No reviewer approval. Confirm that you want to merge this pull request.</p>
          <button type="button" style={{ ...button, color: colors.red }} disabled={busy} onClick={() => void merge()}>{busy ? 'Merging…' : 'Confirm merge without approval'}</button>
          <button type="button" style={button} disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button>
        </div> : <button type="button" style={button} disabled={busy || result === 'Merged' || !mobileMergeAvailable(pr)} onClick={() => void merge()}>{busy ? 'Merging…' : 'Merge'}</button>}
      </>}
    </> : <>
      {list.isPending ? <p role="status">Loading pull requests…</p> : null}
      {list.error || list.data?.error ? <p role="alert">Pull requests could not be refreshed. Retry with Refresh.</p> : null}
      {list.data?.unavailable ? <p>Pull requests are unavailable for this project.</p> : null}
      {list.data?.prs.filter(row => row.state.toLowerCase() === 'open').map(row => <button key={row.number} type="button"
        style={{ ...button, display: 'block', width: '100%', textAlign: 'left', marginBottom: 4 }} onClick={() => select(row.number)}>#{row.number} {row.title}</button>)}
      {list.data && !list.data.unavailable && !list.data.prs.some(row => row.state.toLowerCase() === 'open') ? <p>No open pull requests.</p> : null}
    </>}
  </section>;
}
