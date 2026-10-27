// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const edge = vi.hoisted(() => ({
  calls: [] as Array<{ ticket: Record<string, unknown>; resolve: (value: unknown) => void; reject: (error: Error) => void }>,
  sequence: 0,
  channel: 'beta',
  generation: 0,
  listeners: new Map<string, (event: { payload: unknown }) => void | Promise<void>>(),
  views: [] as Array<{ outcome: string }>,
  registeredCheck: null as null | (() => Promise<{ version: string | null; error?: string }>),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async (command: string, args?: { ticket: Record<string, unknown> }) => {
  if (command === 'begin_update_check') return { checkSequence: ++edge.sequence, checkSession: 'native-session',
    channel: edge.channel, generation: edge.generation };
  if (command === 'read_update_check_ticket') return { checkSequence: edge.sequence, checkSession: 'native-session',
    channel: edge.channel, generation: edge.generation };
  if (command === 'check_app_update') return new Promise((resolve, reject) => edge.calls.push({ ticket: args!.ticket, resolve, reject }));
  if (command === 'get_running_bundle_integrity') return null;
  throw Error(`Unexpected command: ${command}`);
} }));
vi.mock('@tauri-apps/plugin-updater', () => ({ Update: class { constructor(value: object) { Object.assign(this, value); } } }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async (name: string, listener: (event: { payload: unknown }) => void | Promise<void>) => {
  edge.listeners.set(name, listener); return () => edge.listeners.delete(name);
} }));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true, canUseTauriEvents: () => true }));
vi.mock('@/lib/app-update/update-hub-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/app-update/update-hub-client')>('@/lib/app-update/update-hub-client');
  return { ...actual,
    publishAppUpdateView: (view: Parameters<typeof actual.publishAppUpdateView>[0]) => { edge.views.push(view); actual.publishAppUpdateView(view); },
    refreshCliUpdateView: async () => {},
    registerAppUpdateCheck: (callback: NonNullable<typeof edge.registeredCheck>) => {
      edge.registeredCheck = callback; const stop = actual.registerAppUpdateCheck(callback);
      return () => { edge.registeredCheck = null; stop(); };
    },
  };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => { vi.unstubAllGlobals(); });

async function serveState() {
  const route = await import('@/app/api/panel/app/update-state/route');
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    if (url.pathname !== '/api/panel/app/update-state') return Promise.resolve(Response.json({}));
    return init?.method === 'POST' ? route.POST(new Request(url, init)) : route.GET();
  });
  return route;
}

it('UpdateCard rejects native events without tickets before any ordered check exists', async () => {
  await serveState();
  const { UpdateCard } = await import('@/components/desktop/UpdateCard');
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(UpdateCard, { quiet: true })));
    await vi.waitFor(() => expect(edge.listeners.has('o8://update-clear')).toBe(true));
    await act(async () => edge.listeners.get('o8://update-clear')!({ payload: {
      outcome: 'failed', error: 'unsequenced failure', checkedAt: new Date().toISOString(),
    } }));
    await act(async () => edge.listeners.get('o8://update-available')!({ payload: {
      version: '0.3.0', currentVersion: '0.2.0', checkedAt: new Date().toISOString(),
    } }));
    expect(edge.views.at(-1)?.outcome).toBe('never');
  } finally {
    await act(async () => root.unmount()); host.remove();
  }
});

it('A3: a late beta failure cannot overwrite a newer stable result through the real state route', async () => {
  const { GET } = await serveState();
  const { check } = await import('@/lib/app-update/check');
  const offset = edge.calls.length;
  const older = check().catch(() => null);
  await vi.waitFor(() => expect(edge.calls).toHaveLength(offset + 1));
  edge.channel = 'stable'; edge.generation++;
  const newer = check();
  await vi.waitFor(() => expect(edge.calls).toHaveLength(offset + 2));
  edge.calls[offset + 1].resolve(null); await newer;
  edge.calls[offset].reject(Error('old beta failed')); await older;
  await vi.waitFor(async () => expect((await (await GET()).json()).state.check).toMatchObject({
    outcome: 'current', ...edge.calls[offset + 1].ticket,
  }));
});

