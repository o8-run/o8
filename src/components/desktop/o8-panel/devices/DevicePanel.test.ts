// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DevicePanel } from './DevicePanel';
import type { DeviceState } from '@/lib/devices/types';

const base: DeviceState = { phase: 'idle', tools: { hub: { installed: false, version: null, requiredVersion: '0.15.3' }, agent: { installed: false, version: null, requiredVersion: '0.21.23' } }, platforms: { ios: { available: true, detail: 'Xcode is available.' }, android: { available: false, detail: 'Install Android tools.' } } };
let host: HTMLDivElement; let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(base)));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function findButton(label: string) { return [...host.querySelectorAll('button')].find(b => b.textContent === label)!; }
it('only inspects on entry, with explicit separate helper installation actions', async () => {
  await act(async () => root.render(createElement(DevicePanel, { active: true })));
  expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.method === undefined)).toBe(true);
  expect(host.textContent).toContain('SDKs and simulator images are installed separately.');
  await act(async () => findButton('Set up device viewer').click());
  expect(fetch).toHaveBeenLastCalledWith('/api/panel/devices', expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'install', tool: 'hub' }) }));
  await act(async () => findButton('Set up agent controls').click());
  expect(fetch).toHaveBeenLastCalledWith('/api/panel/devices', expect.objectContaining({ body: JSON.stringify({ action: 'install', tool: 'agent' }) }));
});
it('releases the embedded live viewer when hidden without stopping the simulator helper', async () => {
  vi.mocked(fetch).mockImplementation(async () => Response.json({ ...base, phase: 'running', embedUrl: 'http://127.0.0.1:3333/?token=test-fixture' }));
  await act(async () => root.render(createElement(DevicePanel, { active: true })));
  expect(host.querySelector('iframe')?.getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(host.querySelector('iframe')?.getAttribute('sandbox')).not.toContain('allow-top-navigation');
  await act(async () => root.render(createElement(DevicePanel, { active: false })));
  expect(host.querySelector('iframe')).toBeNull();
  expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.method === undefined)).toBe(true);
  await act(async () => root.render(createElement(DevicePanel, { active: true })));
  expect(host.querySelector('iframe')).not.toBeNull();
  await act(async () => findButton('Stop viewer').click());
  expect(fetch).toHaveBeenLastCalledWith('/api/panel/devices', expect.objectContaining({ body: JSON.stringify({ action: 'stop' }) }));
});
it('shows API failures without starting another action automatically', async () => {
  vi.mocked(fetch).mockImplementation(async () => Response.json({ error: { message: 'Local operator required.' } }, { status: 403 }));
  await act(async () => root.render(createElement(DevicePanel, { active: true })));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Local operator required.');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('detects a stopped helper without refreshing manually and stops polling when hidden', async () => {
  vi.useFakeTimers();
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ...base, phase: 'running', embedUrl: 'http://127.0.0.1:3333/' }))
    .mockImplementation(async () => Response.json({ ...base, phase: 'error', error: 'The device dashboard stopped. Reopen it to reconnect.' }));
  await act(async () => root.render(createElement(DevicePanel, { active: true })));
  expect(host.querySelector('iframe')).not.toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(host.querySelector('iframe')).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Reopen it');
  await act(async () => root.render(createElement(DevicePanel, { active: false })));
  const calls = vi.mocked(fetch).mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(fetch).toHaveBeenCalledTimes(calls);
});
it('releases a hung request after a deadline and allows a manual retry', async () => {
  vi.useFakeTimers();
  vi.mocked(fetch).mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
  await act(async () => root.render(createElement(DevicePanel, { active: true })));
  expect(findButton('Refresh').disabled).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('took too long');
  expect(findButton('Refresh').disabled).toBe(false);
  await act(async () => findButton('Refresh').click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
it('keeps shared-device instructions available while the viewer is live', async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  vi.mocked(fetch).mockImplementation(async () => Response.json({ ...base, phase: 'running', embedUrl: 'http://127.0.0.1:3333/', tools: { ...base.tools, agent: { ...base.tools.agent, installed: true } }, agentCommand: ['/node path', "/agent's cli"] }));
  await act(async () => root.render(createElement(DevicePanel, { active: true })));
  expect(host.querySelector('summary')?.textContent).toContain('Shared device');
  await act(async () => findButton('Copy agent instructions').click());
  const instructions = writeText.mock.calls[0] as unknown as [string];
  expect(instructions[0]).toContain('o8_device');
  expect(instructions[0]).toContain('automatically');
  expect(instructions[0]).toContain('handoff');
  expect(instructions[0]).not.toContain('/agent');
  expect(host.querySelector('iframe')).not.toBeNull();
});
it('backs off after a live status timeout and recovers without remounting the viewer', async () => {
  vi.useFakeTimers();
  const running = { ...base, phase: 'running', embedUrl: 'http://127.0.0.1:3333/' };
  let reads = 0;
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    if (String(url).includes('stream=controllers')) return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"revision":0,"controllers":[]}\n\n'));
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
    if (++reads === 2) return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
    return Response.json(running);
  });
  await act(async () => root.render(createElement(DevicePanel, { active: true })));
  const frame = host.querySelector('iframe');
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(findButton('Refresh').disabled).toBe(false);
  expect(findButton('Stop viewer').disabled).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(host.querySelector('summary')?.textContent).toContain('Connection delayed');
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(29_999));
  expect(reads).toBe(2);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(host.querySelector('summary')?.textContent).toContain('Shared device');
  expect(host.querySelector('iframe')).toBe(frame);
});
it('keeps viewing passive and shows attributed controllers with an explicit operator takeover', async () => {
  const running = { ...base, phase: 'running', embedUrl: 'http://127.0.0.1:3333/',
    devices: [{ id: 'ios-1', name: 'Fixture phone', platform: 'ios', state: 'running' }],
    controllers: [{ deviceId: 'ios-1', active: { session: 'worker-a', label: 'Conversation a · Worker a', kind: 'worker' },
      waiting: [{ session: 'worker-b', label: 'Conversation b · Worker b', kind: 'worker' }],
      lastInput: { action: 'press', label: 'Conversation a · Worker a', x: 20, y: 30 } }],
  };
  vi.mocked(fetch).mockImplementation(async () => Response.json(running));
  await act(async () => root.render(createElement(DevicePanel, { active: true })));
  expect(host.textContent).toContain('Conversation a · Worker a');
  expect(host.textContent).toContain('Conversation b · Worker b');
  expect(host.querySelector('iframe')?.closest('[inert]')).not.toBeNull();
  expect(host.querySelector('[aria-label="Last agent input"]')?.textContent).toContain('press');
  await act(async () => findButton('Take operator control').click());
  expect(fetch).toHaveBeenLastCalledWith('/api/panel/devices', expect.objectContaining({ body: JSON.stringify({ action: 'take-control', deviceId: 'ios-1', expectedSession: 'worker-a' }) }));
});
it('revokes both operator panels on a pushed handoff without waiting for polling', async () => {
  vi.useFakeTimers();
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const operator = { session: 'operator-fixture', label: 'Operator', kind: 'operator' };
  const running = { ...base, phase: 'running', embedUrl: 'http://127.0.0.1:3333/', controllerRevision: 1,
    devices: [{ id: 'ios-1', name: 'Fixture phone', platform: 'ios', state: 'running' }],
    controllers: [{ deviceId: 'ios-1', active: operator, waiting: [], busy: false }],
  };
  vi.mocked(fetch).mockImplementation(async url => String(url).includes('stream=controllers')
    ? new Response(new ReadableStream({ start(controller) {
      streams.push(controller);
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ revision: 1, controllers: running.controllers })}\n\n`));
    } }), { headers: { 'Content-Type': 'text/event-stream' } }) : Response.json(running));
  await act(async () => root.render(createElement('div', null, createElement(DevicePanel, { active: true }), createElement(DevicePanel, { active: true }))));
  expect(streams).toHaveLength(2);
  expect([...host.querySelectorAll('iframe')].every(frame => !frame.closest('[inert]'))).toBe(true);
  await act(async () => {
    for (const stream of streams) stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ revision: 2,
      controllers: [{ ...running.controllers[0], active: { session: 'worker-fixture', kind: 'worker', label: 'Worker fixture' } }] })}\n\n`));
  });
  expect([...host.querySelectorAll('iframe')].every(frame => Boolean(frame.closest('[inert]')))).toBe(true);
  expect(host.textContent).toContain('Worker fixture');
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect([...host.querySelectorAll('iframe')].every(frame => Boolean(frame.closest('[inert]')))).toBe(true);
});
