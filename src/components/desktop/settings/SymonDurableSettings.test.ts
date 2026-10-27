// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SymonTextBrainSection } from './SymonTextBrainSection';
import { SymonMessagesReceiverSection } from './SymonMessagesReceiverSection';
import { SymonConversationsSection } from './SymonConversationsSection';
import { SymonIMessageAccessSection } from './SymonIMessageAccessSection';
vi.mock('./PairedDevicesSection', () => ({ PairedDevicesSection: () => null }));
import { ConnectionsTab } from './ConnectionsTab';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  delete (window as unknown as { __O8_HOST_PLATFORM__?: string }).__O8_HOST_PLATFORM__;
});

async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent === label);
  expect(button, `Missing button: ${label}`).toBeDefined();
  await act(async () => { button!.click(); });
}

async function changeSenders(value: string) {
  const field = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('reads text mode without writes and saves only the explicit mode, without credentials', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => Response.json({ ok: true, mode: init?.method === 'POST' ? 'pi' : 'planner' }));
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => { root.render(createElement(SymonTextBrainSection)); });
  const select = container.querySelector('select')!;
  expect(select.value).toBe('planner');
  expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0);
  expect(container.textContent).toContain('o8 managed');
  expect(container.querySelector('input[type="password"]')).toBeNull();
  await act(async () => { select.value = 'pi'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(select.value).toBe('pi');
  expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ mode: 'pi' });
  expect(fetchMock.mock.calls.every((call) => String(call[0]) === '/api/panel/symon/text-brain')).toBe(true);
});

it('requires receiver confirmation, preserves off on cancel, and sends only authorized handles', async () => {
  const notify = vi.fn();
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const posted = init?.method === 'POST' ? JSON.parse(String(init.body)) as { enabled: boolean; handles: string[] } : null;
    return Response.json({ ok: true, enabled: posted?.enabled ?? false, handles: posted?.handles ?? [], state: posted?.enabled ? 'missing_permission' : 'off' });
  });
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => { root.render(createElement(SymonMessagesReceiverSection, { onEnabledChange: notify })); });
  expect(notify).toHaveBeenLastCalledWith(false);
  await changeSenders('+15555550100\nfriend@example.test');
  await click('Enable receiver');
  expect(container.textContent).toContain('disables the existing OpenClaw / CLI iMessage bridge');
  expect(container.textContent).toContain('Permission setup is manual');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await click('Cancel');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await click('Enable receiver');
  await click('Confirm enable');
  expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ enabled: true, handles: ['+15555550100', 'friend@example.test'] });
  expect(notify).toHaveBeenLastCalledWith(true);
  expect(container.textContent).toContain('Needs macOS permission');
});

it('saves sender edits while off without activating a receiver and rejects invalid senders', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const posted = init?.method === 'POST' ? JSON.parse(String(init.body)) : null;
    return Response.json({ ok: true, enabled: false, handles: posted?.handles ?? [], state: 'off' });
  });
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => { root.render(createElement(SymonMessagesReceiverSection)); });
  await changeSenders('invalid');
  expect([...container.querySelectorAll('button')].find((button) => button.textContent === 'Enable receiver')?.disabled).toBe(true);
  await changeSenders('+15555550100');
  await click('Save senders');
  expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ enabled: false, handles: ['+15555550100'] });
});

it('blocks competing bridge toggles while native receiver status is unknown or enabled', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, configured: true, enabled: true, groups: [] }));
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => { root.render(createElement(SymonIMessageAccessSection, { nativeReceiverEnabled: null })); });
  expect(container.querySelector<HTMLButtonElement>('[role="switch"]')?.disabled).toBe(true);
  await act(async () => { root.render(createElement(SymonIMessageAccessSection, { nativeReceiverEnabled: true })); });
  const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(toggle.disabled).toBe(true);
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(container.textContent).toContain('Disabled while the native Messages receiver is enabled');
  expect(fetchMock.mock.calls.every((call) => call[1]?.method !== 'POST')).toBe(true);
});

