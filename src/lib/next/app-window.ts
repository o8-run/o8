import { isAbsolute, join } from 'node:path';
import type { ChildProcess } from '@/lib/providers/child-process';
import { access, constants } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { getDataDir } from '@/lib/data-dir-migration';
import { getOperatorDefaults } from '@/lib/operator/defaults';
import { getApiBase } from '@/lib/panel/api-port';

const UNAVAILABLE = 'o8 next is unavailable. Reinstall the app and try again.';
const STARTUP_TIMEOUT_MS = 15_000;
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
    const timer = setTimeout(() => finish(new NextWindowStartupError('NEXT_STARTUP_TIMEOUT')), STARTUP_TIMEOUT_MS);
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

async function start(): Promise<void> {
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
    const child = spawn(binary, ['--enable-next', '--app-shell', '--server', getApiBase(),
      '--shell-state', join(directory, 'next-shell.json')], {
      cwd: directory, shell: false, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      env: childEnvironment({ inherit: false, inject: false, env: { ...display, O8_NEXT_API_TOKEN: getOrCreateWsToken(), O8_NEXT_PARENT_PIPE: '1' } }),
    });
    state.child = child;
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

async function apply(enabled: boolean): Promise<void> {
  try {
    if (enabled) await start(); else await stop();
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
    if (enabled === undefined) return save();
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
  await serialized(async () => {
    const { values } = await getOperatorDefaults();
    if (values.experimentalNext) await apply(true);
  }).catch(() => {});
}
