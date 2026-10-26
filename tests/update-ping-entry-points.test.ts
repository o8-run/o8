import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, check, ticket } = vi.hoisted(() => {
  const ticket = { checkSession: 'native-fixture', checkSequence: 1, generation: 0, channel: 'stable' };
  return {
    ticket,
    invoke: vi.fn(async (command: string, _args?: unknown) =>
      command === 'begin_update_check' || command === 'read_update_check_ticket' ? ticket : null),
    check: vi.fn(async () => null),
  };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check }));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true }));

const { installUpdateAndRestart } = await import('@/lib/app-update/client-restart');

describe('desktop update ping entry points', () => {
  beforeEach(() => {
    invoke.mockClear();
    check.mockClear();
  });

  it('checks through the native ping command when installing an update', async () => {
    await expect(installUpdateAndRestart()).resolves.toEqual({ installed: false });
    expect(invoke.mock.calls).toEqual([
      ['begin_update_check'], ['check_app_update', { ticket }], ['read_update_check_ticket'],
    ]);
    expect(check).not.toHaveBeenCalled();
  });

  it('keeps the service first and the signed GitHub manifest as fallback', () => {
    const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
    expect(config.plugins.updater.endpoints).toEqual([
      'https://api.o8.run/v1/update/{{target}}/{{arch}}/{{current_version}}',
      'https://github.com/hurttlocker/o8-releases/releases/latest/download/latest.json',
    ]);
  });
});
