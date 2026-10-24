'use client';

import { GithubReadStatus } from '@/components/github/GithubReadStatus';
import { memo, useState } from 'react';
// Raw SVG icons — lucide-react doesn't render in Tauri webview
function ChevronDownIcon({ size = 13 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}><path d="m6 9 6 6 6-6" /></svg>;
}
function ChevronRightIcon({ size = 13 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}><path d="m9 18 6-6-6-6" /></svg>;
}
import {
  AlertCircle,
  repoReadinessDisplayLabel,
  repoReadinessExplanation,
  repoReadinessPalette,
  shortenPath,
  worktreeStageTone,
  worktreeStatusExplanation,
  type BranchAgent,
  type RepoRegistryEntry,
} from './shared';
import { RepoStatusHover } from './RepoStatusHover';
import type { RepoCardModel } from './useRepoCardModel';

interface RepoCardHeaderProps {
  repo: RepoRegistryEntry;
  agentsByBranch?: Map<string, BranchAgent[]>;
  activePorts?: number[];
  isActive: boolean;
  expanded?: boolean;
  activeWorkspacePath?: string | null;
  onToggle: () => void;
  onSelectRepo: () => void;
  onLocate: (repo: RepoRegistryEntry) => void;
  onRemove: (repo: RepoRegistryEntry) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onReviewPR?: (prNumber: number, repo?: string) => void;
  model: Omit<RepoCardModel, 'cardRef'>;
}

