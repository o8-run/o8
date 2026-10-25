'use client';

import React, { memo } from 'react';
import {
  Check,
  GitMerge,
  Send,
  XCircle,
} from '../lucide-shims';
import { deriveWorkflowStage, describeWorkflowStage } from '@/lib/workflows/status';
import { readinessTone, formatAge } from '../canvas-utils';
import type { PRDetail, PRSection, PRSectionTab, ActionResult } from './types';
import { prStateStyles } from './constants';

interface PRHeaderProps {
  readOnly?: boolean;
  pr: PRDetail;
  activeSection: PRSection;
  setActiveSection: (section: PRSection) => void;
  reviewThreadCount: number;
  commentText: string;
  setCommentText: (text: string) => void;
  actionLoading: string | null;
  actionResult: ActionResult | null;
  submitAction: (action: string, comment?: string) => void;
  commentInputRef: React.RefObject<HTMLInputElement | null>;
}

function PRHeaderBase({
  pr,
  readOnly = false,
  activeSection,
  setActiveSection,
  reviewThreadCount,
  commentText,
  setCommentText,
  actionLoading,
  actionResult,
  submitAction,
  commentInputRef,
}: PRHeaderProps) {
  const stateStyle = prStateStyles[pr.state] ?? { color: '#6b7280', label: pr.state, bg: 'rgba(0,0,0,0.04)' };
  const ciChecks = pr.statusCheckRollup ?? [];
  const allComments = [
    ...pr.issueComments.map((c) => ({ ...c, kind: 'comment' as const })),
    ...pr.reviewComments.map((c) => ({ ...c, kind: 'review' as const })),
  ];
  const reviews = pr.reviews ?? [];
  const failedChecks = ciChecks.filter((check) => check.conclusion && check.conclusion.toLowerCase() !== 'success');
  const pendingChecks = ciChecks.filter((check) => !check.conclusion || check.status?.toLowerCase() !== 'completed');
  const requestedChangesCount = reviews.filter((review) => review.state?.toLowerCase() === 'changes_requested').length;
  const approvedCount = reviews.filter((review) => review.state?.toLowerCase() === 'approved').length;

  const reviewStage = deriveWorkflowStage({
    prState: pr.state,
    requestedChanges: requestedChangesCount,
    failedChecks: failedChecks.length,
    pendingChecks: pendingChecks.length,
  });
  const reviewGuidance = describeWorkflowStage({
    stage: reviewStage,
    prState: pr.state,
    requestedChanges: requestedChangesCount,
    approvedCount,
    failedChecks: failedChecks.length,
    pendingChecks: pendingChecks.length,
  });
  const mergeAllowed = reviewGuidance.mergeAllowed && (pr.mergeGate?.allowed ?? true);
  const reviewStatus = reviewStage
    ? {
        label: reviewStage.label,
        detail: reviewGuidance.detail,
        nextAction: reviewGuidance.nextAction,
        tone: reviewStage.key === 'blocked'
          ? { background: 'rgba(239,68,68,0.10)', border: 'rgba(239,68,68,0.18)', color: '#b91c1c' }
          : reviewStage.key === 'waiting'
            ? { background: 'rgba(245,158,11,0.10)', border: 'rgba(245,158,11,0.18)', color: '#b45309' }
            : reviewStage.key === 'merge_ready'
              ? { background: 'rgba(34,197,94,0.10)', border: 'rgba(34,197,94,0.18)', color: '#15803d' }
              : readinessTone(pr.readiness),
      }
    : null;

  const sections: PRSectionTab[] = [
    { id: 'overview', label: 'Overview', shortcut: '1' },
    { id: 'files', label: 'Files', count: pr.changedFiles, shortcut: '2' },
    { id: 'checks', label: 'Checks', count: ciChecks.length, shortcut: '3' },
    { id: 'comments', label: 'Comments', count: allComments.length, shortcut: '4' },
    { id: 'reviews', label: 'Threads', count: reviewThreadCount, shortcut: '5' },
  ];

  return (
    <>
      {/* Header */}
      <div style={{
        paddingTop: 16,
        paddingRight: 20,
        paddingBottom: 12,
        paddingLeft: 20,
        borderBottom: '1px solid #e5e7eb',
        background: '#ffffff',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            paddingTop: 3,
            paddingRight: 8,
            paddingBottom: 3,
            paddingLeft: 8,
            borderRadius: 99,
            fontSize: 11,
            fontWeight: 600,
            color: stateStyle.color,
            background: stateStyle.bg,
          }}>
            {stateStyle.label}
          </span>
          <span style={{ fontSize: 15, fontWeight: 600, color: '#111827' }}>
            #{pr.number} {pr.title}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6, fontSize: 12, color: '#6b7280' }}>
          <span>{pr.author.login}</span>
          <span>wants to merge</span>
          <span style={{
            fontFamily: '"SF Mono", ui-monospace, monospace',
            fontSize: 11,
            paddingTop: 1,
            paddingRight: 5,
            paddingBottom: 1,
            paddingLeft: 5,
            borderRadius: 4,
            background: '#f3f4f6',
            color: '#374151',
          }}>{pr.headRefName}</span>
          <span>→</span>
          <span style={{
            fontFamily: '"SF Mono", ui-monospace, monospace',
            fontSize: 11,
            paddingTop: 1,
            paddingRight: 5,
            paddingBottom: 1,
            paddingLeft: 5,
            borderRadius: 4,
            background: '#f3f4f6',
            color: '#374151',
          }}>{pr.baseRefName}</span>
          <span>·</span>
          <span style={{ color: '#22c55e', fontWeight: 600 }}>+{pr.additions}</span>
          <span style={{ color: '#ef4444', fontWeight: 600 }}>-{pr.deletions}</span>
          <span>·</span>
          <span>{formatAge(pr.createdAt)}</span>
          {reviewStatus ? (
            <>
              <span>·</span>
              <span
                title={reviewStatus.detail}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '2px 8px',
                  borderRadius: 999,
                  border: `1px solid ${reviewStatus.tone.border}`,
                  background: reviewStatus.tone.background,
                  color: reviewStatus.tone.color,
                  fontSize: 10,
                  fontWeight: 700,
                }}
              >
                {reviewStatus.label}
              </span>
            </>
          ) : null}
        </div>
        {pr.mergedBy ? (
          <div style={{ fontSize: 12, color: '#8b5cf6', marginTop: 4 }}>
            Merged by {pr.mergedBy.login} {pr.mergedAt ? formatAge(pr.mergedAt) : ''}
          </div>
        ) : null}

        {readOnly ? <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>Read-only stack</span> : null}
        {/* Section tabs + actions row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginTop: 10 }}>
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setActiveSection(s.id)}
              style={{
                paddingTop: 5,
                paddingRight: 12,
                paddingBottom: 5,
                paddingLeft: 12,
                borderRadius: 8,
                border: 'none',
                fontSize: 12,
                fontWeight: activeSection === s.id ? 600 : 400,
                color: activeSection === s.id ? '#2563eb' : '#6b7280',
                background: activeSection === s.id ? 'rgba(37,99,235,0.08)' : 'transparent',
                cursor: 'pointer',
                fontFamily: 'var(--font-sans-system)',
              }}
              title={`Shortcut ${s.shortcut}`}
            >
              {s.label}{s.count !== undefined ? ` (${s.count})` : ''}
              <span style={{
                marginLeft: 6,
                fontSize: 10,
                fontWeight: 700,
                color: activeSection === s.id ? '#1d4ed8' : '#9ca3af',
              }}>
                {s.shortcut}
              </span>
            </button>
          ))}

          {/* Action buttons -- only for open PRs */}
          {!readOnly && pr.state === 'OPEN' && (
            <>
              <div style={{ flex: 1 }} />
              <button
                type="button"
                onClick={() => submitAction('approve', commentText || undefined)}
                disabled={actionLoading !== null}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  paddingTop: 5,
                  paddingRight: 10,
                  paddingBottom: 5,
                  paddingLeft: 8,
                  borderRadius: 8,
                  border: '1px solid rgba(34, 197, 94, 0.2)',
                  background: actionLoading === 'approve' ? 'rgba(34,197,94,0.15)' : 'rgba(34,197,94,0.06)',
                  color: '#22c55e',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: actionLoading ? 'wait' : 'pointer',
                  fontFamily: 'var(--font-sans-system)',
                }}
              >
                <Check size={12} strokeWidth={2.5} />
                Approve
                <span style={{ fontSize: 10, opacity: 0.75 }}>A</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!commentText) { setActiveSection('comments'); return; }
                  submitAction('request-changes', commentText);
                }}
                disabled={actionLoading !== null}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  paddingTop: 5,
                  paddingRight: 10,
                  paddingBottom: 5,
                  paddingLeft: 8,
                  borderRadius: 8,
                  border: '1px solid rgba(239, 68, 68, 0.2)',
                  background: actionLoading === 'request-changes' ? 'rgba(239,68,68,0.15)' : 'rgba(239,68,68,0.06)',
                  color: '#ef4444',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: actionLoading ? 'wait' : 'pointer',
                  fontFamily: 'var(--font-sans-system)',
                }}
              >
                <XCircle size={12} strokeWidth={2.5} />
                Changes
                <span style={{ fontSize: 10, opacity: 0.75 }}>R</span>
              </button>
              <button
                type="button"
                onClick={() => submitAction('merge')}
                disabled={actionLoading !== null || !mergeAllowed}
                title={!mergeAllowed ? reviewGuidance.mergeDetail : 'Merge this pull request'}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  paddingTop: 5,
                  paddingRight: 10,
                  paddingBottom: 5,
                  paddingLeft: 8,
                  borderRadius: 8,
                  border: '1px solid rgba(139, 92, 246, 0.2)',
                  background: actionLoading === 'merge'
                    ? 'rgba(139,92,246,0.15)'
                    : !mergeAllowed
                      ? 'rgba(148,163,184,0.12)'
                      : 'rgba(139,92,246,0.06)',
                  color: !mergeAllowed ? 'var(--t-text-muted)' : '#8b5cf6',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: actionLoading ? 'wait' : reviewGuidance.mergeAllowed ? 'pointer' : 'not-allowed',
                  fontFamily: 'var(--font-sans-system)',
                  opacity: mergeAllowed ? 1 : 0.7,
                }}
              >
                <GitMerge size={12} strokeWidth={2.5} />
                Merge
                <span style={{ fontSize: 10, opacity: 0.75 }}>M</span>
              </button>
            </>
          )}
        </div>

        {/* Action result toast */}
        {actionResult && (
          <div style={{
            marginTop: 6,
            paddingTop: 4,
            paddingRight: 10,
            paddingBottom: 4,
            paddingLeft: 10,
            borderRadius: 6,
            fontSize: 11,
            fontWeight: 500,
            color: actionResult.type === 'success' ? '#22c55e' : '#ef4444',
            background: actionResult.type === 'success' ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)',
          }}>
            {actionResult.message}
          </div>
        )}
      </div>

      {/* Comment compose bar -- for open PRs */}
      {!readOnly && pr.state === 'OPEN' && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingTop: 6,
          paddingRight: 20,
          paddingBottom: 6,
          paddingLeft: 20,
          borderBottom: '1px solid #e5e7eb',
          background: '#f9fafb',
          flexShrink: 0,
        }}>
          <input
            ref={commentInputRef}
            name="reviewComment"
            type="text"
            placeholder="Add a comment... (C focuses, Cmd/Ctrl+Enter sends)"
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            onKeyDown={(e) => {
              if (((e.metaKey || e.ctrlKey) || !e.shiftKey) && e.key === 'Enter' && commentText.trim()) {
                e.preventDefault();
                submitAction('comment', commentText);
              }
            }}
            style={{
              flex: 1,
              border: '1px solid var(--t-divider)',
              borderRadius: 8,
              paddingTop: 6,
              paddingRight: 10,
              paddingBottom: 6,
              paddingLeft: 10,
              fontSize: 12,
              background: 'var(--t-panel)',
              color: 'var(--t-text)',
              outline: 'none',
              fontFamily: 'var(--font-sans-system)',
            }}
          />
          <button
            type="button"
            onClick={() => { if (commentText.trim()) submitAction('comment', commentText); }}
            disabled={!commentText.trim() || actionLoading !== null}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              paddingTop: 6,
              paddingRight: 10,
              paddingBottom: 6,
              paddingLeft: 10,
              borderRadius: 8,
              border: 'none',
              background: commentText.trim() ? '#2563eb' : 'var(--t-divider)',
              color: commentText.trim() ? '#fff' : 'var(--t-text-muted)',
              fontSize: 11,
              fontWeight: 600,
              cursor: commentText.trim() ? 'pointer' : 'default',
              fontFamily: 'var(--font-sans-system)',
            }}
          >
            <Send size={11} />
            Comment
          </button>
        </div>
      )}
    </>
  );
}

export const PRHeader = memo(PRHeaderBase);
