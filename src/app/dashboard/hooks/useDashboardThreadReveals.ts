import { useEffect, useRef, type RefObject } from 'react';
import { isPaneOwnedThread } from '@/lib/orchestrator/pane-thread-registry';
import { useWsConnectionState } from '@/components/desktop/hooks/DesktopWebSocketContext';
import type { TerminalTabHandle } from '@/components/desktop/WorkspaceTerminal';
import type { SavedChatRepoContext } from '@/lib/llm/chat-history';
import type { MobileOrchestratorThread } from '@/lib/mobile/types';

function historyRepoContextFromMobileThread(thread: MobileOrchestratorThread): SavedChatRepoContext | null {
  if (!thread.repoPath) return null;
  return {
    name: thread.repoName ?? undefined,
    localPath: thread.repoPath,
    branch: thread.repoBranch ?? null,
    remoteUrl: null,
  };
}

export function useDashboardThreadReveals(
  workspaceTerminalHandlesRef: RefObject<Map<string, TerminalTabHandle>>,
  openHistoryChat: (threadId: string, title: string, repo?: SavedChatRepoContext | null) => void,
) {
  const wsConnectionState = useWsConnectionState();
  const wsConnectedRef = useRef<typeof wsConnectionState>('disconnected');
  wsConnectedRef.current = wsConnectionState;
  const mobileRevealCursorRef = useRef(new Date(Date.now() - 3000).toISOString());
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const seen = new Set<string>();
    let disposed = false;
    let inFlight = false;

    const openRevealRequest = (requestedAt: string | null, thread: MobileOrchestratorThread | undefined) => {
      if (!requestedAt || !thread?.id || !thread.title) return;
      if (Date.parse(requestedAt) > Date.parse(mobileRevealCursorRef.current)) {
        mobileRevealCursorRef.current = requestedAt;
      }
      const seenKey = `${thread.id}:${requestedAt}`;
      if (seen.has(seenKey)) return;
      seen.add(seenKey);
      // A send broadcasts a reveal too. Its owning pane already shows the
      // thread; routing it through primary-pane history navigation would
      // replace another conversation and discard that pane's draft.
      if (isPaneOwnedThread(thread.id)) return;
      for (const handle of workspaceTerminalHandlesRef.current.values()) {
        if (handle.getTabsSnapshot().tabs.some(tab => tab.orchestratorThreadId === thread.id)) return;
      }
      openHistoryChat(
        thread.id,
        thread.title,
        historyRepoContextFromMobileThread(thread),
      );
    };

    const handleThreadEvent = (event: Event) => {
      const detail = (event as CustomEvent<{
        event?: string;
        data?: { requestedAt?: string; thread?: MobileOrchestratorThread };
      }>).detail;
      if (detail?.event !== 'reveal') return;
      openRevealRequest(
        typeof detail.data?.requestedAt === 'string' ? detail.data.requestedAt : null,
        detail.data?.thread,
      );
    };

    const pollMobileRevealRequests = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(`/api/mobile/orchestrator/threads/reveal?since=${encodeURIComponent(mobileRevealCursorRef.current)}`, { cache: 'no-store' });
        if (!res.ok || disposed) return;
        const data = await res.json() as {
          requests?: Array<{ requestedAt?: string; thread?: MobileOrchestratorThread }>;
        };
        const requests = Array.isArray(data.requests) ? data.requests : [];
        for (const request of requests) {
          openRevealRequest(
            typeof request.requestedAt === 'string' ? request.requestedAt : null,
            request.thread,
          );
        }
      } catch {
        // Best-effort mobile reveal bridge; the normal history list still works.
      } finally {
        inFlight = false;
      }
    };

    window.addEventListener('o8:orchestrator-threads', handleThreadEvent);
    void pollMobileRevealRequests();
    const timer = window.setInterval(() => {
      if (wsConnectedRef.current === 'connected') return;
      void pollMobileRevealRequests();
    }, 30000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener('o8:orchestrator-threads', handleThreadEvent);
    };
  }, [openHistoryChat, workspaceTerminalHandlesRef]);
}
