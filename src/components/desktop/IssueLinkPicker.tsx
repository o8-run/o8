'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, ExternalLink, Search } from './lucide-shims';
import { openExternalUrl } from '@/lib/desktop/open-external';
import { GithubReadStatus } from '@/components/github/GithubReadStatus';
import { useRepoIssues } from '@/lib/github-client';

export interface LinkedIssueRef {
  repo: string;
  number: number;
  title: string;
  body?: string | null;
  url?: string;
}

interface RepoOption {
  name: string;
  slug: string;
  remoteUrl?: string | null;
}

export function repoSlugFromRemoteUrl(remoteUrl?: string | null) {
  if (!remoteUrl) return null;

  const normalized = remoteUrl
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');
  const match = normalized.match(/github\.com\/([^/]+\/[^/]+)$/i);
  return match?.[1] ?? null;
}

export function buildLinkedIssueContext(linkedIssue?: LinkedIssueRef | null) {
  if (!linkedIssue) return '';
  const trimmedBody = linkedIssue.body?.trim() ?? '';
  const compactBody = trimmedBody
    ? trimmedBody.length > 1400
      ? `${trimmedBody.slice(0, 1400)}…`
      : trimmedBody
    : '';

  return [
    `Linked GitHub issue #${linkedIssue.number} in ${linkedIssue.repo}: ${linkedIssue.title}.`,
    compactBody ? `Issue context:\n${compactBody}` : null,
  ].filter(Boolean).join('\n\n');
}

