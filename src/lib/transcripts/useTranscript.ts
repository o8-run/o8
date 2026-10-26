'use client';

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  EMPTY_TRANSCRIPT_SLICE,
  isAssistantTextEdit,
  transcriptStore,
  type TranscriptSlice,
} from './store';

const getServerSnapshot = (): TranscriptSlice => EMPTY_TRANSCRIPT_SLICE;

type SubscribeToTranscriptSession = (sessionKey: string) => () => void;

const TranscriptSessionSubscriptionContext = createContext<SubscribeToTranscriptSession | null>(null);

export function TranscriptSessionSubscriptionProvider({
  children,
  subscribe,
}: {
  children: ReactNode;
  subscribe: SubscribeToTranscriptSession;
}) {
  return createElement(TranscriptSessionSubscriptionContext.Provider, { value: subscribe }, children);
}

export interface UseTranscriptOptions {
  live?: boolean;
  /** Slow only text presentation while retaining urgent changes and the live cache. */
  visible?: boolean;
}

function createTranscriptPresentation(sessionKey: string | null | undefined, visible: boolean) {
  let snapshot = transcriptStore.getPresentedSlice(sessionKey);
  const foreground = () => visible && (typeof document === 'undefined' || !document.hidden);
  return {
    getSnapshot: () => foreground() ? transcriptStore.getPresentedSlice(sessionKey) : snapshot,
    subscribe: (listener: () => void) => {
      if (!sessionKey) return () => {};
      let timer: ReturnType<typeof setTimeout> | null = null;
      let latest = snapshot;
      const cancel = () => { if (timer !== null) clearTimeout(timer); timer = null; };
      const update = (next: TranscriptSlice) => {
        if (next === snapshot) return;
        latest = next;
        // Only prose and freshness can wait. Questions, receipts, errors
        // and new turns must bypass the background timer.
        const unchangedContent = snapshot.messages === next.messages
          && snapshot.status === next.status && snapshot.error === next.error;
        if (foreground() || !(unchangedContent || isAssistantTextEdit(snapshot, next))) {
          cancel(); snapshot = next; listener();
        } else if (timer === null) {
          timer = setTimeout(() => { timer = null; snapshot = latest; listener(); }, 1000);
        }
      };
      const unsubscribe = transcriptStore.subscribe(sessionKey, update);
      const onVisibilityChange = () => {
        if (foreground()) update(transcriptStore.getPresentedSlice(sessionKey));
      };
      document.addEventListener('visibilitychange', onVisibilityChange);
      // Account for a store change between render and subscription.
      update(transcriptStore.getPresentedSlice(sessionKey));
      return () => { cancel(); unsubscribe(); document.removeEventListener('visibilitychange', onVisibilityChange); };
    },
  };
}

export function useTranscript(
  sessionKey: string | null | undefined,
  options?: UseTranscriptOptions,
): TranscriptSlice {
  const subscribeToSession = useContext(TranscriptSessionSubscriptionContext);
  const liveSessionKey = options?.live === false ? null : sessionKey;
  const visible = options?.visible !== false;

  useEffect(() => {
    if (!liveSessionKey || !subscribeToSession) return;
    return subscribeToSession(liveSessionKey);
  }, [liveSessionKey, subscribeToSession]);

  const presentation = useMemo(
    () => createTranscriptPresentation(sessionKey, visible),
    [sessionKey, visible],
  );

  return useSyncExternalStore(
    presentation.subscribe,
    presentation.getSnapshot,
    getServerSnapshot,
  );
}
