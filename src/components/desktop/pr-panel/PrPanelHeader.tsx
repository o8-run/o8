'use client';

import { memo } from 'react';
import { ExternalLink, GitPullRequest } from '../lucide-shims';
import { PrDiffStats } from './PrDiffStats';
import { PrPanelTitle } from './PrPanelTitle';
import { PrPanelActions } from './PrPanelActions';
import type { PrComposerMode, PrDetail } from './types';

export const PrPanelHeader = memo(function PrPanelHeader({ detail, repoSlug, repoPath, showDiffStats, onRefresh, onAsk, onComposerMode, readOnly = false }: {
  readOnly?: boolean; detail: PrDetail; repoSlug?: string | null; repoPath?: string | null; showDiffStats: boolean; onRefresh: () => void; onAsk: (prompt?: string) => void; onComposerMode: (mode: PrComposerMode) => void;
}) {
  const state = detail.mergedAt ? 'Merged' : detail.state.toLowerCase() === 'closed' ? 'Closed' : detail.draft ? 'Draft' : 'Open';
  const stateColor = state === 'Open' ? 'var(--t-success)' : state === 'Closed' ? 'var(--t-danger)' : state === 'Draft' ? 'var(--t-text-muted)' : 'var(--t-accent)';
  const repo = detail.resolvedRepo || repoSlug;
  return <header style={{ display: 'grid', gap: 16, paddingTop: 14, paddingRight: 18, paddingBottom: 16, paddingLeft: 18, borderBottom: '1px solid var(--t-divider-subtle)' }}>
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12, minHeight: 30 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, maxWidth: '100%', flex: '1 1 220px' }}>
        <a href={detail.url} target="_blank" rel="noopener noreferrer" aria-label={`View PR #${detail.number} on GitHub`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, color: 'var(--t-text-muted)', fontSize: 12, textDecoration: 'none' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{repo || 'Pull request'}</span><span style={{ color: stateColor, flexShrink: 0 }}>#{detail.number}</span><ExternalLink size={12} aria-hidden="true" style={{ flexShrink: 0 }} />
        </a>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: stateColor, fontSize: 10, flexShrink: 0 }}><GitPullRequest size={12} aria-hidden="true" />{state}</span>
      </div>
      {readOnly ? <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>Read-only stack</span> : <PrPanelActions key={`${repo}:${detail.number}:${repoPath || ''}`} detail={detail} repoSlug={repoSlug} repoPath={repoPath} onRefresh={onRefresh} onAsk={onAsk} onComposerMode={onComposerMode} />}
    </div>
    <PrPanelTitle title={detail.title} author={detail.author} avatarUrl={detail.avatarUrl} updatedAt={detail.updatedAt} />
    {detail.watch?.changes.length ? <span role="status" style={{ fontSize: 11, color: 'var(--t-text-secondary)' }}>Updated: {detail.watch.changes.map(change => change === 'head' ? 'new commit' : change).join(', ')}</span> : null}
    {detail.watch?.commentUpdatesPaused ? <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>Comment notifications paused until checks or the commit change. Discussion still refreshes.</span> : null}
    {detail.checksUnavailable || detail.discussionIncomplete ? <span role="status" style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{detail.checksUnavailable ? 'Checks unavailable. ' : ''}{detail.discussionIncomplete ? 'Some discussion is available only on GitHub.' : ''}</span> : null}
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, fontSize: 11, color: 'var(--t-text-muted)' }}>
      <span title={`${detail.baseRefName} ← ${detail.headRefName}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0, maxWidth: '100%', fontFamily: 'var(--font-mono)' }}><span style={{ color: 'var(--t-text-secondary)', flexShrink: 0 }}>{detail.baseRefName}</span><span aria-hidden="true">←</span><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail.headRefName}</span></span>
      {showDiffStats ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}><span>{detail.changedFiles} file{detail.changedFiles === 1 ? '' : 's'}</span><PrDiffStats files={detail.files} totalFiles={detail.changedFiles} additions={detail.additions} deletions={detail.deletions} /></span> : null}
    </div>
  </header>;
});
