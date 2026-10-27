'use client';

/**
 * BottomXtermPanel — the xterm.js surface used by the bottom ContextualPanel
 * for each terminal tab. Extracted from ContextualPanel.tsx to keep that file
 * under the 800-line ceiling. Mirrors the TerminalWorkspace xterm pattern:
 * lazy-loads @xterm/* on mount, attaches to a tmux session over WS, and renders
 * any inline images the agent emits.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTheme } from '@/lib/theme/context';
import { shellLacksGlass } from '@/lib/desktop/host-platform';
import { isWebMachineBrowserSurface } from '@/lib/connect/web-machine-surface';
import { buildXtermTheme } from '@/components/desktop/workspace-terminal/constants';
import { recordXtermSelectionSnapshot, registerXtermSelectionSource } from '@/components/desktop/workspace-terminal/xterm-selection-registry';
import { retainInlineTerminalImages, TERMINAL_SCROLLBACK_LINES } from '@/lib/terminal/client-retention';
import { disposeTerminalOutput, setTerminalInputDisabled, writeTerminalOutput } from '@/components/desktop/workspace-terminal/terminal-output-writer';
import { terminalExitState, type TerminalExitState } from '@/lib/terminal/exit-state';
import { TerminalExitNotice } from '@/components/desktop/workspace-terminal/TerminalExitNotice';
import { retainTerminalExitBuffer } from '@/components/desktop/workspace-terminal/terminal-exit-buffer';

interface InlineImage {
  id: string;
  dataUrl: string;
  filename: string;
}

export interface XtermPanelHandle {
  writeData: (data: string, historical?: boolean) => void;
  showImage: (imageB64: string, filename: string) => void;
  setError: (error: string) => void;
  setExited: (exitCode?: number | null) => void;
}

export const BottomXtermPanel = forwardRef<XtermPanelHandle, {
  tmuxSession: string;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalDetach: (sessionName: string) => void;
  visible: boolean;
  /** Watch-only: render live output but never forward keystrokes to the PTY. */
  readOnly?: boolean;
  onNewShell?: () => void;
  onClose?: () => void;
}>(function BottomXtermPanel(
  { tmuxSession, sendTerminalAttach, sendTerminalInput, sendTerminalResize, sendTerminalDetach, visible, readOnly = false, onNewShell, onClose },
  ref,
) {
  const { themeId, surface, workspaceGlass } = useTheme();
  // Glass surface: the bottom terminal reads as part of the chrome, so it
  // bleeds the vibrancy like every other glass panel instead of painting a
  // solid near-black slab (Q ruling 2026-07-14). Solid surface keeps the
  // opaque paper terminal. Kept in a ref so the init effect sees the current
  // value without re-initializing the terminal.
  const glass = surface === 'glass' || (workspaceGlass && !isWebMachineBrowserSurface() && !shellLacksGlass());
  const glassRef = useRef(glass);
  glassRef.current = glass;
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const termRef = useRef<any>(null);
  const exitBufferRef = useRef<ReturnType<typeof retainTerminalExitBuffer> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fitAddonRef = useRef<any>(null);
  const [error, setError] = useState<string | null>(null);
  const exitedRef = useRef(false);
  const [exited, setExited] = useState<TerminalExitState | null>(null);
  const [inlineImages, setInlineImages] = useState<InlineImage[]>([]);
  const imageCountRef = useRef(0);

  useImperativeHandle(ref, () => ({
    writeData: (data: string, historical = false) => {
      if (!termRef.current) return;
      try {
        const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
        writeTerminalOutput(termRef.current, bytes, undefined, historical);
      } catch { /* ignore decode errors */ }
    },
    showImage: (imageB64: string, filename: string) => {
      const ext = filename.split('.').pop()?.toLowerCase() ?? 'png';
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'svg' ? 'image/svg+xml' : 'image/png';
      const dataUrl = `data:${mime};base64,${imageB64}`;
      imageCountRef.current += 1;
      setInlineImages((previous) => retainInlineTerminalImages([
        ...previous,
        { id: `img-${imageCountRef.current}`, dataUrl, filename },
      ]));
      if (termRef.current) writeTerminalOutput(termRef.current, '\r\n\r\n');
    },
    setError: (err: string) => { if (!exitedRef.current) setError(err); },
    setExited: (exitCode) => {
      exitedRef.current = true;
      if (termRef.current) setTerminalInputDisabled(termRef.current, true);
      const term = termRef.current;
      const finish = () => {
        const state = terminalExitState(exitCode, exitBufferRef.current?.read() ?? '');
        if (term && state.transcript) { term.reset(); setTerminalInputDisabled(term, true); writeTerminalOutput(term, state.transcript.replace(/\n/g, '\r\n'), undefined, true); }
        setExited(state);
      };
      if (term) writeTerminalOutput(term, '', finish); else finish();
    },
  }), []);

  useEffect(() => {
    if (!visible || !fitAddonRef.current || !termRef.current) return;
    const timer = setTimeout(() => {
      try {
        fitAddonRef.current?.fit();
        if (!exitedRef.current) sendTerminalResize(tmuxSession, termRef.current.cols, termRef.current.rows);
        // Pin to the latest output. While the panel is hidden (display:none)
        // the buffer keeps growing but the viewport doesn't track the bottom,
        // so on re-show it lands mid-scroll. A second deferred call catches
        // any tmux replay that streams in just after the fit.
        termRef.current?.scrollToBottom();
        setTimeout(() => termRef.current?.scrollToBottom(), 200);
      } catch { /* ignore */ }
    }, 50);
    return () => clearTimeout(timer);
  }, [visible, sendTerminalResize, tmuxSession]);

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;

    async function init() {
      try {
        const [{ Terminal }, { FitAddon }, { WebLinksAddon }, { SearchAddon }, { Unicode11Addon }, { ImageAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
          import('@xterm/addon-web-links'),
          import('@xterm/addon-search'),
          import('@xterm/addon-unicode11'),
          import('@xterm/addon-image'),
        ]);
        if (disposed) return;

        if (!document.getElementById('xterm-css')) {
          const link = document.createElement('link');
          link.id = 'xterm-css';
          link.rel = 'stylesheet';
          link.href = '/xterm.css';
          document.head.appendChild(link);
        }

        const term = new Terminal({
          fontFamily: 'ui-monospace, "SF Mono", Monaco, Menlo, monospace',
          fontSize: 12,
          lineHeight: 1.35,
          cursorBlink: true,
          cursorStyle: 'block',
          // Transparency follows the surface axis: glass mode blends the
          // terminal into the vibrancy chrome; solid keeps an opaque canvas.
          allowTransparency: true,
          allowProposedApi: true,
          scrollback: TERMINAL_SCROLLBACK_LINES,
          // Watch posture: a read-only agent-run view never captures input.
          disableStdin: readOnly,
          theme: { ...buildXtermTheme(), ...(glassRef.current ? { background: 'rgba(0,0,0,0)' } : {}) },
        });

        const fitAddon = new FitAddon();
        const webLinksAddon = new WebLinksAddon();
        const searchAddon = new SearchAddon();
        const unicode11Addon = new Unicode11Addon();
        const imageAddon = new ImageAddon({
          enableSizeReports: true,
          pixelLimit: 16777216,
          sixelSupport: true,
          sixelScrolling: true,
          sixelPaletteLimit: 4096,
          iipSupport: true,
          iipSizeLimit: 20000000,
        });
        term.loadAddon(fitAddon);
        term.loadAddon(webLinksAddon);
        term.loadAddon(searchAddon);
        term.loadAddon(unicode11Addon);
        term.loadAddon(imageAddon);
        term.unicode.activeVersion = '11';

        if (!containerRef.current || disposed) { term.dispose(); return; }

        term.open(containerRef.current);
        exitBufferRef.current = retainTerminalExitBuffer(term);
        fitAddon.fit();
        termRef.current = term;
        fitAddonRef.current = fitAddon;

        sendTerminalAttach(tmuxSession, term.cols, term.rows);
        // Read-only (agent-run) views watch without typing into the agent's PTY.
        if (!readOnly) {
          term.onData((data) => { if (!exitedRef.current) sendTerminalInput(tmuxSession, data); });
        }
        // Snapshot selections for the speak-selection reader (busy TUIs can
        // wipe the live selection before the chord lands).
        term.onSelectionChange(() => {
          recordXtermSelectionSnapshot(term.getSelection?.() ?? '');
        });

        const observer = new ResizeObserver(() => {
          if (disposed || !fitAddonRef.current) return;
          try {
            fitAddonRef.current.fit();
            if (!exitedRef.current) sendTerminalResize(tmuxSession, termRef.current.cols, termRef.current.rows);
          } catch { /* ignore */ }
        });
        if (containerRef.current) observer.observe(containerRef.current);

        return () => { observer.disconnect(); };
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : 'Failed to load terminal');
      }
    }

    const cleanupPromise = init();

    // Speak-selection bridge (Ctrl+Shift+R) — xterm selections aren't DOM
    // selections; register a getter so the dashboard handler can read them.
    const unregisterSelection = registerXtermSelectionSource(
      () => termRef.current?.getSelection?.() ?? '',
    );

    return () => {
      disposed = true;
      unregisterSelection();
      sendTerminalDetach(tmuxSession);
      cleanupPromise?.then(cleanup => cleanup?.());
      exitBufferRef.current?.dispose(); exitBufferRef.current = null;
      if (termRef.current) { disposeTerminalOutput(termRef.current); termRef.current.dispose(); termRef.current = null; }
      fitAddonRef.current = null;
    };
  }, [tmuxSession, sendTerminalAttach, sendTerminalInput, sendTerminalResize, sendTerminalDetach, readOnly]);

  // Live-update xterm theme when the app theme OR surface switches — no
  // dispose/recreate. Glass keeps the terminal background fully transparent
  // so the vibrancy shows through.
  useEffect(() => {
    if (!termRef.current) return;
    try {
      termRef.current.options.theme = { ...buildXtermTheme(), ...(glass ? { background: 'rgba(0,0,0,0)' } : {}) };
    } catch {
      // Terminal may have been disposed mid-update; safe to ignore.
    }
  }, [themeId, glass]);

  if (error) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#ef4444', fontSize: 13, fontFamily: 'ui-monospace, monospace',
      }}>
        Terminal error: {error}
      </div>
    );
  }

  return (
    <div data-o8-term-panel={tmuxSession} style={{
      flex: 1,
      width: '100%',
      display: visible ? 'flex' : 'none',
      flexDirection: 'column',
      background: glass ? 'transparent' : 'var(--t-terminal-bg, #16191e)',
      overflow: 'hidden',
    }}>
      {exited ? <TerminalExitNotice state={exited} onNewShell={onNewShell} onClose={onClose} /> : null}
      {inlineImages.map((img) => (
        <div key={img.id} style={{
          paddingTop: 8, paddingBottom: 8, paddingLeft: 12, paddingRight: 12,
          borderBottom: '1px solid var(--t-divider)', flexShrink: 0,
        }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={img.dataUrl} alt={img.filename} style={{
            maxWidth: '100%', maxHeight: 400, borderRadius: 8, objectFit: 'contain',
          }} />
          <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 4, fontFamily: 'ui-monospace, monospace' }}>
            {img.filename}
          </div>
        </div>
      ))}
      <div ref={containerRef} className="cortex-terminal-fade" style={{
        // minHeight:0 lets this flex child shrink below the xterm's intrinsic
        // content height. Without it the terminal keeps its full row-count
        // height and the parent's overflow:hidden clips the bottom rows (the
        // "cut off" trust prompt). With it, the ResizeObserver re-fits the
        // xterm to the actual visible height so nothing is clipped.
        flex: 1, minHeight: 0, width: '100%', overflow: 'hidden', background: glass ? 'transparent' : 'var(--t-terminal-bg, #16191e)', paddingTop: 2, paddingLeft: 2,
      }} />
    </div>
  );
});
