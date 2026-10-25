'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { invalidatePrPanelDetail } from './detail-query';
import { invalidatePrTimeline } from './timeline-query-key';
import type { PrMergeMethod, PrReviewAction } from './types';

export type PrWriteAction = 'comment' | 'close-with-comment' | 'close' | 'merge' | 'draft' | 'ready' | 'enable-auto-merge' | 'disable-auto-merge' | PrReviewAction;
type WriteAction = PrWriteAction;
interface CommentState { busy: boolean; posted: boolean; postedAction?: WriteAction; partialClose: boolean; uncertain: boolean; error: string | null }
const idle: CommentState = { busy: false, posted: false, partialClose: false, uncertain: false, error: null };
const states = new Map<string, CommentState>();
const listeners = new Map<string, Set<() => void>>();
function read(key: string) { return states.get(key) || idle; }
function update(key: string, state: CommentState) {
  states.set(key, state);
  if (states.size > 40) {
    const oldest = [...states.keys()].find((candidate) => candidate !== key && !read(candidate).busy && !read(candidate).uncertain && !read(candidate).partialClose && !listeners.get(candidate)?.size);
    if (oldest) states.delete(oldest);
  }
  listeners.get(key)?.forEach((listener) => listener());
}

/** Comment delivery remains scoped across panel changes. An uncertain write is never retried automatically. */
export function usePrComment(repo: string | null | undefined, number: number) {
  const key = (repo || '') + ':' + number;
  const subscribe = useCallback((listener: () => void) => {
    const group = listeners.get(key) || new Set<() => void>(); group.add(listener); listeners.set(key, group);
    return () => { group.delete(listener); if (!group.size) listeners.delete(key); };
  }, [key]);
  const snapshot = useCallback(() => read(key), [key]);
  const state = useSyncExternalStore(subscribe, snapshot, () => idle);
  const post = useCallback(async (body: string, action: WriteAction = 'comment', commitSha?: string, mergeMethod?: PrMergeMethod, expectedMergeGate?: string): Promise<boolean> => {
    const previous = read(key);
    const needsBody = action === 'comment' || action === 'close-with-comment' || action === 'request-changes' || action === 'review-comment';
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || (needsBody && !body.trim()) || previous.busy || previous.uncertain || (previous.partialClose && action !== 'close')) return false;
    update(key, { ...previous, busy: true, error: null });
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await fetch('/api/panel/prs/' + number, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, repo, comment: body.trim(), ...(commitSha ? { commitSha } : {}), ...(mergeMethod ? { mergeMethod } : {}), ...(expectedMergeGate ? { expectedMergeGate } : {}) }), signal: controller.signal });
      const result = await response.json().catch(() => null) as { ok?: boolean; commentPosted?: boolean; mergeRefused?: boolean; error?: string } | null;
      if (result?.mergeRefused === true) { update(key, { ...idle, error: result.error || 'Merge gates refused publication. Refresh before retrying.' }); return false; }
      const partialClose = action === 'close-with-comment' && result?.commentPosted === true && result.ok !== true;
      if (!partialClose && (!response.ok || result?.ok !== true)) throw new Error('Delivery could not be confirmed.');
      update(key, { ...idle, posted: true, postedAction: partialClose ? 'comment' : action, partialClose, error: partialClose ? 'Comment posted. Closing could not be confirmed. Retry close without posting again.' : null });
      invalidatePrPanelDetail(repo, number);
      invalidatePrTimeline(repo, number);
      window.dispatchEvent(new CustomEvent('o8:pr-updated', { detail: { repo, number, action } }));
      return true;
    } catch {
      update(key, { ...previous, busy: false, uncertain: true, error: 'Could not confirm delivery. Check this pull request on GitHub before another attempt.' });
      return false;
    } finally { clearTimeout(timer); }
  }, [key, number, repo]);
  return { ...state, post, acknowledge: () => update(key, idle) };
}
