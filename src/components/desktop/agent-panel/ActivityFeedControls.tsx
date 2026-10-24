'use client';

import { GithubReadStatus } from '@/components/github/GithubReadStatus';
import { memo, type CSSProperties, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, Folder, GitCommit, GitPullRequest, Globe, Zap } from '../lucide-shims';
import { THEME_ACCENT, THEME_ACCENT_SOFT, shortRepoLabel } from './shared';
import type { FeedFilter } from './types';

const FILTER_TABS: { key: FeedFilter; label: string; icon: ReactNode }[] = [
  { key: 'all', label: 'All', icon: <Zap size={11} strokeWidth={2} /> },
  { key: 'issue', label: 'Issues', icon: <AlertCircle size={11} strokeWidth={2} /> },
  { key: 'pr', label: 'PRs', icon: <GitPullRequest size={11} strokeWidth={2} /> },
  { key: 'commit', label: 'Commits', icon: <GitCommit size={11} strokeWidth={2} /> },
  { key: 'ci', label: 'CI', icon: <CheckCircle2 size={11} strokeWidth={2} /> },
];

interface ActivityFeedControlsProps {
  repoLabel: string;
  repoPickerOpen: boolean;
  onToggleRepoPicker: () => void;
  isAllRepos: boolean;
  repo: string | null;
  allRepos: string[];
  scopeHelp: string;
  remoteScopeError: string | null;
  remoteUpdatedAt?: number | null;
  filter: FeedFilter;
  counts: Record<FeedFilter, number>;
  onSelectFilter: (filter: FeedFilter) => void;
  onSelectRepo: (repo: string) => void;
  onSelectAllRepos: () => void;
  openPrContext: { count: number; repo: string } | null;
  onOpenPrs: (repo: string) => void;
}

