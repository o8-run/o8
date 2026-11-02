#!/usr/bin/env node
/** Installed GPUI/server proof. Run on a private Xvfb display, with software Vulkan. */
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
if (args.length !== 4 || !['--stage', '--appimage', '--installed-root'].includes(args[0]) || args[2] !== '--output' || !process.env.DISPLAY) {
  console.error('Usage on a private display: smoke-payload.mjs --stage PAYLOAD|--appimage FILE|--installed-root ROOT --output RECEIPT_DIRECTORY');
  process.exit(1);
}
const output = resolve(args[3]);
if (existsSync(output)) {
  console.error('Choose a new receipt directory; existing proof is never overwritten.');
  process.exit(1);
}
mkdirSync(output);
const root = mkdtempSync(join(tmpdir(), 'o8-linux-installed-'));
const home = join(root, 'home');
mkdirSync(home);
let installed = join(root, 'installed payload');
let launcher;
if (args[0] === '--installed-root') {
  installed = resolve(args[1]);
  launcher = join(installed, 'usr/bin/o8');
} else if (args[0] === '--appimage') {
  launcher = join(root, 'o8.AppImage');
  cpSync(resolve(args[1]), launcher);
  installed = execFileSync(launcher, ['--o8-appimage-root'], { env: environment(join(root, 'probe')),
    encoding: 'utf8', timeout: 60_000 }).trim();
  if (!installed.startsWith(join(home, '.local/share/o8/appimage/'))) throw new Error('Unexpected AppImage application path');
} else {
  cpSync(resolve(args[1]), installed, { recursive: true });
  launcher = join(installed, 'usr/bin/o8');
}
const binary = join(installed, 'usr/lib/o8/o8-next');
const results = [];