export function IssueLinkPickerModal({
  open,
  onClose,
  onSelect,
  onClear,
  value,
  preferredRepo,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (issue: LinkedIssueRef) => void;
  onClear?: () => void;
  value?: LinkedIssueRef | null;
  preferredRepo?: { name?: string; remoteUrl?: string | null } | null;
}) {
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const issuesQuery = useRepoIssues(open ? selectedRepo : null);
  const issuesLoading = issuesQuery.isLoading;
  const listError = error || issuesQuery.data?.error
    || (issuesQuery.isError ? 'Unable to load GitHub issues for this repository.' : null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void (async () => {
      if (active) {
        setReposLoading(true);
        setError(null);
      }

      try {
        const response = await fetch('/api/panel/repos');
        const data = await response.json() as { repos?: Array<{ name?: string; remoteUrl?: string | null }> };
        if (!active) return;
        const nextRepos = (data.repos ?? [])
          .map((repo) => {
            const slug = repoSlugFromRemoteUrl(repo.remoteUrl);
            if (!slug) return null;
            return {
              name: repo.name ?? slug.split('/')[1] ?? slug,
              slug,
              remoteUrl: repo.remoteUrl,
            } satisfies RepoOption;
          })
          .filter(Boolean) as RepoOption[];
        setRepos(nextRepos);

        const preferredSlug = value?.repo || repoSlugFromRemoteUrl(preferredRepo?.remoteUrl) || nextRepos[0]?.slug || '';
        setSelectedRepo((current) => current || preferredSlug);
      } catch {
        if (active) {
          setRepos([]);
          setError('Unable to load registered repositories.');
        }
      } finally {
        if (active) setReposLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [open, preferredRepo?.remoteUrl, value?.repo]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, open]);

  const filteredIssues = useMemo(() => {
    const issues = (issuesQuery.data?.issues ?? []).filter((issue) => issue.state?.toLowerCase() === 'open');
    const normalized = query.trim().toLowerCase();
    if (!normalized) return issues;
    return issues.filter((issue) => (
      issue.title.toLowerCase().includes(normalized)
      || String(issue.number).includes(normalized)
    ));
  }, [issuesQuery.data?.issues, query]);

  if (!open || typeof document === 'undefined') return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9998,
        background: 'rgba(15, 23, 42, 0.18)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--cortex-dialog-overlay-padding)',
        boxSizing: 'border-box',
      }}
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 'min(560px, 100%)',
          maxHeight: 'min(76vh, 760px)',
          borderRadius: 22,
          border: '1px solid rgba(96, 165, 250, 0.18)',
          background: 'linear-gradient(180deg, rgba(255,255,255,0.96), rgba(239,246,255,0.92))',
          boxShadow: '0 24px 64px rgba(15, 23, 42, 0.16)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 16,
            padding: 'var(--cortex-dialog-header-padding)',
            borderBottom: '1px solid rgba(148, 163, 184, 0.14)',
          }}
        >
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-0.02em', color: '#0f172a' }}>
              Link Issue
            </div>
            <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.45, color: '#64748b' }}>
              Pick an open GitHub issue and keep it attached to this chat composer.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close issue picker"
            style={{
              width: 32,
              height: 32,
              padding: 0,
              borderRadius: 16,
              border: '1px solid rgba(148, 163, 184, 0.18)',
              background: 'linear-gradient(180deg, rgba(255,255,255,0.94), rgba(248,250,252,0.84))',
              color: '#475569',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              flexShrink: 0,
              boxShadow: '0 8px 18px rgba(15, 23, 42, 0.08)',
              appearance: 'none',
              WebkitAppearance: 'none',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                fontSize: 18,
                fontWeight: 600,
                lineHeight: 1,
                transform: 'translateY(-1px)',
              }}
            >
              ×
            </span>
          </button>
        </div>

        <div style={{ padding: 'var(--cortex-dialog-body-padding)', display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 220px' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Repository
              </span>
              <select
                value={selectedRepo}
                onChange={(event) => setSelectedRepo(event.currentTarget.value)}
                disabled={reposLoading || repos.length === 0}
                style={{
                  minHeight: 38,
                  borderRadius: 12,
                  border: '1px solid rgba(148, 163, 184, 0.18)',
                  background: 'rgba(255,255,255,0.8)',
                  color: '#0f172a',
                  fontSize: 13,
                  padding: '0 12px',
                  outline: 'none',
                }}
              >
                {repos.length === 0 ? <option value="">No repos available</option> : null}
                {repos.map((repo) => (
                  <option key={repo.slug} value={repo.slug}>
                    {repo.name} ({repo.slug})
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 180px' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Search
              </span>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  minHeight: 38,
                  borderRadius: 12,
                  border: '1px solid rgba(148, 163, 184, 0.18)',
                  background: 'rgba(255,255,255,0.8)',
                  padding: '0 12px',
                }}
              >
                <Search size={14} color="#94a3b8" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder="Issue number or title"
                  style={{
                    border: 'none',
                    outline: 'none',
                    background: 'transparent',
                    color: '#0f172a',
                    fontSize: 13,
                    width: '100%',
                  }}
                />
              </div>
            </label>
          </div>

          <div
            style={{
              minHeight: 0,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              paddingRight: 4,
            }}
          >
            <GithubReadStatus error={listError} updatedAt={issuesQuery.dataUpdatedAt} />
            {reposLoading || issuesLoading ? (
              <div style={{ padding: '28px 14px', fontSize: 13, color: '#64748b', textAlign: 'center' }}>
                Loading issues…
              </div>
            ) : filteredIssues.length > 0 ? (
              filteredIssues.map((issue) => {
                const selected = value?.repo === selectedRepo && value?.number === issue.number;
                return (
                  <button
                    key={`${selectedRepo}-${issue.number}`}
                    type="button"
                    onClick={() => {
                      onSelect({
                        repo: selectedRepo,
                        number: issue.number,
                        title: issue.title,
                        body: issue.body,
                        url: issue.url,
                      });
                      onClose();
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 10,
                      width: '100%',
                      padding: '12px 14px',
                      borderRadius: 16,
                      border: selected ? '1px solid rgba(37, 99, 235, 0.24)' : '1px solid rgba(148, 163, 184, 0.16)',
                      background: selected ? 'rgba(239,246,255,0.92)' : 'rgba(255,255,255,0.74)',
                      textAlign: 'left',
                      cursor: 'pointer',
                    }}
                  >
                    <span
                      style={{
                        minWidth: 34,
                        height: 24,
                        borderRadius: 999,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'rgba(37, 99, 235, 0.08)',
                        color: '#2563eb',
                        fontSize: 10,
                        fontWeight: 800,
                        fontFamily: 'ui-monospace, monospace',
                        flexShrink: 0,
                      }}
                    >
                      #{issue.number}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: '#0f172a', lineHeight: 1.4 }}>
                        {issue.title}
                      </span>
                      {issue.body ? (
                        <span style={{ display: 'block', marginTop: 4, fontSize: 11, color: '#64748b', lineHeight: 1.45 }}>
                          {issue.body.trim().slice(0, 180)}{issue.body.trim().length > 180 ? '…' : ''}
                        </span>
                      ) : null}
                    </span>
                    {selected ? <Check size={14} color="#2563eb" style={{ flexShrink: 0, marginTop: 2 }} /> : null}
                  </button>
                );
              })
            ) : (
              <div
                style={{
                  padding: '28px 16px',
                  borderRadius: 16,
                  border: '1px solid rgba(148, 163, 184, 0.14)',
                  background: 'rgba(255,255,255,0.7)',
                  textAlign: 'center',
                  color: '#64748b',
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                {listError || 'No open issues matched this search.'}
              </div>
            )}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: 'var(--cortex-dialog-footer-padding)',
            borderTop: '1px solid rgba(148, 163, 184, 0.14)',
          }}
        >
          <div style={{ fontSize: 11, color: '#94a3b8' }}>
            {value ? `Linked to #${value.number} in ${value.repo}` : 'No issue linked yet.'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {value?.url ? (
              <button
                type="button"
                onClick={() => openExternalUrl(value.url)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  minHeight: 32,
                  padding: '7px 11px',
                  borderRadius: 10,
                  border: '1px solid rgba(148, 163, 184, 0.16)',
                  background: 'rgba(255,255,255,0.72)',
                  color: '#64748b',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                <ExternalLink size={12} />
                Open issue
              </button>
            ) : null}
            {value && onClear ? (
              <button
                type="button"
                onClick={() => {
                  onClear();
                  onClose();
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  minHeight: 32,
                  padding: '7px 11px',
                  borderRadius: 10,
                  border: '1px solid rgba(239, 68, 68, 0.16)',
                  background: 'rgba(239, 68, 68, 0.08)',
                  color: '#dc2626',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                <AlertCircle size={12} />
                Clear link
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
