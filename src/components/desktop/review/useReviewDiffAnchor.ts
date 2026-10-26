import { useCallback, useLayoutEffect, useRef } from 'react';

type Anchor = { file: string; key: string | null; offset: number };

/** Keep source identity across reflows; pixel scrollTop alone cannot identify a hunk. */
export function useReviewDiffAnchor(identity: string, presentation: string) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<Anchor | null>(null);
  const restoredTop = useRef(0);
  const restoredHeight = useRef(0);
  const selectedFile = useRef<string | null>(null);
  const cancel = useCallback(() => { anchor.current = null; selectedFile.current = null; }, []);
  const select = useCallback((file: string) => { anchor.current = null; selectedFile.current = file; }, []);
  const capture = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    if (anchor.current && Math.abs(scroll.scrollTop - restoredTop.current) < 1) return;
    const top = scroll.getBoundingClientRect().top;
    const files = [...scroll.querySelectorAll<HTMLElement>('[data-review-file]')];
    const selected = files.find(node => node.dataset.reviewFile === selectedFile.current);
    selectedFile.current = null;
    if (selected) {
      // Finish an explicit file jump before a layout toggle, even mid smooth-scroll.
      scroll.scrollTo({ top: scroll.scrollTop + selected.getBoundingClientRect().top - top - 46, behavior: 'instant' });
      anchor.current = { file: selected.dataset.reviewFile!, key: null, offset: selected.getBoundingClientRect().top - top };
      restoredTop.current = scroll.scrollTop;
      restoredHeight.current = scroll.scrollHeight;
      return;
    }
    const file = files.find(node => node.getBoundingClientRect().bottom > top + 8);
    if (!file) { cancel(); return; }
    const lines = [...file.querySelectorAll<HTMLElement>('[data-review-line]')];
    const line = lines.find(node => node.getBoundingClientRect().bottom > top + 8);
    const keys = line?.dataset.reviewLine?.split(' ') ?? [];
    anchor.current = {
      file: file.dataset.reviewFile!,
      key: keys.find(key => key.startsWith('R:')) ?? keys[0] ?? null,
      offset: (line ?? file).getBoundingClientRect().top - top,
    };
    restoredTop.current = scroll.scrollTop;
    restoredHeight.current = scroll.scrollHeight;
  }, [cancel]);
  const restore = useCallback(() => {
    const scroll = scrollRef.current;
    const saved = anchor.current;
    if (!scroll || !saved) return;
    const file = [...scroll.querySelectorAll<HTMLElement>('[data-review-file]')]
      .find(node => node.dataset.reviewFile === saved.file);
    if (!file) { cancel(); return; }
    const lines = [...file.querySelectorAll<HTMLElement>('[data-review-line]')];
    const exact = lines.find(node => node.dataset.reviewLine?.split(' ').includes(saved.key ?? ''));
    // Whitespace filtering can remove a line. Keep the original key for the return trip.
    const side = saved.key?.slice(0, 2);
    const number = Number(saved.key?.slice(2));
    const nearest = saved.key ? lines.reduce<{ node?: HTMLElement; distance: number }>((best, node) => {
      const key = node.dataset.reviewLine?.split(' ').find(key => key.startsWith(side!));
      const distance = key ? Math.abs(Number(key.slice(2)) - number) : Infinity;
      return distance < best.distance ? { node, distance } : best;
    }, { distance: Infinity }).node : undefined;
    // During a patch refetch there is no source geometry yet. Wait for the resize.
    if (saved.key && !exact && !nearest) {
      restoredTop.current = scroll.scrollTop;
      restoredHeight.current = scroll.scrollHeight;
      return;
    }
    const target = exact ?? nearest ?? file;
    scroll.scrollTop += target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - saved.offset;
    restoredTop.current = scroll.scrollTop;
    restoredHeight.current = scroll.scrollHeight;
  }, [cancel]);

  useLayoutEffect(cancel, [cancel, identity]);
  useLayoutEffect(restore, [restore, presentation]);
  useLayoutEffect(() => {
    const content = contentRef.current;
    const scroll = content?.parentElement;
    if (!scroll || !content) return;
    scrollRef.current = scroll as HTMLDivElement;
    const previousAnchor = scroll.style.overflowAnchor;
    // Browser anchoring must not compete with the source-line restoration.
    scroll.style.overflowAnchor = 'none';
    const onScroll = () => {
      // Layout can clamp scrollTop while patches are temporarily loading.
      // Let the content resize restore it; real input still cancels immediately.
      if (scroll.scrollHeight === restoredHeight.current
        && Math.abs(scroll.scrollTop - restoredTop.current) >= 1) anchor.current = null;
    };
    const onKey = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) cancel();
    };
    scroll.addEventListener('scroll', onScroll);
    scroll.addEventListener('wheel', cancel, { passive: true });
    scroll.addEventListener('touchstart', cancel, { passive: true });
    scroll.addEventListener('pointerdown', cancel);
    scroll.addEventListener('keydown', onKey);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(restore);
    observer?.observe(content);
    return () => {
      observer?.disconnect();
      scroll.style.overflowAnchor = previousAnchor;
      scrollRef.current = null;
      scroll.removeEventListener('scroll', onScroll);
      scroll.removeEventListener('wheel', cancel);
      scroll.removeEventListener('touchstart', cancel);
      scroll.removeEventListener('pointerdown', cancel);
      scroll.removeEventListener('keydown', onKey);
    };
  }, [cancel, restore]);
  return { contentRef, capture, select, cancel };
}
