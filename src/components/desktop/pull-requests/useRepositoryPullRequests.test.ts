// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { useRepositoryPullRequests } from './useRepositoryPullRequests';

it('keeps the typed organization coverage message through the PR list observer', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'github_org_not_covered', error: "GitHub sign-in doesn't cover organization repos yet", prs: [] }, { status: 422 })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  function List() {
    const query = useRepositoryPullRequests('/fixture/repo', 'open', 'updated', true);
    return createElement('div', null, query.error);
  }
  try {
    await act(async () => { root.render(createElement(QueryClientProvider, { client }, createElement(List))); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(host.textContent).toBe("GitHub sign-in doesn't cover organization repos yet");
  } finally {
    await act(async () => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals();
  }
});
