import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { TerminalTab } from './types';
import { WORKSPACE_THREAD_ID_EVENT } from './utils';

/** Commit navigation intent before a send or reload can observe the old owner. */
export function useWorkspaceThreadBindings({ tabsRef, activeTabIdRef, closeTabRef, setTabs, persistTabsNow }: {
  tabsRef: RefObject<TerminalTab[]>;
  activeTabIdRef: RefObject<string>;
  closeTabRef: RefObject<(tabId: string) => void>;
  setTabs: Dispatch<SetStateAction<TerminalTab[]>>;
  persistTabsNow: (tabs: TerminalTab[], activeTabId: string) => void;
}) {
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string; threadId?: string | null }>).detail;
      const tabId = detail?.tabId;
      const threadId = detail?.threadId;
      if (!tabId || !threadId) return;
      const previous = tabsRef.current;
      // A second tab claiming an existing thread must not replace its owner.
      if (previous.some(tab => tab.id !== tabId && tab.kind === 'orchestrator' && tab.orchestratorThreadId === threadId)) {
        closeTabRef.current(tabId);
        return;
      }
      const index = previous.findIndex(tab => tab.id === tabId && tab.kind === 'orchestrator');
      if (index < 0 || previous[index].orchestratorThreadId === threadId) return;
      const next = [...previous];
      next[index] = { ...next[index], orchestratorThreadId: threadId, outsideWorkerHost: undefined };
      tabsRef.current = next;
      setTabs(next);
      persistTabsNow(next, activeTabIdRef.current);
    };
    window.addEventListener(WORKSPACE_THREAD_ID_EVENT, handler);
    return () => window.removeEventListener(WORKSPACE_THREAD_ID_EVENT, handler);
  }, [activeTabIdRef, closeTabRef, persistTabsNow, setTabs, tabsRef]);
}
