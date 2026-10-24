// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalResidentPanel } from './WorkspaceTerminalPanels';
import type { TerminalApprovalAdapter } from '@/lib/terminal-status/approval-adapter';

vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ workspaceGlass: false }) }));
vi.mock('@/components/desktop/hooks/DesktopWebSocketContext', () => ({ useWsConnectionEpoch: () => 0 }));
vi.mock('./WorkspaceChatPane', () => ({ WorkspaceChatPane: () => null }));
vi.mock('./XtermPanel', () => ({ XtermPanel: () => createElement('textarea', { 'aria-label': 'Raw terminal', defaultValue: 'unchanged PTY bytes' }) }));

const adapter: TerminalApprovalAdapter = {
  version: 1, authority: 'lane-state', runtime: 'codex', sessionKey: 'codex-owned:one',
  terminalSession: 'terminal-one', laneId: 'lane-one', approvalId: 'approval-one', approvalUpdatedAt: 1, approvalRevision: 'approval-revision',
  revision: 'revision-one', subjectRevision: 'subject-one', sessionRevision: 'session-one', laneRevision: 'lane-revision', headSha: 'a'.repeat(40),
  runId: 'run-one', title: 'Resume lane', summary: 'Continue after checkpoint',
};
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root?.unmount()); container?.remove(); vi.unstubAllGlobals(); });
const noop = () => {};
function props(): ComponentProps<typeof TerminalResidentPanel> {
  return { tabId: 'one', tmuxSession: 'terminal-one', active: true, panelRefs: { current: new Map() },
    sendTerminalAttach: noop, sendTerminalDetach: noop, sendTerminalInput: noop, sendTerminalResize: noop,
    sendTerminalVisibility: noop, statusEvidence: { sessionId: adapter.sessionKey, runtime: 'codex', state: 'blocked',
      authority: 'lane-state', observedAt: '2026-10-24T00:00:00Z', summary: 'Approval required', evidence: [] } };
}
async function render(p = props()) {
  if (!root) { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); }
  await act(async () => root!.render(createElement(TerminalResidentPanel, p)));
}
function button(label: string) {
  const found = Array.from(container.querySelectorAll('button')).find(b => b.textContent === label);
  expect(found, label).toBeDefined();
  return found!;
}

it('resolves the displayed approval through the shared route and keeps the raw terminal mounted', async () => {
  let finish: ((r: Response) => void) | undefined;
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => init?.method === 'POST'
    ? new Promise<Response>(r => { finish = r; }) : Response.json({ terminalAdapter: adapter }));
  vi.stubGlobal('fetch', fetcher);
  await render();
  const raw = container.querySelector('textarea')!;
  await act(async () => button('Show raw terminal').click());
  expect(container.querySelector('textarea')).toBe(raw);
  expect(container.textContent).not.toContain(adapter.summary);
  await act(async () => button('Show lane decision').click());
  await act(async () => button('Resume lane').click());
  expect(button('Resuming lane…').disabled).toBe(true);
  const post = fetcher.mock.calls.find(call => call[1]?.method === 'POST')!;
  expect(JSON.parse(String(post[1]?.body))).toMatchObject({ action: 'approve', id: adapter.approvalId, terminalAdapter: adapter });
  await act(async () => finish!(Response.json({ ok: true, note: 'Resumed the reviewed session' })));
  expect(container.querySelector('textarea')).toBe(raw);
  expect(raw.value).toBe('unchanged PTY bytes');
});

it.each(['unknown version', 'wrong session', 'malformed', 'unsupported evidence', 'read-only'])('keeps %s raw without active controls', async condition => {
  root = undefined;
  const value = condition === 'unknown version' ? { ...adapter, version: 99 }
    : condition === 'wrong session' ? { ...adapter, sessionKey: 'codex-owned:other' }
      : condition === 'malformed' ? { ...adapter, runId: null } : adapter;
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ terminalAdapter: value })));
  const p = props();
  if (condition === 'unsupported evidence') p.statusEvidence!.authority = 'raw-terminal';
  if (condition === 'read-only') p.readOnly = true;
  await render(p);
  expect(container.querySelector('textarea')).not.toBeNull();
  expect(container.textContent).not.toContain(adapter.summary);
  expect(Array.from(container.querySelectorAll('button')).some(b => b.textContent === 'Resume lane')).toBe(false);
});

it('invalidates controls immediately when the displayed session changes, including an abandoned read', async () => {
  root = undefined;
  let finish: ((r: Response) => void) | undefined;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(r => { finish = r; })));
  await render();
  const raw = container.querySelector('textarea');
  const p = props();
  p.statusEvidence = { ...p.statusEvidence!, sessionId: 'codex-owned:replacement' };
  await render(p);
  await act(async () => finish!(Response.json({ terminalAdapter: adapter })));
  expect(container.textContent).not.toContain(adapter.summary);
  expect(container.querySelector('textarea')).toBe(raw);
});

it('releases old busy state after hiding and returning while a decision is pending', async () => {
  root = undefined;
  let finish: ((r: Response) => void) | undefined;
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => init?.method === 'POST'
    ? new Promise<Response>(r => { finish = r; }) : Response.json({ terminalAdapter: adapter })));
  await render();
  await act(async () => button('Resume lane').click());
  await render({ ...props(), active: false });
  await render();
  await act(async () => finish!(Response.json({ ok: false, error: 'changed' }, { status: 409 })));
  expect(button('Resume lane').disabled).toBe(false);
});
