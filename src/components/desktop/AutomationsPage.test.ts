// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AutomationsPage } from './AutomationsPage';

afterEach(() => {
  delete (window as Window & { __o8ConnectedAutomationsCache?: unknown }).__o8ConnectedAutomationsCache;
  vi.unstubAllGlobals();
});

it.each(['loaded', 'failed'] as const)('keeps cold activity unknown until connected schedules are %s', async outcome => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let resolveConnected!: (response: Response) => void;
  let rejectConnected!: (error: Error) => void;
  const connected = new Promise<Response>((resolve, reject) => { resolveConnected = resolve; rejectConnected = reject; });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/automations') return Response.json({ automations: [] });
    if (String(input) === '/api/panel/repos') return Response.json({ repos: [] });
    if (String(input) === '/api/automations/connected') return connected;
    throw new Error('Unexpected automation request');
  }));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(AutomationsPage, { currentOwner: 'operator' })));
    expect(host.textContent).not.toContain('0 active');
    expect(host.querySelector('[aria-busy="true"] [role="status"]')?.textContent).toContain('Reading connected schedules');
    await act(async () => {
      if (outcome === 'failed') rejectConnected(new Error('Schedule read unavailable'));
      else resolveConnected(Response.json({ ok: true, available: true, jobs: [{
        id: 'delayed-job', name: 'Delayed schedule', agentId: 'agent', enabled: true,
        schedule: { kind: 'every', everyMs: 3_600_000 }, nextRunAt: null, lastRunAt: null,
      }] }));
    });
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    if (outcome === 'loaded') {
      expect(host.textContent).toContain('Delayed schedule');
      expect(host.textContent).toContain('1 active');
    } else {
      expect(host.textContent).toContain('Schedule read unavailable');
      expect(host.textContent).toContain('Activity unavailable');
      expect(host.textContent).not.toContain('0 active');
    }
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('shows connected schedules without empty Mine or placeholder Team tabs', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/automations') return Response.json({ automations: [] });
    if (url === '/api/panel/repos') return Response.json({ repos: [] });
    if (url === '/api/automations/connected') return Response.json({ ok: true, available: true, jobs: [{
      id: 'job-1', name: 'Daily planning check-in', agentId: 'agent', enabled: true,
      schedule: { kind: 'every', expr: null, tz: null, everyMs: 3_600_000, at: null },
      nextRunAt: null, lastRunAt: null, lastRunStatus: null, lastDeliveryStatus: null,
    }] });
    throw new Error(`Unexpected fetch: ${url}`);
  }));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(AutomationsPage, { currentOwner: 'operator' })));
    await vi.waitFor(() => expect(host.textContent).toContain('Daily planning check-in'));
    expect(host.textContent).toContain('1 active');
    expect(host.textContent).not.toContain('Mine');
    expect(host.textContent).not.toContain('Team');
    expect(host.textContent).not.toContain('Let agents handle the repeat work');
    const scroller = host.querySelector<HTMLElement>('div[style*="overflow-y: auto"]');
    expect(scroller?.style.scrollbarWidth).toBe('none');
    expect(scroller?.style.overflowY).toBe('auto');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
