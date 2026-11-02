// @vitest-environment jsdom
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-next-app-')));
const dataDir = join(root, 'data');
const binary = join(root, ...(process.platform === 'darwin' ? ['o8.app', 'Contents', 'MacOS'] : ['bin']), 'o8-next');
const receipt = join(root, 'receipt.json');
const token = 'fixture-operator-canary-4708';
mkdirSync(dataDir);
mkdirSync(dirname(binary), { recursive: true });
Object.assign(process.env, { O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir, CORTEX_IDE_DB_PATH: join(dataDir, 'fixture.db'),
  O8_PACKAGED_APP: '1', O8_NEXT_BIN: binary, O8_API_PORT: '43219', WS_TOKEN: token });

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  getRuntimeAuthSnapshot: async () => ({ statuses: {}, suggestedSubscriptionProfile: { profile: null, detail: null } }),
  getDispatchableRuntimeAvailability: async () => [], invalidateRuntimeAuthCache: () => {},
}));
vi.mock('@/lib/telemetry/uploader', () => ({ startTelemetryUploadLoop: () => {} }));
vi.mock('@/lib/telemetry/sentry-node', () => ({ initSentryNode: async () => {} }));
vi.mock('@/lib/mobile/orchestrator-thread-history', () => ({ repairFlippedOrchestratorTranscripts: () => {}, repairComposerPreamblePollution: () => {} }));
vi.mock('@/lib/lane/review-drain-bootstrap', () => ({ ensureReviewQueueDrainStarted: () => {} }));
vi.mock('@/lib/panel/status-boot', () => ({ startStatusBootHooks: () => {} }));
vi.mock('@/lib/search/backfill', () => ({ runUnifiedSearchBackfills: async () => {} }));
vi.mock('@/lib/symon/messages-receiver/loop', () => ({ startMessagesReceiver: () => {} }));
vi.mock('@/lib/tauri/bridge', () => ({ storeSet: vi.fn(), isTauri: () => false }));
vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => ({ clerkEnabled: false, isLoaded: true, signedIn: false, user: null }) }));
vi.mock('@/components/desktop/settings/SettingsTomlEditor', () => ({ SettingsTomlEditor: () => null }));

const route = await import('@/app/api/panel/operator-defaults/route');
const { OperatorDefaultsTab } = await import('@/components/desktop/settings/OperatorDefaultsTab');
const { closeDb } = await import('@/lib/db');
const { getDataDir } = await import('@/lib/data-dir-migration');
const { getOperatorDefaults } = await import('@/lib/operator/defaults');
const { ensureNextServerInitialized } = await import('@/lib/startup/next');
const endpoint = 'http://untrusted.invalid/api/panel/operator-defaults';
let ui: Root | undefined;
let container: HTMLDivElement;
const logs: string[] = [];
const startup = globalThis as typeof globalThis & { __o8NextOptionalStartup?: Promise<void> };

async function post(value: boolean, extra = {}) {
  return route.POST(new Request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ experimentalNext: value, ...extra }) }));
}
function probe() { return JSON.parse(readFileSync(receipt, 'utf8')) as { pid: number; argv: string[]; authorized: boolean; inherited: boolean; cwd: string }; }
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    // A container's PID 1 may defer reaping an orphan. ps supports this field
    // on macOS and Linux; a zombie has exited and no longer holds credentials.
    return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z');
  } catch { return false; }
}
function stageBinary(mode: 'ready' | 'silent' | 'error' | 'held' = 'ready') {
  writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(receipt + '.tmp')}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2),
  authorized: process.env.O8_NEXT_API_TOKEN === ${JSON.stringify(token)}, cwd: fs.realpathSync(process.cwd()),
  inherited: ['O8_WORKER_TOKEN', 'O8_API_TOKEN', 'O8_NEXT_CLERK_SESSION_TOKEN', 'NODE_OPTIONS', 'O8_MASTER_KEY'].some(k => !!process.env[k]) }));
