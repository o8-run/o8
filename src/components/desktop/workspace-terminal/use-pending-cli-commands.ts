import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { toast } from '@/components/shared/ConfirmToastHost';
import { flushPendingCliCommands } from './terminal-tab-handlers';
import type { TerminalTab } from './types';

export function usePendingCliCommands(
  tabs: TerminalTab[],
  pendingCliCommands: MutableRefObject<Map<string, string>>,
  tabsRef: MutableRefObject<TerminalTab[]>,
  setTabs: Dispatch<SetStateAction<TerminalTab[]>>,
  sendTerminalInput: (sessionName: string, data: string) => void,
): void {
  useEffect(() => {
    flushPendingCliCommands(
      tabs,
      pendingCliCommands.current,
      sendTerminalInput,
      (tabId, sessionName) => tabsRef.current.some((tab) => tab.id === tabId && tab.tmuxSession === sessionName),
      (tabId, started) => {
        setTabs((current) => current.map((tab) => (
          tab.id === tabId && tab.remoteMachine ? { ...tab, remoteLaunchPending: !started } : tab
        )));
        if (!started) toast('Could not connect to the saved machine terminal. Refresh and open it again.');
      },
    );
  }, [pendingCliCommands, sendTerminalInput, setTabs, tabs, tabsRef]);
}
