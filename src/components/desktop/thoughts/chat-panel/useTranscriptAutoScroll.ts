'use client';

import { useLayoutEffect, useRef, type RefObject } from 'react';
import { captureTranscriptReadingAnchor, restoreTranscriptReadingAnchor } from './transcript-reading-anchor';
import { loadTranscriptReadingPosition, saveTranscriptReadingPosition } from './transcript-reading-position';

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
      const saved = loadTranscriptReadingPosition(scope);
      let following = saved?.following ?? true;
      let anchor = saved?.anchor ?? null;
      // History may arrive tail-first. Keep the identity until backfill mounts
      // it; an intermediate scroll must not save the tail over that identity.
      let restoring = !following && anchor !== null;
      if (saved && !following) container.scrollTop = saved.top;
      let lastTop = container.scrollTop;
      let frame = 0;
      let savedFollowing = saved?.following;
      const save = () => {
        if (restoring || (following && savedFollowing === true)) return;
        saveTranscriptReadingPosition(scope, { following, top: following ? 0 : lastTop, anchor: following ? null : anchor });
        savedFollowing = following;
      };
      const cancel = () => { cancelAnimationFrame(frame); frame = 0; };
      const pause = () => {
        restoring = false; following = false; cancel();
        anchor = captureTranscriptReadingAnchor(container); lastTop = container.scrollTop; save();
      };
      const preserve = () => {
        if (following) return;
        if (restoreTranscriptReadingAnchor(container, anchor)) restoring = false;
        lastTop = container.scrollTop;
      };
      const follow = () => {
        if (!following) { preserve(); return; }
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (!following || !container.isConnected || container.clientHeight === 0) return;
          container.scrollTop = container.scrollHeight;
          lastTop = container.scrollTop;
        });
      };
      const onScroll = () => {
        if (restoring || container.clientHeight === 0) return;
        const top = container.scrollTop;
        if (top < lastTop - 1) pause();
        // A deliberate return to the bottom resumes following. Content growth
        // alone must not revoke an already-following reader.
        if (container.scrollHeight - top - container.clientHeight <= 4) following = true;
        if (!following) anchor = captureTranscriptReadingAnchor(container);
        lastTop = top;
        save();
      };
      const onWheel = (event: WheelEvent) => { if (event.deltaY < 0 || (restoring && event.deltaY !== 0)) pause(); };
      const onKey = (event: KeyboardEvent) => {
        if ((event.target as HTMLElement)?.closest('input, textarea, [contenteditable="true"]')) return;
        if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)
          || (restoring && ['ArrowDown', 'PageDown', 'End', ' '].includes(event.key))) pause();
      };
      const onPointerDown = () => { if (restoring) pause(); };
      container.addEventListener('scroll', onScroll, { passive: true });
      container.addEventListener('wheel', onWheel, { passive: true });
      container.addEventListener('touchmove', pause, { passive: true });
      container.addEventListener('keydown', onKey);
      container.addEventListener('pointerdown', onPointerDown);
      window.addEventListener('pagehide', save);
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
        // React may already have replaced the rows for a different scope.
        // Save the last observed position, never capture from that new DOM.
        save(); cancel(); observer?.disconnect(); mutations?.disconnect();
        container.removeEventListener('scroll', onScroll);
        container.removeEventListener('wheel', onWheel);
        container.removeEventListener('touchmove', pause);
        container.removeEventListener('keydown', onKey);
        container.removeEventListener('pointerdown', onPointerDown);
        window.removeEventListener('pagehide', save);
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
