'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from '../lucide-shims';
import { useWorkspaceChanges } from '../o8-panel/workspace-rail/ChangesList';
import { useLaneReviewChanges } from './useLaneReviewChanges';
import { useLaneReviewSummary } from './useLaneReviewSummary';
import { LaneReviewSummaryHeader } from './panel/LaneReviewSummaryHeader';
import { ReviewGitActions } from './ReviewGitActions';
import { useArtifacts } from '../artifacts/useArtifacts';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { DiffMode, CollapseSignal, ReviewScope } from './panel/types';
import {
  SCOPE_LABELS,
  SCOPE_ORDER,
  UI_FONT,
  REVIEW_CONTROL_BG,
  REVIEW_CONTROL_BG_ACTIVE,
  REVIEW_POPOVER_BG,
  REVIEW_POPOVER_SHADOW,
} from './panel/constants';
import { IconFilesDrawer, IconScopeFilter, IconSplit, IconUnified, IconViewOptions, DiffStatBadge } from './panel/icons';
import { PanelMessage } from './panel/DiffView';
import { ReviewFileRow, ToolbarButton, MenuItem } from './panel/ReviewFileRow';
import { FilesDrawer } from './panel/FilesDrawer';
import { ReviewSkeleton } from './panel/ReviewSkeleton';
import { MissingWorktreeNotice } from './panel/MissingWorktreeNotice';
import { WORKTREE_MISSING_CODE } from '@/lib/lane/review-target-codes';
import { useArchitectureDelta } from './useArchitectureDelta';
import { useArchitectureAttention } from './useArchitectureAttention';
import { ArchitectureDeltaCard } from './panel/ArchitectureDeltaCard';
import { reviewPathCandidates, reviewRowPathForSourcePath } from './panel/review-paths';
import { useDiffModeAnchor } from './useDiffModeAnchor';

/**
 * ReviewPanel — the dedicated Review surface for the right panel's `review`
 * mode. One continuous diff, no file-list rail. Every changed
 * file is a collapsible row whose diff loads inline on expand.
 *
 * Phase 1: continuous diff.  Phase 2: header — file filter +
 * unified/split diff toggle.  Phase 3: chat-file clicks → header tabs.
 * (A scope dropdown — Last turn / Staged — needs backend data wiring and is
 * tracked as its own follow-up, not part of this header.)
 */

interface LastTurnScopeResponse {
  filePaths?: string[];
}

function lastTurnPathMatches(reviewPath: string, lastTurnPaths: Set<string>) {
  return reviewPathCandidates(reviewPath).some((candidate) => (
    lastTurnPaths.has(candidate) || (candidate.endsWith('.tsx') && lastTurnPaths.has(candidate.slice(0, -1)))
  ));
}