fs.renameSync(${JSON.stringify(receipt + '.tmp')}, ${JSON.stringify(receipt)});
const state = process.argv[process.argv.indexOf('--shell-state') + 1];
if (fs.existsSync(state)) { try { JSON.parse(fs.readFileSync(state, 'utf8')); } catch { process.exit(1); } }
console.log(process.env.O8_NEXT_API_TOKEN); console.error(process.env.O8_NEXT_API_TOKEN);
if (${JSON.stringify(mode)} === 'ready') { process.stdout.write('o8-next-'); setImmediate(() => console.log('ready')); }
if (${JSON.stringify(mode)} === 'error') console.log('o8-next-startup-error');
if (${JSON.stringify(mode)} === 'held') { const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(join(root, 'ready'))})) { clearInterval(timer); console.log('o8-next-ready'); }
}, 20); }
if (process.env.O8_NEXT_PARENT_PIPE === '1') { process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); }
setInterval(() => {}, 1000);
`, { mode: 0o755 });
}
async function boot() {
  delete startup.__o8NextOptionalStartup;
  await ensureNextServerInitialized();
}

beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((...args) => { logs.push(args.join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation((...args) => { logs.push(args.join(' ')); });
  stageBinary();
});
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => {
  if (ui) { await act(async () => ui!.unmount()); ui = undefined; container.remove(); }
  if (existsSync(receipt)) { const pid = probe().pid; if (alive(pid)) process.kill(pid); await vi.waitFor(() => expect(alive(pid)).toBe(false)); }
  await post(false);
  rmSync(join(dataDir, 'settings.toml'), { force: true });
  rmSync(join(dataDir, 'operator-defaults.json'), { force: true });
  rmSync(receipt, { force: true });
  rmSync(join(dataDir, 'next-shell.json'), { force: true });
  rmSync(join(root, 'ready'), { force: true });
  stageBinary();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(() => { closeDb(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('keeps default startup, all existing defaults, environment and the data directory unchanged while off', async () => {
  const before = await getOperatorDefaults();
  await route.GET(new Request(`${endpoint}?include=values`));
  const files = readdirSync(dataDir).sort();
  const environment = { ...process.env };
  await boot();
  const response = await route.GET(new Request(`${endpoint}?include=values`));
  expect((await response.json()).values.experimentalNext).toBe(false);
  expect(await getOperatorDefaults()).toEqual(before);
  const changedEnvironmentKeys = Object.keys({ ...environment, ...process.env }).filter(key => environment[key] !== process.env[key]);
  expect(changedEnvironmentKeys).toEqual([]);
  expect(realpathSync(getDataDir())).toBe(dataDir);
  expect(readdirSync(dataDir).sort()).toEqual(files);
  expect(existsSync(receipt)).toBe(false);
});

it('opens o8 next as the main window of the packaged macOS app, and the old switch cannot close it', async () => {
  // The packaged macOS shell sets this when it spawns the server (#5069).
  vi.stubEnv('O8_NEXT_MAIN_WINDOW', '1');
  expect((await getOperatorDefaults()).values.experimentalNext).toBe(false);
  await boot();
  await vi.waitFor(() => expect(existsSync(receipt)).toBe(true), { timeout: 10_000 });
  const child = probe();
  expect(child.authorized).toBe(true);
  expect(child.argv).toContain('--app-shell');
  expect((await post(false)).status).toBe(200);
  expect((await getOperatorDefaults()).values.experimentalNext).toBe(false);
  expect(alive(child.pid)).toBe(true);
});

async function mountSettings(beforeGet: () => Promise<void> = async () => {}) {
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const request = new Request(new URL(input, endpoint), init);
    if (request.method === 'GET') await beforeGet();
    return request.method === 'POST' ? route.POST(request) : route.GET(request);
  });
  container = document.createElement('div'); document.body.appendChild(container); ui = createRoot(container);
  await act(async () => { ui!.render(createElement(OperatorDefaultsTab)); });
  return vi.waitFor(async () => {
    await act(async () => {});
    const label = Array.from(container.querySelectorAll('span')).find(el => el.textContent === 'o8 next' && el.children.length === 0);
    const rowContainer = label?.parentElement?.parentElement;
    const row = rowContainer?.querySelector('[role="switch"]');
    expect(row).toBeTruthy();
    return { row, rowContainer };
  }, { timeout: 10_000 });
}

it('waits for settings readiness when a cold response takes longer than one second', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    // Inject cold-route latency; mountSettings must still wait for the rendered switch.
    const { row } = await mountSettings(() => new Promise(resolve => { setTimeout(resolve, 1_500); }));
    expect(row!.getAttribute('aria-checked')).toBe('false');
    expect(existsSync(receipt)).toBe(false);
  } finally { vi.useRealTimers(); }
});

it('drives the single short switch through the real settings route and real spawn, then off kills it', async () => {
  const { row, rowContainer } = await mountSettings();
  expect(row).toBeTruthy();
  expect(row!.getAttribute('aria-checked')).toBe('false');
  await act(async () => { (row as HTMLElement).click(); });
  await vi.waitFor(() => expect(existsSync(receipt)).toBe(true), { timeout: 10_000 });
  const child = probe();
  expect(child.authorized).toBe(true);
  expect(child.argv).toContain('--app-shell');
  expect(child.argv[child.argv.indexOf('--server') + 1]).toBe('http://127.0.0.1:43219');
  expect(child.argv.join(' ')).not.toContain(token);
  expect(child.cwd).toBe(dataDir);
  expect(rowContainer!.textContent).toBe('o8 next');
  await vi.waitFor(async () => { await act(async () => {}); expect(row!.getAttribute('aria-checked')).toBe('true'); expect((row as HTMLButtonElement).disabled).toBe(false); });
  await act(async () => { (row as HTMLElement).click(); });
  await vi.waitFor(() => expect(alive(child.pid)).toBe(false));
  await vi.waitFor(async () => expect((await getOperatorDefaults()).values.experimentalNext).toBe(false));
});

it('restores the persisted choice in a fresh server process and reaps the window on TERM and hard restart', async () => {
  expect((await post(true)).status).toBe(200);
  await vi.waitFor(() => expect(existsSync(receipt)).toBe(true), { timeout: 10_000 });
  const first = probe().pid; process.kill(first);
  await vi.waitFor(() => expect(alive(first)).toBe(false));
  const source = pathToFileURL(join(process.cwd(), 'src/lib/next/app-window.ts')).href;
  const script = `const mod = await import(${JSON.stringify(source)}); await (mod.default ?? mod).restoreNextWindow();
    process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
  let server: ChildProcess | undefined;
  try {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      rmSync(receipt, { force: true });
      server = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
        '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
      let output = '';
      server.stdout!.on('data', chunk => { output += String(chunk); });
      server.stderr!.on('data', chunk => { output += String(chunk); });
      await vi.waitFor(() => expect(existsSync(receipt)).toBe(true), { timeout: 10_000 });
      const pid = probe().pid;
      expect(pid).not.toBe(first);
      expect(probe().authorized).toBe(true);
      const exited = once(server, 'exit');
      server.kill(signal);
      await vi.waitFor(() => expect(alive(pid)).toBe(false));
      if (signal === 'SIGTERM') server.kill('SIGKILL');
      await exited; server = undefined;
      expect(output.includes(token)).toBe(false);
    }
    expect((await getOperatorDefaults()).values.experimentalNext).toBe(true);
  } finally { server?.kill('SIGKILL'); }
});

