'use client';

import { PrStackSummary } from '../agent-panel/PrStackSummary';

import { memo, useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { PullRequestConversations } from '@/components/conversation-prs/PullRequestConversations';
import { PrPanelHeader } from './PrPanelHeader';
import { PrPanelTabs } from './PrPanelTabs';
import { PrChangesToolbar } from './PrChangesToolbar';
import { PrSummary } from './PrSummary';
import { PrBrainComposer, prBrainContext } from './PrBrainComposer';
import { openComposerBrain } from '../brain/brain-events';
import { openPrChangesView, usePrViewState } from './usePrViewState';
import { ChangesTab } from './tabs/ChangesTab';
import { ChecksTab } from './tabs/ChecksTab';
import { ReviewsTab } from './tabs/ReviewsTab';
import { TimelineTab } from './tabs/TimelineTab';
import { GithubReadStatus } from '@/components/github/GithubReadStatus';
import { usePrDetail } from './usePrDetail';
import { PrReviewGuide } from './PrReviewGuide';
import { X } from '../lucide-shims';
import { ArtifactStrip } from '../artifacts/ArtifactStrip';
import { useArtifacts } from '../artifacts/useArtifacts';
import type { PrComposerMode, PrPanelProps, PrReviewAction } from './types';

export const PrPanel = memo(function PrPanel(props: PrPanelProps) {
  const owner = `${props.repoSlug || props.repoPath || ''}:${props.prNumber}`;
  const [selection, setSelection] = useState({ owner, number: props.prNumber });
  const number = selection.owner === owner ? selection.number : props.prNumber;
  if (selection.owner !== owner) setSelection({ owner, number: props.prNumber });
  return <PrPanelContent {...props} prNumber={number} onSelectStack={next => {
    openPrChangesView(`${props.repoSlug || props.repoPath || ''}:${next}`);
    setSelection({ owner, number: next });
    props.onSelectLayer?.(next);
  }} />;
});

const PrPanelContent = memo(function PrPanelContent({ prNumber, repoSlug, repoPath, onClose, active = true, id, onSelectStack }: PrPanelProps & { onSelectStack: (number: number) => void }) {
  const selectionKey = `${repoSlug || repoPath || ''}:${prNumber}`;
  const { view, update, recordScroll, scrollFor } = usePrViewState(selectionKey);
  const { detail, loading, error, refresh, updatedAt } = usePrDetail(prNumber, repoSlug, active, view.activeTab === 'checks');
  const hasDetail = Boolean(detail);
  const panelId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [fileJump, setFileJump] = useState(0);
  const pendingFile = useRef<{ key: string; path: string } | null>(null);
  const openFile = useCallback((path: string) => {
    pendingFile.current = { key: selectionKey, path };
    setFileJump((value) => value + 1);
    update({ activeTab: 'changes', openFiles: view.openFiles.includes(path) ? view.openFiles : [...view.openFiles, path] });
  }, [selectionKey, update, view.openFiles]);
  const toggleDescription = useCallback(() => update({ descriptionOpen: !view.descriptionOpen }), [update, view.descriptionOpen]);
  const changeCommentDraft = useCallback((commentDraft: string) => update({ commentDraft }), [update]);
  const changeReviewDraft = useCallback((reviewDraft: string) => update({ reviewDraft }), [update]);
  const changeReviewAction = useCallback((reviewAction: PrReviewAction) => update({ reviewAction }), [update]);
  const changeReviewHead = useCallback(() => update({ reviewHeadSha: detail?.headSha || '' }), [update, detail?.headSha]);
  const changeComposerMode = useCallback((composerMode: PrComposerMode, commandDraft?: string) => update({
    composerMode,
    ...(composerMode === 'review' && !view.reviewHeadSha ? { reviewHeadSha: detail?.headSha || '' } : {}),
    ...(commandDraft !== undefined ? { questionDraft: '', ...(commandDraft ? composerMode === 'review' ? { reviewDraft: commandDraft } : { commentDraft: commandDraft } : {}) } : {}),
  }), [update, detail?.headSha, view.reviewHeadSha]);
  const changeOpenFiles = useCallback((openFiles: string[]) => update({ openFiles }), [update]);
  const changeDiffStyle = useCallback((diffStyle: 'unified' | 'split') => update({ diffStyle }), [update]);
  const changeTreeOpen = useCallback((fileTreeOpen: boolean) => update({ fileTreeOpen }), [update]);
  const toggleFolder = useCallback((path: string) => { const current = view.collapsedFolders || []; update({ collapsedFolders: current.includes(path) ? current.filter((folder) => folder !== path) : [...current, path] }); }, [update, view.collapsedFolders]);
  const toggleFile = useCallback((path: string) => update({ openFiles: view.openFiles.includes(path) ? view.openFiles.filter((file) => file !== path) : [...view.openFiles, path] }), [update, view.openFiles]);
  const closePanel = () => {
    const previousFocus = document.activeElement;
    onClose();
    window.requestAnimationFrame(() => {
      if (document.activeElement !== document.body && document.activeElement !== previousFocus) return;
      const list = Array.from(document.querySelectorAll<HTMLElement>('[data-pull-requests-list]')).find((element) => !element.closest('[inert]') && (!repoPath || element.dataset.repoPath === repoPath));
      const row = Array.from(list?.querySelectorAll<HTMLButtonElement>('[data-pr-number]') ?? []).find((button) => button.dataset.prNumber === String(prNumber) && button.getAttribute('aria-current') === 'true');
      (row ?? list?.querySelector<HTMLElement>('input'))?.focus({ preventScroll: true });
    });
  };
  const onKeyDown: React.KeyboardEventHandler<HTMLDivElement> = (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || (event.target as Element).closest('[role="dialog"]')) return;
    event.preventDefault(); event.stopPropagation(); closePanel();
  };
  // Visual proof (#1147): an agent's before/after stills for this PR, if any.
  // The strip self-hides when empty, so it only appears on PRs whose packet
  // captured proof.
  const { artifacts } = useArtifacts({ prNumber });

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !hasDetail) return;
    scroller.scrollTop = scrollFor(view.activeTab);
  }, [hasDetail, selectionKey, view.activeTab, scrollFor]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !hasDetail) return;
    if (pendingFile.current?.key === selectionKey && view.activeTab === 'changes') {
      const path = pendingFile.current.path;
      pendingFile.current = null;
      const row = Array.from(scroller.querySelectorAll<HTMLButtonElement>('[data-pr-file]')).find((button) => button.dataset.prFile === path);
      row?.scrollIntoView?.({ block: 'start' });
      row?.focus({ preventScroll: true });
    }
  }, [hasDetail, selectionKey, view.activeTab, view.openFiles, fileJump]);

  const containerStyle: React.CSSProperties = {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'var(--t-panel)',
    color: 'var(--t-text)',
    minHeight: 0,
  };

  if (!detail) {
    return (
      <div id={id || panelId} data-pr-detail={prNumber} aria-busy={loading} style={containerStyle} onKeyDown={onKeyDown}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 10, paddingRight: 14, paddingBottom: 10, paddingLeft: 14, borderBottom: '1px solid var(--t-divider-subtle)' }}>
          <span style={{ flex: 1, fontSize: 12 }}>PR #{prNumber}</span>
          <button type="button" aria-label="Close pull request" onClick={closePanel} style={{ width: 28, height: 28, display: 'grid', placeItems: 'center', border: 0, borderRadius: 8, background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer' }}>
            <X size={14} />
          </button>
        </div>
        <div style={{ padding: 16, fontSize: 12 }}>
          <div role={error ? 'alert' : 'status'} style={{ color: error ? 'var(--t-danger)' : 'var(--t-text-secondary)' }}>
            {loading ? `Loading PR #${prNumber}…` : error ?? `PR #${prNumber} not available.`}
          </div>
          {loading ? (
            <>
              <p style={{ marginTop: 6, color: 'var(--t-text-muted)', fontSize: 11 }}>Fetching changes, checks and discussion.</p>
              <div aria-hidden="true" style={{ display: 'grid', gap: 12, marginTop: 22 }}>
                {[85, 60, 100].map((width) => <div key={width} style={{ height: 10, width: `${width}%`, borderRadius: 5, background: 'var(--t-divider-subtle)' }} />)}
              </div>
            </>
          ) : null}
          {error ? (
            <button type="button" onClick={refresh} style={{ marginTop: 12, height: 32, paddingTop: 0, paddingRight: 12, paddingBottom: 0, paddingLeft: 12, border: '1px solid var(--t-border)', borderRadius: 8, background: 'var(--t-bg-card)', color: 'var(--t-text)', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer' }}>Retry</button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div id={id || panelId} data-pr-detail={detail.number} style={containerStyle} onKeyDown={onKeyDown}>
      <PrPanelHeader detail={detail} repoSlug={repoSlug} repoPath={repoPath} showDiffStats={active && view.activeTab !== 'changes'} onRefresh={refresh} onComposerMode={changeComposerMode} onAsk={(prompt) => {
        if (repoPath) openComposerBrain({ repoPath, prompt, context: prBrainContext(detail, repoSlug) });
      }} />
      <PullRequestConversations repo={detail.resolvedRepo || repoSlug || ''} number={detail.number} active={active} />
      {error ? <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12, fontSize: 11, color: 'var(--t-danger)' }}>{error}<button type="button" onClick={refresh} style={{ border: 0, borderRadius: 6, padding: 6, background: 'var(--t-hover)', color: 'var(--t-text)', font: 'inherit', cursor: 'pointer' }}>Retry</button></div> : null}
      <GithubReadStatus error={error} updatedAt={updatedAt} />
      {detail.stack ? <div style={{ paddingTop: 8, paddingRight: 14, paddingBottom: 8, paddingLeft: 14, flexShrink: 0 }}>
        <PrStackSummary observation={detail.stack} prNumber={prNumber} onSelect={onSelectStack} retained={Boolean(error)} repo={repoSlug || detail.resolvedRepo} />
      </div> : null}
      <PrPanelTabs
        activeTab={view.activeTab}
        onChange={(activeTab) => update({ activeTab })}
        changesCount={detail.changedFiles}
        checks={detail.statusCheckRollup}
        reviewsCount={detail.reviewComments.length + detail.issueComments.length}
        idBase={panelId}
      />
      <PrReviewGuide key={selectionKey} selection={selectionKey} detail={detail} onNavigate={(activeTab, file) => { if (file) openFile(file); else update({ activeTab }); }} onAsk={prompt => { if (repoPath) openComposerBrain({ repoPath, prompt, context: prBrainContext(detail, repoSlug) }); }} />
      {(['summary', 'timeline', 'changes', 'checks', 'reviews'] as const).map((tab) => <div key={tab} id={`${panelId}-${tab}-panel`} role="tabpanel" aria-labelledby={`${panelId}-${tab}`} hidden={view.activeTab !== tab} inert={view.activeTab !== tab} style={{ display: view.activeTab === tab ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0, containerType: 'size', maskImage: 'linear-gradient(to bottom, #000 calc(100% - var(--pr-composer-occlusion, 60px) - 12px), transparent calc(100% - var(--pr-composer-occlusion, 60px)))', WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - var(--pr-composer-occlusion, 60px) - 12px), transparent calc(100% - var(--pr-composer-occlusion, 60px)))' }}>
        {tab === 'changes' && detail.files.length > 0 ? <PrChangesToolbar statsActive={active && view.activeTab === tab} files={detail.files} totalFiles={detail.changedFiles} additions={detail.additions} deletions={detail.deletions} allOpen={detail.files.every((file) => view.openFiles.includes(file.path))} onSetOpenFiles={changeOpenFiles} diffStyle={view.diffStyle || 'unified'} onDiffStyleChange={changeDiffStyle} treeOpen={Boolean(view.fileTreeOpen)} onTreeOpenChange={changeTreeOpen} collapsedFolders={view.collapsedFolders || []} onToggleFolder={toggleFolder} onNavigate={openFile} /> : null}
        <div data-pr-detail-scroll={tab} ref={view.activeTab === tab ? scrollRef : undefined} role="region" aria-labelledby={`${panelId}-${tab}`} tabIndex={0} onScroll={(event) => { if (view.activeTab === tab) recordScroll(tab, event.currentTarget.scrollTop); }} style={{ flex: 1, overflowY: 'auto', minHeight: 0, overscrollBehavior: 'contain', scrollbarWidth: 'none', paddingBottom: 76 }}>
        {tab === 'summary' ? <PrSummary detail={detail} descriptionOpen={view.descriptionOpen} onToggleDescription={toggleDescription} onOpenFile={openFile} /> : null}
        {tab === 'timeline' ? <TimelineTab detail={detail} repoSlug={repoSlug} active={active && view.activeTab === 'timeline'} newestFirst={view.timelineNewestFirst} onToggleOrder={() => update({ timelineNewestFirst: !view.timelineNewestFirst })} onOpenFile={openFile} /> : null}
        {tab === 'changes' ? (
          <>
            {artifacts.length > 0 ? (
              <div style={{ paddingTop: 12, paddingBottom: 8, paddingLeft: 14, paddingRight: 14 }}>
                <ArtifactStrip artifacts={artifacts} />
              </div>
            ) : null}
            <ChangesTab
              files={detail.files}
              totalFiles={detail.changedFiles}
              openFiles={view.openFiles}
              onToggleFile={toggleFile}
              diffStyle={view.diffStyle || 'unified'}
            />
          </>
        ) : null}
        {tab === 'checks' ? <ChecksTab checks={detail.statusCheckRollup} repo={repoSlug || detail.resolvedRepo} number={prNumber} /> : null}
        {tab === 'reviews' ? (
          <ReviewsTab
            reviewComments={detail.reviewComments}
            issueComments={detail.issueComments}
            reviewDecision={detail.reviewDecision}
            detail={detail}
            onOpenFile={openFile}
          />
        ) : null}
        </div>
      </div>)}
      {view.composerMode !== 'brain' ? <PrBrainComposer allowBrain={false} key={`${selectionKey}:${repoPath || ''}`} detail={detail} repoSlug={repoSlug} repoPath={repoPath} draft={view.questionDraft} onDraftChange={() => {}} mode={view.composerMode} onModeChange={changeComposerMode} commentDraft={view.commentDraft} onCommentDraftChange={changeCommentDraft} reviewDraft={view.reviewDraft} onReviewDraftChange={changeReviewDraft} reviewAction={view.reviewAction} onReviewActionChange={changeReviewAction} reviewHeadSha={view.reviewHeadSha} onReviewHeadChange={changeReviewHead} onCommentPosted={refresh} /> : null}
    </div>
  );
});

export type { PrPanelProps } from './types';