it('keeps native enable and the competing bridge blocked after a receiver read failure', async () => {
  const notify = vi.fn();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => String(input).endsWith('/messages-receiver')
    ? Response.json({ ok: false }, { status: 503 })
    : Response.json({ ok: true, configured: true, enabled: true, groups: [] }));
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => { root.render(createElement(SymonMessagesReceiverSection, { onEnabledChange: notify })); });
  expect(notify).toHaveBeenLastCalledWith(null);
  expect(container.textContent).toContain('Native Messages receiver status is unavailable');
  expect([...container.querySelectorAll('button')].find((button) => button.textContent === 'Enable receiver')?.disabled).toBe(true);
  await act(async () => { root.render(createElement(SymonIMessageAccessSection, { nativeReceiverEnabled: notify.mock.calls.at(-1)![0] })); });
  expect(container.querySelector<HTMLButtonElement>('[role="switch"]')?.disabled).toBe(true);
  expect(fetchMock.mock.calls.every((call) => call[1]?.method !== 'POST')).toBe(true);
});

it('aborts settings reads on unmount without writes', async () => {
  let signal: AbortSignal | null = null;
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    signal = init?.signal ?? null;
    return await new Promise<Response>((resolve) => { signal?.addEventListener('abort', () => resolve(Response.json({ ok: true, mode: 'auto' }))); });
  });
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => { root.render(createElement(SymonTextBrainSection)); });
  await act(async () => { root.render(null); });
  expect((signal as AbortSignal | null)?.aborted).toBe(true);
  expect(fetchMock.mock.calls.every((call) => call[1]?.method !== 'POST')).toBe(true);
});

it('starts no turn on mount or browsing, preserves the exact thread key, and renders saved transcript safely', async () => {
  const key = 'imessage:direct:+15555550100';
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => String(input).includes('/transcript?')
    ? Response.json({ ok: true, key, transcript: [{ id: 'u1', role: 'user', text: 'hi' }, { id: 'a1', role: 'assistant', text: '**Saved reply**\n<script>window.bad = true</script>\n![tracking](https://example.test/private-history-pixel)' }] })
    : Response.json({ ok: true, conversations: [{ key, conversationId: 'c1', source: 'messages', title: 'Saved thread', createdAt: 1, updatedAt: Date.UTC(2026, 9, 10) }] }));
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => { root.render(createElement(SymonConversationsSection)); });
  expect(fetchMock).not.toHaveBeenCalled();
  await click('Browse saved conversations');
  expect(container.textContent).toContain('Messages');
  expect(container.textContent).toContain('2026');
  await act(async () => { [...container.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Saved thread'))!.click(); });
  expect(String(fetchMock.mock.calls[1]?.[0])).toBe(`/api/panel/symon/conversations/transcript?key=${encodeURIComponent(key)}&limit=100`);
  expect(container.textContent).toContain('Saved reply');
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('iframe')).toBeNull();
  expect(container.textContent).toContain('https://example.test/private-history-pixel');
  expect(fetchMock.mock.calls.every((call) => !call[1]?.method || call[1]?.method === 'GET')).toBe(true);
  expect(container.querySelector('textarea')).toBeNull();
});

it.each([
  null,
  { ok: true, conversations: [null] },
  { ok: true, conversations: [{ key: 'key', title: null }] },
  { ok: true, conversations: [{ key: 'key', conversationId: 'c1', title: 'Bad', source: 'unknown', createdAt: 1, updatedAt: 2 }] },
])('rejects malformed conversation list responses without crashing: %j', async (payload) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(payload)));
  await act(async () => { root.render(createElement(SymonConversationsSection)); });
  await click('Browse saved conversations');
  expect(container.textContent).toContain('Saved conversations are unavailable');
});

it.each([null, { id: 'x', role: 'assistant', text: null }, { id: 'x', role: 'tool', text: 'invalid' }])('rejects malformed transcript entries: %j', async (entry) => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/transcript?')
    ? Response.json({ ok: true, key: 'key', transcript: [entry] })
    : Response.json({ ok: true, conversations: [{ key: 'key', conversationId: 'c1', source: 'app', title: 'Thread', createdAt: 1, updatedAt: 2 }] })));
  await act(async () => { root.render(createElement(SymonConversationsSection)); });
  await click('Browse saved conversations');
  await act(async () => { [...container.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Thread'))!.click(); });
  expect(container.textContent).toContain('This conversation is unavailable');
});

it.each(['linux', 'windows', 'unsupported'])('hides the native receiver on %s while it is off, but still reports its state', async (platform) => {
  if (platform !== 'unsupported') (window as unknown as { __O8_HOST_PLATFORM__: string }).__O8_HOST_PLATFORM__ = platform;
  const notify = vi.fn();
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, enabled: false, handles: [], state: platform === 'unsupported' ? 'unsupported' : 'off' }));
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => { root.render(createElement(SymonMessagesReceiverSection, { onEnabledChange: notify })); });
  expect(notify).toHaveBeenLastCalledWith(false);
  expect(container.textContent).not.toContain('Native Messages receiver');
  expect(container.textContent).not.toContain('Messages are unavailable');
  expect(container.querySelector('textarea')).toBeNull();
  expect(fetchMock.mock.calls.every((call) => call[1]?.method !== 'POST')).toBe(true);
});