function ActivityFeedControlsBase({
  repoLabel,
  repoPickerOpen,
  onToggleRepoPicker,
  isAllRepos,
  repo,
  allRepos,
  scopeHelp,
  remoteScopeError,
  remoteUpdatedAt,
  filter,
  counts,
  onSelectFilter,
  onSelectRepo,
  onSelectAllRepos,
  openPrContext,
  onOpenPrs,
}: ActivityFeedControlsProps) {
  return (
    <div style={{ padding: '8px 8px 6px' }}>
      <div
        style={{
          borderRadius: 12,
          border: '0.5px solid var(--t-divider-subtle)',
          background: 'var(--t-chrome)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 8px 6px',
            flexWrap: 'wrap',
          }}
        >
          <button
            type="button"
            onClick={onToggleRepoPicker}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              minHeight: 28,
              padding: '0 10px 0 8px',
              borderRadius: 8,
              border: '0.5px solid var(--t-divider-subtle)',
              background: 'var(--t-panel)',
              cursor: 'pointer',
              fontFamily: 'var(--font-sans-system)',
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--t-text)',
              letterSpacing: '-0.01em',
            }}
          >
            <span
              style={{
                width: 18,
                height: 18,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 999,
                background: THEME_ACCENT_SOFT,
                color: THEME_ACCENT,
              }}
            >
              <Folder size={11} strokeWidth={2} />
            </span>
            {repoLabel}
            <ChevronDown
              size={10}
              strokeWidth={2}
              style={{
                color: 'var(--t-text-muted)',
                transform: repoPickerOpen ? 'rotate(180deg)' : 'none',
                transition: 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)',
              }}
            />
          </button>

          {openPrContext ? (
            <button
              type="button"
              onClick={() => onOpenPrs(openPrContext.repo)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                height: 22,
                paddingTop: 0,
                paddingRight: 7,
                paddingBottom: 0,
                paddingLeft: 5,
                borderRadius: 6,
                border: 'none',
                background: 'rgba(34, 197, 94, 0.12)',
                color: '#16a34a',
                fontSize: 10,
                fontWeight: 700,
                cursor: 'pointer',
                fontFamily: '"SF Mono", ui-monospace, monospace',
                letterSpacing: '-0.01em',
                marginLeft: 'auto',
                flexShrink: 0,
              }}
            >
              <GitPullRequest size={10} strokeWidth={2.5} />
              {openPrContext.count}
            </button>
          ) : null}
        </div>

        {repoPickerOpen ? (
          <div
            style={{
              margin: '0 10px 8px',
              borderRadius: 14,
              border: '1px solid var(--t-panel-border)',
              background: 'var(--t-chrome)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              boxShadow: 'var(--t-panel-shadow)',
              maxHeight: 200,
              overflowY: 'auto',
              scrollbarWidth: 'none',
            } as CSSProperties}
            className="hide-scrollbar"
          >
            <button
              type="button"
              onClick={onSelectAllRepos}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '7px 12px',
                border: 'none',
                borderBottom: '1px solid var(--t-divider-subtle)',
                background: isAllRepos ? THEME_ACCENT_SOFT : 'transparent',
                color: isAllRepos ? THEME_ACCENT : 'var(--t-text)',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'var(--font-sans-system)',
                textAlign: 'left',
              }}
            >
              <Globe size={12} strokeWidth={2} style={{ color: isAllRepos ? THEME_ACCENT : 'var(--t-text-muted)' }} />
              GitHub
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: 9,
                  color: 'var(--t-text-faint)',
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                }}
              >
                registered
              </span>
              {isAllRepos ? <CheckCircle2 size={12} strokeWidth={2} style={{ color: THEME_ACCENT }} /> : null}
            </button>

            {allRepos.map((repoOption) => {
              const selected = repoOption === repo && !isAllRepos;
              return (
                <button
                  key={repoOption}
                  type="button"
                  onClick={() => onSelectRepo(repoOption)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '7px 12px',
                    border: 'none',
                    background: selected ? THEME_ACCENT_SOFT : 'transparent',
                    color: selected ? THEME_ACCENT : 'var(--t-text)',
                    fontSize: 12,
                    fontWeight: selected ? 600 : 400,
                    cursor: 'pointer',
                    fontFamily: 'var(--font-sans-system)',
                    textAlign: 'left',
                  }}
                >
                  <Folder size={12} strokeWidth={2} style={{ color: selected ? THEME_ACCENT : 'var(--t-text-muted)' }} />
                  {shortRepoLabel(repoOption)}
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: 9,
                      color: 'var(--t-text-faint)',
                      fontFamily: '"SF Mono", ui-monospace, monospace',
                    }}
                  >
                    {repoOption.split('/').pop()}
                  </span>
                  {selected ? <CheckCircle2 size={12} strokeWidth={2} style={{ color: THEME_ACCENT }} /> : null}
                </button>
              );
            })}
          </div>
        ) : null}

        <div
          style={{
            padding: '0 8px 6px',
            fontSize: 10,
            color: 'var(--t-text-faint)',
            lineHeight: 1.35,
          }}
        >
          {scopeHelp}
        </div>
        {remoteScopeError ? (
          <div
            style={{
              padding: '0 8px 6px',
              fontSize: 9,
              color: '#9ca3af',
              lineHeight: 1.35,
            }}
          >
            {remoteScopeError.includes('rate limit') ? 'GitHub API paused — will resume automatically' : 'GitHub sync delayed'}
            <GithubReadStatus error={remoteScopeError} updatedAt={remoteUpdatedAt} />
          </div>
        ) : null}

        <div style={{ padding: '0 8px 8px' }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: 3,
              borderRadius: 10,
              border: '0.5px solid var(--t-divider-subtle)',
              background: 'var(--t-panel)',
            }}
          >
            {FILTER_TABS.map((tab) => {
              const active = filter === tab.key;
              const count = counts[tab.key];
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => onSelectFilter(tab.key)}
                  aria-label={count > 0 && tab.key !== 'all' ? `${tab.label} ${count}` : tab.label}
                  title={count > 0 && tab.key !== 'all' ? `${tab.label} ${count}` : tab.label}
                  style={{
                    position: 'relative',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 26,
                    height: 24,
                    padding: 0,
                    borderRadius: 7,
                    border: 'none',
                    background: active ? 'var(--t-hover)' : 'transparent',
                    color: active ? 'var(--t-text)' : 'var(--t-text-muted)',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-sans-system)',
                    transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
                  }}
                >
                  {tab.icon}
                  {count > 0 && tab.key !== 'all' ? (
                    <span
                      style={{
                        position: 'absolute',
                        top: -2,
                        right: -2,
                        minWidth: 14,
                        height: 14,
                        padding: '0 4px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: 999,
                        background: active ? THEME_ACCENT : 'rgba(148, 163, 184, 0.16)',
                        color: '#ffffff',
                        boxShadow: '0 0 0 2px var(--t-panel)',
                        fontSize: 9,
                        fontWeight: 700,
                        fontFamily: '"SF Mono", ui-monospace, monospace',
                        lineHeight: 1,
                      }}
                    >
                      {count}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export const ActivityFeedControls = memo(ActivityFeedControlsBase);
