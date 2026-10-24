'use client';

import { memo, useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useMobileGithubContext, type getMobileGithubContext } from '@/lib/mobile/github-cache';
import { githubItemQuery } from '@/lib/github-client/item-query';
import { GithubReadStatus } from '@/components/github/GithubReadStatus';
import { useTheme } from './ThemeContext';

type ThemeColors = ReturnType<typeof useTheme>['colors'];

interface PRData {
  number: number;
  title: string;
  body: string;
  author: string;
  branch: string;
  baseBranch: string;
  state: string;
  mergeable: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  checksStatus: 'success' | 'failure' | 'pending' | 'unknown';
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  files: PRFile[];
  url: string;
}

interface PRFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}

interface PRReviewSheetProps {
  open: boolean;
  repoPath: string;
  prNumber: number | null;
  onClose: () => void;
  onViewDiff: (filePath: string) => void;
}

const STATUS_ICONS: Record<PRFile['status'], { color: string; label: string }> = {
  added: { color: '#30d158', label: 'A' },
  modified: { color: '#ff9f0a', label: 'M' },
  deleted: { color: '#ff453a', label: 'D' },
  renamed: { color: '#bf5af2', label: 'R' },
};

function sectionHeaderStyle(colors: ThemeColors) {
  return {
    display: 'block',
    fontSize: 12,
    fontWeight: 600,
    color: colors.textSecondary,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginBottom: 8,
    padding: '0 4px',
  };
}

function renderCheckIcon(status: PRData['checksStatus']) {
  switch (status) {
    case 'success':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#30d158" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      );
    case 'failure':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff453a" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
      );
    case 'pending':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff9f0a" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 7v5l3 3" />
        </svg>
      );
    default:
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#A09890" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      );
  }
}

function checkLabel(status: PRData['checksStatus']): { color: string; label: string } {
  switch (status) {
    case 'success':
      return { color: '#30d158', label: 'Checks passing' };
    case 'failure':
      return { color: '#ff453a', label: 'Checks failing' };
    case 'pending':
      return { color: '#ff9f0a', label: 'Checks running' };
    default:
      return { color: '#A09890', label: 'No checks' };
  }
}

