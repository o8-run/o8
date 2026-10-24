'use client';

import { useCallback, useState } from 'react';
import type { PrComposerMode, PrReviewAction, PrTabId } from './types';

interface PrViewState {
  activeTab: PrTabId;
  descriptionOpen: boolean;
  openFiles: string[];
  diffStyle: 'unified' | 'split';
  fileTreeOpen: boolean;
  collapsedFolders: string[];
  timelineNewestFirst: boolean;
  questionDraft: string;
  commentDraft: string;
  reviewDraft: string;
  reviewAction: PrReviewAction;
  reviewHeadSha: string;
  composerMode: PrComposerMode;
  scroll: Partial<Record<PrTabId, number>>;
}

// Keep a small, session-only history across panel close/reopen and workspace
// round trips. Never share the view of the same number in another repository.
const views = new Map<string, PrViewState>();
function readView(key: string): PrViewState {
  let view = views.get(key);
  if (!view) {
    view = { activeTab: 'summary', descriptionOpen: true, openFiles: [], diffStyle: 'unified', fileTreeOpen: false, collapsedFolders: [], timelineNewestFirst: false, questionDraft: '', commentDraft: '', reviewDraft: '', reviewAction: 'review-comment', reviewHeadSha: '', composerMode: 'brain', scroll: {} };
    if (views.size >= 80) views.delete(views.keys().next().value!);
    views.set(key, view);
  }
  return view;
}

export function usePrViewState(key: string) {
  const [selection, setSelection] = useState(() => ({ key, view: readView(key) }));
  const view = selection.key === key ? selection.view : readView(key);
  const update = useCallback((patch: Partial<Omit<PrViewState, 'scroll'>>) => {
    const next = { ...readView(key), ...patch };
    views.set(key, next);
    setSelection({ key, view: next });
  }, [key]);
  // Scroll is a receipt, not render state: recording it must not rerender a
  // large diff on every wheel event.
  const recordScroll = useCallback((tab: PrTabId, top: number) => {
    readView(key).scroll[tab] = top;
  }, [key]);
  const scrollFor = useCallback((tab: PrTabId) => readView(key).scroll[tab] ?? 0, [key]);
  return { view, update, recordScroll, scrollFor };
}

/** Layer navigation opens that PR's own saved diff view. */
export function openPrChangesView(key: string) { readView(key).activeTab = 'changes'; }
