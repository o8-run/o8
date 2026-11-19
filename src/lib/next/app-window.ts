import { dirname, isAbsolute, join } from 'node:path';
import { renameSync } from 'node:fs';
import type { ChildProcess } from '@/lib/providers/child-process';
import { access, constants, rename, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { getDataDir } from '@/lib/data-dir-migration';
import { getOperatorDefaults } from '@/lib/operator/defaults';
import { getApiBase } from '@/lib/panel/api-port';
import { bindNextBrowserPipe } from './browser-pipe';

const UNAVAILABLE = 'o8 next is unavailable. Reinstall the app and try again.';
// Only spawn-to-first-paint is parent-owned; server loads stay in the window.
const WINDOW_OPEN_TIMEOUT_MS = 15_000;
export class NextWindowStartupError extends Error {
  constructor(readonly code: 'NEXT_STARTUP_FAILED' | 'NEXT_STARTUP_TIMEOUT') {
    super(code === 'NEXT_STARTUP_TIMEOUT'
      ? 'o8 next did not become ready. Try again.'
      : 'o8 next could not start. Try again.');
  }
}

function waitForStartup(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    let settled = false;
    const finish = (error?: NextWindowStartupError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); lines.close(); child.stdout?.resume();
      child.removeListener('exit', failed); child.removeListener('error', failed);
      if (error) reject(error); else resolve();
    };
    const failed = () => finish(new NextWindowStartupError('NEXT_STARTUP_FAILED'));
    const timer = setTimeout(() => finish(new NextWindowStartupError('NEXT_STARTUP_TIMEOUT')), WINDOW_OPEN_TIMEOUT_MS);
    child.once('exit', failed); child.once('error', failed);
    lines.on('line', line => {
      if (line === 'o8-next-ready') {
        if (child.exitCode === null && child.signalCode === null) finish(); else failed();
      } else if (line === 'o8-next-startup-error') failed();
    });
    if (child.exitCode !== null || child.signalCode !== null) failed();
  });
}
type WindowState = { child?: ChildProcess; error: string | null; queue: Promise<unknown>; cleanup?: boolean };
/** Set by the packaged macOS shell: o8 next is the main window, not a Settings switch. */
const isMainWindow = () => process.env.O8_NEXT_MAIN_WINDOW === '1';
/** With Next off, the launcher owns the window and this process only attaches to its control (#6529). */
const launcherControl = () => process.env.O8_NEXT_WINDOW_CONTROL;
const runtime = globalThis as typeof globalThis & { __o8NativeWindow?: WindowState };
const state = runtime.__o8NativeWindow ??= { error: null, queue: Promise.resolve() };

export function nextWindowError(): string | null { return state.error; }

async function stop(): Promise<void> {
  const child = state.child;
  if (!child) return;
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) { state.child = undefined; return; }
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 1_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
  if (state.child === child) state.child = undefined;
}

async function start(startupResult?: string): Promise<void> {
  if (state.child) return;
  const binary = process.env.O8_NEXT_BIN;
  if (process.env.O8_PACKAGED_APP !== '1' || !binary || !isAbsolute(binary)) throw new Error(UNAVAILABLE);
  const directory = getDataDir();
  // No ambient Node flags, worker credentials, provider keys, proxies or account
  // sessions. Retain only the OS variables needed to display a native window.
  const display: Record<string, string | undefined> = {};
  for (const name of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
    'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) display[name] = process.env[name];
  try {
    await access(binary, constants.X_OK);
    const { spawn } = await import('@/lib/providers/child-process');
    const { childEnvironment } = await import('@/lib/providers/spawn-environment');
    const { getOrCreateWsToken } = await import('@/lib/ws-auth');
    // Linux launch ownership: claim the launcher's attempt by renaming its
    // marker after all async work, immediately before spawning. A timed-out
    // launcher cancels with the same rename, so exactly one side wins.
    if (startupResult) {
      try {
        const { writeLinuxWindowOwner } = await import('./linux-window-startup');
        writeLinuxWindowOwner(dirname(startupResult));
        renameSync(join(dirname(startupResult), 'pending'), join(dirname(startupResult), 'claimed'));
      } catch { return; }
    }
    const child = spawn(binary, ['--enable-next', '--app-shell', '--server', getApiBase(),
      '--shell-state', join(directory, 'next-shell.json')], {
      cwd: directory, shell: false, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      env: childEnvironment({ inherit: false, inject: false, env: { ...display, O8_NEXT_API_TOKEN: getOrCreateWsToken(), O8_NEXT_PARENT_PIPE: '1' } }),
    });
    state.child = child;
    bindNextBrowserPipe(child);
    // Errors have fixed public messages; never forward child output or spawn diagnostics.
    child.on('error', () => {});
    child.once('exit', () => { if (state.child === child) state.child = undefined; });
    if (!state.cleanup) {
      state.cleanup = true;
      process.once('exit', () => { state.child?.kill('SIGKILL'); });
      // Next already owns signal shutdown. Closing this lifeline immediately
      // reaps the window even while Next drains active requests. SIGKILL also
      // closes the pipe in the OS, without relying on a JavaScript handler.
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.on(signal, () => { state.child?.stdin?.destroy(); });
      }
    }
    try { await waitForStartup(child); } catch (error) { await stop(); throw error; }
  } catch (error) {
    if (error instanceof NextWindowStartupError) throw error;
    // Spawn errors can retain argv and environment; expose a fixed message only.
    throw new Error(UNAVAILABLE);
  }
}

