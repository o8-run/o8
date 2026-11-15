'use client';

import { memo, useMemo } from 'react';
import type { PrDetail, PrIssueComment, PrReviewComment, PrSubmittedReview } from '../types';
import { PrMarkdown } from '../PrMarkdown';

const MONO_FONT = "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace";

type CombinedComment =
  | { kind: 'issue'; id: number; author: string; body: string; createdAt: string }
  | { kind: 'review'; id: number; author: string; body: string; createdAt: string; path: string; line: number | null }
  | ({ kind: 'submitted'; createdAt: string } & PrSubmittedReview);

interface ReviewsTabProps {
  reviewComments: PrReviewComment[];
  issueComments: PrIssueComment[];
  reviewDecision: string | null;
  detail?: PrDetail;
  onOpenFile?: (path: string) => void;
}

function decisionPill(decision: string | null): { label: string; bg: string; color: string } | null {
  if (!decision) return null;
  const d = decision.toUpperCase();
  if (d === 'APPROVED') return { label: 'Approved', bg: 'rgba(22, 163, 74, 0.14)', color: '#16a34a' };
  if (d === 'CHANGES_REQUESTED') return { label: 'Changes Requested', bg: 'rgba(239, 68, 68, 0.14)', color: '#ef4444' };
  if (d === 'COMMENTED') return { label: 'Commented', bg: 'rgba(148, 163, 184, 0.18)', color: 'var(--t-text-muted)' };
  return { label: decision, bg: 'rgba(148, 163, 184, 0.18)', color: 'var(--t-text-muted)' };
}

function formatTime(value: string): string {
  if (!value) return '';
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return '';
  const diffMs = Date.now() - ms;
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.max(1, Math.round(diffMs / 60_000))}m ago`;
  if (diffMs < 86_400_000) return `${Math.max(1, Math.round(diffMs / 3_600_000))}h ago`;
  return `${Math.max(1, Math.round(diffMs / 86_400_000))}d ago`;
}

const CommentRow = memo(function CommentRow({ comment, detail, onOpenFile }: { comment: CombinedComment; detail?: PrDetail; onOpenFile?: (path: string) => void }) {
  const initial = (comment.author || '?').slice(0, 1).toUpperCase();
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        paddingTop: 12,
        paddingBottom: 12,
        paddingLeft: 14,
        paddingRight: 14,
        borderBottom: '1px solid var(--t-divider-subtle)',
      }}
    >
      <div
        style={{
          width: 26,
          height: 26,
          borderRadius: 999,
          background: 'var(--t-bg-card)',
          color: 'var(--t-text-secondary, var(--t-text-muted))',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          fontWeight: 400,
          flexShrink: 0,
        }}
      >
        {initial}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text)' }}>{comment.author}</span>
          <time dateTime={comment.createdAt} title={comment.createdAt} style={{ fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', color: 'var(--t-text-faint)' }}>{formatTime(comment.createdAt)}</time>
          {comment.kind === 'submitted' ? <span style={{ fontSize: 11, fontWeight: 300, color: 'var(--t-text-muted)' }}>{decisionPill(comment.state)?.label ?? 'Review submitted'}</span> : null}
          {comment.kind === 'review' && comment.path ? (
            <span
              style={{
                fontSize: 10,
                color: 'var(--t-text-muted)',
                fontFamily: MONO_FONT,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={`${comment.path}${comment.line ? `:${comment.line}` : ''}`}
            >
              {comment.path}{comment.line ? `:${comment.line}` : ''}
            </span>
          ) : null}
        </div>
        {comment.kind === 'submitted' ? <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', color: 'var(--t-text-muted)' }}>
          <span title={comment.reviewedHeadSha ?? undefined}>
            {comment.reviewedHeadSha ? `Reviewed ${comment.reviewedHeadSha.slice(0, 8)}` : 'Reviewed revision unavailable'}
          </span>
          {comment.reviewedHeadSha ? <span>{!detail?.headSha ? 'Current revision unavailable' : comment.reviewedHeadSha === detail.headSha ? 'Current revision' : 'Different revision'}</span> : null}
          {comment.url?.startsWith('https://') ? <a href={comment.url} target="_blank" rel="noreferrer" aria-label={`Open review by ${comment.author} on GitHub`} style={{ color: 'var(--t-text-muted)', minHeight: 26, display: 'inline-flex', alignItems: 'center', textUnderlineOffset: 3 }}>Open review</a> : null}
        </div> : null}
        <div
          style={{
            fontSize: 13,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            color: 'var(--t-text)',
            lineHeight: 1.45,
            whiteSpace: detail ? 'normal' : 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {comment.body ? detail && onOpenFile ? <PrMarkdown text={comment.body} detail={detail} onOpenFile={onOpenFile} /> : comment.body : <span style={{ color: 'var(--t-text-faint)', fontStyle: 'italic' }}>(no body)</span>}
        </div>
      </div>
    </div>
  );
});

export const ReviewsTab = memo(function ReviewsTab({ reviewComments, issueComments, reviewDecision, detail, onOpenFile }: ReviewsTabProps) {
  const submittedReviews = detail?.submittedReviews;
  const combined = useMemo<CombinedComment[]>(() => {
    const merged: CombinedComment[] = [
      ...issueComments.map((comment): CombinedComment => ({
        kind: 'issue',
        id: comment.id,
        author: comment.user,
        body: comment.body,
        createdAt: comment.created_at,
      })),
      ...reviewComments.map((comment): CombinedComment => ({
        kind: 'review',
        id: comment.id,
        author: comment.author,
        body: comment.body,
        createdAt: comment.createdAt,
        path: comment.path,
        line: comment.line,
      })),
      ...(submittedReviews ?? []).map((review): CombinedComment => ({ ...review, kind: 'submitted', createdAt: review.submittedAt })),
    ];
    const unique = [...new Map(merged.map(comment => [`${comment.kind}-${comment.id}`, comment])).values()];
    unique.sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0) || `${a.kind}-${a.id}`.localeCompare(`${b.kind}-${b.id}`));
    return unique;
  }, [issueComments, reviewComments, submittedReviews]);

  const pill = decisionPill(reviewDecision);

  return (
    <div>
      {pill ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            paddingTop: 10,
            paddingBottom: 10,
            paddingLeft: 14,
            paddingRight: 14,
            borderBottom: '1px solid var(--t-divider-subtle)',
            background: 'var(--t-bg-card)',
          }}
        >
          <span style={{ fontSize: 10, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text-faint)' }}>Latest review:</span>
          <span
            style={{
              display: 'inline-flex',
              paddingTop: 2,
              paddingBottom: 2,
              paddingLeft: 8,
              paddingRight: 8,
              borderRadius: 999,
              background: pill.bg,
              color: pill.color,
              fontSize: 9,
              fontWeight: 300,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            {pill.label}
          </span>
        </div>
      ) : null}

      {detail?.discussionIncomplete ? <div role="status" style={{ paddingTop: 8, paddingRight: 14, paddingBottom: 8, paddingLeft: 14, fontSize: 11, color: 'var(--t-text-muted)' }}>Discussion is incomplete. Open GitHub for the full conversation.</div> : null}
      {combined.length === 0 && !detail?.discussionIncomplete ? (
        <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>
          No comments or reviews yet.
        </div>
      ) : (
        combined.map((comment) => (
          <CommentRow key={`${comment.kind}-${comment.id}`} comment={comment} detail={detail} onOpenFile={onOpenFile} />
        ))
      )}
    </div>
  );
});