it.each(['linux', 'windows', 'unsupported'])('keeps a saved receiver on %s visible until it is disabled, and blocks enable', async (platform) => {
  if (platform !== 'unsupported') (window as unknown as { __O8_HOST_PLATFORM__: string }).__O8_HOST_PLATFORM__ = platform;
  let enabled = true;
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') enabled = JSON.parse(String(init.body)).enabled;
    return Response.json({ ok: true, enabled, handles: ['+15555550100'], state: platform === 'unsupported' ? 'unsupported' : 'off' });
  });
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => { root.render(createElement(SymonMessagesReceiverSection)); });
  expect(container.textContent).toContain('Native Messages replies require macOS. You can still disable a saved receiver.');
  expect([...container.querySelectorAll('button')].find((button) => button.textContent === 'Disable receiver')?.disabled).toBe(false);
  await click('Disable receiver');
  expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).toEqual({ enabled: false, handles: ['+15555550100'] });
  expect(container.textContent).not.toContain('Native Messages receiver');
  expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Enable receiver')).toBe(false);
});

it.each(['native', 'bridge'])('shares a pending write lock and reconciles both receivers after a %s write', async (writer) => {
  let nativeEnabled = false;
  let bridgeEnabled = true;
  let finishPost: (() => void) | null = null;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/messages-receiver')) {
      if (init?.method === 'POST') {
        await new Promise<void>((resolve) => { finishPost = resolve; });
        nativeEnabled = JSON.parse(String(init.body)).enabled;
        if (nativeEnabled) bridgeEnabled = false;
      }
      return Response.json({ ok: true, enabled: nativeEnabled, handles: ['+15555550100'], state: nativeEnabled ? 'listening' : 'off' });
    }
    if (url.endsWith('/imessage-access')) {
      if (init?.method === 'POST') {
        await new Promise<void>((resolve) => { finishPost = resolve; });
        bridgeEnabled = JSON.parse(String(init.body)).enabled;
      }
      return Response.json({ ok: true, configured: true, enabled: bridgeEnabled, groups: [] });
    }
    return Response.json({ ok: true, enabled: false, connected: false, locked: false });
  });
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => { root.render(createElement(ConnectionsTab)); });
  const bridgeSwitch = () => [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find((button) => button.closest('section')?.textContent?.includes('iMessage bridge access'))!;
  const nativeButton = () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Enable receiver' || button.textContent === 'Disable receiver')!;
  const initialReads = fetchMock.mock.calls.filter((call) => call[1]?.method !== 'POST').length;
  if (writer === 'native') {
    await click('Enable receiver');
    await click('Confirm enable');
    expect(bridgeSwitch().disabled).toBe(true);
    await act(async () => { bridgeSwitch().click(); });
  } else {
    await act(async () => { bridgeSwitch().click(); });
    expect(nativeButton().disabled).toBe(true);
    await act(async () => { nativeButton().click(); });
  }
  expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
  await act(async () => { finishPost!(); });
  expect(fetchMock.mock.calls.filter((call) => call[1]?.method !== 'POST').length).toBeGreaterThan(initialReads + 1);
  expect(bridgeSwitch().getAttribute('aria-checked')).toBe('false');
  expect(nativeButton().textContent).toBe(writer === 'native' ? 'Disable receiver' : 'Enable receiver');
});