async function apply(enabled: boolean, startupResult?: string): Promise<void> {
  // The launcher starts, focuses and closes its window; a server restart never does.
  if (launcherControl()) { state.error = null; return; }
  try {
    if (enabled) await start(startupResult); else await stop();
    state.error = null;
  } catch (error) {
    state.error = error instanceof NextWindowStartupError ? error.message : UNAVAILABLE;
    throw error instanceof NextWindowStartupError ? error : new Error(UNAVAILABLE);
  }
}

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const operation = state.queue.catch(() => {}).then(work);
  state.queue = operation;
  return operation;
}

export function changeNextWindowPreference<T>(enabled: boolean | undefined, save: () => Promise<T>): Promise<T> {
  return serialized(async () => {
    // The main window stays open; turning the old switch off only saves it.
    if (enabled === undefined || (enabled === false && isMainWindow())) return save();
    const wasOpen = Boolean(state.child);
    await apply(enabled);
    try { return await save(); } catch (error) {
      await apply(wasOpen).catch(() => {});
      throw error;
    }
  });
}

export function setNextWindowEnabled(enabled: boolean): Promise<void> {
  return changeNextWindowPreference(enabled, async () => {});
}

/** Called only by packaged server startup; false never reads the bearer or binary. */
export async function restoreNextWindow(): Promise<void> {
  const control = launcherControl();
  if (control) { attachLauncherWindow(control, process.env.O8_NEXT_WINDOW_CONTROL_KEY ?? ''); return; }
  const result = process.platform === 'linux' && isMainWindow() ? process.env.O8_NEXT_STARTUP_RESULT : undefined;
  await serialized(async () => {
    // The shell gives the window binary only to the process that owns the
    // window. The WS process also sees O8_NEXT_MAIN_WINDOW (for update apply),
    // and must not claim the window or report it unavailable.
    if (!process.env.O8_NEXT_BIN) return;
    if (isMainWindow() || (await getOperatorDefaults()).values.experimentalNext) {
      await apply(true, result && isAbsolute(result) ? result : undefined);
    }
  }).catch(() => {});
  // A Linux launcher must wait for this actual attempt, including a delayed
  // startup hook and the child's full first-paint timeout. Failure is published
  // only after start() has reaped the child, so a CLI fallback cannot race it.
  if (result && isAbsolute(result)) {
    const status = state.child?.exitCode === null && state.child.signalCode === null && !state.error ? 'ready' : 'failed';
    await writeFile(`${result}.tmp`, JSON.stringify({ status }), { mode: 0o600 })
      .then(() => rename(`${result}.tmp`, result)).catch(() => {});
  }
}

/**
 * Browser control for the launcher-owned window, over the launcher's private socket.
 * The socket stands in for the child pipe: lines in reach the window's stdin, result
 * lines come back. Its close ends pending requests exactly as a window exit did.
 */
function attachLauncherWindow(path: string, key: string): void {
  if (!isAbsolute(path) || !key) return;
  void import('node:net').then(({ createConnection }) => {
    const socket = createConnection(path);
    // Written before any frame; a stream keeps write order across the connect.
    socket.write(`${key}\n`);
    const window = Object.assign(new EventEmitter(), {
      stdin: socket, stdout: socket, pid: undefined, exitCode: null as number | null, signalCode: null,
    });
    socket.on('error', () => {});
    socket.once('close', () => {
      window.exitCode = 0;
      window.emit('exit', 0, null);
      // The launcher outlives this process; a lost attachment is retried.
      setTimeout(() => attachLauncherWindow(path, key), 1_000).unref?.();
    });
    bindNextBrowserPipe(window as unknown as ChildProcess);
  }).catch(() => {});
}