function environment(data) {
  const env = { HOME: home, PATH: '/usr/bin:/bin', NODE_ENV: 'production',
    O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data };
  for (const key of ['DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'LANG',
    'VK_DRIVER_FILES', 'VK_ICD_FILENAMES', 'LIBGL_ALWAYS_SOFTWARE', 'FONTCONFIG_FILE', 'FONTCONFIG_PATH', 'APPIMAGE_EXTRACT_AND_RUN']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}
function cli(env, ...args) {
  return execFileSync(launcher, args, { env, encoding: 'utf8', timeout: 150_000 });
}
function windows(data) {
  return readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(pid => {
    try {
      if (readlinkSync(`/proc/${pid}/exe`) !== binary) return [];
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      return argv[argv.indexOf('--shell-state') + 1] === join(data, 'next-shell.json') ? [Number(pid)] : [];
    } catch { return []; }
  });
}
async function until(check, label, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try { await exited; } finally { clearTimeout(timer); }
}
function frame(env, name) {
  execFileSync('xrefresh', ['-none'], { env });
  const file = join(output, `${name}.png`);
  execFileSync('import', ['-window', 'root', `png:${file}`], { env, timeout: 5_000 });
  const colors = Number(execFileSync('identify', ['-format', '%k', file], { env, encoding: 'utf8' }));
  return colors > 32;
}
async function measure(terminalDaemon) {
  const name = terminalDaemon ? 'terminal-daemon' : 'fresh-server';
  const data = join(root, name);
  const env = environment(data);
  let app;
  let reopened;
  let originalPid;
  let launcherOutput = '';
  console.log(`[linux-payload] ${name}: start`);
  try {
    if (terminalDaemon) {
      cli(env, 'serve');
      originalPid = JSON.parse(cli(env, 'serve', 'status')).pid;
      if (windows(data).length) throw new Error('Terminal daemon unexpectedly opened a window');
    }
    if (frame(env, `${name}-before`)) throw new Error('The proof requires an empty private display');
    const started = performance.now();
    app = spawn(launcher, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    app.stdout.on('data', chunk => { launcherOutput += String(chunk); });
    app.stderr.on('data', chunk => { launcherOutput += String(chunk); });
    await until(() => windows(data).length === 1 && existsSync(join(data, 'next-shell.json')),
      `${name} connected shell state`);
    await until(() => frame(env, name), `${name} first frame`, 20_000);
    const firstFrameMs = Math.round(performance.now() - started);
    const daemon = JSON.parse(cli(env, 'serve', 'status'));
    if (!daemon.healthy || (originalPid && originalPid !== daemon.pid)) throw new Error('Healthy daemon was not reused');
    // Fresh state is saved by the shell only after its session/workspace load succeeds.
    JSON.parse(readFileSync(join(data, 'next-shell.json'), 'utf8'));
    cli(env); // A repeated desktop launch must reuse this window.
    if (windows(data).length !== 1) throw new Error('Repeated launch duplicated the window');
    await delay(2_000);
    const rss = [];
    const serverRss = [];
    const windowPid = windows(data)[0];
    const parentPid = Number(readFileSync(`/proc/${windowPid}/status`, 'utf8').match(/^PPid:\s+(\d+)$/m)?.[1]);
    const windowOwner = daemon.children.some(child => child.pid === parentPid) ? 'server' : 'launcher';
    if (terminalDaemon && windowOwner !== 'launcher') throw new Error('Terminal daemon case did not use the launcher fallback');
    const serverPids = [...new Set([daemon.pid, daemon.supervisorPid, ...daemon.children.map(child => child.pid)].filter(Boolean))];
    if (serverPids.some(pid => readlinkSync(`/proc/${pid}/exe`) !== join(installed, 'usr/lib/o8/node'))) {
      throw new Error('A server process used an external Node runtime');
    }
    for (let i = 0; i < 5; i++) {
      rss.push(Number(execFileSync('ps', ['-p', String(windowPid), '-o', 'rss='], { encoding: 'utf8' })) / 1024);
      serverRss.push(execFileSync('ps', ['-p', serverPids.join(','), '-o', 'rss='], { encoding: 'utf8' })
        .trim().split(/\s+/).reduce((sum, value) => sum + Number(value), 0) / 1024);
      await delay(200);
    }
    if (rss.some(value => !Number.isFinite(value) || value <= 0)) throw new Error('Invalid idle RSS');
    process.kill(windowPid, 'SIGTERM');
    await until(() => windows(data).length === 0, 'window close', 10_000);
    await stop(app);
    reopened = spawn(launcher, [], { env, stdio: 'ignore' });
    await until(() => windows(data).length === 1, 'window reopen', 30_000);
    if (JSON.parse(cli(env, 'serve', 'status')).pid !== daemon.pid) throw new Error('Reopen replaced the daemon');
    // AppImage's outer extraction process is not the native window. Close the
    // actual window, as above, before waiting for its launcher to settle.
    process.kill(windows(data)[0], 'SIGTERM');
    await until(() => windows(data).length === 0, 'reopened window close', 10_000);
    await stop(reopened);
    const result = { case: name, connected: true, firstFrameMs, idleRssMiB: Math.round(Math.max(...rss) * 100) / 100,
      serverIdleRssMiB: Math.round(Math.max(...serverRss) * 100) / 100,
      windowOwner, repeatedLaunchWindows: 1, reopened: true, daemonReused: true, bundledRuntime: true };
    results.push(result);
    console.log(JSON.stringify(result));
  } finally {
    writeFileSync(join(output, `${name}-launcher.log`), launcherOutput);
    await stop(reopened);
    await stop(app);
    for (const pid of windows(data)) {
      try { process.kill(pid, 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    // Only this profile's serve lifecycle owns the daemon and its descendants.
    try {
      cli(env, 'serve', 'stop');
      if (JSON.parse(cli(env, 'serve', 'status')).running) throw new Error('Daemon still running');
      await until(() => windows(data).length === 0, 'owned window cleanup', 10_000);
    } finally {
      if (existsSync(join(data, 'logs/serve.log'))) cpSync(join(data, 'logs/serve.log'), join(output, `${name}-serve.log`));
    }
  }
}

try {
  await measure(false);
  await measure(true);
  if (args[0] !== '--installed-root') rmSync(installed, { recursive: true });
  for (const name of ['fresh-server', 'terminal-daemon']) {
    if (!existsSync(join(root, name, 'next-shell.json'))) throw new Error('Removing the installation lost user data');
  }
  const receipt = { schema: 1, status: 'passed', format: args[0].slice(2),
    installationRemovedDataPreserved: args[0] !== '--installed-root',
    ...(args[0] === '--installed-root' ? { retainedProfileRoot: root } : {}), runs: results };
  writeFileSync(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  if (args[0] !== '--installed-root') rmSync(root, { recursive: true });
} catch (error) {
  console.error(`[linux-payload] failed: ${error.message}; diagnostic state retained at ${root}`);
  process.exitCode = 1;
}
