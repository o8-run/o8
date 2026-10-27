'use client';

import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Typed, inserted and restored drafts share the same bounded reading area. */
export function useComposerAutosize(ref: RefObject<HTMLTextAreaElement | null>, value: string, active: boolean) {
  const measured = useRef<{ node: HTMLTextAreaElement; value: string; width: number; viewportHeight: number } | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !active) return;
    const resize = (observedWidth?: number) => {
      if (!node.isConnected) return;
      const width = observedWidth ?? node.getBoundingClientRect().width;
      if (!width) return;
      const limit = Math.max(52, Math.min(200, window.innerHeight * 0.28));
      node.style.height = 'auto';
      node.style.height = `${Math.max(52, Math.min(node.scrollHeight, limit))}px`;
      measured.current = { node, value, width, viewportHeight: window.innerHeight };
    };
    const previous = measured.current;
    // The retained textarea still has its measured height. Avoid forcing the
    // entire revealed transcript to lay out just to remeasure an unchanged draft.
    if (!previous || previous.node !== node || previous.value !== value || previous.viewportHeight !== window.innerHeight
      || typeof ResizeObserver === 'undefined') resize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
      const entry = entries?.find(candidate => candidate.target === node);
      const next = entry?.contentRect.width ?? node.getBoundingClientRect().width;
      if (!next || next === measured.current?.width) return;
      resize(next);
    });
    observer?.observe(node);
    const onWindowResize = () => resize();
    window.addEventListener('resize', onWindowResize);
    return () => { observer?.disconnect(); window.removeEventListener('resize', onWindowResize); };
  }, [active, ref, value]);
}
