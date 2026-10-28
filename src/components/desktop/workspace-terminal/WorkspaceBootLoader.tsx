'use client';

/**
 * WorkspaceBootLoader — the calm boot loader shown while a workspace surface is
 * resolving: OrchestratorTab rehydrating its last thread, or the workspace panel
 * still figuring out its tabs (the boot window before the "Start a new session"
 * CTA is allowed to show).
 *
 * It paints the SAME ASCII "o8" wave as the app's boot splash
 * (scripts/tauri-export.mjs) so boot → workspace reads as one continuous
 * identity. Unlike the bundled boot splash (which can't see the app theme and is
 * hardcoded), this one runs inside the app and follows the theme via the
 * data-palette/data-surface attrs (stamped pre-paint by the layout script) and
 * the --o8-boot-cover-* vars in globals.css — light glyphs on dark, dark glyphs
 * on light. A wordmark is rasterized to the grid, sampled to a density ramp, and
 * a diagonal crest washes across it. It renders IN PLACE (no portal) so it
 * server-renders into the dashboard HTML and owns the first paint.
 */

import { memo, useEffect, useRef } from 'react';

const RAMP = ' .:-=+*#%@';
const CELL = 6;
const SCALE = 0.4;
const TEXT = 'o8';

function WorkspaceBootLoaderBase({ contained = false }: { contained?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Theme-aware WITHOUT reading --t-* vars: this effect can run BEFORE the
    // ThemeProvider effect applies tokens (child effects fire first), so var
    // reads here race hydration. The data-surface/data-palette attrs are
    // stamped pre-paint by the layout's inline script, so they're always
    // truthful by now. The wrapper div owns the background (cover var); the
    // canvas only ever CLEARS and draws glyphs.
    const glass = document.documentElement.dataset.surface === 'glass';
    const darkPalette = document.documentElement.dataset.palette === 'dark';
    const ink = glass ? '#ffffff' : darkPalette ? '#e8ecf2' : '#0f172a';

    let dpr = 1;
    let cssW = 0;
    let cssH = 0;
    let cols = 0;
    let rows = 0;
    let activeCells: Array<{ i: number; j: number; base: number }> = [];
    let cx = -1;
    let cy = -1;
    let canvasLeft = 0;
    let canvasTop = 0;
    const off = document.createElement('canvas');
    const onPointerMove = (e: PointerEvent) => {
      cx = (e.clientX - canvasLeft) / CELL;
      cy = (e.clientY - canvasTop) / CELL;
    };
    const onPointerLeave = () => { cx = -1; cy = -1; };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerleave', onPointerLeave);

    function build() {
      const rect = canvas!.getBoundingClientRect();
      canvasLeft = rect.left;
      canvasTop = rect.top;
      cssW = Math.max(1, Math.floor(rect.width));
      cssH = Math.max(1, Math.floor(rect.height));
      dpr = Math.min(window.devicePixelRatio || 1, 3);
      canvas!.width = Math.floor(cssW * dpr);
      canvas!.height = Math.floor(cssH * dpr);
      cols = Math.max(8, Math.floor(cssW / CELL));
      rows = Math.max(8, Math.floor(cssH / CELL));

      off.width = cols;
      off.height = rows;
      const o = off.getContext('2d', { willReadFrequently: true });
      if (!o) return;
      o.fillStyle = '#000';
      o.fillRect(0, 0, cols, rows);
      o.fillStyle = '#fff';
      o.textBaseline = 'middle';
      o.textAlign = 'center';
      let size = rows * SCALE;
      const font = (s: number) => `700 ${s}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
      o.font = font(size);
      const w = o.measureText(TEXT).width;
      const maxW = cols * 0.86;
      const maxH = rows * 0.86;
      if (w > maxW) size *= maxW / w;
      if (size > maxH) size = maxH;
      o.font = font(size);
      o.fillText(TEXT, cols / 2, rows / 2);
      const d = o.getImageData(0, 0, cols, rows).data;
      const nextCells: Array<{ i: number; j: number; base: number }> = [];
      for (let k = 0; k < cols * rows; k++) {
        const a = d[4 * k + 3] / 255;
        const base = ((0.299 * d[4 * k] + 0.587 * d[4 * k + 1] + 0.114 * d[4 * k + 2]) / 255) * a;
        if (base > 0.015) nextCells.push({ i: k % cols, j: Math.floor(k / cols), base });
      }
      activeCells = nextCells;
    }

    build();
    const ro = new ResizeObserver(() => build());
    ro.observe(canvas);

    const last = RAMP.length - 1;
    let raf = 0;
    let start = 0;
    let lastFrame = 0;
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

    function frame(ts: number) {
      raf = requestAnimationFrame(frame);
      if (ts - lastFrame < 1000 / 30) return;
      lastFrame = ts;
      if (!start) start = ts;
      const t = (ts - start) / 1000;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Always transparent — the wrapper div's cover background is the ONE
      // paint (solid token or glass tint); the canvas only draws glyphs.
      ctx!.clearRect(0, 0, cssW, cssH);
      ctx!.fillStyle = ink;
      ctx!.font = `${CELL}px ui-monospace, Menlo, monospace`;
      ctx!.textBaseline = 'top';
      ctx!.textAlign = 'left';

      const span = cols + rows * 0.4;
      const edge = ((t * 0.25) % 1.4) * span;
      const bw2 = 2 * (cols * 0.1) * (cols * 0.1);
      // Pointer ripple — same recipe as the bundled boot splash (ripple 0.66,
      // radiusFrac 0.04) so the two loaders read as one continuous surface.
      const rad = 0.04 * Math.min(cols, rows);
      const rad2 = 2 * rad * rad;
      const inside = cx >= 0;

      for (const cell of activeCells) {
        const dist = cell.i + cell.j * 0.4 - edge;
        const crest = Math.exp(-(dist * dist) / bw2);
        let val = cell.base * (0.5 + crest * 0.85);
        if (inside) {
          const dx = cell.i - cx;
          const dy = cell.j - cy;
          const d2 = dx * dx + dy * dy;
          if (d2 < rad2 * 3) {
            val += cell.base * (33 / 50) * Math.exp(-d2 / rad2) * Math.sin(Math.sqrt(d2) * 0.7 - t * 7);
          }
        }
        if (val <= 0.02) continue;
        if (val > 1) val = 1;
        const idx = Math.round(Math.pow(val, 1.2) * last);
        if (idx <= 0) continue;
        const ch = RAMP[idx];
        if (ch === ' ') continue;
        ctx!.fillText(ch, cell.i * CELL, cell.j * CELL);
      }
    }
    raf = requestAnimationFrame(frame);
    start = now();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onPointerLeave);
    };
  }, []);

  // Rendered IN PLACE (no portal) so the loader server-renders into the
  // dashboard HTML — the splash owns the window from the very first paint
  // instead of letting ~1.2s of naked pre-hydration chrome through (prod boot
  // recording 2026-07-17). The Host mounts at the dashboard root, so
  // position:fixed escapes nothing it needs (same level as the drag-capture
  // layer). Background/ink come from --o8-boot-cover-* — defined in
  // globals.css keyed on the data-palette/data-surface attrs the pre-paint
  // stamp script sets, so the cover paints the RIGHT theme before any
  // ThemeProvider JS runs.
  return (
    <div
      style={{
        position: contained ? 'relative' : 'fixed',
        inset: contained ? undefined : 0,
        zIndex: contained ? undefined : 180,
        flex: contained ? 1 : undefined,
        minHeight: contained ? 120 : undefined,
        width: contained ? '100%' : undefined,
        // OPAQUE in both surfaces (Q ruling 2026-07-16): the old glass tint
        // (alpha ~0.6, borrowed from the bundled splash) let the mounted
        // chrome + the solid center tile read THROUGH the loader — the
        // "half-and-half" boot (sidebar and status bar up, bright grey slab
        // over the workspace). The splash's translucency only worked because
        // nothing but vibrancy sat behind it. Same tones, alpha 1: one cover,
        // one reveal when the workspace is actually ready.
        background: 'var(--o8-boot-cover-bg, #F4F2ED)',
        animation: 'o8BootBackdropIn 200ms ease-out both',
      }}
      role="status"
      aria-label="Loading workspace"
      aria-live="polite"
    >
      <style>{`
        @keyframes o8BootBackdropIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes o8BootCaptionIn { from { opacity: 0; } to { opacity: 1; } }
      `}</style>
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} aria-hidden />
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: '14%',
          textAlign: 'center',
          fontSize: 11.5,
          fontWeight: 320,
          letterSpacing: '0.04em',
          color: 'var(--o8-boot-cover-ink, var(--t-text-faint))',
          fontFamily: 'var(--font-sans-system)',
          animation: 'o8BootCaptionIn 600ms ease-out both',
        }}
      >
        Loading workspace…
      </div>
    </div>
  );
}

export const WorkspaceBootLoader = memo(WorkspaceBootLoaderBase);
