/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkerDisclosureProvider } from './WorkerDisclosure';
import { ThreadWorkerCard } from './ThreadWorkerCard';
import { WorkerCorrections } from './WorkerCorrections';

vi.mock('@/components/desktop/hooks/DesktopWebSocketContext', () => ({ useSharedDesktopWs: vi.fn() }));
const worker = { surfaceId: 'codex-owned:one', runId: 'run-one', runtime: 'codex', taskName: 'Inspect code', running: true };
let host: HTMLDivElement; let root: Root;
const delivered = vi.fn();
const calls: Array<Record<string, unknown>> = [];
let response: (body: Record<string, unknown>) => Promise<unknown>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  localStorage.clear(); calls.length = 0; delivered.mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init?.method === 'POST') { const body = JSON.parse(init.body); calls.push(body); return response(body); }
    return { ok: true, json: async () => ({ workers: [worker], corrections: [] }) };
  }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render(draft = 'Use the existing worker.', threadId = 'thoughts-one') {
  await act(async () => root.render(createElement(WorkerCorrections, { repoPath: '/repo', threadId, draft,
    hasAttachments: false, working: false, onDelivered: delivered })));
}
function button(text: string) {
  const found = [...document.body.querySelectorAll('button')].find(item => (item.getAttribute('aria-label') ?? item.textContent)?.includes(text));
  expect(found, text).toBeTruthy(); return found!;
}
async function choose() {
  await act(async () => button('Correct workers').click());
  await act(async () => document.body.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
}
function accepted(body: Record<string, unknown>) {
  return { ok: true, json: async () => ({ receipt: { ...body, deliveries: [{ ...worker, status: 'delivered', note: 'Accepted, not acknowledged.' }] } }) };
}

it('reconciles an uncertain request after reload with its original identity and payload', async () => {
  response = async () => { throw new Error('Connection lost'); };
  await render(); await choose();
  await act(async () => button('Pause and correct selected').click());
  expect(calls).toHaveLength(1); expect(delivered).not.toHaveBeenCalled();
  await act(async () => root.unmount()); root = createRoot(host);
  response = async body => accepted(body);
  await render('A newer draft.');
  await act(async () => button('Correct workers').click());
  await act(async () => button('Check pending correction').click());
  expect(calls[1]).toEqual(calls[0]);
  expect(delivered).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
});

it('releases a confirmed pre-admission rejection so a changed selection is usable', async () => {
  response = async () => ({ ok: false, json: async () => ({ error: 'Worker changed.', notAdmitted: true }) });
  await render(); await choose();
  await act(async () => button('Pause and correct selected').click());
  expect(document.body.textContent).toContain('Worker changed.'); expect(localStorage.length).toBe(0);
  response = async body => accepted(body);
  await render('Correct the new turn.');
  await act(async () => button('Pause and correct selected').click());
  expect(calls[1].id).not.toBe(calls[0].id);
  expect(calls[1].payload).toMatchObject({ message: 'Correct the new turn.' });
  expect(delivered).toHaveBeenCalledWith('Correct the new turn.');
});

it('preserves a draft edited while runtime delivery is still pending', async () => {
  let finish!: () => void;
  response = async body => { await new Promise<void>(resolve => { finish = resolve; }); return accepted(body); };
  await render(); await choose();
  await act(async () => button('Pause and correct selected').click());
  expect(document.body.querySelector('progress')).toBeNull();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)); });
  expect(document.body.querySelector('progress')).not.toBeNull();
  await render('Keep this newer message.');
  await act(async () => finish());
  expect(delivered).not.toHaveBeenCalled();
});

it('keeps the composer usable when the worker endpoint returns an unexpected response', async () => {
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
  await render();
  await act(async () => button('Correct workers').click());
  expect(document.body.querySelector('[role=alert]')?.textContent).toContain('invalid response');
  expect(calls).toHaveLength(0);
});

it('does not carry an in-flight correction lock into another conversation', async () => {
  let finish!: () => void;
  response = async body => { await new Promise<void>(resolve => { finish = resolve; }); return accepted(body); };
  await render(); await choose();
  await act(async () => button('Pause and correct selected').click());
  await render('The other conversation.', 'thoughts-two'); await choose();
  expect(button('Pause and correct selected').disabled).toBe(false);
  await act(async () => finish());
  expect(delivered).not.toHaveBeenCalled();
  expect(button('Pause and correct selected').disabled).toBe(false);
});

it('keeps delivery details behind View activity instead of presenting them as current status', async () => {
  const receipt = { id: 'older', payload: { message: 'Old correction text', targets: [], mode: 'send' },
    deliveries: [{ surfaceId: worker.surfaceId, status: 'delivered', note: 'Transport accepted, acknowledgment unknown.' }] };
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ workers: [worker], corrections: [receipt] }) } as Response);
  await render();
  await act(async () => button('Worker corrections').click());
  expect(document.body.textContent).not.toContain('Old correction text');
  expect(document.body.textContent).not.toContain('acknowledgment unknown');
  await act(async () => button('View activity').click());
  expect(document.body.textContent).toContain('Old correction text');
  expect(document.body.textContent).toContain('Inspect code');
  expect(document.body.textContent).toContain('acknowledgment unknown');
});

