'use client';
import { useCallback, useEffect } from 'react';
import type { MobileSearchTarget } from './MobileSearchSheet';
export function useMobileSearchNavigation(setActiveView: (view: 'chat' | 'orchestrator' | 'activity') => void, setCurrentTabId: (id: string | null) => void) {
  const select = useCallback((target: MobileSearchTarget) => {
    if (target.category === 'chat') { setActiveView('chat'); setCurrentTabId(target.id); return; }
    if (target.category === 'thread') {
      // The existing conversation view reads this exact ID on mount, including archived history.
      try { window.localStorage.setItem('o8:mobile:orchestrator-active-thread', target.id); } catch { /* Keep navigation usable if storage is unavailable. */ }
      setActiveView('orchestrator'); return;
    }
    if (target.category === 'activity') setActiveView('activity');
  }, [setActiveView, setCurrentTabId]);
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: string; title?: string }>).detail;
      if (detail?.threadId && /^thoughts-[A-Za-z0-9_-]{1,120}$/.test(detail.threadId)) select({ category: 'thread', id: detail.threadId, title: detail.title ?? detail.threadId });
    };
    window.addEventListener('o8:open-pr-conversation', open);
    return () => window.removeEventListener('o8:open-pr-conversation', open);
  }, [select]);
  return select;
}
