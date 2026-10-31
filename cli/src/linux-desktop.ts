/** Linux desktop entry. CLI subcommands continue to use the ordinary CLI bundle. */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolveCliDataDir } from './config.js';
import { linuxWindowOwnerIsDead } from '../../src/lib/next/linux-window-startup.js';

// The stage places this entry in <payload>/server/cli/ beside o8.mjs.
const payload = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const binary = realpathSync(join(payload, 'o8-next'));
const directory = resolve(resolveCliDataDir());
const shellState = join(directory, 'next-shell.json');
const cli = join(payload, 'server/cli/o8.mjs');
// Allow delayed bootstrap plus the server's 15-second first-paint deadline.
// Expiry reports an error; it never starts a competing window.
const SERVER_WINDOW_RESULT_TIMEOUT_MS = 60_000;
// Bound this launcher's wait, while retaining a live claim for later launches.
// A pause between claim and spawn precedes app-window's first-paint timer.
const CLAIMED_ATTEMPT_GRACE_MS = 20_000;
const WINDOW_STARTING = 'o8 is still opening its window. Try launching again shortly.';

function record(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Invalid CLI output is never evidence of a healthy/reusable daemon. */ }
  return undefined;
}

type CliResult = { code: number; stdout: string; stderr: string };
function reusableServeError(result: CliResult): boolean {
  // Prefer the structured stdout response. The ordinary CLI currently emits
  // error envelopes on stderr, one pretty-printed JSON object per write; keep
  // surrounding runtime warnings separate instead of merging the streams.
  const responses = [record(result.stdout),
    ...Array.from(result.stderr.matchAll(/^\{[\s\S]*?^\}/gm), match => record(match[0]))];
  for (const response of responses) {
    const error = response?.error;
    if (response?.schema !== 'o8/cli/error/v1' || !error || typeof error !== 'object' || Array.isArray(error)) continue;
    const detail = error as Record<string, unknown>;
    if (typeof detail.code !== 'string' || typeof detail.message !== 'string') continue;
    return ['serve_already_running', 'serve_desktop_owns_data_dir'].includes(detail.code);
  }
  return false;
}
function healthy(result: CliResult): boolean {
  const status = record(result.stdout);
  return result.code === 0 && status?.schema === 'o8/cli/serve-status/v1'
    && status.running === true && status.healthy === true
    && typeof status.pid === 'number' && Number.isSafeInteger(status.pid) && status.pid > 0;
}

async function runCli(args: string[], capture = false, timeoutMs?: number): Promise<CliResult> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', timeout: timeoutMs, killSignal: 'SIGKILL',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    const forward = () => { child.kill('SIGTERM'); };
    process.once('SIGINT', forward); process.once('SIGTERM', forward);
    const cleanup = () => { process.off('SIGINT', forward); process.off('SIGTERM', forward); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => { cleanup(); done({ code: code ?? 1, stdout, stderr }); });
  });
}

function windowIsOpen(): boolean {
  // Linux has no application singleton for a raw GPUI executable. Scope reuse to
  // this installed executable and data directory, including server-owned windows.
  for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try {
      const path = `/proc/${pid}`;
      if (statSync(path).uid !== process.getuid!() || readlinkSync(`${path}/exe`) !== binary) continue;
      const args = readFileSync(`${path}/cmdline`, 'utf8').split('\0');
      const stateAt = args.indexOf('--shell-state');
      if (stateAt >= 0 && args[stateAt + 1] === shellState && args.includes('--app-shell')
        && !args.includes('--offscreen')) return true;
    } catch { /* A process may exit between directory enumeration and inspection. */ }
  }
  return false;
}

// The server claims an attempt by renaming `pending` just before it spawns;
// the launcher cancels with the same rename. Exactly one of them wins.
function cancelAttempt(attempt: string): boolean {
  try {
    renameSync(join(attempt, 'pending'), join(attempt, 'cancelled'));
    return true;
  } catch { return false; }
}

function windowResult(attempt: string): 'ready' | 'failed' | undefined {
  try {
    const result = record(readFileSync(join(attempt, 'result.json'), 'utf8'));
    if (result?.status === 'ready' || result?.status === 'failed') return result.status;
  } catch { /* No published result yet. */ }
  return undefined;
}

function cleanFinishedAttempt(attempt: string): boolean {
  if (!cancelAttempt(attempt) && !windowResult(attempt)) {
    // Observe pending before claimed: the server can rename between probes.
    if (existsSync(join(attempt, 'pending'))) return false;
    if (existsSync(join(attempt, 'claimed')) && !linuxWindowOwnerIsDead(attempt)) return false;
  }
  rmSync(attempt, { recursive: true, force: true });
  return true;
}