it('uses the existing worker card with separate selection and pane navigation', async () => {
  const focus = vi.fn();
  window.addEventListener('o8:focus-spawned-agent-lane', focus);
  try {
    await render(); await choose();
    expect(document.body.querySelector('[aria-label="Subagents: 1"]')).not.toBeNull();
    expect(calls).toHaveLength(0);
    await act(async () => button('Inspect code').click());
    expect(focus).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(0);
  } finally { window.removeEventListener('o8:focus-spawned-agent-lane', focus); }
});

it('retains stopped worker names and navigation without enabling correction authority', async () => {
  const focus = vi.fn();
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ workers: [], corrections: [{ id: 'stop',
    payload: { message: 'Stop selected.', mode: 'stop', targets: [] }, deliveries: [{ surfaceId: worker.surfaceId, status: 'stopped', note: 'Worker stopped.' }] }] }) } as Response);
  await act(async () => root.render(createElement(WorkerCorrections, { repoPath: '/repo', threadId: 'thoughts-one', draft: 'Keep my draft.',
    hasAttachments: false, working: false, onDelivered: delivered, workerContext: { packets: [],
      sessions: [{ sessionKey: worker.surfaceId, name: 'Inspect code', runtime: 'codex', status: 'interrupted' }], onFocusSession: focus } })));
  await act(async () => button('Worker corrections').click());
  expect(document.body.textContent).toContain('Interrupted');
  expect(document.body.textContent).not.toContain(worker.surfaceId);
  expect(document.body.querySelector('input[type=checkbox]')).toBeNull();
  await act(async () => button('Inspect code').click());
  expect(focus).toHaveBeenCalledWith(worker.surfaceId);
  await act(async () => button('View activity').click());
  expect(document.body.textContent).toContain('Inspect code · Stopped');
  expect(calls).toHaveLength(0); expect(delivered).not.toHaveBeenCalled();
});

it.each(['interrupted', 'completed', 'retired', 'failed'])('keeps %s consistent between the composer and turn card when correction discovery is idle', async status => {
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ workers: [{ ...worker, running: false }], corrections: [] }) } as Response);
  const sessions = [{ sessionKey: worker.surfaceId, name: worker.taskName, runtime: worker.runtime, status }];
  await act(async () => root.render(createElement(WorkerDisclosureProvider, null,
    createElement(WorkerCorrections, { key: 'composer', repoPath: '/repo', threadId: 'thoughts-one', draft: '',
      hasAttachments: false, working: false, onDelivered: delivered, workerContext: { sessions } }),
    createElement(ThreadWorkerCard, { key: 'turn', group: { sessions, packets: [], scouts: [] } }),
  )));
  await act(async () => button('Correct workers').click());
  const label = status[0].toUpperCase() + status.slice(1);
  expect(button(worker.taskName).textContent).toContain(label);
  expect(document.body.textContent).not.toContain('Idle');
});

it('opens on keyboard focus, closes with Escape, and restores trigger focus without a mutation', async () => {
  await render();
  const trigger = button('Correct workers');
  await act(async () => trigger.focus());
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  const close = button('Close worker controls');
  expect(host.contains(close)).toBe(false);
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(close);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  await act(async () => close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(trigger);
  await act(async () => { close.focus(); close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger);
  expect(calls).toHaveLength(0);
});

it('previews on hover, pins on click, and dismisses outside without clearing the draft', async () => {
  await render();
  const dock = document.body.querySelector('[data-worker-correction-dock]')!;
  const trigger = button('Correct workers');
  await act(async () => dock.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  await act(async () => dock.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })));
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  await act(async () => trigger.click());
  await act(async () => dock.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })));
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(calls).toHaveLength(0); expect(delivered).not.toHaveBeenCalled();
});

it('hands off the expanded surface between transcript and composer without removing history', async () => {
  const group = { packets: [], scouts: [], sessions: [{ sessionKey: worker.surfaceId, name: worker.taskName, runtime: 'codex', status: 'running' }] };
  await act(async () => root.render(createElement(WorkerDisclosureProvider, null, createElement('div', {},
    createElement(ThreadWorkerCard, { group }),
    createElement(WorkerCorrections, { repoPath: '/repo', threadId: 'thoughts-one', draft: 'A correction', hasAttachments: false,
      working: false, onDelivered: delivered, workerContext: group }),
  ))));
  const transcript = document.body.querySelector<HTMLButtonElement>('[aria-label="Subagents: 1"] > button')!;
  await act(async () => transcript.click());
  expect(transcript.getAttribute('aria-expanded')).toBe('true');
  await act(async () => button('Correct workers').click());
  expect(transcript.getAttribute('aria-expanded')).toBe('false');
  expect(button('Correct workers').getAttribute('aria-expanded')).toBe('true');
  expect(transcript.isConnected).toBe(true);
  await act(async () => transcript.click());
  expect(button('Correct workers').getAttribute('aria-expanded')).toBe('false');
  expect(transcript.getAttribute('aria-expanded')).toBe('true');
  expect(calls).toHaveLength(0); expect(delivered).not.toHaveBeenCalled();
});

