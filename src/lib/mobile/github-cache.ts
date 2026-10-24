'use client';
import { useSyncExternalStore } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { getMobileWsToken } from './ws-token-client';

interface MobileGithubContext {
  client: QueryClient; headers: Record<string, string>; epoch: number;
  beforeRead: () => void;
}
let current: { credential: string; context: MobileGithubContext } | undefined;
let epoch = 0;
const listeners = new Set<() => void>();
/** Separate principal caches. A dispatch guard also closes the gap between storage notifications. */
export function getMobileGithubContext(): MobileGithubContext {
  const credential = getMobileWsToken();
  if (!current || current.credential !== credential) {
    const previous = current;
    const context: MobileGithubContext = {
      client: new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }),
      headers: credential ? { Authorization: `Bearer ${credential}` } : {}, epoch: ++epoch,
      beforeRead: () => {
        if (getMobileGithubContext() !== context) throw new Error('Mobile credential changed.');
      },
    };
    current = { credential, context };
    if (previous) {
      // Clear private rows and abort the old principal's reads before publishing the new epoch.
      previous.context.client.clear();
      queueMicrotask(() => listeners.forEach(listener => listener()));
    }
  }
  return current.context;
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const check = () => { getMobileGithubContext(); };
  window.addEventListener('storage', check);
  window.addEventListener('hashchange', check);
  document.addEventListener('visibilitychange', check);
  // Same-window localStorage writes have no storage event. This only reads local credentials.
  const timer = window.setInterval(check, 1000);
  return () => {
    listeners.delete(listener); window.clearInterval(timer);
    window.removeEventListener('storage', check); window.removeEventListener('hashchange', check);
    document.removeEventListener('visibilitychange', check);
  };
}
export function useMobileGithubContext(): MobileGithubContext {
  return useSyncExternalStore(subscribe, getMobileGithubContext, getMobileGithubContext);
}