it('shows one clear missing-binary error without saving a failed opt-in or exposing credentials', async () => {
  rmSync(binary);
  const response = await post(true);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'o8 next is unavailable. Reinstall the app and try again.' });
  expect((await getOperatorDefaults()).values.experimentalNext).toBe(false);
  expect(logs.join('\n')).not.toContain(token);
  const { row } = await mountSettings();
  expect(row!.getAttribute('aria-checked')).toBe('false');
  expect(container.textContent?.match(/o8 next is unavailable\. Reinstall the app and try again\./g)).toHaveLength(1);
});

it('refuses malformed shell state when the binary exits 1 and shows the failure once in Settings', async () => {
  writeFileSync(join(dataDir, 'next-shell.json'), '{malformed');
  const response = await post(true);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ code: 'NEXT_STARTUP_FAILED', error: 'o8 next could not start. Try again.' });
  expect((await getOperatorDefaults()).values.experimentalNext).toBe(false);
  expect(readFileSync(join(dataDir, 'next-shell.json'), 'utf8')).toBe('{malformed');
  expect(existsSync(join(dataDir, 'settings.toml'))).toBe(false);
  const { row } = await mountSettings();
  expect(row!.getAttribute('aria-checked')).toBe('false');
  expect(container.textContent?.match(/o8 next could not start\. Try again\./g)).toHaveLength(1);
});

it('keeps the preference off until the running child acknowledges startup', async () => {
  stageBinary('held');
  const pending = post(true);
  await vi.waitFor(() => expect(existsSync(receipt)).toBe(true), { timeout: 10_000 });
  expect((await getOperatorDefaults()).values.experimentalNext).toBe(false);
  expect(existsSync(join(dataDir, 'settings.toml'))).toBe(false);
  writeFileSync(join(root, 'ready'), 'ready');
  expect((await pending).status).toBe(200);
  expect((await getOperatorDefaults()).values.experimentalNext).toBe(true);
});