export const ReviewPanel = memo(function ReviewPanel({ repoPath, registeredRepos = [], onRepoPathChange, selectedFile = null, reviewLaneId = null }: { repoPath?: string | null; registeredRepos?: RepoRegistryEntry[]; onRepoPathChange?: (repoPath: string) => void; selectedFile?: string | null; reviewLaneId?: string | null }) {
  const localChanges = useWorkspaceChanges(reviewLaneId ? null : repoPath);
  const laneChanges = useLaneReviewChanges(reviewLaneId);
  const changes = reviewLaneId ? laneChanges : localChanges;
  const laneSummary = useLaneReviewSummary(reviewLaneId);
  const { artifacts: laneArtifacts } = useArtifacts({ laneId: reviewLaneId, enabled: Boolean(reviewLaneId) });
  const [fileQuery, setFileQuery] = useState('');
  const [mode, setMode] = useState<DiffMode>('unified');
  const [wrap, setWrap] = useState(true);
  const [wordDiff, setWordDiff] = useState(false);
  const [hideWhitespace, setHideWhitespace] = useState(false);
  const [richPreview, setRichPreview] = useState(false);
  const [collapseSignal, setCollapseSignal] = useState<CollapseSignal>({ open: false, nonce: 0 });
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [scope, setScope] = useState<ReviewScope>('all');
  const [scopeOpen, setScopeOpen] = useState(false);
  const scopeRef = useRef<HTMLDivElement | null>(null);
  const [repoMenuOpen, setRepoMenuOpen] = useState(false);
  const repoMenuRef = useRef<HTMLDivElement | null>(null);
  const [filesDrawerOpen, setFilesDrawerOpen] = useState(false);
  const [focusSignal, setFocusSignal] = useState<{ path: string | null; nonce: number }>({ path: null, nonce: 0 });
  const [lastTurnPaths, setLastTurnPaths] = useState<Set<string>>(new Set());
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const { capture: captureDiffAnchor, selectFile: selectDiffAnchor } = useDiffModeAnchor(mode, rowRefs);

  // Close the header menus on outside-click or Escape.
  useEffect(() => {
    if (!menuOpen && !scopeOpen && !repoMenuOpen && !filesDrawerOpen) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current && !menuRef.current.contains(target)) setMenuOpen(false);
      if (scopeRef.current && !scopeRef.current.contains(target)) setScopeOpen(false);
      if (repoMenuRef.current && !repoMenuRef.current.contains(target)) setRepoMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        setScopeOpen(false);
        setRepoMenuOpen(false);
        setFilesDrawerOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, scopeOpen, repoMenuOpen, filesDrawerOpen]);

  const handleCollapseAll = () => {
    setCollapseSignal((signal) => ({ open: !signal.open, nonce: signal.nonce + 1 }));
    setMenuOpen(false);
  };
  const handleWordWrap = () => {
    setWrap((value) => !value);
    setMenuOpen(false);
  };
  const handleWordDiff = () => {
    setWordDiff((value) => !value);
    setMenuOpen(false);
  };
  const handleHideWhitespace = () => {
    setHideWhitespace((value) => !value);
    setMenuOpen(false);
  };
  const handleRichPreview = () => {
    setRichPreview((value) => !value);
    setMenuOpen(false);
  };
  const handleSelectScope = (next: ReviewScope) => {
    setScope(next);
    setScopeOpen(false);
  };
  const handleSelectRepo = (path: string) => {
    onRepoPathChange?.(path);
    setRepoMenuOpen(false);
  };
  const setRowRef = useCallback((path: string, node: HTMLDivElement | null) => {
    if (node) rowRefs.current.set(path, node);
    else rowRefs.current.delete(path);
  }, []);
  const jumpToFile = useCallback((path: string) => {
    selectDiffAnchor(path);
    setFocusSignal((signal) => ({ path, nonce: signal.nonce + 1 }));
    window.setTimeout(() => {
      rowRefs.current.get(path)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 40);
  }, [selectDiffAnchor]);
  const currentRepo = registeredRepos.find((repo) => repo.localPath === repoPath);
  const repoLabel = currentRepo?.name ?? (repoPath ? (repoPath.split('/').filter(Boolean).pop() ?? 'Repo') : 'Repo');
  const changedFilesKey = useMemo(() => changes.files.map((file) => file.path).join('\n'), [changes.files]);
  const diffRepoPath = changes.repoPath ?? repoPath ?? null;
  const architecture = useArchitectureDelta({
    repoPath: diffRepoPath,
    laneId: reviewLaneId,
    analysisKey: changes.files,
    enabled: Boolean(diffRepoPath && changes.files.length > 0 && !changes.loading),
  });
  const handleRefresh = () => {
    void changes.refresh();
    setMenuOpen(false);
  };
  useEffect(() => {
    if (!repoPath) {
      setLastTurnPaths(new Set());
      return;
    }

    let cancelled = false;
    const loadLastTurn = async () => {
      try {
        const response = await fetch(`/api/review/last-turn?workspace=${encodeURIComponent(repoPath)}`);
        if (!response.ok) throw new Error('Failed to load last-turn scope');
        const data = await response.json() as LastTurnScopeResponse;
        const paths = Array.isArray(data.filePaths)
          ? data.filePaths.filter((item): item is string => typeof item === 'string' && item.length > 0)
          : [];
        if (!cancelled) setLastTurnPaths(new Set(paths));
      } catch {
        if (!cancelled) setLastTurnPaths(new Set());
      }
    };

    void loadLastTurn();
    return () => { cancelled = true; };
  }, [changedFilesKey, repoPath]);

  const visible = useMemo(() => {
    let list = changes.files;
    if (scope === 'staged') list = list.filter((file) => file.staged);
    else if (scope === 'unstaged') list = list.filter((file) => file.unstaged);
    else if (scope === 'last-turn') list = list.filter((file) => lastTurnPathMatches(file.path, lastTurnPaths));
    return list;
  }, [changes.files, lastTurnPaths, scope]);
  const architectureScopePaths = useMemo(
    () => [...new Set(visible.flatMap((file) => reviewPathCandidates(file.path)))],
    [visible],
  );
  const architectureAttention = useArchitectureAttention({
    repoPath: diffRepoPath,
    laneId: reviewLaneId,
    analysis: architecture.result,
    scopePaths: architectureScopePaths,
    enabled: Boolean(architecture.result?.status === 'ready' && architectureScopePaths.length > 0),
  });
  const jumpFromArchitecture = useCallback((path: string) => {
    const reviewPath = reviewRowPathForSourcePath(path, visible.map((file) => file.path));
    if (reviewPath) jumpToFile(reviewPath);
  }, [jumpToFile, visible]);
  const drawerQuery = fileQuery.trim().toLowerCase();
  const drawerFiles = useMemo(() => (
    drawerQuery ? visible.filter((file) => file.path.toLowerCase().includes(drawerQuery)) : visible
  ), [drawerQuery, visible]);
  const visibleStats = useMemo(
    () => visible.reduce(
      (acc, file) => ({
        additions: acc.additions + (file.additions ?? 0),
        deletions: acc.deletions + (file.deletions ?? 0),
      }),
      { additions: 0, deletions: 0 },
    ),
    [visible],
  );
  const hasFiles = changes.files.length > 0;

  useEffect(() => {
    if (!selectedFile || changes.loading) return;
    const root = diffRepoPath?.replace(/\/$/, '');
    const path = root && selectedFile.startsWith(`${root}/`) ? selectedFile.slice(root.length + 1) : selectedFile;
    const row = reviewRowPathForSourcePath(path, changedFilesKey.split('\n'));
    if (row) jumpToFile(row);
  }, [changedFilesKey, changes.loading, diffRepoPath, jumpToFile, selectedFile]);

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--t-bg)', overflow: 'hidden' }}>
      {hasFiles ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 40, paddingTop: 6, paddingBottom: 6, paddingLeft: 14, paddingRight: 10, borderBottom: '1px solid var(--t-divider-subtle)', flexShrink: 0 }}>
          {registeredRepos.length > 1 ? (
            <div ref={repoMenuRef} style={{ position: 'relative', flexShrink: 0 }}>
              <button
                type="button"
                onClick={() => setRepoMenuOpen((open) => !open)}
                title="Switch repository"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  height: 28,
                  maxWidth: 168,
                  paddingLeft: 9,
                  paddingRight: 7,
                  border: '1px solid var(--t-input-border)',
                  borderRadius: 8,
                  background: repoMenuOpen ? REVIEW_CONTROL_BG_ACTIVE : REVIEW_CONTROL_BG,
                  color: 'var(--t-text)',
                  fontFamily: UI_FONT,
                  fontSize: 12,
                  fontWeight: 650,
                  cursor: 'pointer',
                }}
                onMouseEnter={(event) => { if (!repoMenuOpen) event.currentTarget.style.background = REVIEW_CONTROL_BG_ACTIVE; }}
                onMouseLeave={(event) => { if (!repoMenuOpen) event.currentTarget.style.background = REVIEW_CONTROL_BG; }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{repoLabel}</span>
                <ChevronDown size={12} strokeWidth={2} />
              </button>
              {repoMenuOpen ? (
                <div
                  role="menu"
                  style={{
                    position: 'absolute',
                    top: 34,
                    left: 0,
                    minWidth: 180,
                    maxWidth: 300,
                    padding: 4,
                    borderRadius: 10,
                    background: REVIEW_POPOVER_BG,
                    border: '1px solid var(--t-input-border)',
                    boxShadow: REVIEW_POPOVER_SHADOW,
                    zIndex: 50,
                  }}
                >
                  {registeredRepos.map((repo) => (
                    <MenuItem key={repo.id} checked={repo.localPath === repoPath} onClick={() => handleSelectRepo(repo.localPath)}>
                      {repo.name}
                    </MenuItem>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <div ref={scopeRef} style={{ position: 'relative', flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setScopeOpen((open) => !open)}
              title={SCOPE_LABELS[scope]}
              aria-label={`Review scope: ${SCOPE_LABELS[scope]}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 0,
                width: 28,
                height: 28,
                padding: 0,
                border: '1px solid var(--t-input-border)',
                borderRadius: 8,
                background: scopeOpen ? REVIEW_CONTROL_BG_ACTIVE : REVIEW_CONTROL_BG,
                color: scopeOpen ? 'var(--t-text)' : 'var(--t-text-muted)',
                fontFamily: UI_FONT,
                fontSize: 12,
                fontWeight: 300,
                letterSpacing: '-0.1px',
                cursor: 'pointer',
              }}
              onMouseEnter={(event) => { if (!scopeOpen) event.currentTarget.style.background = REVIEW_CONTROL_BG_ACTIVE; }}
              onMouseLeave={(event) => { if (!scopeOpen) event.currentTarget.style.background = REVIEW_CONTROL_BG; }}
            >
              <IconScopeFilter size={14} />
            </button>
            {scopeOpen ? (
              <div
                role="menu"
                style={{
                  position: 'absolute',
                  top: 34,
                  left: 0,
                  minWidth: 156,
                  padding: 4,
                  borderRadius: 10,
                  background: REVIEW_POPOVER_BG,
                  border: '1px solid var(--t-input-border)',
                  boxShadow: REVIEW_POPOVER_SHADOW,
                  zIndex: 50,
                }}
              >
                {SCOPE_ORDER.map((option) => (
                  <MenuItem key={option} checked={scope === option} onClick={() => handleSelectScope(option)}>
                    {SCOPE_LABELS[option]}
                  </MenuItem>
                ))}
              </div>
            ) : null}
          </div>
          <DiffStatBadge additions={visibleStats.additions} deletions={visibleStats.deletions} />
          {changes.sourceLabel ? (
            <span style={{ flexShrink: 0, fontSize: 10, color: 'var(--t-text-faint)', fontFamily: UI_FONT, whiteSpace: 'nowrap' }}>
              {changes.sourceLabel}
            </span>
          ) : null}
          <div style={{ flex: 1, minWidth: 8 }} />

          <ToolbarButton
            title={filesDrawerOpen ? 'Hide files' : 'Show files'}
            active={filesDrawerOpen}
            onClick={() => setFilesDrawerOpen((open) => !open)}
          >
            <IconFilesDrawer size={15} />
          </ToolbarButton>
          <ToolbarButton
            title={mode === 'unified' ? 'Switch to split diff' : 'Switch to unified diff'}
            active={mode === 'side'}
            onClick={() => {
              captureDiffAnchor();
              setMode((current) => (current === 'unified' ? 'side' : 'unified'));
            }}
          >
            {mode === 'unified' ? <IconSplit size={14} /> : <IconUnified size={14} />}
          </ToolbarButton>
          <div ref={menuRef} style={{ position: 'relative', flexShrink: 0 }}>
            <ToolbarButton title="View options" active={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
              <IconViewOptions size={15} />
            </ToolbarButton>
            {menuOpen ? (
              <div
                role="menu"
                style={{
                  position: 'absolute',
                  top: 34,
                  right: 0,
                  minWidth: 168,
                  padding: 4,
                  borderRadius: 10,
                  background: REVIEW_POPOVER_BG,
                  border: '1px solid var(--t-input-border)',
                  boxShadow: REVIEW_POPOVER_SHADOW,
                  zIndex: 50,
                }}
              >
                <MenuItem onClick={handleCollapseAll}>{collapseSignal.open ? 'Collapse all' : 'Expand all'}</MenuItem>
                <MenuItem onClick={handleWordWrap} checked={wrap}>Word wrap</MenuItem>
                <MenuItem onClick={handleWordDiff} checked={wordDiff}>Word diffs</MenuItem>
                <MenuItem onClick={handleHideWhitespace} checked={hideWhitespace}>Hide whitespace</MenuItem>
                <MenuItem onClick={handleRichPreview} checked={richPreview}>Rich preview</MenuItem>
                <MenuItem onClick={handleRefresh}>Refresh</MenuItem>
              </div>
            ) : null}
          </div>
          {!reviewLaneId && !changes.error && !changes.loading ? (
            <ReviewGitActions repoPath={repoPath} branch={changes.branch} repoSlug={changes.repoSlug} onChanged={changes.refresh} />
          ) : null}
        </div>
      ) : null}
      <div className="cortex-scroll-fade-y cortex-themed-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
        {!diffRepoPath ? (
          <PanelMessage text="Select a repo to review changes." />
        ) : changes.loading && !hasFiles ? (
          <ReviewSkeleton />
        ) : changes.error ? (
          // #2144 — a lane whose checkout is gone is unrecoverable, not
          // retryable, so it gets its own state plus the action that ends it.
          reviewLaneId && changes.errorCode === WORKTREE_MISSING_CODE ? (
            <MissingWorktreeNotice
              laneId={reviewLaneId}
              detail={changes.error}
              onDiscarded={() => { void changes.refresh(); }}
            />
          ) : (
            <div>
              <PanelMessage text={changes.error} tone={changes.errorCode === 'REVIEW_NOT_GIT' ? undefined : 'error'} />
              <div style={{ paddingLeft: 16, paddingBottom: 16 }}>
                <ToolbarButton title="Refresh review" onClick={() => { void changes.refresh(); }}>Retry</ToolbarButton>
              </div>
            </div>
          )
        ) : !hasFiles ? (
          <PanelMessage text={reviewLaneId ? 'No branch diff to review.' : 'Working tree clean — nothing to review.'} />
        ) : visible.length === 0 ? (
          <PanelMessage
            text={
              scope === 'staged'
                ? 'No staged changes.'
                : scope === 'unstaged'
                  ? 'No unstaged changes.'
                  : scope === 'last-turn'
                    ? 'No files from the last agent turn.'
                    : 'No files match.'
            }
          />
        ) : (
          <>
            {reviewLaneId ? (
              <LaneReviewSummaryHeader
                summary={laneSummary.summary}
                files={visible}
                totalAdditions={visibleStats.additions}
                totalDeletions={visibleStats.deletions}
                onSelectFile={jumpToFile}
                packetId={laneSummary.packetId}
                laneStatus={laneSummary.laneStatus}
                refreshStatus={laneSummary.refreshStatus}
                artifacts={laneArtifacts}
                onMerged={() => { void changes.refresh(); }}
              />
            ) : null}
            <ArchitectureDeltaCard
              analysis={architecture}
              attention={architectureAttention}
              scopePaths={architectureScopePaths}
              onSelectFile={jumpFromArchitecture}
            />
            {visible.map((file) => (
            <ReviewFileRow
              key={file.path}
              file={file}
              repoPath={diffRepoPath}
              preloadedDiff={changes.patchByPath?.get(file.path)}
              mode={mode}
              wrap={wrap}
              wordDiff={wordDiff}
              hideWhitespace={hideWhitespace}
              richPreview={richPreview}
              initialOpen={collapseSignal.open}
              collapseSignal={collapseSignal}
              focusSignal={focusSignal}
              selected={focusSignal.path === file.path}
              setRowRef={setRowRef}
            />
            ))}
          </>
        )}
      </div>
      {hasFiles ? (
        <FilesDrawer
          open={filesDrawerOpen}
          files={drawerFiles}
          query={fileQuery}
          onQueryChange={setFileQuery}
          selectedPath={focusSignal.path}
          onSelectFile={jumpToFile}
          onClose={() => setFilesDrawerOpen(false)}
        />
      ) : null}
    </div>
  );
});
