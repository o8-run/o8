'use client';


import React from 'react';
import { GithubReadStatus } from '@/components/github/GithubReadStatus';
import { PrStackSummary } from '../agent-panel/PrStackSummary';
import { usePrStackSelection } from '../pr-panel/usePrStackSelection';
import { ExternalLink, RefreshCw } from '../lucide-shims';
import { LIGHT_CANVAS_VARS } from '../canvas-utils';
import type { PRViewerProps } from './types';
import { usePRData } from './usePRData';
import { PRHeader } from './PRHeader';
import { PROverviewSection } from './PROverviewSection';
import { PRFilesSection } from './PRFilesSection';
import { PRChecksSection } from './PRChecksSection';
import { PRCommentsSection } from './PRCommentsSection';
import { PRReviewThreadsSection } from './PRReviewThreadsSection';
import { openExternalUrl } from '@/lib/desktop/open-external';

export function PRViewer({
  prNumber: initialNumber,
  repo,
  active = true,
  readOnly = false,
  onInjectChatContext,
}: PRViewerProps) {
  const selection = usePrStackSelection(repo || '', initialNumber, readOnly);
  const prNumber = selection.number;
  const data = usePRData(prNumber, repo, onInjectChatContext, active, selection.readOnly);

  if (data.loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>Loading PR...</div>;
  }

  if (data.error || !data.pr) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        height: '100%',
        padding: 24,
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 13, color: '#ef4444', lineHeight: 1.5 }}>
          Failed to load PR: {data.error || 'Unknown'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button
            type="button"
            onClick={data.reload}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 12px',
              borderRadius: 10,
              border: '1px solid rgba(37, 99, 235, 0.18)',
              background: 'rgba(37, 99, 235, 0.08)',
              color: '#2563eb',
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: 'var(--font-sans-system)',
            }}
          >
            <RefreshCw size={12} strokeWidth={2.2} />
            Retry
          </button>
          {repo ? (
            <button
              type="button"
              onClick={() => openExternalUrl(`https://github.com/${repo}/pull/${prNumber}`)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 12px',
                borderRadius: 10,
                border: '1px solid rgba(15, 23, 42, 0.1)',
                background: 'var(--t-panel)',
                color: 'var(--t-text)',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
                fontFamily: 'var(--font-sans-system)',
              }}
            >
              <ExternalLink size={12} strokeWidth={2.2} />
              Open on GitHub
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#ffffff', ...LIGHT_CANVAS_VARS }}>
      <GithubReadStatus error={data.refreshError} updatedAt={data.updatedAt} />
      <PRHeader readOnly={data.readOnly}
        pr={data.pr}
        activeSection={data.activeSection}
        setActiveSection={data.setActiveSection}
        reviewThreadCount={data.reviewThreads.length}
        commentText={data.commentText}
        setCommentText={data.setCommentText}
        actionLoading={data.actionLoading}
        actionResult={data.actionResult}
        submitAction={data.submitAction}
        commentInputRef={data.commentInputRef}
      />

      {data.pr.stack ? <div style={{ paddingTop: 8, paddingRight: 20, paddingBottom: 8, paddingLeft: 20 }}>
        <PrStackSummary observation={data.pr.stack} prNumber={prNumber} repo={repo} retained={data.retainedStack} onSelect={number => {
          selection.select(number); data.setActiveSection('files');
        }} />
      </div> : null}
      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', paddingTop: 16, paddingRight: 20, paddingBottom: 16, paddingLeft: 20, color: '#374151' }}>
        {data.activeSection === 'overview' ? (
          <PROverviewSection pr={data.pr} />
        ) : null}

        {data.activeSection === 'files' ? (
          <PRFilesSection pr={data.pr} activeItemIndex={data.activeItemIndex} />
        ) : null}

        {data.activeSection === 'checks' ? (
          <PRChecksSection readOnly={data.readOnly}
            pr={data.pr}
            activeItemIndex={data.activeItemIndex}
            addedContextKeys={data.addedContextKeys}
            checkContextKey={data.checkContextKey}
            injectPayload={data.injectPayload}
            onInjectChatContext={onInjectChatContext}
            repo={repo}
          />
        ) : null}

        {data.activeSection === 'comments' ? (
          <PRCommentsSection
            prNumber={prNumber}
            visibleComments={data.currentVisibleComments}
            activeItemIndex={data.activeItemIndex}
            addedContextKeys={data.addedContextKeys}
            hoveredCommentKey={data.hoveredCommentKey}
            setHoveredCommentKey={data.setHoveredCommentKey}
            injectPayload={data.injectPayload}
            hideComment={data.hideComment}
            onInjectChatContext={onInjectChatContext}
            repo={repo}
          />
        ) : null}

        {data.activeSection === 'reviews' ? (
          <PRReviewThreadsSection
            prNumber={prNumber}
            visibleReviewThreads={data.readOnly ? data.currentVisibleReviewThreads.map(thread => ({ ...thread, viewerCanReply: false, viewerCanResolve: false, viewerCanUnresolve: false })) : data.currentVisibleReviewThreads}
            reviewsLoading={data.reviewsLoading}
            reviewThreadsError={data.reviewThreadsError}
            activeItemIndex={data.activeItemIndex}
            addedContextKeys={data.addedContextKeys}
            viewedThreadIds={data.viewedThreadIds}
            setViewedThreadIds={data.setViewedThreadIds}
            collapsedThreadIds={data.collapsedThreadIds}
            replyDrafts={data.replyDrafts}
            setReplyDrafts={data.setReplyDrafts}
            threadActionLoading={data.threadActionLoading}
            injectPayload={data.injectPayload}
            toggleViewedThread={data.toggleViewedThread}
            toggleCollapsedThread={data.toggleCollapsedThread}
            submitThreadReply={data.submitThreadReply}
            submitThreadResolve={data.submitThreadResolve}
            fetchReviewThreads={data.fetchReviewThreads}
            onInjectChatContext={onInjectChatContext}
            repo={repo}
          />
        ) : null}
      </div>
    </div>
  );
}