it('native sequence orders reports even when the client clock moves backwards', async () => {
  const { POST, GET } = await serveState();
  const post = (body: object) => POST(new Request('http://localhost/api/panel/app/update-state', {
    method: 'POST', body: JSON.stringify(body),
  }));
  const base = { checkSession: 'native-session', generation: edge.generation, channel: 'stable' };
  const earlier = ++edge.sequence;
  await post({ ...base, checkSequence: earlier, updatePending: true, version: '0.3.0', checkOutcome: 'available',
    checkedAt: '2030-01-01T00:00:00.000Z' });
  const newer = ++edge.sequence;
  await post({ ...base, checkSequence: newer, updatePending: false, checkOutcome: 'current', checkedAt: '2029-01-01T00:00:00.000Z' });
  await post({ ...base, checkSequence: earlier, updatePending: false, checkOutcome: 'failed', checkError: 'old native failure',
    checkedAt: '2031-01-01T00:00:00.000Z' });
  await post({ updatePending: false, checkOutcome: 'failed', checkError: 'untagged failure', checkedAt: '2032-01-01T00:00:00.000Z' });
  expect((await (await GET()).json()).state.check).toMatchObject({ outcome: 'current', checkSequence: newer });
});

it.each(['error', 'available'] as const)('manual %s from another webview cannot supersede its newer native ticket', async outcome => {
  const { GET, POST } = await serveState();
  const { check } = await import('@/lib/app-update/check');
  const { invoke } = await import('@tauri-apps/api/core');
  const offset = edge.calls.length;
  edge.channel = 'beta'; edge.generation++;
  const older = check();
  await vi.waitFor(() => expect(edge.calls).toHaveLength(offset + 1));
  edge.channel = 'stable'; edge.generation++;
  const newer = await invoke<Record<string, unknown>>('begin_update_check');
  await POST(new Request('http://localhost/api/panel/app/update-state', { method: 'POST', body: JSON.stringify({
    ...newer, updatePending: false, checkOutcome: 'current', checkedAt: new Date().toISOString(),
  }) }));
  if (outcome === 'error') edge.calls[offset].reject(Error('old webview failed'));
  else edge.calls[offset].resolve({ version: '0.3.0', installExits: false });
  expect(await older).toBeNull();
  expect((await (await GET()).json()).state.check).toMatchObject({ outcome: 'current', ...newer });
});

it('the real UpdateCard rejects a queued native failure after a newer manual Stable check', async () => {
  await serveState();
  const { check } = await import('@/lib/app-update/check');
  const { UpdateCard } = await import('@/components/desktop/UpdateCard');
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(UpdateCard, { quiet: true })));
    await vi.waitFor(() => expect(edge.listeners.has('o8://update-clear')).toBe(true));
    const offset = edge.calls.length;
    edge.channel = 'beta'; edge.generation++;
    const older = check().catch(() => null);
    await vi.waitFor(() => expect(edge.calls).toHaveLength(offset + 1));
    edge.channel = 'stable'; edge.generation++;
    const newer = check();
    await vi.waitFor(() => expect(edge.calls).toHaveLength(offset + 2));
    edge.calls[offset + 1].resolve(null); await newer;
    await act(async () => edge.listeners.get('o8://update-clear')!({ payload: {
      ...edge.calls[offset + 1].ticket, outcome: 'current', checkedAt: '2029-01-02T00:00:00.000Z',
    } }));
    await act(async () => edge.listeners.get('o8://update-clear')!({ payload: {
      ...edge.calls[offset].ticket, outcome: 'failed', error: 'queued beta failure', checkedAt: '2031-01-01T00:00:00.000Z',
    } }));
    edge.calls[offset].reject(Error('old beta failed')); await older;
    expect(edge.views.at(-1)?.outcome).toBe('current');
    expect(host.textContent).not.toContain('queued beta failure');
  } finally {
    await act(async () => root.unmount()); host.remove();
  }
});

