'use client';
import { useEffect, useState } from 'react';
import { ipcFetch } from '@/lib/tauri/ipc-fetch';
import type { PullRequestContextLink } from '@/lib/orchestrator/pull-request-context';
export const CONVERSATION_PR_CHANGED = 'o8:conversation-prs-changed';
export async function contextRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await ipcFetch(url, { cache: 'no-store', ...init });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error?.message ?? 'Conversation PR links are unavailable.');
  return body.result as T;
}
export function useConversationPrs(endpoint: string, query: string, active = true) {
  const key = `${endpoint}?${query}`;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ key: string; links: PullRequestContextLink[]; error: string | null; loading: boolean }>({ key: '', links: [], error: null, loading: true });
  useEffect(() => {
    const changed = () => setRevision(value => value + 1);
    window.addEventListener(CONVERSATION_PR_CHANGED, changed);
    return () => window.removeEventListener(CONVERSATION_PR_CHANGED, changed);
  }, []);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void (async () => {
      const links: PullRequestContextLink[] = [];
      let cursor: number | null = null;
      try {
        do {
          const page: { links: PullRequestContextLink[]; nextCursor: number | null } = await contextRequest(`${key}&limit=200${cursor === null ? '' : `&after=${cursor}`}`, { signal: controller.signal });
          links.push(...page.links);
          if (page.nextCursor !== null && page.nextCursor <= (cursor ?? 0)) throw new Error('Invalid PR link cursor.');
          cursor = page.nextCursor;
        } while (cursor !== null);
        if (!controller.signal.aborted) setState({ key, links, error: null, loading: false });
      } catch (error) {
        if (!controller.signal.aborted) setState({ key, links: [], error: error instanceof Error ? error.message : 'PR links unavailable.', loading: false });
      }
    })();
    return () => controller.abort();
  }, [key, active, revision]);
  return state.key === key ? state : { links: [], error: null, loading: true };
}
