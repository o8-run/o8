'use client';

import { useLayoutEffect, useRef, type RefObject } from 'react';
import { captureTranscriptReadingAnchor, restoreTranscriptReadingAnchor } from './transcript-reading-anchor';

interface Options {
  endRef: RefObject<HTMLDivElement | null>;
  suppressRef: RefObject<boolean>;
  scope: string | null;
}

/** Follow content growth, but let the reader own the viewport until they return to the bottom. */
export function useTranscriptAutoScroll({ endRef, suppressRef, scope }: Options) {
  const connection = useRef<{
    container: HTMLElement; scope: string | null; follow: () => void; preserve: () => void; cancel: () => void; dispose: () => void;
  } | null>(null);

  // The empty composer can acquire a transcript without changing chat identity.
  // Reconcile its actual element after each commit; listeners survive caption updates.
  useLayoutEffect(() => {
    const end = endRef.current;
    const container = end?.closest<HTMLElement>('.thoughts-scroll') ?? null;
    if (connection.current?.container !== container || connection.current?.scope !== scope) {
      connection.current?.dispose(); connection.current = null;
    }
    if (!container || !end) return;
    if (!connection.current) {
      let following = true;
      let lastTop = container.scrollTop;
      let frame = 0;
      let anchor: ReturnType<typeof captureTranscriptReadingAnchor> = null;
      const cancel = () => { cancelAnimationFrame(frame); frame = 0; };
      const pause = () => { following = false; cancel(); anchor = captureTranscriptReadingAnchor(container); };
      const preserve = () => {
        if (following) return;
        restoreTranscriptReadingAnchor(container, anchor);
        lastTop = container.scrollTop;
      };
      const follow = () => {
        if (!following) { preserve(); return; }
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (!following || !container.isConnected) return;
          container.scrollTop = container.scrollHeight;
          lastTop = container.scrollTop;
        });
      };
      const onScroll = () => {
        const top = container.scrollTop;
        if (top < lastTop - 1) pause();
        // A deliberate return to the bottom resumes following. Content growth
        // alone must not revoke an already-following reader.
        if (container.scrollHeight - top - container.clientHeight <= 4) following = true;
        if (!following) anchor = captureTranscriptReadingAnchor(container);
        lastTop = top;
      };
      const onWheel = (event: WheelEvent) => { if (event.deltaY < 0) pause(); };
      const onKey = (event: KeyboardEvent) => {
        if ((event.target as HTMLElement)?.closest('input, textarea, [contenteditable="true"]')) return;
        if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) pause();
      };
      container.addEventListener('scroll', onScroll, { passive: true });
      container.addEventListener('wheel', onWheel, { passive: true });
      container.addEventListener('touchmove', pause, { passive: true });
      container.addEventListener('keydown', onKey);
      const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(follow);
      const content = end.parentElement;
      const observeContent = () => {
        observer?.disconnect();
        observer?.observe(container);
        if (content) {
          observer?.observe(content);
          // The flex content box can stay viewport-sized while its bubbles
          // overflow. Observe those bubbles for text reveal and image growth.
          for (const child of content.children) observer?.observe(child);
        }
        follow();
      };
      observeContent();
      const mutations = typeof MutationObserver === 'undefined' ? null : new MutationObserver(observeContent);
      if (content) mutations?.observe(content, { childList: true, subtree: true });
      connection.current = { container, scope, follow, preserve, cancel, dispose: () => {
        pause(); observer?.disconnect(); mutations?.disconnect();
        container.removeEventListener('scroll', onScroll);
        container.removeEventListener('wheel', onWheel);
        container.removeEventListener('touchmove', pause);
        container.removeEventListener('keydown', onKey);
      } };
    }
    if (suppressRef.current) {
      suppressRef.current = false;
      // Backfill owns this frame, but is not a reader gesture. If it adds no
      // visible height there may be no scroll event to reattach following.
      connection.current.cancel();
      connection.current.preserve();
    } else connection.current.follow();
  });

  useLayoutEffect(() => () => {
    connection.current?.dispose(); connection.current = null;
  }, []);
}
