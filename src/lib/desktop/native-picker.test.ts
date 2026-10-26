import { describe, expect, it, vi } from 'vitest';
import { pickNativePath, type PickerRunner } from './native-picker';

function failure(code: unknown): Error {
  return Object.assign(new Error('picker failed'), { code });
}

describe('pickNativePath', () => {
  it('uses zenity on Linux and strips the trailing newline and slash', async () => {
    const run = vi.fn<PickerRunner>(async () => '/home/q/repo/\n');
    await expect(pickNativePath('folder', 'Pick', { platform: 'linux', home: '/home/q', run })).resolves.toEqual({ path: '/home/q/repo' });
    expect(run).toHaveBeenCalledWith('zenity', ['--file-selection', '--title=Pick', '--directory'], 120_000);
  });

  it('falls back to kdialog when zenity is missing', async () => {
    const run = vi.fn<PickerRunner>(async (command) => {
      if (command === 'zenity') throw failure('ENOENT');
      return '/home/q/notes.md\n';
    });
    await expect(pickNativePath('file', 'Open', { platform: 'linux', home: '/home/q', run })).resolves.toEqual({ path: '/home/q/notes.md' });
    expect(run).toHaveBeenLastCalledWith('kdialog', ['--getopenfilename', '/home/q', '--title', 'Open'], 120_000);
  });

  it('treats exit code 1 as a cancel and does not open a second picker', async () => {
    const run = vi.fn<PickerRunner>(async () => { throw failure(1); });
    await expect(pickNativePath('folder', 'Pick', { platform: 'linux', run })).resolves.toEqual({ path: null });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reports unavailable when no Linux picker program exists', async () => {
    const run = vi.fn<PickerRunner>(async () => { throw failure('ENOENT'); });
    await expect(pickNativePath('file', 'Open', { platform: 'linux', run })).resolves.toEqual({ path: null, unavailable: true });
    expect(run.mock.calls.map(([command]) => command)).toEqual(['zenity', 'kdialog']);
  });

  it('keeps osascript on macOS', async () => {
    const run = vi.fn<PickerRunner>(async () => '/Users/q/repo/\n');
    await expect(pickNativePath('folder', 'Select a project folder', { platform: 'darwin', run, timeoutMs: 60_000 })).resolves.toEqual({ path: '/Users/q/repo' });
    const [command, args, timeout] = run.mock.calls[0]!;
    expect(command).toBe('osascript');
    expect(args[1]).toContain('choose folder with prompt "Select a project folder"');
    expect(timeout).toBe(60_000);
  });

  it('reports unavailable on hosts without a picker path', async () => {
    const run = vi.fn<PickerRunner>();
    await expect(pickNativePath('file', 'Open', { platform: 'win32', run })).resolves.toEqual({ path: null, unavailable: true });
    expect(run).not.toHaveBeenCalled();
  });
});