async function serverWindowResult(attempt: string): Promise<'ready' | 'failed'> {
  let deadline = Date.now() + SERVER_WINDOW_RESULT_TIMEOUT_MS;
  let claimed = false;
  let healthAt = 0;
  for (;;) {
    const result = windowResult(attempt);
    if (result) return result;
    if (existsSync(join(attempt, 'claimed')) && linuxWindowOwnerIsDead(attempt)) {
      throw new Error('The server exited before reporting its window startup result.');
    }
    if (Date.now() >= deadline) {
      if (claimed) throw new Error(WINDOW_STARTING);
      if (cancelAttempt(attempt) || !existsSync(join(attempt, 'claimed'))) {
        throw new Error('The server did not report its window startup result within 60 seconds. Try launching o8 again.');
      }
      claimed = true;
      deadline = Date.now() + CLAIMED_ATTEMPT_GRACE_MS;
    }
    if (Date.now() >= healthAt) {
      let status: CliResult | undefined;
      try { status = await runCli(['serve', 'status'], true, Math.max(1, deadline - Date.now())); }
      catch { /* A failed probe cannot revoke a server's claim. */ }
      if (Date.now() >= deadline) continue;
      if ((!status || !healthy(status)) && !existsSync(join(attempt, 'claimed'))) {
        throw new Error('The server stopped being healthy before reporting its window startup result.');
      }
      healthAt = Date.now() + 1_000;
    }
    await delay(100);
  }
}

async function openDesktop(): Promise<number> {
  if (process.platform !== 'linux') throw new Error('The Linux desktop launcher requires Linux.');
  mkdirSync(directory, { recursive: true });
  const lock = openSync(join(directory, 'linux-desktop.lock'), 'a', 0o600);
  let released = false;
  let attempt: string | undefined;
  try {
    // flock locks the inherited open file description; this process retains it
    // until launch completes. No stale PID lock.
    const acquired = spawnSync('flock', ['--nonblock', '3'], { stdio: ['ignore', 'ignore', 'inherit', lock] });
    if (acquired.status === 1) return 0;
    if (acquired.error || acquired.status !== 0) throw new Error('The Linux desktop launcher requires util-linux flock.');
    process.env.O8_PACKAGED_APP = '1';
    process.env.O8_NEXT_BIN = binary;
    process.env.O8_NEXT_MAIN_WINDOW = '1';
    process.env.O8_DATA_DIR = directory;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('linux-window-startup-')
        && !cleanFinishedAttempt(join(directory, entry.name))) throw new Error(WINDOW_STARTING);
    }
    if (windowIsOpen()) {
      const status = await runCli(['serve', 'status'], true);
      if (healthy(status)) return 0;
      // A CLI-owned window can outlive a stopped daemon. Leave that window's
      // visible retry state intact rather than creating a second main window.
      throw new Error('An o8 next window is still open, but its server is not healthy. Close that window and launch o8 again.');
    }
    // Run the CLI as its own entry point: serve re-execs argv[1] for the daemon.
    attempt = mkdtempSync(join(directory, 'linux-window-startup-'));
    writeFileSync(join(attempt, 'pending'), '', { mode: 0o600 });
    const resultFile = join(attempt, 'result.json');
    process.env.O8_NEXT_STARTUP_RESULT = resultFile;
    const serve = await runCli(['serve'], true);
    if (serve.code === 0 && !healthy(serve)) throw new Error('The server returned an invalid startup status.');
    const started = serve.code === 0;
    if (!started) {
      if (!reusableServeError(serve) || !healthy(await runCli(['serve', 'status'], true))) {
        process.stderr.write(serve.stderr);
        process.stdout.write(serve.stdout);
        return serve.code;
      }
    }
    if (started) {
      // The server owns the actual first-paint deadline and reaps failures.
      // Its hook can start arbitrarily later than serve's health response.
      const result = await serverWindowResult(attempt);
      if (result === 'ready' && windowIsOpen()) return 0;
    } else if (windowIsOpen()) return 0;
    // A terminal daemon cannot inherit this launcher's packaged environment.
    // The existing CLI resolves its health, ports, credentials and shell state.
    let finished = false;
    const next = runCli(['next', '--binary', binary]);
    void next.then(() => { finished = true; }, () => { finished = true; });
    while (!finished && !windowIsOpen()) await delay(100);
    // Keep the CLI's signal/exit lifecycle, but release launch exclusion once
    // /proc can identify the window. Later clicks can check daemon health.
    closeSync(lock);
    released = true;
    return (await next).code;
  } finally {
    // Keep unresolved claims across launcher exits and failed health probes.
    try { if (attempt) cleanFinishedAttempt(attempt); }
    finally { if (!released) closeSync(lock); }
  }
}

try {
  process.exitCode = await openDesktop();
} catch (error) {
  process.stderr.write(`o8: ${error instanceof Error ? error.message : 'Desktop launch failed.'}\n`);
  process.exitCode = 1;
}
