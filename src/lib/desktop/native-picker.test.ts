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

  it('keeps the macOS file picker command and cancel/error contract', async () => {
    const run = vi.fn<PickerRunner>(async () => '/Users/q/notes.md\n');
    const options = { platform: 'darwin' as const, run };
    await expect(pickNativePath('file', 'Open a file on the canvas', options)).resolves.toEqual({ path: '/Users/q/notes.md' });
    expect(run).toHaveBeenCalledWith('osascript', ['-e', [
      'tell application "System Events" to activate',
      'POSIX path of (choose file with prompt "Open a file on the canvas" with invisibles)',
    ].join('\n')], 120_000);
    run.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { stderr: 'User canceled. (-128)' }));
    await expect(pickNativePath('file', 'Open a file on the canvas', options)).resolves.toEqual({ path: null });
    run.mockRejectedValueOnce(new Error('command unavailable'));
    await expect(pickNativePath('file', 'Open a file on the canvas', options)).resolves.toEqual({ path: null });
  });

});

it('falls back to kdialog after a GTK startup failure exits 1', async () => {
  const run = vi.fn<PickerRunner>(async command => {
    if (command === 'zenity') throw Object.assign(failure(1), { stderr: '(zenity:12): Gtk-WARNING **: cannot open display: :77\n' });
    return '/tmp/selected\n';
  });
  await expect(pickNativePath('folder', 'Pick', { platform: 'linux', run })).resolves.toEqual({ path: '/tmp/selected' });
  expect(run.mock.calls.map(([command]) => command)).toEqual(['zenity', 'kdialog']);
});

it('reports unavailable when both pickers fail to start with exit 1', async () => {
  const run = vi.fn<PickerRunner>(async () => { throw Object.assign(failure(1), { stderr: Buffer.from('cannot connect to display\n') }); });
  await expect(pickNativePath('file', 'Pick', { platform: 'linux', run })).resolves.toEqual({ path: null, unavailable: true });
  expect(run).toHaveBeenCalledTimes(2);
});

it('keeps informational GTK cancellation from opening a second picker', async () => {
  const run = vi.fn<PickerRunner>(async () => { throw Object.assign(failure(1), {
    stderr: 'Gtk-Message: 12:00:00.000: GtkDialog mapped without a transient parent. This is discouraged.\n',
  }); });
  await expect(pickNativePath('folder', 'Pick', { platform: 'linux', run })).resolves.toEqual({ path: null });
  expect(run).toHaveBeenCalledOnce();
});

it.each([
  ['linux', 'folder'], ['linux', 'file'], ['darwin', 'folder'], ['darwin', 'file'],
] as const)('preserves exact newline and whitespace paths for %s %s', async (platform, kind) => {
  for (const selected of ['/tmp/chosen\nthen other ', '/tmp/quotes "and\' spaces\t', '/tmp/trailing-newline\n']) {
    const run = vi.fn<PickerRunner>(async () => selected + (kind === 'folder' ? '/' : '') + '\n');
    await expect(pickNativePath(kind, 'Pick', { platform, run })).resolves.toEqual({ path: selected });
  }
});

it('keeps cancellation after nonfatal EGL and accessibility diagnostics', async () => {
  const run = vi.fn<PickerRunner>(async () => { throw Object.assign(failure(1), { stderr: [
    'libEGL warning: DRI3 error: Could not get DRI3 device',
    'libEGL warning: Ensure your X server supports DRI3 to get accelerated rendering',
    '(zenity:12): Gtk-WARNING **: 12:00:00: Unable to acquire the address of the accessibility bus: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name org.a11y.Bus was not provided by any .service files.',
    'Gtk-Message: 12:00:00: GtkDialog mapped without a transient parent. This is discouraged.',
  ].join('\n') }); });
  await expect(pickNativePath('folder', 'Pick', { platform: 'linux', run })).resolves.toEqual({ path: null });
  expect(run).toHaveBeenCalledOnce();
});
