/**
 * Server-side native file and folder pickers for the /api/panel picker
 * routes. The webview tries `@tauri-apps/plugin-dialog` first; these routes
 * are the fallback when that plugin is unavailable.
 *
 * macOS uses osascript. Linux tries zenity (GTK, and the xdg-desktop-portal
 * picker on GNOME), then kdialog (KDE). When no picker program exists the
 * result says `unavailable` so callers can ask for a typed path instead of
 * treating it as a cancel.
 */

import { promisify } from 'node:util';
import { execFile } from '@/lib/providers/child-process';
import { workerParentEnvironment } from '@/lib/providers/worker-environment';

export type PickerKind = 'folder' | 'file';
export type PickerResult = { path: string | null; unavailable?: true };
export type PickerRunner = (command: string, args: string[], timeoutMs: number) => Promise<string>;

const execFileAsync = promisify(execFile);

const defaultRunner: PickerRunner = async (command, args, timeoutMs) => {
  const linuxPicker = command === 'zenity' || command === 'kdialog';
  const { stdout } = await execFileAsync(command, args, {
    windowsHide: true, timeout: timeoutMs, encoding: 'utf8',
    ...(linuxPicker ? { env: {
      ...workerParentEnvironment(process.env),
      NODE_ENV: process.env.NODE_ENV, // Already inherited; required by Next's ProcessEnv type.
      DISPLAY: process.env.DISPLAY,
      WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
    } } : {}),
  });
  return String(stdout);
};

function macScript(kind: PickerKind, prompt: string): string {
  const quoted = JSON.stringify(prompt);
  return kind === 'folder'
    ? `tell application "System Events"\nactivate\nreturn POSIX path of (choose folder with prompt ${quoted})\nend tell`
    : `tell application "System Events" to activate\nPOSIX path of (choose file with prompt ${quoted} with invisibles)`;
}

function linuxCandidates(kind: PickerKind, prompt: string, home: string): Array<[string, string[]]> {
  const zenity = ['--file-selection', `--title=${prompt}`, ...(kind === 'folder' ? ['--directory'] : [])];
  const kdialog = [kind === 'folder' ? '--getexistingdirectory' : '--getopenfilename', home, '--title', prompt];
  return [['zenity', zenity], ['kdialog', kdialog]];
}

function cleanPath(raw: string, kind: PickerKind): string | null {
  // Each chooser appends one protocol newline; all other bytes belong to the path.
  const path = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (!path) return null;
  return kind === 'folder' && path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function isCancellation(error: unknown): boolean {
  const failure = error as { code?: unknown; stderr?: unknown } | null;
  if (failure?.code !== 1) return false;
  const stderr = Buffer.isBuffer(failure.stderr) ? failure.stderr.toString('utf8')
    : typeof failure.stderr === 'string' ? failure.stderr : '';
  // GTK prints some nonfatal rendering/accessibility hints on working dialogs.
  // Other diagnostics distinguish startup failure from a plain cancellation.
  const informational = [
    /Gtk-Message:.*GtkDialog mapped without a transient parent\. This is discouraged\.\s*$/,
    /^libEGL warning: (?:DRI3 error: Could not get DRI3 device|Ensure your X server supports DRI3 to get accelerated rendering)\s*$/,
    /Gtk-WARNING.*Unable to acquire the address of the accessibility bus:.*ServiceUnknown:.*org\.a11y\.Bus/,
  ];
  return stderr.split('\n').every(line => !line.trim() || informational.some(pattern => pattern.test(line)));
}

export async function pickNativePath(
  kind: PickerKind,
  prompt: string,
  options: { platform?: NodeJS.Platform; home?: string; timeoutMs?: number; run?: PickerRunner } = {},
): Promise<PickerResult> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRunner;
  const timeoutMs = options.timeoutMs ?? 120_000;

  if (platform === 'darwin') {
    try {
      return { path: cleanPath(await run('osascript', ['-e', macScript(kind, prompt)], timeoutMs), kind) };
    } catch (error) {
      // The file picker keeps its existing cancel/error contract. Folder
      // failures must reach the direct-open form's inline recovery from #4845.
      const reason = error instanceof Error ? `${error.message} ${'stderr' in error ? error.stderr : ''}` : '';
      if (kind === 'file' || /\(-128\)|user cancel(?:ed|led)/i.test(reason)) return { path: null };
      return { path: null, unavailable: true };
    }
  }

  if (platform !== 'linux') return { path: null, unavailable: true };

  for (const [command, args] of linuxCandidates(kind, prompt, options.home ?? process.env.HOME ?? '/')) {
    try {
      return { path: cleanPath(await run(command, args, timeoutMs), kind) };
    } catch (error) {
      // Both tools use exit 1 for cancellation and some startup failures.
      if (isCancellation(error)) return { path: null };
      // Missing program (ENOENT), no display, or a crash: try the next one.
    }
  }
  return { path: null, unavailable: true };
}
