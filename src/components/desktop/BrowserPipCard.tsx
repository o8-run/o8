'use client';

/**
 * BrowserPipCard — browser-specific content for the shared hover PiP shell.
 * Emitters dispatch BROWSER_PIP_EVENT; HoverPipCard owns visibility timing,
 * orientation, positioning, controls, and motion.
 */

import type { CSSProperties, RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import { HoverPipCard } from '@/components/desktop/HoverPipCard';
import { NativeBrowserSurface } from '@/components/desktop/NativeBrowserSurface';
import { useO8BrowserTabs } from '@/components/desktop/use-o8-browser-tabs';
import { useNativeBrowserViewFlag } from '@/lib/operator/use-native-browser-view';
import { isTauri } from '@/lib/tauri/bridge';
import { readBrowserPaneState } from '@/lib/browser/pane-state';
import { browserFrameSrc } from '@/lib/browser/url';
import { O8EnginePane } from './O8EnginePane';

export const BROWSER_PIP_EVENT = 'o8:browser-pip';

const ORIENTATION_KEY = 'o8:browser-pip-orientation';

export function BrowserPipCard({
  active,
  scopeKey,
  onOpenBrowser,
  panelVisible = false,
  browserVisible = false,
  boundsRef,
}: {
  /** No side panel is open — the only mode where the PIP earns its place. */
  active: boolean;
  /** MUST match the dashboard's browser tab-store scope (right-panel:<repo>). */
  scopeKey: string;
  onOpenBrowser?: (url?: string) => void;
  panelVisible?: boolean;
  browserVisible?: boolean;
  boundsRef?: RefObject<HTMLElement | null>;
}) {
  const tabs = useO8BrowserTabs(scopeKey);
  const [inTauri] = useState<boolean>(() => isTauri());
  const nativeEnabled = useNativeBrowserViewFlag() && inTauri;
  const [selection, setSelection] = useState<{ scope: string; id: string } | null>(null);
  const activeId = readBrowserPaneState(scopeKey)?.activeTabId;
  const tab = tabs.find((item) => item.id === (selection?.scope === scopeKey ? selection.id : activeId)) ?? tabs[0] ?? null;
  const previous = useRef({ scopeKey, panelVisible, browserSeen: browserVisible });
  useEffect(() => {
    const before = previous.current;
    const sameScope = before.scopeKey === scopeKey;
    const browserSeen = browserVisible || sameScope && before.browserSeen;
    previous.current = { scopeKey, panelVisible, browserSeen: panelVisible && browserSeen };
    if (sameScope && before.panelVisible && !panelVisible && browserSeen && tabs.length > 0) {
      window.dispatchEvent(new CustomEvent(BROWSER_PIP_EVENT, { detail: { open: true } }));
    }
  }, [browserVisible, panelVisible, scopeKey, tabs.length]);
  const tabIndex = tab ? tabs.findIndex((item) => item.id === tab.id) : 0;
  const cycle = (direction: number) => { const next = tabs[(tabIndex + direction + tabs.length) % tabs.length]; if (next) setSelection({ scope: scopeKey, id: next.id }); };

  return (
    <HoverPipCard
      active={active}
      available={Boolean(tab)}
      eventName={BROWSER_PIP_EVENT}
      storageKey={ORIENTATION_KEY}
      contextKey={scopeKey}
      boundsRef={boundsRef}
      title={tab?.title || tab?.host || tab?.url || ''}
      titleTooltip={tab?.url}
      openLabel="Open in Browser tab"
      onOpen={() => onOpenBrowser?.(tab?.url)}
      headerContent={tabs.length > 1 ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
        <button type="button" aria-label="Previous browser preview" onClick={() => cycle(-1)} style={pageButton}>‹</button>
        <span aria-label={`${tabIndex + 1} of ${tabs.length} browser pages`} style={{ fontSize: 10, color: 'var(--t-text-muted)', fontVariantNumeric: 'tabular-nums' }}>{tabIndex + 1}/{tabs.length}</span>
        <button type="button" aria-label="Next browser preview" onClick={() => cycle(1)} style={pageButton}>›</button>
      </span> : null}
    >
      {({ shape, close }) => {
        if (!tab) return null;
        const iframeScale = shape.width / shape.viewport;

        return (
          <div style={{ position: 'relative', height: shape.frameHeight, overflow: 'hidden', background: 'var(--t-canvas-bg)' }}>
            {tab.surface === 'engine' && !nativeEnabled ? <O8EnginePane url={tab.url} /> : nativeEnabled ? (
              <NativeBrowserSurface url={tab.url} viewportWidth={shape.viewport} />
            ) : (
              <>
                <iframe
                  src={browserFrameSrc(tab.url)}
                  title="Browser preview"
                  sandbox="allow-scripts allow-same-origin allow-forms"
                  style={{
                    width: shape.viewport,
                    height: shape.frameHeight / iframeScale,
                    borderWidth: 0,
                    transform: `scale(${iframeScale})`,
                    transformOrigin: '0 0',
                    pointerEvents: 'none',
                  } as CSSProperties}
                />
                <button
                  type="button"
                  aria-label="Open browser tab"
                  onClick={() => {
                    close();
                    onOpenBrowser?.(tab.url);
                  }}
                  style={{
                    position: 'absolute',
                    top: 0,
                    right: 0,
                    bottom: 0,
                    left: 0,
                    borderWidth: 0,
                    background: 'transparent',
                    cursor: 'pointer',
                  }}
                />
              </>
            )}
          </div>
        );
      }}
    </HoverPipCard>
  );
}

const pageButton: CSSProperties = { width: 22, height: 24, padding: 0, border: 0, borderRadius: 6, background: 'transparent', color: 'var(--t-text-muted)', fontSize: 16, cursor: 'pointer' };