it('UpdateCard consults native ordering when another webview completed the newer check', async () => {
  const { POST, GET } = await serveState();
  const { invoke } = await import('@tauri-apps/api/core');
  const { UpdateCard } = await import('@/components/desktop/UpdateCard');
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(UpdateCard, { quiet: true })));
    await vi.waitFor(() => expect(edge.listeners.has('o8://update-clear')).toBe(true));
    edge.channel = 'beta'; edge.generation++;
    const older = await invoke<Record<string, unknown>>('begin_update_check');
    edge.channel = 'stable'; edge.generation++;
    const newer = await invoke<Record<string, unknown>>('begin_update_check');
    const offset = edge.calls.length;
    const manual = invoke('check_app_update', { ticket: newer });
    await vi.waitFor(() => expect(edge.calls).toHaveLength(offset + 1));
    edge.calls[offset].resolve(null); await manual;
    await POST(new Request('http://localhost/api/panel/app/update-state', { method: 'POST', body: JSON.stringify({
      ...newer, updatePending: false, checkOutcome: 'current', checkedAt: new Date().toISOString(),
    }) }));
    await act(async () => edge.listeners.get('o8://update-clear')!({ payload: {
      ...older, outcome: 'failed', error: 'queued failure from another window', checkedAt: '2031-01-01T00:00:00.000Z',
    } }));
    expect(edge.views.at(-1)?.outcome).toBe('current');
    expect((await (await GET()).json()).state.check).toMatchObject({ outcome: 'current', ...newer });
  } finally {
    await act(async () => root.unmount()); host.remove();
  }
});


it.each(['failed', 'available'] as const)('UpdateCard ignores an older manual-route %s after a newer Stable result', async outcome => {
  const { POST } = await serveState();
  const actualFetch = globalThis.fetch;
  let finishOlder: (() => void) | undefined;
  let olderTicket: Record<string, unknown>;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/panel/update/apply') return new Promise<Response>((resolve, reject) => { finishOlder = () => outcome === 'failed' ? reject(Error('old beta route failed')) : resolve(Response.json({ok:true,state:{updatePending:true,version:'0.4.0',info:{version:'0.4.0'},check:{...olderTicket,outcome:'available',checkedAt:new Date().toISOString()}}})); });
    return actualFetch(input, init);
  });
  const { UpdateCard } = await import('@/components/desktop/UpdateCard');
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(UpdateCard, { quiet: true })));
    await vi.waitFor(() => expect(edge.registeredCheck).not.toBeNull());
    const { invoke } = await import('@tauri-apps/api/core');
    edge.channel = 'stable'; edge.generation++;
    const baseline = await invoke<Record<string, unknown>>('begin_update_check');
    await act(async () => edge.listeners.get('o8://update-clear')!({ payload: { ...baseline, outcome: 'current', checkedAt: new Date().toISOString() } }));
    edge.channel = 'beta'; edge.generation++;
    olderTicket = await invoke<Record<string, unknown>>('begin_update_check');
    const { checkAppUpdates } = await import('@/lib/app-update/update-hub-client');
    const older = checkAppUpdates();
    await vi.waitFor(() => expect(finishOlder).toBeDefined());
    edge.channel = 'stable'; edge.generation++;
    const newer = await invoke<Record<string, unknown>>('begin_update_check');
    await POST(new Request('http://localhost/api/panel/app/update-state', { method: 'POST', body: JSON.stringify({ ...newer, updatePending: false, checkOutcome: 'current', checkedAt: new Date().toISOString() }) }));
    let result: { incomplete: boolean } | undefined;
    await act(async () => { finishOlder!(); result = await older; });
    expect(result?.incomplete).toBe(true);
    expect(edge.views.at(-1)?.outcome).toBe('current');
    expect(host.textContent).not.toContain('old beta route failed');
  } finally {
    await act(async () => root.unmount()); host.remove();
  }
});
