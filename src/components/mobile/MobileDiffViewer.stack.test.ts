// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { MobileDiffViewer } from './MobileDiffViewer';
vi.mock('./ThemeContext', () => ({ useTheme: () => ({ colors: { bg: '#f5f3ef', frostStrong: '#fff', text: '#111', textSecondary: '#555', textTertiary: '#777' } }) }));
it('navigates native stack layers inside the live mobile diff sheet', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const stack = { status: 'ready', stale: false, source: 'github-native', revision: 'revision', fetchedAt: '2026-01-01T00:00:00Z', attemptedAt: '2026-01-01T00:00:00Z',
    snapshot: { id: 70, number: 7, trunk: 'main', layers: [11, 12, 13].map((number, index) => ({ number, title: `Layer ${number}`, state: 'open', headRef: `layer-${number}`, baseRef: index ? `layer-${number - 1}` : 'main', headSha: String(index + 1).repeat(40), baseSha: String(index).repeat(40) })) } };
  const observed = { ...stack, history: ['a', 'b', 'a'].map(revision => ({ revision, source: 'github-native', trigger: 'target', snapshot: stack.snapshot, fetchedAt: stack.fetchedAt })) };
  const errors = vi.spyOn(console, 'error');
  const fetcher = vi.fn(async (url: string, _options?: RequestInit) => {
    if (url.startsWith('/api/mobile/conversation-pr-context?')) return Response.json({ ok: true, result: { links: [], nextCursor: null } });
    const number = Number(url.match(/prs\/(\d+)/)?.[1]);
    return Response.json({ pr: { stack: observed, files: [{ path: `layer-${number}.ts`, patch: '@@ -1 +1 @@\n-old\n+new' }], additions: 1, deletions: 1 } });
  });
  vi.stubGlobal('fetch', fetcher);
  try {
    await act(async () => root.render(createElement(MobileDiffViewer, { open: true, onClose: () => {}, source: { kind: 'pr', repo: 'example/repo', number: 11 }, title: 'PR #11' })));
    expect(host.textContent).toContain('Native GitHub stack #7');
    for (const number of [12, 13, 11]) {
      await act(async () => host.querySelector<HTMLButtonElement>(`[data-stack-layer="${number}"]`)!.click());
      expect(host.textContent).toContain(`layer-${number}.ts`);
      expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toContain(`PR #${number}`);
      await act(async () => root.render(createElement(MobileDiffViewer, { open: true, onClose: () => {}, source: { kind: 'pr', repo: 'example/repo', number: 11 }, title: 'PR #11', subtitle: 'example/repo #11' })));
      expect(host.querySelector(`[data-stack-layer="${number}"]`)?.getAttribute('aria-current')).toBe('true');
      expect(host.querySelector(`a[href="https://github.com/example/repo/pull/${number}"]`)).not.toBeNull();
    }
    expect(errors.mock.calls.some(call => String(call[0]).includes('same key'))).toBe(false);
    expect(fetcher.mock.calls.every(([url, options]) => (!options?.method || options.method === 'GET')
      && (url.startsWith('/api/panel/prs/') || url.startsWith('/api/mobile/conversation-pr-context?')))).toBe(true);
    const conversations = fetcher.mock.calls.filter(([url]) => url.startsWith('/api/mobile/conversation-pr-context?'));
    expect(new Set(conversations.map(([url]) => new URL(url, 'http://fixture.invalid').searchParams.get('number')))).toEqual(new Set(['11', '12', '13']));
  } finally { await act(async () => root.unmount()); host.remove(); errors.mockRestore(); vi.unstubAllGlobals(); }
});
