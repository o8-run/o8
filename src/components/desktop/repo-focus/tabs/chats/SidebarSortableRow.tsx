'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { trackThreadDrag } from '@/lib/workspace-terminal/thread-drag';
import { historySection } from './helpers';
import type { ChatHistoryItem } from './types';
import type { SidebarInsertion } from './use-sidebar-manual-order';

/** Sorting and pane drops share one pointer gesture, resolved at release. */
export function SidebarSortableRow({ item, insertion, onMove, siblings, children }: {
  item: ChatHistoryItem; insertion: SidebarInsertion | null;
  onMove: (from: string, to: SidebarInsertion) => void;
  siblings: ChatHistoryItem[]; children: ReactNode;
}) {
  const consumed = useRef(false);
  const dispose = useRef<(() => void) | null>(null);
  useEffect(() => () => dispose.current?.(), []);
  const marker = insertion?.id === item.tabId ? insertion : null;
  return <div data-sidebar-chat-id={item.tabId} style={{ position: 'relative', minWidth: 0 }}
    onPointerDownCapture={event => {
      if (event.button !== 0 || !event.isPrimary) return;
      const control = (event.target as Element).closest('button,input,textarea,select,a');
      if (control && control !== event.currentTarget.firstElementChild) { event.stopPropagation(); return; }
      event.stopPropagation(); consumed.current = false; dispose.current?.();
      // Clear an old mouse drag, then leave fingers to native scrolling.
      if (event.pointerType === 'touch') return;
      dispose.current = trackThreadDrag(event, { threadId: item.tabId, title: item.title,
        mode: historySection(item) === 'orchestrator' ? 'orchestrator' : 'chat', repoPath: item.repoPath,
        sidebarItemId: item.tabId, navigationOnly: item.tabId.startsWith('sidebar-agent:') },
      { source: event.currentTarget, onActivate: () => { consumed.current = true; } });
    }}
    onClickCapture={event => {
      if (!consumed.current || event.detail === 0) return;
      event.preventDefault(); event.stopPropagation(); consumed.current = false;
    }}
    onKeyDownCapture={event => {
      if (!event.altKey || !event.shiftKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      const peers = siblings.filter(peer => Boolean(peer.pinned) === Boolean(item.pinned));
      const target = peers[peers.findIndex(peer => peer.tabId === item.tabId) + (event.key === 'ArrowDown' ? 1 : -1)];
      if (!target) return;
      event.preventDefault(); event.stopPropagation(); onMove(item.tabId, { id: target.tabId, after: event.key === 'ArrowDown' });
      requestAnimationFrame(() => {
        const row = [...document.querySelectorAll<HTMLElement>('[data-sidebar-chat-id]')]
          .find(node => node.dataset.sidebarChatId === item.tabId);
        row?.querySelector<HTMLElement>('[tabindex],button')?.focus({ preventScroll: true });
      });
    }}>
    {children}
    {marker ? <div aria-hidden data-sidebar-insertion={marker.after ? 'after' : 'before'} style={{ position: 'absolute',
      left: 12, right: 12, top: marker.after ? undefined : 0, bottom: marker.after ? 0 : undefined,
      height: 1, background: 'var(--t-accent)', pointerEvents: 'none', zIndex: 2 }} /> : null}
  </div>;
}
