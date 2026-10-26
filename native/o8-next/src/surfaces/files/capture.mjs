// Capture the real GPUI shell and the current React FileViewer with owned fixtures.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if (!args.includes('--binary') || !args.includes('--output')) throw new Error('Use --binary EXECUTABLE --output DIRECTORY');
const binary = realpathSync(resolve(option('--binary')));
const output = resolve(option('--output'));
mkdirSync(output, { recursive: true });
const owned = realpathSync(mkdtempSync(join(tmpdir(), 'o8-readonly-capture-')));
const children = [];
let browser;
let web;
let stage = 'prepare';
const fixtureSource = '// Read-only workspace preview\nexport function greeting(name: string): string {\n  const message = `Hello, ${name}!`;\n  return message;\n}\n\nexport const examples = ["workspace", "source", "copy"];\n';
const env = { NODE_ENV: 'test', O8_NEXT_API_TOKEN: randomBytes(32).toString('hex'),
  XDG_CACHE_HOME: join(owned, 'cache'), XDG_CONFIG_HOME: join(owned, 'config'), XDG_RUNTIME_DIR: join(owned, 'runtime') };
for (const key of ['PATH', 'LD_LIBRARY_PATH', 'VK_DRIVER_FILES', 'VK_ICD_FILENAMES', 'LIBGL_ALWAYS_SOFTWARE', 'FONTCONFIG_FILE', 'FONTCONFIG_PATH']) {
  if (process.env[key]) env[key] = process.env[key];
}
mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { await exited; } finally { clearTimeout(timer); }
}
function child(command, args, extra = {}) {
  const process = spawn(command, args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], ...extra });
  process.diagnostic = '';
  process.stderr?.on('data', chunk => { process.diagnostic = (process.diagnostic + String(chunk)).slice(-16_384); });
  children.push(process); return process;
}
async function until(predicate, process, timeout = 30_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (process && (process.exitCode !== null || process.signalCode !== null)) throw new Error('Owned process exited');
    if (await predicate()) return;
    await delay(40);
  }
  throw new Error('Owned capture timed out');
}
async function main() {
  if (process.platform !== 'linux') throw new Error('Native capture requires an owned Linux display');
  stage = 'display';
  const display = child('Xvfb', ['-displayfd', '1', '-screen', '0', '1280x900x24', '-nolisten', 'tcp']);
  let displayNumber = '';
  createInterface({ input: display.stdout }).on('line', line => { if (/^\d+$/.test(line)) displayNumber = line; });
  await until(() => displayNumber, display);
  env.DISPLAY = ':' + displayNumber;
  stage = 'fixture';
  const requestLog = join(owned, 'requests.json');
  const host = child(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
    'scripts/next/dev-server.ts', '--shell', '--composer', '--files'], { env: { ...env, O8_NEXT_REQUEST_LOG: requestLog } });
  let origin; let configDir;
  createInterface({ input: host.stdout }).on('line', line => {
    try { const data = JSON.parse(line); origin = data.origin || origin; configDir = data.configDir || configDir; } catch { /* Drain private fixture diagnostics. */ }
  });
  await until(() => origin && configDir, host);
  const headers = { authorization: 'Bearer ' + env.O8_NEXT_API_TOKEN };
  const sessions = await (await fetch(origin + '/api/mobile/orchestrator/threads', { headers })).json();
  const workspace = realpathSync(sessions.threads[0].repoPath);
  if (basename(workspace) !== 'fixture-repo' || dirname(workspace) !== dirname(realpathSync(configDir))) throw new Error('Unexpected fixture root');
  writeFileSync(join(workspace, 'fixture.ts'), fixtureSource);
  const state = join(owned, 'shell.json');
  writeFileSync(state, JSON.stringify({ version: 1, bounds: [0, 0, 1200, 816], selected: workspace,
    workspaces: { [workspace]: { tabs: [{ surface: 'Files' }], active: 0, composer: false, selections: {} } } }));
  stage = 'native';
  const app = child(binary, ['--enable-next', '--app-shell', '--server', origin, '--shell-state', state]);
  let window;
  await until(() => {
    try { window = execFileSync('xdotool', ['search', '--onlyvisible', '--pid', String(app.pid)], { env, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim().split('\n')[0]; return window; } catch { return false; }
  }, app);
  execFileSync('xdotool', ['windowfocus', '--sync', window], { env, stdio: 'ignore' });
  execFileSync('xdotool', ['key', '--window', window, 'ctrl+k'], { env, stdio: 'ignore' });
  execFileSync('xdotool', ['type', '--window', window, '--delay', '20', 'open file'], { env, stdio: 'ignore' });
  execFileSync('xdotool', ['key', '--window', window, 'Return'], { env, stdio: 'ignore' });
  await delay(300);
  execFileSync('xdotool', ['type', '--window', window, '--delay', '30', 'fixture.ts'], { env, stdio: 'ignore' });
  execFileSync('xdotool', ['key', '--window', window, 'Return'], { env, stdio: 'ignore' });
  await delay(1800);
  execFileSync('xrefresh', ['-none'], { env, stdio: 'ignore' });
  execFileSync('import', ['-window', window, '-strip', join(output, 'native-read-only.png')], { env, stdio: 'ignore' });
  await stop(app);
  stage = 'desktop-bundle';
  const assets = join(owned, 'assets'); mkdirSync(assets);
  await build({ absWorkingDir: repo, bundle: true, write: true, format: 'esm', splitting: true, outdir: assets,
    jsx: 'automatic', platform: 'browser', alias: { '@': join(repo, 'src') }, loader: { '.ttf': 'file' },
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_RUNTIME': '"browser"', 'process.env': '{}' },
    stdin: { resolveDir: repo, loader: 'tsx', contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {ThemeProvider} from './src/lib/theme/context';
      import {FileViewer} from './src/components/desktop/FileViewer';
      createRoot(document.getElementById('root')).render(<ThemeProvider><FileViewer filePath="fixture.ts" workspace={${JSON.stringify(workspace)}}/></ThemeProvider>);
    ` }, logLevel: 'silent' });
  for (const [name, entry] of [['ts.worker.js', 'language/typescript/ts.worker.js'], ['editor.worker.js', 'editor/editor.worker.js']]) {
    await build({ entryPoints: [join(repo, 'node_modules/monaco-editor/esm/vs', entry)], bundle: true, write: true,
      format: 'iife', platform: 'browser', outfile: join(assets, name), logLevel: 'silent' });
  }
  web = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (url.pathname.startsWith('/api/')) {
      const upstream = await fetch(origin + url.pathname + url.search, { headers });
      res.writeHead(upstream.status, { 'content-type': 'application/json' }).end(Buffer.from(await upstream.arrayBuffer())); return;
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html><head><link rel="stylesheet" href="/assets/stdin.css"></head><body style="margin:0"><div id="root" style="height:816px;width:1200px"></div><script type="module" src="/assets/stdin.js"></script></body></html>'); return;
    }
    const name = url.pathname.includes('/monaco-editor/') ? basename(url.pathname) : url.pathname.replace('/assets/', '');
    if (name.includes('..') || name.includes('/') || !/^[\w.-]+$/.test(name)) { res.writeHead(404).end(); return; }
    try { const bytes = readFileSync(join(assets, name)); res.writeHead(200, { 'content-type': name.endsWith('.css') ? 'text/css' : name.endsWith('.ttf') ? 'font/ttf' : 'text/javascript' }).end(bytes); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  const address = web.address();
  stage = 'desktop';
  browser = await chromium.launch({ executablePath: process.env.O8_BROWSER_BINARY || '/usr/bin/chromium', headless: true,
    args: ['--disable-background-networking', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 816 }, colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.setItem('cortex-theme-palette', 'dark'));
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.locator('.monaco-editor .view-lines').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector('.monaco-editor .view-lines')?.textContent?.includes('greeting'));
  await page.screenshot({ path: join(output, 'current-file-view.png') });
  await browser.close(); browser = null;
  await stop(host);
  const requests = JSON.parse(readFileSync(requestLog, 'utf8'));
  if (!requests.includes('GET /api/panel/files') || !requests.includes('GET /api/panel/file-content') || requests.some(value => /^(POST|PUT|PATCH|DELETE) /.test(value))) throw new Error('Unexpected fixture request set');
  writeFileSync(join(output, 'capture.json'), JSON.stringify({ native: 'real GPUI X11/Vulkan window', current: 'production React FileViewer and bundled Monaco',
    fixture: 'identical owned TypeScript source', nativeViewport: [1200, 816], currentViewport: [1200, 816], mutations: 0 }, null, 2) + '\n');
  console.log('Captured native and current file views using owned, authenticated read-only fixtures');
}
try { await main(); } catch (error) {
  const diagnostic = [error instanceof Error ? error.message : '', ...children.map(child => child.diagnostic)].join('\n').replaceAll(env.O8_NEXT_API_TOKEN, '<redacted>')
    .replaceAll(hostname(), '<machine>').replace(/\/(?:home|Users|root)\/[^\s:'"]+/g, '<private-path>');
  const directory = join(repo, 'work/evidence/readonly-files'); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'capture-diagnostic.log'), diagnostic);
  console.error('Read-only comparison capture failed at stage: ' + stage); process.exitCode = 1;
}
finally {
  await browser?.close().catch(() => {});
  web?.closeAllConnections(); await new Promise(resolve => web ? web.close(resolve) : resolve());
  for (const process of children.reverse()) await stop(process);
  rmSync(owned, { recursive: true, force: true });
}
