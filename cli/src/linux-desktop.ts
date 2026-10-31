/** Linux desktop entry. CLI subcommands continue to use the ordinary CLI bundle. */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolveCliDataDir } from './config.js';

// The stage places this entry in <payload>/server/cli/ beside o8.mjs.
const payload = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const binary = realpathSync(join(payload, 'o8-next'));
const directory = resolve(resolveCliDataDir());
const shellState = join(directory, 'next-shell.json');
const cli = join(payload, 'server/cli/o8.mjs');

function shellRevision(): string | undefined {
  try {
    const file = statSync(shellState);
    return `${file.ino}:${file.mtimeMs}`;
  } catch { return undefined; }
}

async function runCli(args: string[], capture = false): Promise<{ code: number; output: string }> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let output = '';
    child.stdout?.on('data', chunk => { output += String(chunk); });
    child.stderr?.on('data', chunk => { output += String(chunk); });
    const forward = () => { child.kill('SIGTERM'); };
    process.once('SIGINT', forward); process.once('SIGTERM', forward);
    const cleanup = () => { process.off('SIGINT', forward); process.off('SIGTERM', forward); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => { cleanup(); done({ code: code ?? 1, output }); });
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
      if (stateAt >= 0 && args[stateAt + 1] === shellState && args.includes('--app-shell')) return true;
    } catch { /* A process may exit between directory enumeration and inspection. */ }
  }
  return false;
}

async function openDesktop(): Promise<number> {
  if (process.platform !== 'linux') throw new Error('The Linux desktop launcher requires Linux.');
  mkdirSync(directory, { recursive: true });
  const lock = openSync(join(directory, 'linux-desktop.lock'), 'a', 0o600);
  let released = false;
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
    if (windowIsOpen()) {
      const status = await runCli(['serve', 'status'], true);
      if (status.code === 0 && JSON.parse(status.output).healthy === true) return 0;
      // A CLI-owned window can outlive a stopped daemon. Leave that window's
      // visible retry state intact rather than creating a second main window.
      throw new Error('An o8 next window is still open, but its server is not healthy. Close that window and launch o8 again.');
    }
    // Run the CLI as its own entry point: serve re-execs argv[1] for the daemon.
    const previousShell = shellRevision();
    const serve = await runCli(['serve'], true);
    const started = serve.code === 0;
    if (!started) {
      let code;
      try { code = JSON.parse(serve.output).error?.code; } catch { /* Unstructured failure is not a reusable daemon. */ }
      if (!['serve_already_running', 'serve_desktop_owns_data_dir'].includes(code)) {
        process.stderr.write(serve.output);
        return serve.code;
      }
    }
    if (started) {
      // app-window.ts owns the initial window and its 15-second first-paint
      // deadline. Let that attempt finish before considering the CLI fallback.
      const deadline = Date.now() + 16_000;
      while (Date.now() < deadline) {
        // A PID can appear and immediately fail display initialization. The
        // shell saves state after connecting; do not mistake that PID for an
        // opened window and skip the environment-preserving CLI fallback.
        if (windowIsOpen() && shellRevision() !== previousShell) return 0;
        await delay(100);
      }
      if (windowIsOpen()) return 0;
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
    if (!released) closeSync(lock);
  }
}

try {
  process.exitCode = await openDesktop();
} catch (error) {
  process.stderr.write(`o8: ${error instanceof Error ? error.message : 'Desktop launch failed.'}\n`);
  process.exitCode = 1;
}
