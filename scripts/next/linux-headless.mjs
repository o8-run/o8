/** Real X11/Vulkan shell smoke. Run inside a private Xvfb display, never --offscreen. */
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

class VerificationError extends Error {}
function safeReason(error) {
  return error instanceof VerificationError ? error.message : 'Headless verification failed';
}
const keys = ['launchToFirstFrameMs', 'idleRssMiB'];
function readJson(file) { return JSON.parse(readFileSync(realpathSync(file), 'utf8')); }
function samples(runs) {
  if (!Array.isArray(runs) || runs.length !== 3 || runs.some(run =>
    !run || keys.some(key => !Number.isFinite(run[key]) || run[key] <= 0))) {
    throw new VerificationError('Expected three complete positive finite measurements');
  }
  return runs;
}
function check(receipt, budget) {
  if (receipt.schema !== 1 || budget.schema !== 1) throw new VerificationError('Invalid measurement schema');
  samples(budget.baseline);
  const failures = [];
  for (const [index, run] of samples(receipt.runs).entries()) {
    for (const key of keys) {
      if (!Number.isFinite(budget[key]) || budget[key] <= 0) throw new VerificationError('Invalid budget');
      if (run[key] > budget[key]) failures.push(`run ${index + 1} ${key} ${run[key]} exceeds ${budget[key]}`);
    }
  }
  if (failures.length) throw new VerificationError(failures.join('\n'));
  console.log('Three runs within launch and idle RSS budgets');
}

// Deliberately omit inherited application credentials, account bindings and data paths.
function environment(root, token) {
  const env = { NODE_ENV: 'test', O8_NEXT_API_TOKEN: token, XDG_CACHE_HOME: join(root, 'cache') };
  for (const key of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'LD_LIBRARY_PATH', 'DISPLAY',
    'XAUTHORITY', 'VK_DRIVER_FILES', 'VK_ICD_FILENAMES', 'LIBGL_ALWAYS_SOFTWARE',
    'DBUS_SESSION_BUS_ADDRESS', 'FONTCONFIG_FILE', 'FONTCONFIG_PATH']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}
