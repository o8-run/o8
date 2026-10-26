import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ open: vi.fn(), requestPrompt: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: fixture.open }));
vi.mock('@/components/shared/ConfirmToastHost', () => ({ requestPrompt: fixture.requestPrompt }));

import { pickRepoFolder } from './pickRepoFolder';

function serverPicker(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
}

beforeEach(() => {
  fixture.open.mockReset().mockRejectedValue(new Error('dialog plugin unavailable'));
  fixture.requestPrompt.mockReset().mockResolvedValue(' /home/q/typed ');
});
afterEach(() => vi.unstubAllGlobals());

describe('pickRepoFolder server fallback', () => {
  it('uses the server picker path when the dialog plugin is unavailable', async () => {
    serverPicker({ path: '/home/q/repo' });
    await expect(pickRepoFolder('Pick', 'Type a path')).resolves.toBe('/home/q/repo');
    expect(fixture.requestPrompt).not.toHaveBeenCalled();
  });

  it('treats a server-side cancel as a cancel', async () => {
    serverPicker({ path: null });
    await expect(pickRepoFolder('Pick', 'Type a path')).resolves.toBeNull();
    expect(fixture.requestPrompt).not.toHaveBeenCalled();
  });

  it('asks for a typed path when the host has no picker program', async () => {
    serverPicker({ path: null, unavailable: true });
    await expect(pickRepoFolder('Pick', 'Type a path')).resolves.toBe('/home/q/typed');
    expect(fixture.requestPrompt).toHaveBeenCalledWith(expect.objectContaining({ title: 'Pick', message: 'Type a path' }));
  });
});
