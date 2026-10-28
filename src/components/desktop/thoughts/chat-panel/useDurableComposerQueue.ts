'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSharedDesktopWs } from '@/components/desktop/hooks/DesktopWebSocketContext';
import type { RealtimeMutationRecord } from '@/lib/realtime/types';
import type { ComposerQueuePayload, ComposerQueueTarget, QueuedComposerSendRecord } from '@/lib/orchestrator/composer-queue-types';

import { composerRecoveryNotice, composerQueuePayloadMatches, confirmComposerSend, findPendingComposerSend, prepareComposerSend } from './composer-queue-recovery';
import { composerQueueRequest, ComposerQueueRequestError } from './composer-queue-request';
import { voiceFollowupRemovalReceipt } from './managed-voice-followup';

const EMPTY_QUEUE: QueuedComposerSendRecord[] = [];

export function useDurableComposerQueue(target: ComposerQueueTarget | null, busy: boolean, backend?: string) {
  const [saved, setSaved] = useState<{ key: string; items: QueuedComposerSendRecord[]; backend?: string; canSteer: boolean; steerableIds?: string[] } | null>(null);
  const backendRef = useRef(backend); backendRef.current = backend;
  const [removing, setRemoving] = useState<Set<number>>(new Set());
  const removingRef = useRef(new Set<number>());
  const [promoting, setPromoting] = useState<Set<string>>(new Set());
  const promotingRef = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const scopeKey = target ? JSON.stringify(target) : '';
  const scopeRef = useRef(scopeKey); scopeRef.current = scopeKey;
  const targetRef = useRef(target); targetRef.current = target;
  const ownerRef = useRef<object | null>(null);
  useLayoutEffect(() => {
    ownerRef.current = {};
    return () => { ownerRef.current = null; };
  }, [scopeKey]);
  const revisionRef = useRef(0);
  const mutations = useRef(new Map<string, Promise<unknown>>());
  const serialize = useCallback(<T,>(key: string, action: () => Promise<T>): Promise<T> => {
    const pending = (mutations.current.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
    mutations.current.set(key, pending);
    void pending.finally(() => { if (mutations.current.get(key) === pending) mutations.current.delete(key); }).catch(() => {});
    return pending;
  }, []);
  const refresh = useCallback(async () => {
    const snapshot = targetRef.current;
    if (!snapshot) return;
    const key = JSON.stringify(snapshot);
    const snapshotBackend = backendRef.current;
    const revision = ++revisionRef.current;
    try {
      const body = await composerQueueRequest<{ items: QueuedComposerSendRecord[]; canSteer?: boolean; steerableIds?: string[] }>(
        `/api/orchestrator/composer-queue?repoPath=${encodeURIComponent(snapshot.repoPath)}&threadId=${encodeURIComponent(snapshot.threadId)}${snapshotBackend ? `&backend=${encodeURIComponent(snapshotBackend)}` : ''}`,
        { cache: 'no-store' }, 'Queued messages could not be loaded. Reopen this chat to retry.');
      if (!Array.isArray(body.items)) throw new Error('Unable to load queued messages.');
      if (scopeRef.current === key && revision === revisionRef.current) { setSaved({ key, items: body.items, backend: snapshotBackend, canSteer: body.canSteer === true, steerableIds: body.steerableIds }); setError(null); }
    } catch (cause) {
      if (scopeRef.current === key && revision === revisionRef.current) setError(cause instanceof Error ? cause.message : 'Unable to load queued messages.');
    }
  }, []);
  useSharedDesktopWs(undefined, { onRealtimeEvent: event => {
    const mutation = event.channel === 'mutation' ? (event.data as { mutation?: RealtimeMutationRecord }).mutation : undefined;
    if (mutation?.action === 'composer-queue' && mutation.surfaceId === targetRef.current?.threadId) void refresh();
  } });
  useEffect(() => {
    setError(null);
    void refresh();
    window.addEventListener('o8:lifecycle-reconcile', refresh);
    return () => { window.removeEventListener('o8:lifecycle-reconcile', refresh); };
  }, [scopeKey, busy, backend, refresh]);
  const enqueue = useCallback(async (draft: Pick<ComposerQueuePayload, 'text' | 'images'>, capture: () => ComposerQueuePayload, intent: QueuedComposerSendRecord['intent'] = 'send-next') => {
    const snapshot = targetRef.current;
    if (!snapshot) throw new Error('Wait for this chat to be saved before using Send next.');
    const owner = ownerRef.current;
    const payload = (await findPendingComposerSend(snapshot, draft))?.payload ?? capture();
    const { attempt, fresh, recoveryError } = await prepareComposerSend(snapshot, payload);
    if (ownerRef.current !== owner) throw new Error('The chat changed before submission. The message was not queued. Keep the original draft.');
    let item: QueuedComposerSendRecord;
    try {
      const body = await composerQueueRequest<{ item: QueuedComposerSendRecord }>('/api/orchestrator/composer-queue', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...snapshot, id: attempt.id, intent, payload: attempt.payload }),
      }, 'Send next was not confirmed. Your draft is unchanged. Retry to check the same send with its original routing.');
      item = body.item;
      if (item?.id !== attempt.id || item.threadId !== snapshot.threadId
        || !composerQueuePayloadMatches(item.payload, attempt.payload)) throw new Error('The Send next receipt did not match. Keep this draft and inspect the chat before retrying.');
    } catch (cause) {
      // A first, explicit client rejection did not accept the new submission.
      // A retry rejection cannot disprove delivery of the earlier uncertain request.
      if (ownerRef.current === owner && fresh && cause instanceof ComposerQueueRequestError && cause.status >= 400 && cause.status < 500) { try { await confirmComposerSend(snapshot, attempt.id); } catch { /* The server explicitly refused this first request. */ } }
      if (recoveryError) throw new Error(composerRecoveryNotice(recoveryError, fresh && cause instanceof ComposerQueueRequestError && cause.status < 500 ? 'rejected' : false, cause instanceof ComposerQueueRequestError ? cause.message : undefined));
      throw cause;
    }
    if (item.status === 'cancelled') {
      if (ownerRef.current === owner) await confirmComposerSend(snapshot, attempt.id).catch(() => {});
      throw new Error('The previous send was cancelled. No new message was sent. Send again only if you want a new turn.');
    }
    if (ownerRef.current === owner) { setError(null); await refresh(); }
    if (recoveryError) throw new Error(composerRecoveryNotice(recoveryError, true));
    // The still-current composer retires recovery immediately before consuming its draft.
    return async () => {
      if (ownerRef.current === owner) {
        try { await confirmComposerSend(snapshot, attempt.id); }
        catch { throw new Error('Message queued. The browser could not finish saving that change. Check your current draft before sending again.'); }
      }
    };
  }, [refresh]);
  // Voice supplies its durable delegation id; ordinary composer retries retain
  // the separate draft-recovery contract above. Both write the same server queue.
  const enqueueVoice = useCallback(async (payload: ComposerQueuePayload, id: string) => {
    const snapshot = targetRef.current;
    if (!snapshot) throw new Error('Wait for this chat to be saved before using Send next.');
    const owner = ownerRef.current;
    return serialize(JSON.stringify(snapshot), async () => {
      const body = await composerQueueRequest<{ item: QueuedComposerSendRecord }>('/api/orchestrator/composer-queue', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...snapshot, id, intent: 'send-next', payload }),
      }, 'The voice follow-up was not confirmed. Inspect the shared queue before retrying.');
      const item = body.item;
      if (item?.id !== id || item.threadId !== snapshot.threadId || item.repoPath !== snapshot.repoPath
        || !composerQueuePayloadMatches(item.payload, payload)) throw new Error('The voice follow-up receipt did not match. Inspect the chat before retrying.');
      if (item.status === 'cancelled') throw new Error('The voice follow-up was cancelled. No new message was sent.');
      if (ownerRef.current === owner) { setError(null); await refresh(); }
      return item;
    });
  }, [refresh, serialize]);
  const transcriptItems = saved?.key === scopeKey ? saved.items : EMPTY_QUEUE;
  const items = transcriptItems.filter(item => item.status !== 'applied');
  const steer = useCallback(async (id: string) => {
    const snapshot = targetRef.current;
    if (!snapshot || promotingRef.current.has(id)) return;
    promotingRef.current.add(id); setPromoting(new Set(promotingRef.current));
    try {
      await composerQueueRequest('/api/orchestrator/composer-queue', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...snapshot, id }) }, 'Steering was not confirmed. The saved message is unchanged.');
      if (scopeRef.current === JSON.stringify(snapshot)) await refresh();
    } catch (cause) {
      if (scopeRef.current === JSON.stringify(snapshot)) setError(cause instanceof Error ? cause.message : 'Steering was not confirmed.');
    } finally { promotingRef.current.delete(id); setPromoting(new Set(promotingRef.current)); }
  }, [refresh]);
  const cancelRecord = useCallback(async (item: QueuedComposerSendRecord) => {
    const sequence = item.sequence;
    if (removingRef.current.has(sequence)) return false;
    const key = JSON.stringify({ repoPath: item.repoPath, threadId: item.threadId });
    removingRef.current.add(sequence); setRemoving(new Set(removingRef.current));
    try {
      await composerQueueRequest('/api/orchestrator/composer-queue', { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPath: item.repoPath, threadId: item.threadId, id: item.id }) },
      'Removal was not confirmed. Inspect the chat, then retry if the message is still queued.');
      if (scopeRef.current === JSON.stringify({ repoPath: item.repoPath, threadId: item.threadId })) { setError(null); await refresh(); }
      return true;
    } catch (cause) {
      if (scopeRef.current === key) setError(cause instanceof Error ? cause.message : 'Unable to remove the queued message.');
      return false;
    } finally { removingRef.current.delete(sequence); setRemoving(new Set(removingRef.current)); }
  }, [refresh]);
  const cancel = useCallback(async (sequence: number) => {
    const item = items.find(row => row.sequence === sequence);
    return item ? cancelRecord(item) : false;
  }, [items, cancelRecord]);
  const cancelVoiceFollowups = useCallback(async () => {
    const snapshot = targetRef.current;
    if (!snapshot) return 'The shared follow-up queue is unavailable; cancellation is not confirmed.';
    return serialize(JSON.stringify(snapshot), async () => {
      try {
        // Read after prior saves settle, including saves whose response was lost.
        const body = await composerQueueRequest<{ items: QueuedComposerSendRecord[] }>(
          `/api/orchestrator/composer-queue?repoPath=${encodeURIComponent(snapshot.repoPath)}&threadId=${encodeURIComponent(snapshot.threadId)}`,
          { cache: 'no-store' }, 'Unable to confirm queued messages.');
        const voiceItems = (body.items as QueuedComposerSendRecord[]).filter(item => item.payload.afterTaskId);
        if (!voiceItems.length) return 'No pending voice follow-up was found. Already submitted work is unchanged.';
        const removed = await Promise.all(voiceItems.map(cancelRecord));
        return removed.every(Boolean) ? voiceFollowupRemovalReceipt()
          : 'Cancellation is not confirmed for every follow-up. Inspect the conversation; work may already have been submitted.';
      } catch { return 'Unable to confirm cancellation. Inspect the queued messages in this conversation.'; }
    });
  }, [cancelRecord, serialize]);
  const hasPending = async (text: string, images: ComposerQueuePayload['images']) =>
    Boolean(target && await findPendingComposerSend(target, { text, images }));
  const steerableIds = useMemo(() => saved?.key === scopeKey && saved.steerableIds ? new Set(saved.steerableIds) : undefined, [saved, scopeKey]);
  return { items, transcriptItems, promoting, steerableIds, canSteer: saved?.key === scopeKey && saved.backend === backend && saved.canSteer, steer, hasPending, enqueue, enqueueVoice, cancel, cancelVoiceFollowups, error, removing, ready: !target || saved?.key === scopeKey };
}
