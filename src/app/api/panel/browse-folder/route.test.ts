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
    const response = await POST();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ path: null, unavailable: true, error: expect.stringContaining('Paste') }));
  });
});

it('keeps macOS cancellation distinct from an unavailable folder picker', async () => {
  setPlatform('darwin');
  fixture.execFile.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { stderr: 'User canceled. (-128)' }));
  const { POST } = await import('./route');
  const cancelled = await POST();
  expect(cancelled.status).toBe(200);
  expect(await cancelled.json()).toEqual({ path: null });
  fixture.execFile.mockRejectedValueOnce(new Error('command unavailable'));
  const unavailable = await POST();
  expect(unavailable.status).toBe(503);
  expect((await unavailable.json()).error).toContain('Paste');
});

vi.mock('@/lib/auth/principal', () => ({ resolveRequestPrincipal: () => 'operator' }));

it.each([
  ['linux', 'folder'], ['linux', 'file'], ['darwin', 'folder'], ['darwin', 'file'],
] as const)('returns an intact newline selection through the %s %s route', async (platform, kind) => {
  setPlatform(platform);
  const selected = '/tmp/chosen\nthen other';
  fixture.execFile.mockResolvedValue({ stdout: selected + (kind === 'folder' ? '/' : '') + '\n', stderr: '' });
  const response = kind === 'folder'
    ? await (await import('./route')).POST()
    : await (await import('../file-io/route')).POST(new Request('http://localhost/api/panel/file-io', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pick' }),
    }));
  expect(response.status).toBe(200);
  expect((await response.json()).path).toBe(selected);
});