it('returns a reported startup failure to the actual Settings switch and reaps the child', async () => {
  stageBinary('error');
  const { row } = await mountSettings();
  await act(async () => { (row as HTMLElement).click(); });
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent?.match(/o8 next could not start\. Try again\./g)).toHaveLength(1);
    expect((row as HTMLButtonElement).disabled).toBe(false);
  }, { timeout: 10_000 });
  expect(row!.getAttribute('aria-checked')).toBe('false');
  expect((await getOperatorDefaults()).values.experimentalNext).toBe(false);
  expect(alive(probe().pid)).toBe(false);
});

it('returns a typed spawn error when an executable has no valid interpreter', async () => {
  writeFileSync(binary, '#!/nonexistent-o8-fixture-interpreter\n', { mode: 0o755 });
  const response = await post(true);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ code: 'NEXT_STARTUP_FAILED', error: 'o8 next could not start. Try again.' });
  expect((await getOperatorDefaults()).values.experimentalNext).toBe(false);
});

it('times out a child that never acknowledges startup without persisting the opt-in', async () => {
  stageBinary('silent');
  const response = await post(true);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ code: 'NEXT_STARTUP_TIMEOUT', error: 'o8 next did not become ready. Try again.' });
  expect((await getOperatorDefaults()).values.experimentalNext).toBe(false);
  expect(alive(probe().pid)).toBe(false);
}, 25_000);

// Hostile review 1: an untrusted request origin or inherited launch variables must not redirect the bearer.
it('ignores request origins, argv options and inherited credentials when spawning the app-owned sidecar', async () => {
  for (const key of ['O8_NEXT_API_TOKEN', 'O8_WORKER_TOKEN', 'O8_API_TOKEN', 'O8_NEXT_CLERK_SESSION_TOKEN', 'NODE_OPTIONS', 'O8_MASTER_KEY']) vi.stubEnv(key, 'fixture-unrelated');
  expect((await post(true, { server: 'http://127.0.0.1:9', binary: '/missing', args: [token] })).status).toBe(200);
  await vi.waitFor(() => expect(existsSync(receipt)).toBe(true), { timeout: 10_000 });
  expect(probe()).toMatchObject({ authorized: true, inherited: false });
  expect(probe().argv.join(' ')).not.toContain(token);
  expect(process.env.O8_NEXT_API_TOKEN).toBe('fixture-unrelated');
});

// Hostile review 2: child diagnostics must not escape to app logs, responses, or persisted settings.
it('discards child output and never persists or returns the bearer', async () => {
  const response = await post(true);
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain(token);
  await vi.waitFor(() => expect(existsSync(receipt)).toBe(true), { timeout: 10_000 });
  const checkFiles = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) checkFiles(path);
      else if (entry.isFile()) expect(readFileSync(path).includes(Buffer.from(token)), entry.name).toBe(false);
    }
  };
  checkFiles(dataDir);
  expect(logs.join('\n')).not.toContain(token);
  expect(process.env.O8_NEXT_API_TOKEN).not.toBe(token);
});

// Hostile review 3: disabled startup must never probe the binary or mint a credential, even if it is missing.
it('boots with a missing sidecar and no bearer while disabled without adding any files', async () => {
  rmSync(binary); vi.stubEnv('WS_TOKEN', undefined);
  const before = readdirSync(dataDir).sort();
  await boot();
  expect(readdirSync(dataDir).sort()).toEqual(before);
  expect(existsSync(receipt)).toBe(false);
});

it('refuses a missing-sidecar TOML opt-in before persisting the choice', async () => {
  rmSync(binary);
  const settings = await (await route.GET(new Request(`${endpoint}?include=values`))).json();
  const response = await route.POST(new Request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ settingsToml: settings.settingsToml.text.replace('next_enabled = false', 'next_enabled = true'),
      settingsTomlRevision: settings.settingsToml.revision }) }));
  expect(response.status).toBe(400);
  expect((await getOperatorDefaults()).values.experimentalNext).toBe(false);
});

