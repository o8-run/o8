import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { DiffMode } from './panel/types';

type Anchor = { path: string; line: string | null; offset: number };

/** Preserve a source line across renderer replacement and wrapped-line reflow. */
export function useDiffModeAnchor(mode: DiffMode, rows: RefObject<Map<string, HTMLDivElement>>) {
  const pending = useRef<Anchor | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  const capture = () => {
    cancel.current?.();
    pending.current = null;
    // File rows are siblings inside the changed-file scroller.
    const scroll = rows.current.values().next().value?.parentElement;
    if (!scroll) return;
    const viewport = scroll.getBoundingClientRect();
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
      const line = anchor.line === null ? null : [...row.querySelectorAll<HTMLElement>('[data-review-line]')]
        .find(node => node.getAttribute('data-review-line') === anchor.line);
      scroll.scrollTop += (line ?? row).getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.offset;
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
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) scroll.removeEventListener(event, stop);
      if (cancel.current === stop) cancel.current = null;
    };
    const timeout = setTimeout(stop, 500);
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) scroll.addEventListener(event, stop, { passive: true });
    cancel.current = stop;
    return stop;
  }, [mode, rows]);
  return { capture };
}