export const PRReviewSheet = memo(function PRReviewSheet(props: PRReviewSheetProps) {
  const context = useMobileGithubContext();
  return <PRReviewSheetBody key={`${context.epoch}:${props.repoPath}:${props.prNumber}`} {...props} context={context} />;
});
function PRReviewSheetBody({
  open,
  repoPath,
  prNumber,
  onClose,
  onViewDiff,
  context,
}: PRReviewSheetProps & { context: ReturnType<typeof getMobileGithubContext> }) {
  const { colors } = useTheme();
  const query = useQuery({
    ...githubItemQuery<PRData>(repoPath, 'pr-summary', prNumber ?? 0,
      `/api/panel/pr?repo=${encodeURIComponent(repoPath)}&number=${prNumber}`, context),
    enabled: Boolean(open && prNumber && repoPath),
  }, context.client);
  const pr = query.data ?? null;
  const loading = query.isPending;
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [showComment, setShowComment] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleAction = useCallback(
    async (action: 'approve' | 'request_changes' | 'comment' | 'merge') => {
      if (!pr) return;
      setActionLoading(action);
      setError(null);
      setSuccess(null);

      try {
        const body: Record<string, unknown> = {
          repo: repoPath,
          number: pr.number,
          action,
        };
        if (action === 'comment' || action === 'request_changes') {
          body.comment = comment;
        }

        context.beforeRead();
        const response = await fetch('/api/panel/pr/review', {
          method: 'POST',
          headers: { ...context.headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const result = await response.json();

        if (!response.ok || result.error) {
          setError(result.error || `${action} failed`);
        } else {
          setSuccess(action === 'merge' ? 'PR merged' : action === 'approve' ? 'Approved' : 'Review submitted');
          setComment('');
          setShowComment(false);
          if (action === 'merge') {
            setTimeout(onClose, 1500);
          }
        }
      } catch {
        setError(`${action} failed`);
      } finally {
        setActionLoading(null);
      }
    },
    [pr, repoPath, comment, onClose, context]
  );

  if (!open) return null;

  const check = checkLabel(pr?.checksStatus ?? 'unknown');
  const reviewTone =
    pr?.reviewDecision === 'APPROVED'
      ? '#30d158'
      : pr?.reviewDecision === 'CHANGES_REQUESTED'
        ? '#ff9f0a'
        : '#A09890';

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.78)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          zIndex: 9998,
        }}
      />

      <div
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          maxHeight: '90dvh',
          borderRadius: '24px 24px 0 0',
          background: colors.bg,
          borderTop: `1px solid ${colors.cardBorder}`,
          boxShadow: '0 -16px 40px rgba(0,0,0,0.45)',
          zIndex: 9999,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 4px' }}>
          <div style={{ width: 36, height: 4, borderRadius: 999, background: colors.textTertiary }} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 20px 12px', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: colors.text, letterSpacing: '-0.03em' }}>
            Pull Request
          </h2>
          <button
            type="button"
            onClick={onClose}
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: colors.cardBg,
              border: `1px solid ${colors.cardBorder}`,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              WebkitTapHighlightColor: 'transparent',
              flexShrink: 0,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={colors.textSecondary} strokeWidth="3" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '0 20px 20px',
            WebkitOverflowScrolling: 'touch',
          }}
        >
          {loading ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: colors.textSecondary }}>Loading...</div>
          ) : null}

          <GithubReadStatus error={query.error} updatedAt={query.dataUpdatedAt} />
          {error && !loading ? (
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 14,
                background: colors.cardBg,
                border: '1px solid rgba(255,69,58,0.24)',
                color: '#ff453a',
                fontSize: 13,
                fontWeight: 600,
                marginBottom: 12,
              }}
            >
              {error}
            </div>
          ) : null}

          {success ? (
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 14,
                background: colors.cardBg,
                border: `1px solid ${colors.cardBorder}`,
                color: '#30d158',
                fontSize: 13,
                fontWeight: 600,
                marginBottom: 12,
              }}
            >
              {success}
            </div>
          ) : null}

          {pr ? (
            <>
              <div style={{ marginBottom: 12 }}>
                <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: colors.text, lineHeight: 1.35 }}>
                  {pr.title}
                  <span style={{ color: colors.textSecondary, fontWeight: 500 }}> #{pr.number}</span>
                </h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  <span
                    style={{
                      padding: '4px 8px',
                      borderRadius: 999,
                      background: colors.blueGlass,
                      border: `1px solid ${colors.blueGlassBorder}`,
                      fontSize: 11,
                      fontWeight: 600,
                      color: colors.blueAccent,
                      fontFamily: '"SF Mono", ui-monospace, monospace',
                    }}
                  >
                    {pr.branch} → {pr.baseBranch}
                  </span>
                  <span style={{ fontSize: 11, color: colors.textSecondary }}>by {pr.author}</span>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
                <div style={{ padding: '12px 10px', borderRadius: 14, textAlign: 'center', background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color: '#30d158' }}>+{pr.additions}</div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: colors.textSecondary }}>Added</div>
                </div>
                <div style={{ padding: '12px 10px', borderRadius: 14, textAlign: 'center', background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color: '#ff453a' }}>-{pr.deletions}</div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: colors.textSecondary }}>Removed</div>
                </div>
                <div style={{ padding: '12px 10px', borderRadius: 14, textAlign: 'center', background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color: colors.blueAccent }}>{pr.changedFiles}</div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: colors.textSecondary }}>Files</div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <div
                  style={{
                    flex: 1,
                    padding: '12px 14px',
                    borderRadius: 14,
                    background: colors.cardBg,
                    border: `1px solid ${colors.cardBorder}`,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  {renderCheckIcon(pr.checksStatus)}
                  <span style={{ fontSize: 12, fontWeight: 600, color: check.color }}>{check.label}</span>
                </div>

                {pr.reviewDecision ? (
                  <div
                    style={{
                      flex: 1,
                      padding: '12px 14px',
                      borderRadius: 14,
                      background: colors.cardBg,
                      border: `1px solid ${colors.cardBorder}`,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    {pr.reviewDecision === 'APPROVED' ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#30d158" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={reviewTone} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                      </svg>
                    )}
                    <span style={{ fontSize: 12, fontWeight: 600, color: reviewTone }}>
                      {pr.reviewDecision === 'APPROVED' ? 'Approved' : 'Changes requested'}
                    </span>
                  </div>
                ) : null}
              </div>

              <label style={sectionHeaderStyle(colors)}>Changed Files</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {pr.files.map((file) => {
                  const status = STATUS_ICONS[file.status] || STATUS_ICONS.modified;
                  return (
                    <button
                      key={file.path}
                      type="button"
                      onClick={() => onViewDiff(file.path)}
                      style={{
                        width: '100%',
                        minHeight: 44,
                        padding: '12px',
                        borderRadius: 14,
                        border: `1px solid ${colors.cardBorder}`,
                        background: colors.cardBg,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        cursor: 'pointer',
                        WebkitTapHighlightColor: 'transparent',
                        textAlign: 'left',
                      }}
                    >
                      <span
                        style={{
                          width: 20,
                          height: 20,
                          borderRadius: 6,
                          background: `${status.color}1f`,
                          color: status.color,
                          fontSize: 10,
                          fontWeight: 800,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        {status.label}
                      </span>
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: 12,
                          fontWeight: 500,
                          fontFamily: '"SF Mono", ui-monospace, monospace',
                          color: colors.text,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {file.path}
                      </span>
                      <span style={{ fontSize: 10, fontWeight: 600, color: '#30d158', flexShrink: 0 }}>+{file.additions}</span>
                      <span style={{ fontSize: 10, fontWeight: 600, color: '#ff453a', flexShrink: 0 }}>-{file.deletions}</span>
                    </button>
                  );
                })}
              </div>

              {showComment ? (
                <div style={{ marginTop: 12 }}>
                  <label style={sectionHeaderStyle(colors)}>Review Comment</label>
                  <textarea
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                    placeholder="Leave a review comment..."
                    rows={3}
                    style={{
                      width: '100%',
                      minHeight: 108,
                      padding: '12px 14px',
                      borderRadius: 14,
                      border: `1px solid ${colors.cardBorder}`,
                      background: colors.cardBg,
                      color: colors.text,
                      fontSize: 14,
                      resize: 'none',
                      outline: 'none',
                      lineHeight: 1.5,
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        {pr ? (
          <div
            style={{
              padding: '12px 20px',
              paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
              borderTop: `1px solid ${colors.cardBorder}`,
              display: 'flex',
              gap: 8,
            }}
          >
            <button
              type="button"
              onClick={() => {
                if (showComment && comment.trim()) {
                  handleAction('comment');
                } else {
                  setShowComment((value) => !value);
                }
              }}
              style={{
                flex: 1,
                minHeight: 44,
                borderRadius: 12,
                border: `1px solid ${colors.blueGlassBorder}`,
                background: colors.blueGlass,
                color: colors.blueAccent,
                fontSize: 13,
                fontWeight: 700,
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              {actionLoading === 'comment' ? '...' : showComment && comment.trim() ? 'Submit' : 'Comment'}
            </button>

            <button
              type="button"
              onClick={() => handleAction('approve')}
              disabled={actionLoading !== null}
              style={{
                flex: 1,
                minHeight: 44,
                borderRadius: 12,
                border: 'none',
                background: colors.blueAccent,
                color: colors.text,
                fontSize: 13,
                fontWeight: 700,
                cursor: actionLoading ? 'default' : 'pointer',
                opacity: actionLoading ? 0.6 : 1,
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              {actionLoading === 'approve' ? '...' : 'Approve'}
            </button>

            {pr.mergeable ? (
              <button
                type="button"
                onClick={() => handleAction('merge')}
                disabled={actionLoading !== null}
                style={{
                  flex: 1,
                  minHeight: 44,
                  borderRadius: 12,
                  border: `1px solid ${colors.cardBorder}`,
                  background: colors.cardBg,
                  color: colors.text,
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: actionLoading ? 'default' : 'pointer',
                  opacity: actionLoading ? 0.6 : 1,
                  WebkitTapHighlightColor: 'transparent',
                }}
              >
                {actionLoading === 'merge' ? '...' : 'Merge'}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
