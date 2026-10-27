import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeInstallInfo, resolveUpdateAction } from '@/lib/app-update/install-target';

const { readlink, execFile } = vi.hoisted(() => ({ readlink: vi.fn(), execFile: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readlink }));
vi.mock('@/lib/providers/child-process', () => ({ execFile }));
const { GET } = await import('./route');
const platform = process.platform;

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  vi.stubEnv('APPIMAGE', '');
  readlink.mockReset().mockResolvedValue('/usr/bin/o8');
  execFile.mockReset().mockImplementation((_file, _args, _options, callback) => callback(new Error('not owned'), '', ''));
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  vi.unstubAllEnvs();
});
async function runningAction() {
  const payload = await (await GET()).json();
  return { payload, action: resolveUpdateAction(normalizeInstallInfo(payload), '0.1.811') };
}

describe('running shell package ownership', () => {
  it.each([['deb', false], ['rpm', false], ['deb', true], ['rpm', true]] as const)(
    'recognizes a real %s install with deleted=%s even with a spoofed APPIMAGE', async (packageManager, deleted) => {
      if (deleted) readlink.mockResolvedValue('/usr/bin/o8 (deleted)');
      vi.stubEnv('APPIMAGE', '/tmp/writable/fake.AppImage');
      execFile.mockImplementation((file, _args, _options, callback) => {
        if (_args.includes('/usr/bin/o8') && file === (packageManager === 'deb' ? '/usr/bin/dpkg-query' : '/usr/bin/rpm')) {
          callback(null, packageManager === 'deb' ? 'o8: /usr/bin/o8\n' : 'o8\n', '');
        } else callback(new Error('not owned'), '', '');
      });
      const { payload, action } = await runningAction();
      expect(payload.packageManager).toBe(packageManager);
      expect(payload.selfUpdatable).toBe(false);
      expect(action).toEqual({ kind: 'download', url: 'https://github.com/o8-run/o8/releases/tag/v0.1.811', packageManager: true });
      expect(readlink).toHaveBeenCalledWith(`/proc/${process.ppid}/exe`);
  });

  it('does not mistake a writable tarball for a package install', async () => {
    readlink.mockResolvedValue('/tmp/writable/o8');
    const { action } = await runningAction();
    expect(action).toEqual({ kind: 'download', url: 'https://github.com/o8-run/o8/releases/download/v0.1.811/o8_0.1.811_linux_amd64_preview.AppImage' });
  });

  it('does not count a different package or a wildcard ownership match', async () => {
    readlink.mockResolvedValue('/tmp/o8*');
    execFile.mockImplementation((_file, _args, _options, callback) => callback(null, 'other: /usr/bin/other\no8: /usr/bin/o8\n', ''));
    expect((await runningAction()).action).not.toHaveProperty('packageManager');
  });

  it('keeps a real AppImage on the existing restart path', async () => {
    vi.stubEnv('APPIMAGE', '/home/test/o8.AppImage');
    readlink.mockResolvedValue('/tmp/.mount_o8/usr/bin/o8');
    expect((await runningAction()).action).toEqual({ kind: 'restart' });
  });

  it('keeps macOS unchanged and never invokes Linux package managers', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    expect((await runningAction()).action).toEqual({ kind: 'restart' });
    expect(execFile).not.toHaveBeenCalled();
    expect(readlink).not.toHaveBeenCalled();
  });
});
