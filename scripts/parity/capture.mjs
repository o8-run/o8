import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { environment, launch, stop, until } from './processes.mjs';
import { captureWeb } from './web.mjs';

function receipt(child) {
  const value = {};
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try { Object.assign(value, JSON.parse(line)); } catch { /* Fixed startup diagnostics are not receipts. */ }
  });
  return { value, close: () => lines.close() };
}
const run = (file, args, env) => execFileSync(file, args, { env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
function screenshot(id, file, env, size) {
  run('xrefresh', ['-none'], env);
  run('import', ['-window', id, `png:${file}`], env);
  const bytes = readFileSync(file);
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || bytes.readUInt32BE(16) !== size[0] || bytes.readUInt32BE(20) !== size[1]) throw new Error('Native viewport differs from requested size');
  return Number(run('identify', ['-format', '%k', file], env)) > 32;
}
async function nativePixels(options, scenario, state, fixture, env, output, size, log) {
  const app = launch(options.binary, ['--enable-next', '--app-shell', '--server', fixture.origin, '--shell-state', state], env, log);
  try {
    let id;
    await until(app, () => {
      try { id = run('xdotool', ['search', '--pid', String(app.pid), '--name', '^o8 next$'], env).trim().split('\n')[0]; return id; }
      catch { return false; }
    });
    await until(app, () => {
      try { return screenshot(id, output, env, size); } catch { return false; }
    });
    run('xdotool', ['windowfocus', id], env);
    if (scenario.nativeKeys) run('xdotool', ['key', '--window', id, '--clearmodifiers', scenario.nativeKeys], env);
    if (scenario.nativeCommand) {
      run('xdotool', ['key', '--window', id, '--clearmodifiers', 'ctrl+k'], env);
      run('xdotool', ['type', '--window', id, '--clearmodifiers', '--delay', '10', scenario.nativeCommand], env);
      run('xdotool', ['key', '--window', id, 'Return'], env);
    }
    await delay(700);
    screenshot(id, output, env, size);
    if (app.exitCode !== null || app.signalCode !== null) throw new Error('Native process exited');
  } finally { await stop(app); }
}
function testBinary(options) {
  if (options.nativeTest) return resolve(options.nativeTest);
  const result = spawnSync('cargo', ['test', '--locked', '--manifest-path', 'native/o8-next/Cargo.toml',
    '--bin', 'o8-next', '--no-run', '--message-format=json'], { encoding: 'utf8', timeout: 240_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Native test compilation failed');
  const files = result.stdout.split('\n').flatMap(line => {
    try { const entry = JSON.parse(line); return entry.reason === 'compiler-artifact' && entry.profile.test && entry.executable ? [entry.executable] : []; } catch { return []; }
  });
  if (files.length !== 1) throw new Error('Native test executable missing');
  return files[0];
}
export async function capture(manifest, options) {
  if (!process.env.DISPLAY || !existsSync(options.binary)) throw new Error('Build o8 next and run inside a private Xvfb display');
  mkdirSync(options.output, { recursive: true });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-parity-')));
  const logs = join(root, 'logs');
  mkdirSync(logs);
  const token = randomBytes(32).toString('hex');
  const env = environment(root, token);
  const data = join(root, 'web-data');
  mkdirSync(data);
  const web = launch(process.execPath, ['--import', 'tsx', 'scripts/parity/web-server.ts'], {
    ...env, NODE_ENV: 'development', NEXT_PHASE: 'phase-production-build', O8_DATA_DIR: data,
    CORTEX_IDE_DATA_DIR: data, CORTEX_IDE_DB_PATH: join(data, 'web.db'),
  }, join(logs, 'web.log'), true);
  const webReceipt = receipt(web);
  let browser;
  const captures = [];
  try {
    const binary = testBinary(options);
    await until(web, () => webReceipt.value.webOrigin, 120_000);
    browser = await chromium.launch({ executablePath: options.browser || chromium.executablePath(), headless: true,
      args: ['--no-sandbox', '--disable-background-networking'] });
    // Compile the real route before starting two-minute fixture hosts.
    const warm = await fetch(webReceipt.value.webOrigin + '/dashboard', { signal: AbortSignal.timeout(240_000) });
    if (!warm.ok) throw new Error('Current UI route compilation failed');
    await warm.arrayBuffer();
    const selected = options.only ? manifest.surfaces.filter(row => row.id === options.only) : manifest.surfaces;
    if (!selected.length) throw new Error('Unknown surface');
    for (const scenario of selected) {
      const host = launch(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
        'scripts/next/dev-server.ts', '--shell', '--parity', ...scenario.flags], env, join(logs, `${scenario.id}-host.log`), true);
      const hostReceipt = receipt(host);
      try {
        await until(host, () => hostReceipt.value.origin && hostReceipt.value.configDir && hostReceipt.value.parityWorkspace);
        const fixture = { ...hostReceipt.value, token };
        const response = await fetch(fixture.origin + '/api/mobile/orchestrator/threads?limit=500', {
          headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
        const list = await response.json();
        const session = list.threads?.find(row => String(row.id).includes('rich')) ?? list.threads?.[0];
        for (const size of manifest.sizes) {
          console.log(`Capturing ${scenario.id} ${size.join('x')}`);
          const name = `${scenario.id}-${size.join('x')}`;
          const directory = join(options.output, name);
          mkdirSync(directory, { recursive: true });
          const state = join(root, `${name}.json`);
          const tab = scenario.tab ?? 'Session';
          writeFileSync(state, JSON.stringify({ version: 1, bounds: [0, 0, ...size], selected: fixture.parityWorkspace,
            workspaces: { [fixture.parityWorkspace]: { tabs: session || tab !== 'Session' ? [{ surface: tab, ...(tab === 'Session' ? { session: session.id } : {}) }] : [], active: 0, composer: false, selections: {} } } }));
          const entry = { surface: scenario.id, size, native: {}, web: {}, notes: [], images: {} };
          try {
            await nativePixels(options, scenario, state, fixture, env, join(directory, 'native.png'), size, join(logs, `${name}-native.log`));
            entry.images.native = `${name}/native.png`;
            const metrics = spawnSync(binary, ['parity_capture_real_shell', '--nocapture', '--test-threads=1'], {
              env: { ...env, O8_PARITY_ORIGIN: fixture.origin, O8_PARITY_STATE: state, O8_PARITY_ROOT: root, O8_PARITY_SURFACE: scenario.id },
              encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
            });
            writeFileSync(join(logs, `${name}-gpui.log`), metrics.stdout + metrics.stderr);
            if (metrics.status !== 0) throw new Error('GPUI measurement test failed');
            entry.native = JSON.parse(readFileSync(join(root, 'native-metrics.json'), 'utf8')).metrics;
            const webResult = await captureWeb(browser, webReceipt.value.webOrigin, fixture, scenario, size, manifest.elements, join(directory, 'web.png'));
            entry.web = webResult.measured;
            entry.notes = [...webResult.missing, ...(scenario.remaining ? [scenario.remaining] : [])];
            entry.routes = webResult.routes;
            entry.theme = webResult.theme;
            entry.images.web = `${name}/web.png`;
            run('convert', [join(directory, 'web.png'), join(directory, 'native.png'), '+append', '+repage', join(directory, 'pair.png')], env);
            entry.images.pair = `${name}/pair.png`;
          } catch (error) {
            writeFileSync(join(logs, `${name}-error.log`), String(error.stack ?? error));
            entry.crash = 'Capture process, route, measurement test or renderer failed';
          }
          captures.push(entry);
          writeFileSync(join(options.output, 'captures.json'), JSON.stringify(captures, null, 2) + '\n');
        }
      } catch (error) {
        writeFileSync(join(logs, `${scenario.id}-error.log`), String(error.stack ?? error));
        for (const size of manifest.sizes) captures.push({ surface: scenario.id, size, crash: 'Fixture host failed before capture' });
      } finally { hostReceipt.close(); await stop(host); }
    }
    return captures;
  } finally {
    webReceipt.close();
    if (browser) await browser.close();
    await stop(web);
    // Raw diagnostics stay local; they are never uploaded in the public artifact.
    console.log(`Local diagnostics retained under ${logs}`);
  }
}