it('shows the membership count on the transparent composer trigger', async () => {
  await render();
  const trigger = button('Correct workers');
  expect(trigger.textContent).toBe('1');
  expect(trigger.getAttribute('aria-label')).toContain('1 running');
  expect(trigger.style.background).toBe('transparent');
  expect(trigger.style.width).toBe('44px');
  await act(async () => trigger.click());
  expect(trigger.style.background).toBe('transparent');
  expect(trigger.style.color).toBe('var(--t-accent)');
  expect(trigger.hasAttribute('title')).toBe(false);
});

it('keeps recovery actions on the real composer card when the interrupted worker is no longer correctable', async () => {
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ workers: [], corrections: [] }) } as Response);
  await act(async () => root.render(createElement(WorkerCorrections, { repoPath: '/repo', threadId: 'thoughts-one', draft: '',
    hasAttachments: false, working: false, onDelivered: delivered, workerContext: { packets: [], sessions: [{
      sessionKey: worker.surfaceId, name: worker.taskName, runtime: 'codex', status: 'interrupted', recovery: {
        actions: ['resume', 'retire'], worktreePath: '/checkout', branch: 'worker/saved', runId: 'old-run', retired: false,
      },
    }] } })));
  await act(async () => button('Correct workers').click());
  expect(button('Resume').disabled).toBe(false);
  expect(button('Retire').disabled).toBe(false);
  expect(document.body.textContent).toContain('Edits preserved on worker/saved at /checkout');
  expect(document.body.querySelector('input[type=checkbox]')).toBeNull();
  expect(calls).toHaveLength(0);
});

it('keeps the total stable as a crew settles and preserves native workers without granting controls', async () => {
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ workers: [], corrections: [] }) } as Response);
  const sessions = Array.from({ length: 6 }, (_, index) => ({ sessionKey: `codex-owned:${index}`, name: `Task ${index}`, runtime: 'codex', status: 'running' }));
  const props = { repoPath: '/repo', threadId: 'thoughts-one', draft: 'Keep this draft', hasAttachments: false, working: false, onDelivered: delivered };
  await act(async () => root.render(createElement(WorkerCorrections, { ...props, workerContext: { packets: [], sessions,
    scouts: [{ id: 'native-one', label: 'Native research', status: 'failed' }] } })));
  const trigger = button('Correct workers');
  expect(trigger.textContent).toBe('7');
  expect(trigger.getAttribute('aria-label')).toContain('6 running');
  expect(trigger.getAttribute('aria-label')).toContain('1 failed');
  await act(async () => trigger.click());
  expect(document.body.querySelector('[aria-label="Subagents: 7"]')).not.toBeNull();
  expect(document.body.textContent).toContain('Native research');
  expect(document.body.querySelector('input[type=checkbox]')).toBeNull();
  await act(async () => root.render(createElement(WorkerCorrections, { ...props, workerContext: { packets: [],
    sessions: sessions.map(session => ({ ...session, status: 'completed' })), scouts: [{ id: 'native-one', label: 'Native research', status: 'unknown' }] } })));
  expect(trigger.textContent).toBe('7');
  expect(trigger.getAttribute('aria-label')).toContain('6 completed');
  expect(trigger.getAttribute('aria-label')).toContain('1 unconfirmed');
  expect(trigger.getAttribute('aria-label')).not.toContain('running');
  expect(calls).toHaveLength(0); expect(delivered).not.toHaveBeenCalled();
});

it('omits the dock for an empty chat and reveals it when worker membership arrives', async () => {
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ workers: [], corrections: [] }) } as Response);
  await render();
  expect(document.body.querySelector('[data-worker-correction-dock]')).toBeNull();
  const props = { repoPath: '/repo', threadId: 'thoughts-one', draft: 'Keep my message', hasAttachments: false, working: false,
    onDelivered: delivered, workerContext: { packets: [], sessions: [{ sessionKey: worker.surfaceId, name: worker.taskName, runtime: 'codex', status: 'running' }] } };
  await act(async () => root.render(createElement(WorkerCorrections, props)));
  expect(button('Correct workers')).toBeTruthy();
  expect(calls).toHaveLength(0); expect(delivered).not.toHaveBeenCalled();
});
