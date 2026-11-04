// @vitest-environment jsdom
import { createServer, type Server } from 'node:http';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MobileApprovalsClient } from '@/app/mobile/mobile-approvals-client';
import IssuesPage from '@/components/mobile/IssuesPage';
import { getMobileGithubContext } from '@/lib/mobile/github-cache';

vi.mock('@/components/mobile/ThemeContext', () => ({ useTheme: () => ({ colors: {} }), ThemeProvider: ({ children }: { children: ReactNode }) => children }));
let server: Server;
let root: Root;
let host: HTMLDivElement;
let calls: Array<{ path: string; method: string; body: Record<string, unknown> }>;
let decision: string | null;
let refuse: boolean;
const nativeFetch = globalThis.fetch;
const head = 'a'.repeat(40);
const snapshot = 'b'.repeat(64);

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear(); sessionStorage.clear();
  getMobileGithubContext().client.clear();
  calls = []; decision = null; refuse = false;
  server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url!, method: req.method!, body: raw ? JSON.parse(raw) : {} });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') {
      res.statusCode = refuse ? 409 : 200;
      res.end(JSON.stringify(refuse ? { error: 'Merge gates changed. Refresh before confirming again.' } : { ok: true }));
    } else if (req.url?.startsWith('/api/panel/prs/7?')) {
      res.end(JSON.stringify({ pr: { number: 7, title: 'Review the mobile change', state: 'open', headSha: head,
        changedFiles: 3, mergeable: true, reviewDecision: decision, allowedMergeMethods: ['squash'],
        statusCheckRollup: [{ name: 'unit', status: 'completed', conclusion: 'success' }],
        mergeGate: { allowed: true, snapshot, checks: [] } } }));
    } else if (req.url?.startsWith('/api/panel/prs?')) {
      res.end(JSON.stringify({ repo: 'example/project', prs: [{ number: 7, title: 'Review the mobile change', state: 'OPEN' },
        { number: 8, title: 'Already closed', state: 'CLOSED' }] }));
    } else res.end(JSON.stringify({ repos: [{ id: 'project', name: 'Project', localPath: '/workspace/project' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => nativeFetch(new URL(String(input), `http://127.0.0.1:${port}`), init));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  getMobileGithubContext().client.clear(); vi.unstubAllGlobals();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)); }); }
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === label);
  expect(button, label).toBeTruthy();
  await act(async () => button!.click()); await settle();
}
async function open() {
  await act(async () => root.render(createElement(IssuesPage, { ...{ activeRepoPath: '/workspace/project' }, onBack() {} })));
  await settle();
  expect(calls.some(call => call.path.includes('repoPath=%2Fworkspace%2Fproject'))).toBe(true);
  expect(host.textContent).not.toContain('Already closed');
  await click('#7 Review the mobile change');
  expect(host.textContent).toContain('3 files changed');
  expect(host.textContent).toContain('1 passed');
  expect(host.textContent).toContain('Mergeable');
}
it('opens active-project PR detail through the panel and requires a second tap without approval', async () => {
  await open();
  await click('Merge');
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);
  expect(host.textContent).toContain('No reviewer approval');
  await click('Confirm merge without approval');
  const writes = calls.filter(call => call.method === 'POST');
  expect(writes).toEqual([{ path: '/api/panel/prs/7', method: 'POST', body: {
    action: 'merge', repo: 'example/project', commitSha: head, mergeMethod: 'squash', expectedMergeGate: snapshot,
  } }]);
  expect(host.textContent).toContain('Merged');
});
it('merges an approved PR and surfaces a refusal from the existing server gate', async () => {
  decision = 'APPROVED'; refuse = true;
  await open(); await click('Merge');
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
  expect(host.textContent).toContain('Merge gates changed');
});
it('does not query a fallback repository when no project is active', async () => {
  await act(async () => root.render(createElement(IssuesPage, { ...{ activeRepoPath: null }, onBack() {} })));
  await settle();
  expect(calls).toEqual([]);
  expect(host.textContent).toContain('Select a project');
});

it('clears the second-tap confirmation on refresh and project changes', async () => {
  await open(); await click('Merge'); await click('Cancel');
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);
  await click('Merge'); await click('Refresh');
  expect(host.textContent).not.toContain('Confirm merge without approval');
  await click('Merge');
  await act(async () => root.render(createElement(IssuesPage, { activeRepoPath: '/workspace/other-project', onBack() {} })));
  await settle();
  expect(host.textContent).not.toContain('Confirm merge without approval');
  expect(calls.some(call => call.path.includes('repoPath=%2Fworkspace%2Fother-project'))).toBe(true);
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);
});

it('reaches active-project PRs from the client mounted by the mobile page', async () => {
  localStorage.setItem('mobile-selected-repo', '/workspace/project');
  await act(async () => root.render(createElement(MobileApprovalsClient, {
    initialApprovals: [], appVersion: 'test', initialView: 'issues',
  })));
  await settle();
  expect(calls.some(call => call.path.includes('repoPath=%2Fworkspace%2Fproject'))).toBe(true);
  await click('#7 Review the mobile change');
  expect(host.textContent).toContain('3 files changed');
});