it.each(['native', 'bridge', 'membership'])('preserves a failed %s save explanation after successful status rereads until the next write', async (writer) => {
  let posts = 0;
  let finishRetry: (() => void) | null = null;
  const group = { id: 'g1', label: 'Approved group', memberSuffixes: ['0101'], approvalVersion: 'v1', fullAccess: false, canGrant: true };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      posts += 1;
      if (posts === 1) return Response.json({ ok: false, error: writer === 'membership' ? 'membership_changed' : 'write_failed' }, { status: 409 });
      await new Promise<void>((resolve) => { finishRetry = resolve; });
      if (url.endsWith('/messages-receiver')) return Response.json({ ok: true, enabled: true, handles: ['+15555550100'], state: 'listening' });
      if (writer === 'membership') return Response.json({ ok: true, group: { ...group, fullAccess: true } });
      return Response.json({ ok: true, enabled: false });
    }
    if (url.endsWith('/messages-receiver')) return Response.json({ ok: true, enabled: false, handles: ['+15555550100'], state: 'off' });
    if (url.endsWith('/imessage-access')) return Response.json({ ok: true, configured: true, enabled: true, groups: [group] });
    return Response.json({ ok: true, enabled: false, connected: false, locked: false });
  });
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => { root.render(createElement(ConnectionsTab)); });
  async function write() {
    if (writer === 'native') {
      await click('Enable receiver');
      await click('Confirm enable');
    } else {
      const switches = [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].filter((button) => button.closest('section')?.textContent?.includes('iMessage bridge access'));
      await act(async () => { switches[writer === 'membership' ? 2 : 0]!.click(); });
      if (writer === 'membership') await click('Grant full access');
    }
  }
  const beforeReads = fetchMock.mock.calls.filter((call) => call[1]?.method !== 'POST').length;
  await write();
  const explanation = writer === 'native' ? 'Could not save the receiver'
    : writer === 'membership' ? 'Approved members changed. Review the updated list before enabling full access.'
      : 'Could not change iMessage routing.';
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(explanation);
  expect(fetchMock.mock.calls.filter((call) => call[1]?.method !== 'POST').length).toBeGreaterThan(beforeReads + 1);
  await write();
  expect(posts).toBe(2);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => { finishRetry!(); });
});

it('shows unavailable and empty history, and aborts pending history reads when closed', async () => {
  let pendingSignal: AbortSignal | null = null;
  let reads = 0;
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    reads += 1;
    if (reads === 1) return Response.json({ ok: false }, { status: 503 });
    if (reads === 2) return Response.json({ ok: true, conversations: [] });
    pendingSignal = init?.signal ?? null;
    return await new Promise<Response>((resolve) => { pendingSignal?.addEventListener('abort', () => resolve(Response.json({ ok: true, conversations: [] }))); });
  });
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => { root.render(createElement(SymonConversationsSection)); });
  await click('Browse saved conversations');
  expect(container.textContent).toContain('Saved conversations are unavailable');
  await click('Refresh');
  expect(container.textContent).toContain('No saved Symon conversations yet');
  await click('Refresh');
  await click('Close history');
  expect((pendingSignal as AbortSignal | null)?.aborted).toBe(true);
  expect(container.textContent).not.toContain('Reading saved history');
});

it.each(['linux', 'windows', 'macos', 'browser'])('keeps receiver errors and retry reachable on %s without remounting Settings', async platform => {
  if (platform !== 'browser') (window as unknown as { __O8_HOST_PLATFORM__: string }).__O8_HOST_PLATFORM__ = platform;
  let nativeReads = 0;
  let finishRetry!: (response: Response) => void;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    if (String(input).endsWith('/messages-receiver')) {
      nativeReads += 1;
      return nativeReads === 1 ? Response.json({ ok: false }, { status: 503 })
        : new Promise<Response>(resolve => { finishRetry = resolve; });
    }
    if (String(input).endsWith('/imessage-access')) return Response.json({ ok: true, configured: true, enabled: true, groups: [] });
    return Response.json({ ok: true, enabled: false, connected: false, locked: false });
  });
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => { root.render(createElement(ConnectionsTab)); });
  const bridgeSwitch = () => [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
    .find(button => button.closest('section')?.textContent?.includes('iMessage bridge access'))!;
  expect(bridgeSwitch().disabled).toBe(true);
  expect(container.textContent).toContain('Native Messages receiver status is unavailable');
  const refresh = [...container.querySelectorAll('button')].find(button => button.textContent === 'Refresh status');
  expect(refresh, 'a failed read needs a reachable retry').toBeDefined();
  await act(async () => { refresh!.click(); });
  expect(container.contains(refresh!)).toBe(true);
  expect(refresh!.disabled).toBe(true);
  expect(bridgeSwitch().disabled).toBe(true);
  await act(async () => { finishRetry(Response.json({ ok: true, enabled: false, handles: [], state: 'off' })); });
  expect(nativeReads).toBe(2);
  expect(bridgeSwitch().disabled).toBe(false);
  expect(container.textContent).not.toContain('Native Messages receiver status is unavailable');
  expect(fetchMock.mock.calls.every(call => call[1]?.method !== 'POST')).toBe(true);
});
