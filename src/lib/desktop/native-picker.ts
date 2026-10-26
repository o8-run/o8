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

export type PickerKind = 'folder' | 'file';
export type PickerResult = { path: string | null; unavailable?: true };
export type PickerRunner = (command: string, args: string[], timeoutMs: number) => Promise<string>;

const execFileAsync = promisify(execFile);

const defaultRunner: PickerRunner = async (command, args, timeoutMs) => {
  const { stdout } = await execFileAsync(command, args, { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' });
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
  const path = raw.split('\n')[0]?.trim() ?? '';
  if (!path) return null;
  return kind === 'folder' && path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function exitCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
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
    } catch {
      // Cancelled (osascript exits non-zero) or dialog unavailable.
      return { path: null };
    }
  }

  if (platform !== 'linux') return { path: null, unavailable: true };

  for (const [command, args] of linuxCandidates(kind, prompt, options.home ?? process.env.HOME ?? '/')) {
    try {
      return { path: cleanPath(await run(command, args, timeoutMs), kind) };
    } catch (error) {
      // zenity and kdialog both exit 1 when the user cancels.
      if (exitCode(error) === 1) return { path: null };
      // Missing program (ENOENT), no display, or a crash: try the next one.
    }
  }
  return { path: null, unavailable: true };
}