// Opt-in local acceptance: a compiled development bundle, never the installed app.
// Only the display edge adds --offscreen. The settings route, spawn policy,
// native executable, parent pipe and persisted preference remain production paths.
it.skipIf(process.platform !== 'darwin' || !process.env.O8_NEXT_MACOS_TEST_BUNDLE)(
  'refuses a compiled Mac binary that exits 1 on malformed shell state', async () => {
    const nativeBinary = realpathSync(join(process.env.O8_NEXT_MACOS_TEST_BUNDLE!, 'Contents/MacOS/o8-next'));
    expect(readFileSync(join(dirname(nativeBinary), '../Info.plist'), 'utf8'))
      .toContain('<string>run.o8.next.localcheck</string>');
    expect(execFileSync('/usr/bin/file', ['--brief', nativeBinary], { encoding: 'utf8' })).toContain('Mach-O');
    const providers = await import('@/lib/providers/child-process');
    const productionSpawn = providers.spawn;
    let exited: Promise<[number | null, NodeJS.Signals | null]> | undefined;
    const display = vi.spyOn(providers, 'spawn').mockImplementation((command, args, options) => {
      const child = productionSpawn(command, command === nativeBinary ? [...(args ?? []), '--offscreen'] : (args ?? []), options);
      if (command === nativeBinary) exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
      return child;
    });
    try {
      vi.stubEnv('O8_NEXT_BIN', nativeBinary);
      writeFileSync(join(dataDir, 'next-shell.json'), '{malformed');
      const response = await post(true);
      expect(await exited!).toEqual([1, null]);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: 'NEXT_STARTUP_FAILED', error: 'o8 next could not start. Try again.' });
      expect((await getOperatorDefaults()).values.experimentalNext).toBe(false);
      expect(readFileSync(join(dataDir, 'next-shell.json'), 'utf8')).toBe('{malformed');
    } finally { display.mockRestore(); }
  }, 60_000,
);

it.skipIf(process.platform !== 'darwin' || !process.env.O8_NEXT_MACOS_TEST_BUNDLE)(
  'launches the compiled Mac bundle through the settings API and disables it without a hard kill', async () => {
    const nativeBinary = realpathSync(join(process.env.O8_NEXT_MACOS_TEST_BUNDLE!, 'Contents/MacOS/o8-next'));
    expect(readFileSync(join(dirname(nativeBinary), '../Info.plist'), 'utf8'))
      .toContain('<string>run.o8.next.localcheck</string>');
    expect(execFileSync('/usr/bin/file', ['--brief', nativeBinary], { encoding: 'utf8' })).toContain('Mach-O');
    const requestLog = join(root, 'native-requests.json');
    const host = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
      'scripts/next/dev-server.ts', '--shell'], {
      env: { ...process.env, O8_NEXT_API_TOKEN: token, O8_NEXT_REQUEST_LOG: requestLog },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let origin: string | undefined;
    const lines = createInterface({ input: host.stdout! });
    lines.on('line', line => {
      try { origin = JSON.parse(line).origin || origin; } catch { /* Fixture diagnostics are not receipts. */ }
    });
    const providers = await import('@/lib/providers/child-process');
    const productionSpawn = providers.spawn;
    let native: ChildProcess | undefined;
    let exited: Promise<[number | null, NodeJS.Signals | null]> | undefined;
    const display = vi.spyOn(providers, 'spawn').mockImplementation((command, args, options) => {
      const child = productionSpawn(command, command === nativeBinary ? [...(args ?? []), '--offscreen'] : (args ?? []), options);
      if (command === nativeBinary) {
        native = child;
        exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
      }
      return child;
    });
    try {
      await vi.waitFor(() => { expect(host.exitCode).toBeNull(); expect(origin).toBeTruthy(); }, { timeout: 30_000 });
      vi.stubEnv('O8_API_PORT', new URL(origin!).port);
      vi.stubEnv('O8_NEXT_BIN', nativeBinary);
      expect((await post(true)).status).toBe(200);
      expect(native?.pid).toBeTruthy();
      await vi.waitFor(() => expect(existsSync(join(dataDir, 'next-shell.json'))).toBe(true), { timeout: 10_000 });
      expect(alive(native!.pid!)).toBe(true);
      expect(JSON.parse(readFileSync(join(dataDir, 'next-shell.json'), 'utf8')).selected).toBeTruthy();
      expect((await getOperatorDefaults()).values.experimentalNext).toBe(true);
      expect(readFileSync(join(dataDir, 'settings.toml'), 'utf8')).toContain('next_enabled = true');
      expect((await post(false)).status).toBe(200);
      const [code, signal] = await exited!;
      expect(code === 0 || signal === 'SIGTERM').toBe(true);
      expect(alive(native!.pid!)).toBe(false);
      expect((await getOperatorDefaults()).values.experimentalNext).toBe(false);
      const hostExit = once(host, 'exit'); host.kill('SIGTERM'); await hostExit;
      expect(JSON.parse(readFileSync(requestLog, 'utf8'))).toContain('GET /api/mobile/orchestrator/threads');
      const result = { developmentBundle: true, nativeMachO: true, offscreen: true, settingsApi: true,
        persistedEnabled: true, fixtureRoutesRead: true, persistedDisabled: true,
        exited: true, exitCode: code, exitSignal: signal, hardKill: false };
      if (process.env.O8_NEXT_MACOS_TEST_RECEIPT) writeFileSync(process.env.O8_NEXT_MACOS_TEST_RECEIPT, JSON.stringify(result, null, 2) + '\n');
      console.info('Native Mac bundle acceptance:', JSON.stringify(result));
    } finally {
      display.mockRestore(); lines.close();
      if (native?.pid && alive(native.pid)) native.kill('SIGKILL');
      if (host.exitCode === null && host.signalCode === null) { const done = once(host, 'exit'); host.kill('SIGTERM'); await done; }
    }
  }, 60_000,
);