function RepoCardHeaderBase({
  repo,
  agentsByBranch,
  isActive,
  expanded = false,
  activeWorkspacePath = null,
  onToggle,
  onSelectRepo,
  onLocate,
  onRemove,
  model,
}: RepoCardHeaderProps) {
  const {
    cardWidth,
    hoveringHeader,
    hoverPreviewRect,
    prPreview,
    prPreviewLoaded,
    previewCheckCounts,
    worktreeSummary,
    githubSlug,
    schedulePreviewHover,
    holdPreviewHover,
    closePreviewHover,
  } = model;
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const compactLayout = cardWidth > 0 && cardWidth < 320;
  const repoAgents = Array.from(
    new Map(
      Array.from(agentsByBranch?.values() ?? []).flatMap((branchAgents) => branchAgents.map((agent) => [agent.sessionKey, agent])),
    ).values(),
  );
  const activeWorktree = (worktreeSummary?.worktrees ?? []).find((worktree) => worktree.path === activeWorkspacePath) ?? null;
  const activeWorktreeTone = activeWorktree ? worktreeStageTone(activeWorktree.status) : null;
  const readinessPalette = repo.readiness ? repoReadinessPalette(repo.readiness.state) : null;
  const repoMissing = repo.readiness?.state === 'missing';
  const readinessDisplayLabel = repoReadinessDisplayLabel(repo.readiness?.state, repo.readiness?.label);
  const readinessExplanation = repoReadinessExplanation(repo.readiness);
  const activeWorktreeExplanation = worktreeStatusExplanation(activeWorktree);
  const rowStatusLabel = activeWorktreeTone?.label ?? readinessDisplayLabel ?? null;
  const rowStatusColor = activeWorktreeTone?.color ?? readinessPalette?.color ?? 'var(--t-text-faint)';
  const rowStatusExplanation = activeWorktreeExplanation ?? readinessExplanation;
  const showStatusInfo = Boolean(
    rowStatusLabel
    && rowStatusExplanation
    && (activeWorktreeTone?.label || repoMissing || repo.readiness?.state === 'blocked' || repo.readiness?.state === 'needs_setup'),
  );
  /* --- Compact activity badges (PR count + CI dot on the row header) --- */
  const openPrCount = prPreviewLoaded ? prPreview.length : 0;
  const ciTotal = previewCheckCounts.passed + previewCheckCounts.failed + previewCheckCounts.pending;
  const ciDotColor = previewCheckCounts.failed > 0
    ? '#ef4444'
    : previewCheckCounts.pending > 0
      ? '#f59e0b'
      : previewCheckCounts.passed > 0
        ? '#22c55e'
        : null;

  const primaryPreview = prPreview[0] ?? null;
  const rowMetaSegments: Array<{ key: string; content: React.ReactNode }> = [
    {
      key: 'branch',
      content: (
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {activeWorktree?.branch ?? repo.defaultBranch}
        </span>
      ),
    },
  ];
  if (rowStatusLabel) {
    // When the status is a blocker (env files missing, needs setup,
    // worktree stale), make the pill clickable. Click → dispatches
    // o8:resolve-blocker which the dashboard catches: focuses this
    // repo and injects a draft message into the orchestrator chat
    // explaining the issue so the user can ask the agent for help.
    const isBlocker = !repoMissing && showStatusInfo && Boolean(rowStatusExplanation);
    const handleBlockerClick = (event: React.MouseEvent<HTMLElement>) => {
      event.stopPropagation();
      if (typeof window === 'undefined') return;
      window.dispatchEvent(new CustomEvent('o8:resolve-blocker', {
        detail: {
          repoPath: repo.localPath,
          repoName: repo.name,
          explanation: rowStatusExplanation,
          statusLabel: rowStatusLabel,
        },
      }));
    };
    rowMetaSegments.push({
      key: 'status',
      content: isBlocker ? (
        <button
          type="button"
          onClick={handleBlockerClick}
          title={`${rowStatusExplanation ?? ''} — click to ask the orchestrator`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            minWidth: 0,
            color: rowStatusColor,
            fontWeight: 600,
            background: 'transparent',
            borderWidth: 0,
            padding: 0,
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 'inherit',
          }}
        >
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {rowStatusLabel}
          </span>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
            aria-hidden
          >
            <AlertCircle size={10} strokeWidth={2.1} />
          </span>
        </button>
      ) : (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            minWidth: 0,
            color: rowStatusColor,
            fontWeight: 600,
          }}
          title={rowStatusExplanation ?? undefined}
        >
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {rowStatusLabel}
          </span>
        </span>
      ),
    });
  }
  if (primaryPreview) {
    rowMetaSegments.push({ key: 'pr', content: <span>{`PR #${primaryPreview.number}`}</span> });
  }
  if (repoAgents.length > 0) {
    rowMetaSegments.push({ key: 'live', content: <span>{`${repoAgents.length} live`}</span> });
  }
  rowMetaSegments.splice(3);
  const repoHeaderLeadingInset = 14;
  const showHeaderHover = hoveringHeader && hoverPreviewRect !== null;

  return (
    <>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            padding: compactLayout ? '7px 12px 6px' : '8px 12px 7px',
            cursor: 'pointer',
          }}
          onClick={onSelectRepo}
          onMouseEnter={(event) => schedulePreviewHover(event.currentTarget as HTMLDivElement, event.clientX, event.clientY)}
          onMouseLeave={closePreviewHover}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, minWidth: 0 }}>
            <div style={{ flex: 1, minWidth: 0, paddingLeft: repoHeaderLeadingInset }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); onSelectRepo(); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onSelectRepo(); } }}
                  style={{
                    fontSize: 12,
                    fontWeight: 520,
                    color: isActive ? 'var(--t-text)' : 'var(--t-text-secondary)',
                    letterSpacing: '-0.008em',
                    fontFamily: 'var(--font-sans-system)',
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    cursor: 'pointer',
                    background: 'transparent',
                    borderWidth: 0,
                    padding: 0,
                  }}
                >
                  {repo.name.toLowerCase()}
                </span>
                {!repoMissing ? (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); onToggle(); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onToggle(); } }}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      color: 'var(--t-text-faint)',
                      marginTop: 1,
                      cursor: 'pointer',
                    }}
                  >
                    {expanded
                      ? <ChevronDownIcon size={12} />
                      : <ChevronRightIcon size={12} />}
                  </span>
                ) : null}
                {openPrCount > 0 ? (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      paddingTop: 1,
                      paddingBottom: 1,
                      paddingLeft: 5,
                      paddingRight: 5,
                      borderRadius: 999,
                      background: 'rgba(139, 92, 246, 0.08)',
                      color: '#8b5cf6',
                      fontSize: 9,
                      fontWeight: 600,
                      letterSpacing: '0.02em',
                      fontFamily: '"SF Mono", ui-monospace, monospace',
                      flexShrink: 0,
                      opacity: hoveringHeader ? 1 : 0.7,
                      transition: 'opacity 140ms cubic-bezier(0.22, 1, 0.36, 1)',
                    }}
                  >
                    {openPrCount}PR
                  </span>
                ) : null}
                {ciDotColor && ciTotal > 0 ? (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      opacity: hoveringHeader ? 1 : 0.7,
                      transition: 'opacity 140ms cubic-bezier(0.22, 1, 0.36, 1)',
                    }}
                    title={
                      previewCheckCounts.failed > 0
                        ? `${previewCheckCounts.failed} failing`
                        : previewCheckCounts.pending > 0
                          ? `${previewCheckCounts.pending} pending`
                          : `${previewCheckCounts.passed} passing`
                    }
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: ciDotColor,
                      }}
                    />
                  </span>
                ) : null}
              </div>
              <div
                style={{
                  marginTop: 2,
                  fontSize: 9.75,
                  fontWeight: 420,
                  lineHeight: 1.3,
                  color: 'var(--t-text-faint)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  letterSpacing: '-0.005em',
                  fontFamily: 'var(--font-sans-system)',
                }}
              >
                {rowMetaSegments.length > 0 ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 0, minWidth: 0, maxWidth: '100%' }}>
                    {rowMetaSegments.map((segment, index) => (
                      <span key={segment.key} style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>
                        {index > 0 ? (
                          <span style={{ padding: '0 5px', color: 'var(--t-text-faint)' }}>·</span>
                        ) : null}
                        {segment.content}
                      </span>
                    ))}
                  </span>
                ) : shortenPath(repo.localPath)}
              </div>
            </div>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setConfirmingRemove(true);
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 22,
                height: 22,
                borderRadius: 8,
                border: 'none',
                background: 'transparent',
                color: '#9ca3af',
                cursor: 'pointer',
                flexShrink: 0,
                fontSize: 16,
                fontWeight: 300,
                lineHeight: 0,
                fontFamily: 'var(--font-sans-system)',
                appearance: 'none',
                WebkitAppearance: 'none',
                marginRight: -2,
                opacity: hoveringHeader ? 1 : 0,
                transition: 'opacity 140ms cubic-bezier(0.22, 1, 0.36, 1), background 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1)',
              } as React.CSSProperties}
              onMouseEnter={(event) => {
                event.currentTarget.style.color = '#ef4444';
                event.currentTarget.style.background = 'rgba(239, 68, 68, 0.06)';
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.color = '#9ca3af';
                event.currentTarget.style.background = 'transparent';
              }}
              aria-label={`Remove ${repo.name}`}
            >
              &minus;
            </button>
          </div>
        </div>

        {repoMissing ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              paddingTop: 6,
              paddingRight: 12,
              paddingBottom: 8,
              paddingLeft: 26,
              background: 'var(--t-danger-soft)',
              borderBottom: '1px solid var(--t-danger-border)',
            }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 11,
                lineHeight: '15px',
                fontWeight: 300,
                color: 'var(--t-text-secondary)',
                overflowWrap: 'anywhere',
              }}
            >
              {repo.readiness?.summary}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onLocate(repo);
                }}
                style={{
                  minHeight: 44,
                  paddingTop: 0,
                  paddingRight: 10,
                  paddingBottom: 0,
                  paddingLeft: 10,
                  border: '1px solid var(--t-divider)',
                  borderRadius: 8,
                  background: 'var(--t-input-bg)',
                  color: 'var(--t-text)',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 500,
                  fontFamily: 'var(--font-sans-system)',
                }}
              >
                Locate folder…
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(repo);
                }}
                style={{
                  minHeight: 44,
                  paddingTop: 0,
                  paddingRight: 12,
                  paddingBottom: 0,
                  paddingLeft: 12,
                  border: '1px solid var(--t-danger-border)',
                  borderRadius: 8,
                  background: 'transparent',
                  color: 'var(--t-danger)',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 400,
                  fontFamily: 'var(--font-sans-system)',
                }}
              >
                Remove repo
              </button>
            </div>
          </div>
        ) : null}

        {showHeaderHover ? (
          <>
          <GithubReadStatus error={model.prPreviewError} updatedAt={model.prPreviewUpdatedAt} />
          <RepoStatusHover
            repo={repo}
            anchorRect={hoverPreviewRect}
            agents={repoAgents}
            githubSlug={githubSlug ?? null}
            onMouseEnter={holdPreviewHover}
            onMouseLeave={closePreviewHover}
          />
          </>
        ) : null}

        {confirmingRemove ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              padding: '6px 14px',
              background: 'rgba(239, 68, 68, 0.04)',
              borderBottom: '1px solid rgba(239, 68, 68, 0.1)',
            }}
          >
            <span style={{ fontSize: 11, color: 'var(--t-text-secondary)', fontWeight: 500 }}>
              Remove {repo.name}?
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setConfirmingRemove(false);
                }}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--t-text-muted)',
                  fontSize: 11,
                  fontWeight: 500,
                  cursor: 'pointer',
                  padding: '2px 6px',
                  fontFamily: 'var(--font-sans-system)',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(repo);
                  setConfirmingRemove(false);
                }}
                style={{
                  border: 'none',
                  background: 'rgba(239, 68, 68, 0.1)',
                  color: '#ef4444',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                  padding: '2px 8px',
                  borderRadius: 6,
                  fontFamily: 'var(--font-sans-system)',
                }}
              >
                Remove
              </button>
            </div>
          </div>
        ) : null}
    </>
  );
}

export const RepoCardHeader = memo(RepoCardHeaderBase);
