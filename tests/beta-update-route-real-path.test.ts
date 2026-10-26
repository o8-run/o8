import { beforeEach, expect, it, vi } from 'vitest';
import { POST as updateCheck } from '@/app/api/panel/update/apply/route';
import { POST as reportState } from '@/app/api/panel/app/update-state/route';

const edge = vi.hoisted(() => ({ channel: 'stable', version: '0.1.900' }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async (command: string, args?: { channel: string }) => {
  if (command === 'set_update_channel') { edge.channel = args!.channel; return edge.channel; }
  if (command === 'get_update_channel') return edge.channel;
  if (command === 'check_app_update') return edge.channel === 'beta'
    ? { rid: 1, currentVersion: '0.1.800', version: edge.version, channel: edge.channel, installExits: false }
    : null;
  throw new Error('Unexpected native command');
} }));
vi.mock('@tauri-apps/plugin-updater', () => ({ Update: class { constructor(value: object) { Object.assign(this, value); } } }));
const { setUpdateChannel } = await import('@/lib/app-update/channel');

beforeEach(() => {
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    expect(url).toBe('/api/panel/app/update-state');
    return reportState(new Request(`http://127.0.0.1${url}`, init));
  });
});

it('routes beta availability and return-to-stable current state through the real update-check route', async () => {
  for (const channel of ['beta', 'stable'] as const) {
    const pending = updateCheck(new Request('http://127.0.0.1/api/panel/update/apply', {
      method: 'POST', body: JSON.stringify({ checkOnly: true }),
    }));
    await new Promise(resolve => setTimeout(resolve, 5));
    await setUpdateChannel(channel);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, requested: false,
      state: { updatePending: channel === 'beta', version: channel === 'beta' ? edge.version : null, check: { channel } },
      result: { code: channel === 'beta' ? 'check_available' : 'check_current' },
    });
  }
});