it.skipIf(process.platform !== 'darwin' || !process.env.O8_NEXT_MACOS_TEST_BUNDLE).each(['slow', 'failed'])(
  'keeps the compiled offscreen window through a %s first load via Settings', async mode => {
    const nativeBinary = realpathSync(join(process.env.O8_NEXT_MACOS_TEST_BUNDLE!, 'Contents/MacOS/o8-next'));
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let threadRequests = 0;
    const server = createServer((request, response) => {
      const path = new URL(request.url!, 'http://fixture').pathname;
      const bodies: Record<string, unknown> = {
        '/api/mobile/orchestrator/threads': { threads: [] },
        '/api/orchestrator/state': { mission: { packets: [] } },
        '/api/runtime/inventory': { agents: [] },
        '/api/v2/chat-history/list': { conversations: [] },
        '/api/panel/repos': { repos: [] },
        '/api/panel/projects': { projects: [{ id: 'startup', name: 'Startup fixture', color: null,
          sqliteProjectId: null, repoPaths: [dataDir] }], activeProjectId: 'startup' },
      };
      const respond = () => response.writeHead(bodies[path] ? 200 : 404,
        { 'content-type': 'application/json' }).end(JSON.stringify(bodies[path] ?? {}));
      if (path === '/api/mobile/orchestrator/threads') {
        threadRequests++;
        if (mode === 'failed') { response.writeHead(503).end('{}'); return; }
        timers.push(setTimeout(respond, 30_000));
      } else respond();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing startup fixture port');
    const providers = await import('@/lib/providers/child-process');
    const productionSpawn = providers.spawn;
    let native: ChildProcess | undefined;
    const display = vi.spyOn(providers, 'spawn').mockImplementation((command, args, options) => {
      const child = productionSpawn(command, command === nativeBinary ? [...(args ?? []), '--offscreen'] : (args ?? []), options);
      if (command === nativeBinary) native = child;
      return child;
    });
    try {
      vi.stubEnv('O8_API_PORT', String(address.port));
      vi.stubEnv('O8_NEXT_BIN', nativeBinary);
      const started = performance.now();
      expect((await post(true)).status).toBe(200);
      const windowMs = performance.now() - started;
      expect(windowMs).toBeLessThan(15_000);
      expect(alive(native!.pid!)).toBe(true);
      expect((await getOperatorDefaults()).values.experimentalNext).toBe(true);
      await vi.waitFor(() => expect(threadRequests).toBeGreaterThan(0), { timeout: 5_000 });
      if (mode === 'slow') {
        await vi.waitFor(() => {
          expect(alive(native!.pid!)).toBe(true);
          expect(existsSync(join(dataDir, 'next-shell.json'))).toBe(true);
          expect(JSON.parse(readFileSync(join(dataDir, 'next-shell.json'), 'utf8')).selected).toBe(dataDir);
        }, { timeout: 40_000, interval: 50 });
        console.info('Slow startup measurement:', JSON.stringify({ windowMs, windowToLoadMs: performance.now() - started - windowMs }));
      } else {
        await new Promise(resolve => setTimeout(resolve, 500));
        expect(alive(native!.pid!)).toBe(true);
        expect((await getOperatorDefaults()).values.experimentalNext).toBe(true);
      }
      expect((await post(false)).status).toBe(200);
      expect(alive(native!.pid!)).toBe(false);
    } finally {
      display.mockRestore();
      timers.forEach(clearTimeout);
      if (native?.pid && alive(native.pid)) { const exited = once(native, 'exit'); native.kill('SIGTERM'); await exited; }
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 60_000,
);
