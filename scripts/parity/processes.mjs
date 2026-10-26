import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function environment(root, token) {
  const env = { NODE_ENV: 'test', NEXT_TELEMETRY_DISABLED: '1', O8_NEXT_API_TOKEN: token,
    XDG_CACHE_HOME: join(root, 'cache') };
  for (const key of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LD_LIBRARY_PATH', 'DISPLAY', 'XAUTHORITY',
    'VK_DRIVER_FILES', 'VK_ICD_FILENAMES', 'LIBGL_ALWAYS_SOFTWARE', 'FONTCONFIG_PATH', 'FONTCONFIG_FILE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}
export function launch(file, args, env, log, piped = false) {
  const fd = openSync(log, 'w', 0o600);
  const child = spawn(file, args, { env, stdio: ['ignore', piped ? 'pipe' : fd, fd] });
  closeSync(fd);
  if (piped) child.stdout.on('data', chunk => appendFileSync(log, chunk));
  child.on('error', () => {});
  return child;
}
export async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  try { await exited; } finally { clearTimeout(timer); }
}
export async function until(child, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) throw new Error('Capture child exited');
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error('Capture child timed out');
}
