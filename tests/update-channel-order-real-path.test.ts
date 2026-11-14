// @vitest-environment jsdom
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

it('the state route keeps a newer Stable check when another window reports an older failure', async () => {
  const { POST, GET } = await serveState();
  const { invoke } = await import('@tauri-apps/api/core');
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
  await POST(new Request('http://localhost/api/panel/app/update-state', { method: 'POST', body: JSON.stringify({
    ...older, updatePending: false, checkOutcome: 'failed', checkError: 'queued failure from another window', checkedAt: '2031-01-01T00:00:00.000Z',
  }) }));
  expect((await (await GET()).json()).state.check).toMatchObject({ outcome: 'current', ...newer });
});
