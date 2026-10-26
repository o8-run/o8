// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AboutTab } from './settings/AboutTab';
import { Onboarding } from './Onboarding';
import { createOnboardingPreviewRequest } from '@/app/preview/first-run/FirstRunPreview';

vi.mock('./settings/ReportIssueSection', () => ({ ReportIssueSection: () => null }));
vi.mock('@/lib/ws-auth', () => ({ getOrCreateWsToken: () => 'fixture-operator-token' }));
let root: Root;
let host: HTMLDivElement;
const request = vi.fn<typeof fetch>();
const emailInput = () => host.querySelector<HTMLInputElement>('input[aria-label="Email for o8 release notes"]');
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label)!;
async function submit(email = 'reader@example.invalid') {
  const input = emailInput();
  expect(input, 'release notes email field').not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, email);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => input!.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  request.mockReset().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal('fetch', request);
  localStorage.clear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('subscribes from About without account access and sends only the entered email', async () => {
  await act(async () => root.render(createElement(AboutTab)));
  expect(request).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Weekly release notes. Unsubscribe anytime.');
  await submit(' reader@example.invalid ');
  expect(request).toHaveBeenCalledTimes(1);
  const [url, init] = request.mock.calls[0];
  expect(url).toBe('/api/panel/release-notes');
  expect(JSON.parse(String(init?.body))).toEqual({ email: 'reader@example.invalid' });
  expect(init?.credentials).toBe('omit');
  expect(host.textContent).toContain('You’re subscribed to release notes.');
  expect(host.querySelector('a[href="https://discord.gg/TFK2x9A5WS"]')).not.toBeNull();
  expect(localStorage.length).toBe(0);
});

it.each([
  [502, { ok: false }],
  [200, { ok: false, reason: 'not_configured' }],
])('keeps a failed or paused signup retryable without blocking About: %s', async (status, payload) => {
  request.mockResolvedValueOnce(Response.json(payload, { status }));
  await act(async () => root.render(createElement(AboutTab)));
  await submit();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(emailInput()?.value).toBe('reader@example.invalid');
  expect(button('Subscribe').disabled).toBe(false);
  expect(button('Replay onboarding').disabled).toBe(false);
  await submit();
  expect(host.textContent).toContain('You’re subscribed to release notes.');
});

it('offers signup only on the final setup screen and can finish while signup is pending', async () => {
  const fixture = createOnboardingPreviewRequest();
  const complete = vi.fn().mockResolvedValue(true);
  const setupRequest = vi.fn<typeof fetch>((url, init) => String(url) === '/api/panel/release-notes' ? request(url, init) : fixture(url, init));
  await act(async () => root.render(createElement(Onboarding, { request: setupRequest, storage: localStorage, onComplete: complete })));
  expect(emailInput()).toBeNull();
  await act(async () => button('Start without a project').click());
  expect(emailInput()).not.toBeNull();
  request.mockImplementationOnce(() => new Promise(() => {}));
  await submit();
  expect(button('Subscribing…').disabled).toBe(true);
  await act(async () => button('Keep crash reports off').click());
  await act(async () => button('Turn off').click());
  await act(async () => button('Save privacy choices').click());
  expect(complete).toHaveBeenCalledWith(undefined);
});

it('drives a rendered About submission through the real POST handler to the site transport', async () => {
  const { POST } = await import('@/app/api/panel/release-notes/route');
  const site = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
  request.mockImplementation((url, init) => {
    if (!String(url).startsWith('/')) return site(url, init);
    const headers = new Headers(init?.headers); headers.set('host', '127.0.0.1');
    return POST(new NextRequest(`http://127.0.0.1${url}`, { ...init, signal: init?.signal ?? undefined, headers }));
  });
  await act(async () => root.render(createElement(AboutTab)));
  await submit();
  expect(site).toHaveBeenCalledTimes(1);
  expect(site.mock.calls[0][0]).toBe('https://o8.run/api/subscribe');
  expect(JSON.parse(String(site.mock.calls[0][1]?.body))).toEqual({ email: 'reader@example.invalid', source: 'app' });
  expect(host.textContent).toContain('You’re subscribed to release notes.');
});

it('refuses invalid addresses and concurrent submissions before another request', async () => {
  await act(async () => root.render(createElement(AboutTab)));
  await submit('invalid');
  expect(host.textContent).toContain('Enter a valid email address.');
  expect(request).not.toHaveBeenCalled();
  let finish!: (response: Response) => void;
  request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await submit();
  await act(async () => {
    emailInput()!.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    emailInput()!.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => finish(Response.json({ ok: true })));
});

it('names a long wait and recovers from a timed-out signup', async () => {
  vi.useFakeTimers();
  request.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  await act(async () => root.render(createElement(AboutTab)));
  await submit();
  await act(async () => vi.advanceTimersByTime(3_000));
  expect(button('Waiting for confirmation…').disabled).toBe(true);
  await act(async () => vi.advanceTimersByTime(12_000));
  expect(host.textContent).toContain('Could not subscribe. Please try again.');
  expect(button('Subscribe').disabled).toBe(false);
  expect(emailInput()?.value).toBe('reader@example.invalid');
});