async function stop(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const kill = setTimeout(() => child.kill('SIGKILL'), 1500);
  try { await exited; } finally { clearTimeout(kill); }
}
function alive(child, name) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) throw new VerificationError(`${name} exited before measurement completed`);
}
async function until(predicate, child, name, timeoutMs = 15_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    alive(child, name);
    if (await predicate()) return;
    await delay(40);
  }
  throw new VerificationError(`${name} timed out`);
}
function capture(file, env, sampled = false) {
  // Root of a dedicated display: independent of focus, window-manager decoration or window ids.
  execFileSync('import', ['-window', 'root', `png:${file}`], { env, stdio: 'pipe', timeout: 3000 });
  const bytes = readFileSync(file);
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || bytes.readUInt32BE(16) < 600 || bytes.readUInt32BE(20) < 400) throw new VerificationError('Invalid display screenshot');
  // Poll a subset of original pixels, without interpolation or new colors.
  // A full-frame histogram can take seconds and delay observing an already
  // painted frame. Keep full-image checks before launch and after idle.
  const colors = Number(execFileSync(sampled ? 'convert' : 'identify',
    sampled ? [file, '-sample', '25%', '-format', '%k', 'info:'] : ['-format', '%k', file],
    { env, encoding: 'utf8', timeout: 3000 }));
  return Number.isFinite(colors) && colors > 32;
}
async function measure(index, options, progress) {
  progress.stage = 'fixture-host';
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-next-linux-')));
  const env = environment(root, randomBytes(32).toString('hex'));
  let host;
  let app;
  try {
    const requestLog = join(root, 'requests.json');
    host = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
      options.host, '--shell'], { env: { ...env, O8_NEXT_REQUEST_LOG: requestLog }, stdio: ['ignore', 'pipe', 'ignore'] });
    let origin;
    let configDir;
    host.on('error', () => {});
    const lines = createInterface({ input: host.stdout });
    lines.on('line', line => {
      try {
        const data = JSON.parse(line);
        origin = data.origin || origin;
        configDir = data.configDir || configDir;
      } catch { /* The fixture host also writes non-JSON diagnostics. */ }
    });
    try { await until(() => origin && configDir, host, 'fixture host', 30_000); }
    finally { lines.close(); }
    const url = new URL(origin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw new VerificationError('Invalid fixture origin');
    configDir = realpathSync(configDir);
    const state = join(configDir, 'linux-shell.json');
    const image = join(options.output, `shell-${index}.png`);
    // Require an empty display before launch; stale or unrelated windows cannot satisfy first frame.
    if (capture(image, env)) throw new VerificationError('Display must be empty before shell launch');
    const started = performance.now();
    progress.stage = 'first-frame';
    app = spawn(options.binary, ['--enable-next', '--app-shell', '--server', origin,
      '--shell-state', state], { env, stdio: 'ignore' });
    app.on('error', () => {});
    await until(() => {
      // Bare Xvfb has no window manager to expose a newly mapped inactive window.
      execFileSync('xrefresh', ['-none'], { env, stdio: 'pipe', timeout: 3000 });
      return capture(image, env, true);
    }, app, 'first frame');
    const launchToFirstFrameMs = Math.round((performance.now() - started) * 100) / 100;
    progress.stage = 'fixture-state';
    await until(() => {
      if (!existsSync(state)) return false;
      const saved = readJson(state);
      return saved.selected && saved.workspaces?.[saved.selected]?.tabs?.length > 0;
    }, app, 'fixture shell state');
    await delay(2000);
    progress.stage = 'idle-rss';
    const rss = [];
    for (let n = 0; n < 5; n++) {
      alive(app, 'shell');
      // Portable KiB contract on Linux and macOS, including all native renderer threads.
      const value = Number(execFileSync('ps', ['-p', String(app.pid), '-o', 'rss='], { env, encoding: 'utf8', timeout: 3000 }));
      if (!Number.isFinite(value) || value <= 0) throw new VerificationError('Invalid shell RSS');
      rss.push(value / 1024);
      await delay(200);
    }
    if (!capture(image, env)) throw new VerificationError('Shell frame disappeared while idle');
    alive(app, 'shell');
    await stop(app);
    await stop(host);
    progress.stage = 'fixture-requests';
    const requests = readJson(requestLog);
    for (const route of ['GET /api/mobile/orchestrator/threads', 'GET /api/mobile/history']) {
      if (!requests.includes(route)) throw new VerificationError('Shell did not read the production fixture routes');
    }
    const result = { launchToFirstFrameMs, idleRssMiB: Math.round(Math.max(...rss) * 100) / 100 };
    console.log(JSON.stringify({ run: index, ...result }));
    return result;
  } finally {
    await stop(app);
    await stop(host);
    rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const options = { binary: resolve('native/o8-next/target/release/o8-next'),
    host: resolve('scripts/next/dev-server.ts'), output: resolve('work/next-linux'),
    budget: resolve('native/o8-next/linux-budgets.json') };
  let receipt;
  let record = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i].slice(2);
    if (args[i] === '--record') record = true;
    else if (args[i] === '--check' && args[i + 1]) receipt = args[++i];
    else if (Object.hasOwn(options, key) && args[i + 1]) options[key] = resolve(args[++i]);
    else throw new VerificationError('Use --binary FILE --output DIR --budget FILE [--record | --check RECEIPT]');
  }
  if (receipt) { check(readJson(receipt), readJson(options.budget)); return; }
  mkdirSync(options.output, { recursive: true });
  const progress = { stage: 'display', run: 0, completedRuns: 0 };
  try {
    rmSync(join(options.output, 'failure.json'), { force: true });
    if (!process.env.DISPLAY) throw new VerificationError('Run inside an isolated Xvfb display');
    const runs = [];
    for (let index = 1; index <= 3; index++) {
      progress.run = index;
      runs.push(await measure(index, options, progress));
      progress.completedRuns = runs.length;
      writeFileSync(join(options.output, 'measurements.json'), `${JSON.stringify({ schema: 1, runs }, null, 2)}\n`);
    }
    const result = { schema: 1, runs };
    progress.stage = 'budgets';
    if (record) {
      samples(runs);
      writeFileSync(options.budget, `${JSON.stringify({ schema: 1,
        launchToFirstFrameMs: Math.ceil(Math.max(...runs.map(r => r.launchToFirstFrameMs)) * 1.25),
        idleRssMiB: Math.ceil(Math.max(...runs.map(r => r.idleRssMiB)) * 1.25), baseline: runs }, null, 2)}\n`);
    }
    check(result, readJson(options.budget));
  } catch (error) {
    // Publish only controlled stage/count fields and our bounded errors, never child diagnostics.
    writeFileSync(join(options.output, 'failure.json'), `${JSON.stringify({ schema: 1, status: 'failed',
      ...progress, reason: safeReason(error) }, null, 2)}\n`);
    throw error;
  }
}
main().catch(error => {
  // Child diagnostics can contain platform paths or credentials; publish only our bounded errors.
  console.error(safeReason(error));
  process.exitCode = 1;
});
