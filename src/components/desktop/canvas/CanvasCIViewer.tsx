'use client';

import { memo, useState } from 'react';
import { ExternalLink, GitPullRequest } from '../lucide-shims';
import { MarkdownBody } from '@/components/desktop/MarkdownBody';
import { formatAge } from '@/components/desktop/canvas-utils';
import { relativeAge } from '@/lib/util/relative-age';
import { useCanvasCIRuns } from './useCanvasCIRuns';
import { useCanvasCIDetail } from './useCanvasCIDetail';
import { GitHubOrgNotCoveredError } from '@/lib/github/org-access';

function ciColor(conclusion: string, status: string): string {
  if (status === 'in_progress' || status === 'queued') return '#f59e0b';
  if (conclusion === 'success') return '#22c55e';
  if (conclusion === 'failure') return '#ef4444';
  if (conclusion === 'cancelled') return '#6b7280';
  return '#94a3b8';
}

function ciIcon(conclusion: string, status: string): string {
  if (status === 'in_progress') return '◉';
  if (status === 'queued') return '○';
  if (conclusion === 'success') return '✓';
  if (conclusion === 'failure') return '✗';
  if (conclusion === 'cancelled') return '⊘';
  return '○';
}

function CIViewerBase({ repo, initialRunId }: { repo?: string; initialRunId?: number }) {
  const runQuery = useCanvasCIRuns(repo);
  const { repoScope } = runQuery;
  const runs = runQuery.error instanceof GitHubOrgNotCoveredError ? [] : runQuery.data?.runs ?? [];
  const selectionScope = JSON.stringify([repoScope, initialRunId ?? null]);
  const [selection, setSelection] = useState<{ scope: string; id: number | null }>(() => ({ scope: selectionScope, id: initialRunId ?? null }));
  const requestedRun = selection.scope === selectionScope ? selection.id : initialRunId ?? null;
  const selectedRun = runs.some(run => run.databaseId === requestedRun) ? requestedRun : null;
  const detailQuery = useCanvasCIDetail(repo, selectedRun, runQuery.data?.repo);
  const runDetail = detailQuery.data?.run ?? null;
  const logs = detailQuery.data?.logs ?? '';
  const detailLoading = Boolean(selectedRun && detailQuery.isPending);

  const listError = runQuery.isError ? (
    <div role="status" style={{ paddingTop: 10, paddingRight: 14, paddingBottom: 10, paddingLeft: 14, fontSize: 12, color: 'var(--t-text-muted)' }}>
      {runQuery.error instanceof GitHubOrgNotCoveredError ? `${runQuery.error.message}. ` : runQuery.data
        ? `Showing last successful CI runs · ${relativeAge(runQuery.dataUpdatedAt)}. Refresh failed. `
        : 'Unable to load CI runs. '}
      <button type="button" onClick={() => { void runQuery.refetch(); }} style={{ color: 'var(--t-text)', background: 'var(--t-panel)', border: '1px solid var(--t-divider)', borderRadius: 6, cursor: 'pointer' }}>
        Retry
      </button>
    </div>
  ) : null;

  if (runQuery.isPending) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>Loading CI runs…</div>;
  }

  if (runs.length === 0) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>{listError ?? 'No workflow runs found'}</div>;
  }

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div
        style={{
          width: 340,
          flexShrink: 0,
          borderRight: '1px solid var(--t-divider)',
          overflowY: 'auto',
          background: 'var(--t-bg-subtle)',
        }}
      >
        {listError}
        {runs.map((run) => {
          const color = ciColor(run.conclusion, run.status);
          const icon = ciIcon(run.conclusion, run.status);
          const isActive = selectedRun === run.databaseId;
          return (
            <button
              key={run.databaseId}
              type="button"
              onClick={() => setSelection({ scope: selectionScope, id: run.databaseId })}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                width: '100%',
                paddingTop: 10,
                paddingRight: 14,
                paddingBottom: 10,
                paddingLeft: 14,
                border: 'none',
                borderLeft: isActive ? `3px solid ${color}` : '3px solid transparent',
                background: isActive ? 'rgba(37, 99, 235, 0.04)' : 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'var(--font-sans-system)',
                borderBottom: '1px solid var(--t-divider-subtle)',
              }}
            >
              <span
                style={{
                  fontSize: 16,
                  color,
                  fontWeight: 700,
                  lineHeight: 1.2,
                  flexShrink: 0,
                  marginTop: 1,
                }}
              >
                {icon}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: isActive ? 600 : 400,
                    color: 'var(--t-text-strong)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {run.displayTitle}
                </div>
                <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 2, display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace', fontSize: 10 }}>{run.headBranch}</span>
                  <span>·</span>
                  <span>{run.workflowName}</span>
                  <span>·</span>
                  <span>{formatAge(run.createdAt)}</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {selectedRun && detailQuery.isError ? (
          <div role="status" style={{ paddingTop: 16, paddingRight: 20, paddingBottom: 16, paddingLeft: 20, color: 'var(--t-text-muted)', fontSize: 12 }}>
            {detailQuery.data
              ? `Showing last successful run details · ${relativeAge(detailQuery.dataUpdatedAt)}. Refresh failed. `
              : 'Unable to load run details. '}
            <button type="button" aria-label="Retry run details" onClick={() => { void detailQuery.refresh(); }} style={{ color: 'var(--t-text)', background: 'var(--t-panel)', border: '1px solid var(--t-divider)', borderRadius: 6, cursor: 'pointer' }}>Retry details</button>
          </div>
        ) : null}
        {!selectedRun ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>
            Select a run to view details
          </div>
        ) : detailLoading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>
            Loading run details…
          </div>
        ) : runDetail ? (
          <div style={{ paddingTop: 16, paddingRight: 20, paddingBottom: 16, paddingLeft: 20 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--t-text)', marginBottom: 8 }}>
              {runDetail.displayTitle}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--t-text-secondary)', marginBottom: 16 }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  paddingTop: 2,
                  paddingRight: 8,
                  paddingBottom: 2,
                  paddingLeft: 8,
                  borderRadius: 99,
                  fontSize: 11,
                  fontWeight: 600,
                  color: ciColor(runDetail.conclusion, runDetail.status),
                  background: `${ciColor(runDetail.conclusion, runDetail.status)}12`,
                }}
              >
                {ciIcon(runDetail.conclusion, runDetail.status)} {runDetail.conclusion || runDetail.status}
              </span>
              <span>{runDetail.workflowName}</span>
              <span>·</span>
              <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace', fontSize: 10 }}>{runDetail.headBranch}</span>
              {runDetail.headSha ? (
                <>
                  <span>·</span>
                  <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace', fontSize: 10 }}>{runDetail.headSha.slice(0, 7)}</span>
                </>
              ) : null}
              <span>·</span>
              <span>{runDetail.event}</span>
            </div>

            {runDetail.pullRequests && runDetail.pullRequests.length > 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t-text-secondary)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                  Related PRs
                </div>
                {runDetail.pullRequests.map((pr) => (
                  <a
                    key={pr.number}
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
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
                      color: '#2563eb',
                      background: 'rgba(37,99,235,0.08)',
                      textDecoration: 'none',
                    }}
                  >
                    <GitPullRequest size={11} strokeWidth={2} />
                    PR #{pr.number}
                  </a>
                ))}
              </div>
            ) : null}

            {runDetail.jobs?.length > 0 ? (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Jobs
                </div>
                {runDetail.jobs.map((job, i) => {
                  const jobColor = ciColor(job.conclusion, job.status);
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 4 }}>
                      <span style={{ color: jobColor, fontWeight: 700 }}>{ciIcon(job.conclusion, job.status)}</span>
                      <span style={{ color: 'var(--t-text-strong)' }}>{job.name}</span>
                      <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{job.conclusion || job.status}</span>
                      {job.annotations && job.annotations.length > 0 ? (
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            color: '#d97706',
                            paddingTop: 1,
                            paddingRight: 6,
                            paddingBottom: 1,
                            paddingLeft: 6,
                            borderRadius: 99,
                            background: 'rgba(217,119,6,0.08)',
                          }}
                        >
                          {job.annotations.length} annotation{job.annotations.length === 1 ? '' : 's'}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}

            {runDetail.annotations?.length > 0 ? (
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Annotations
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>
                    {runDetail.annotations.length} total
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {runDetail.annotations.map((annotation, index) => {
                    const levelColor = annotation.level === 'failure'
                      ? '#dc2626'
                      : annotation.level === 'warning'
                        ? '#d97706'
                        : '#2563eb';
                    const location = annotation.path
                      ? `${annotation.path}${annotation.startLine ? `:${annotation.startLine}${annotation.endLine && annotation.endLine !== annotation.startLine ? `-${annotation.endLine}` : ''}` : ''}`
                      : 'Unknown location';

                    return (
                      <div
                        key={`${annotation.jobName ?? 'job'}:${annotation.path}:${annotation.startLine}:${index}`}
                        style={{
                          paddingTop: 10,
                          paddingRight: 12,
                          paddingBottom: 10,
                          paddingLeft: 12,
                          borderRadius: 10,
                          border: '1px solid var(--t-divider-subtle)',
                          background: 'var(--t-hover)',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 700,
                              color: levelColor,
                              textTransform: 'uppercase',
                              letterSpacing: '0.05em',
                            }}
                          >
                            {annotation.level}
                          </span>
                          {annotation.jobName ? (
                            <span style={{ fontSize: 11, color: 'var(--t-text-secondary)', fontWeight: 600 }}>
                              {annotation.jobName}
                            </span>
                          ) : null}
                          <span style={{ fontSize: 11, color: 'var(--t-text-muted)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                            {location}
                          </span>
                          {annotation.blobUrl ? (
                            <a
                              href={annotation.blobUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                marginLeft: 'auto',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4,
                                fontSize: 11,
                                color: 'var(--t-text-secondary)',
                                textDecoration: 'none',
                              }}
                            >
                              <ExternalLink size={11} />
                              Source
                            </a>
                          ) : null}
                        </div>
                        {annotation.title ? (
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text-strong)', marginBottom: 4 }}>
                            {annotation.title}
                          </div>
                        ) : null}
                        <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--t-text)' }}>
                          {annotation.message}
                        </div>
                        {annotation.rawDetails ? (
                          <div
                            style={{
                              marginTop: 6,
                              fontSize: 11,
                              lineHeight: 1.5,
                              color: 'var(--t-text-muted)',
                              fontFamily: '"SF Mono", ui-monospace, monospace',
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                            }}
                          >
                            {annotation.rawDetails}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {runDetail.botComments?.length > 0 ? (
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Related Bot Comments
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>
                    {runDetail.botComments.length} found
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {runDetail.botComments.map((comment) => (
                    <div
                      key={`${comment.kind}:${comment.id}`}
                      style={{
                        paddingTop: 10,
                        paddingRight: 12,
                        paddingBottom: 10,
                        paddingLeft: 12,
                        borderRadius: 10,
                        border: '1px solid var(--t-divider-subtle)',
                        background: 'var(--t-panel-translucent)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--t-text-strong)' }}>{comment.author}</span>
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            color: comment.kind === 'review' ? '#8b5cf6' : '#2563eb',
                            textTransform: 'uppercase',
                            letterSpacing: '0.05em',
                          }}
                        >
                          {comment.kind === 'review' ? 'review' : 'comment'}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>
                          PR #{comment.prNumber}
                        </span>
                        {comment.path ? (
                          <span style={{ fontSize: 11, color: 'var(--t-text-muted)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                            {comment.path}{comment.line ? `:${comment.line}` : ''}
                          </span>
                        ) : null}
                        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--t-text-muted)' }}>
                          {formatAge(comment.createdAt)}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                        <MarkdownBody text={comment.body} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {logs ? (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Logs
                </div>
                <pre
                  style={{
                    marginTop: 0,
                    marginRight: 0,
                    marginBottom: 0,
                    marginLeft: 0,
                    paddingTop: 14,
                    paddingRight: 14,
                    paddingBottom: 14,
                    paddingLeft: 14,
                    fontSize: '0.75rem',
                    lineHeight: 1.5,
                    fontFamily: '"SF Mono", "Menlo", ui-monospace, monospace',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    color: 'var(--t-text-strong)',
                    background: 'var(--t-hover)',
                    borderRadius: 8,
                    border: '1px solid var(--t-divider)',
                    maxHeight: 500,
                    overflowY: 'auto',
                  }}
                >
                  {logs}
                </pre>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const CIViewer = memo(CIViewerBase);
