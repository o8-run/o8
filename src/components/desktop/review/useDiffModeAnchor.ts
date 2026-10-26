import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import type { DiffMode } from './panel/types';

type Anchor = { path: string; line: string | null; offset: number };

function anchorLine(row: HTMLElement, key: string): HTMLElement | undefined {
  const lines = [...row.querySelectorAll<HTMLElement>('[data-review-line]')];
  const exact = lines.find(node => node.getAttribute('data-review-line') === key);
  if (exact) return exact;
  const source = /^([LR]):(\d+)$/.exec(key);
  if (!source) return undefined;
  let nearest: HTMLElement | undefined;
  let distance = Infinity;
  for (const line of lines) {
    const candidate = /^([LR]):(\d+)$/.exec(line.getAttribute('data-review-line') ?? '');
    if (!candidate || candidate[1] !== source[1]) continue;
    const delta = Math.abs(Number(candidate[2]) - Number(source[2]));
    if (delta < distance) { nearest = line; distance = delta; }
  }
  return nearest;
}

/** Preserve a source line across renderer replacement and wrapped-line reflow. */
export function useDiffModeAnchor(mode: DiffMode, rows: RefObject<Map<string, HTMLDivElement>>) {
  const pending = useRef<Anchor | null>(null);
  const retained = useRef<Anchor | null>(null);
  const selection = useRef<string | null>(null);
  const reading = useRef<{ scroll: HTMLElement; top: number; width: number; height: number } | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  const reader = useRef<{ scroll: HTMLElement; dispose: () => void } | null>(null);
  const reset = useCallback(() => {
    pending.current = null;
    retained.current = null;
    selection.current = null;
    reading.current = null;
    cancel.current?.();
  }, []);
  const selectFile = useCallback((path: string) => {
    reset();
    selection.current = path;
  }, [reset]);
  useLayoutEffect(() => () => { reader.current?.dispose(); }, []);
  const capture = () => {
    cancel.current?.();
    pending.current = null;
    const original = retained.current;
    retained.current = null;
    // File rows are siblings inside the changed-file scroller.
    const scroll = rows.current.values().next().value?.parentElement;
    if (!scroll) return;
    if (reader.current?.scroll !== scroll) {
      reader.current?.dispose();
      const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
      for (const event of events) scroll.addEventListener(event, reset, { passive: true });
      reader.current = { scroll, dispose: () => {
        for (const event of events) scroll.removeEventListener(event, reset);
      } };
    }
    const position = reading.current;
    if (original && rows.current.has(original.path) && position?.scroll === scroll
      && (Math.abs(scroll.scrollTop - position.top) < 1
        || scroll.clientWidth !== position.width || scroll.clientHeight !== position.height)) {
      pending.current = original;
      retained.current = original;
      return;
    }
    reading.current = { scroll, top: scroll.scrollTop, width: scroll.clientWidth, height: scroll.clientHeight };
    const viewport = scroll.getBoundingClientRect();
    const selectedPath = selection.current;
    const selectedRow = selectedPath ? rows.current.get(selectedPath) : null;
    selection.current = null;
    if (selectedPath && selectedRow) {
      pending.current = { path: selectedPath, line: null, offset: selectedRow.getBoundingClientRect().top - viewport.top };
      retained.current = pending.current;
      return;
    }
    const ordered = [...rows.current].map(([path, row]) => ({ path, row, box: row.getBoundingClientRect() }))
      .sort((a, b) => a.box.top - b.box.top);
    for (const { path, row, box } of ordered) {
      if (box.bottom <= viewport.top || box.top >= viewport.bottom) continue;
      const line = box.top < viewport.top
        ? [...row.querySelectorAll<HTMLElement>('[data-review-line]')].find(node => {
          const rect = node.getBoundingClientRect();
          return rect.bottom > viewport.top && rect.top < viewport.bottom;
        }) : undefined;
      pending.current = { path, line: line?.getAttribute('data-review-line') ?? null,
        offset: (line ?? row).getBoundingClientRect().top - viewport.top };
      retained.current = pending.current;
      break;
    }
  };

  useLayoutEffect(() => {
    const anchor = pending.current;
    pending.current = null;
    const scroll = rows.current.values().next().value?.parentElement;
    if (!scroll || !anchor) return;
    let frame = 0;
    let active = true;
    const restore = () => {
      if (!active) return;
      const row = rows.current.get(anchor.path);
      if (!row) return;
      const line = anchor.line === null ? null : anchorLine(row, anchor.line);
      scroll.scrollTop += (line ?? row).getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.offset;
      reading.current = { scroll, top: scroll.scrollTop, width: scroll.clientWidth, height: scroll.clientHeight };
    };
    restore();
    // Observe row sizes while font metrics and wrapping settle, then relinquish control.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(restore);
    for (const row of rows.current.values()) observer?.observe(row);
    frame = requestAnimationFrame(() => { restore(); frame = requestAnimationFrame(restore); });
    const stop = () => {
      active = false;
      observer?.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
      if (cancel.current === stop) cancel.current = null;
    };
    const timeout = setTimeout(stop, 500);
    cancel.current = stop;
    return stop;
  }, [mode, rows]);
  return { capture, selectFile };
}
