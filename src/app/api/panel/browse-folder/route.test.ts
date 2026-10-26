import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('@/lib/providers/child-process', async () => {
  const { promisify: custom } = await import('node:util');
  const execFile = Object.assign(() => undefined, { [custom.custom]: fixture.execFile });
  return { execFile };
});

const realPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => {
  vi.resetModules();
  fixture.execFile.mockReset();
  setPlatform('linux');
});
afterEach(() => setPlatform(realPlatform));

describe('POST /api/panel/browse-folder on Linux', () => {
  it('returns the folder chosen in zenity', async () => {
    fixture.execFile.mockResolvedValue({ stdout: '/home/q/repo\n', stderr: '' });
    const { POST } = await import('./route');
    await expect((await POST()).json()).resolves.toEqual({ path: '/home/q/repo' });
    expect(fixture.execFile).toHaveBeenCalledWith('zenity', expect.arrayContaining(['--file-selection', '--directory']), expect.objectContaining({ timeout: 60_000 }));
    expect(fixture.execFile.mock.calls.some(([command]) => command === 'osascript')).toBe(false);
  });

  it('tells the caller to ask for a typed path when no picker is installed', async () => {
    fixture.execFile.mockRejectedValue(Object.assign(new Error('spawn zenity ENOENT'), { code: 'ENOENT' }));
    const { POST } = await import('./route');
    await expect((await POST()).json()).resolves.toEqual({ path: null, unavailable: true });
  });
});
