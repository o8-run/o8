// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { WorkspaceTerminalPanels } from './WorkspaceTerminalPanels';

const pending = vi.hoisted(() => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
});
vi.mock('@/components/desktop/Canvas', async () => {
  await pending.promise;
  return { Canvas: () => createElement('div', null, 'Canvas loaded') };
});
vi.mock('@/components/desktop/hooks/DesktopWebSocketContext', () => ({ useWsConnectionEpoch: () => 0 }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ workspaceGlass: false }) }));
vi.mock('./XtermPanel', () => ({ XtermPanel: () => null }));

it('shows the workspace loading state until the selected canvas chunk arrives', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const noop = () => {};
  const props: ComponentProps<typeof WorkspaceTerminalPanels> = {
    workspaceId: 'workspace', tileId: 'tile-root', restoreSettled: true, effectiveActiveTabId: 'canvas',
    visibleTabs: [{ id: 'canvas', kind: 'canvas', label: 'Canvas', tmuxSession: '', createdAt: 0, lastActivity: 0,
      canvasTab: { id: 'welcome', kind: 'welcome', label: 'Welcome', resourceId: 'fixture' } }],
    termWsConnected: true, panelRefs: { current: new Map() }, projectContextRailVisible: false,
    onCloseTab: noop, onRunInTerminal: noop, onOpenWorkspaceCommitTab: noop, onUpdateLlmSummary: noop,
    onUpdateLinkedIssue: noop, onUpdateChatMessages: noop, onUpdateChatSessionKey: noop, onUpdateChatModel: noop,
    onConsumeChatDraftInjection: noop, onSaveCheckpoint: noop, onRestoreLatestCheckpoint: noop,
    sendTerminalAttach: noop, sendTerminalInput: noop, sendTerminalResize: noop, sendTerminalVisibility: noop, sendTerminalDetach: noop,
  };
  try {
    await act(async () => root.render(createElement(WorkspaceTerminalPanels, props)));
    expect(host.querySelector('[aria-label="Loading workspace"]')).not.toBeNull();
    await act(async () => root.render(createElement(WorkspaceTerminalPanels, { ...props, effectiveActiveTabId: 'other' })));
    expect(host.querySelector('[aria-label="Loading workspace"]')).toBeNull();
    await act(async () => root.render(createElement(WorkspaceTerminalPanels, props)));
    expect(host.querySelector('[aria-label="Loading workspace"]')).not.toBeNull();
    await act(async () => { pending.resolve(); await pending.promise; });
    await vi.waitFor(() => expect(host.textContent).toContain('Canvas loaded'));
    expect(host.querySelector('[aria-label="Loading workspace"]')).toBeNull();
  } finally {
    await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});
