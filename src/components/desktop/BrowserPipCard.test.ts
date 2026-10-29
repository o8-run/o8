// @vitest-environment jsdom

import { act, createElement, type ComponentProps, type HTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserPipCard } from './BrowserPipCard';

vi.mock('framer-motion', () => ({ AnimatePresence: ({ children }: { children: ReactNode }) => children, motion: { div: 'div' }, useReducedMotion: () => true }));
vi.mock('@lisse/react', () => ({ SmoothCorners: ({ children, style }: HTMLAttributes<HTMLDivElement>) => createElement('div', { style }, children) }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ workspaceGlass: true, surface: 'glass', paletteId: 'dark' }) }));
vi.mock('./use-o8-browser-tabs', () => ({ useO8BrowserTabs: () => [{ id: 'page', title: 'Docs', host: 'example.com', url: 'https://example.com/docs' }] }));
vi.mock('@/lib/browser/pane-state', () => ({ readBrowserPaneState: () => ({ activeTabId: 'page' }) }));
vi.mock('@/lib/operator/use-native-browser-view', () => ({ useNativeBrowserViewFlag: () => false }));
vi.mock('./O8EnginePane', () => ({ O8EnginePane: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Props = ComponentProps<typeof BrowserPipCard>;

describe('browser picture-in-picture follows the chat it came from', () => {
  let host: HTMLDivElement; let root: Root;
  beforeEach(() => { localStorage.clear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); });
  const render = (props: Partial<Props>) => act(() => root.render(createElement(BrowserPipCard, { scopeKey: 'right-panel:repo', active: true, ...props } as Props)));
  const pip = () => host.querySelector('[data-hover-pip]');

  it('hides on the Pull requests page and returns with the chat', () => {
    render({ active: false, panelVisible: true, browserVisible: true, tabKind: 'chat' });
    render({ panelVisible: false, tabKind: 'chat' });
    expect(pip()).not.toBeNull();

    render({ panelVisible: false, tabKind: 'canvas' });
    expect(pip()).toBeNull();

    render({ panelVisible: false, tabKind: 'chat' });
    expect(pip()).not.toBeNull();
  });

  it('does not appear over Pull requests when opening it closes the Browser panel', () => {
    render({ active: false, panelVisible: true, browserVisible: true, tabKind: 'orchestrator' });
    render({ panelVisible: false, tabKind: 'canvas' });
    expect(pip()).toBeNull();

    render({ panelVisible: false, tabKind: 'orchestrator' });
    expect(pip()).not.toBeNull();
  });

  it('stays off terminal tabs', () => {
    render({ active: false, panelVisible: true, browserVisible: true, tabKind: 'chat' });
    render({ panelVisible: false, tabKind: 'terminal' });
    expect(pip()).toBeNull();
  });
});
