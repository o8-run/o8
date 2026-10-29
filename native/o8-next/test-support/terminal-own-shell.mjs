/** Disposable production binary + production ws-server. No test transport or input hooks. */
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

class VerificationError extends Error {}
const check = (ok, message) => { if (!ok) throw new VerificationError(message); };
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-next-own-shell-')));
const token = randomBytes(32).toString('hex');
const home = join(root, 'home');
mkdirSync(home);
const env = { HOME: home, TMPDIR: root, SHELL: '/bin/sh', NODE_ENV: 'test', O8_NEXT_API_TOKEN: token,
  XDG_CACHE_HOME: join(root, 'cache'), LIBGL_ALWAYS_SOFTWARE: '1', O8_NEXT_REQUEST_LOG: join(root, 'requests.json') };
for (const name of ['PATH', 'DISPLAY', 'XAUTHORITY', 'LD_LIBRARY_PATH', 'FONTCONFIG_FILE', 'FONTCONFIG_PATH']) {
  if (process.env[name]) env[name] = process.env[name];
}
const drivers = '/usr/share/vulkan/icd.d';
const software = readdirSync(drivers).find(name => /^lvp_icd.*\.json$/.test(name));
if (software) { env.VK_DRIVER_FILES = join(drivers, software); env.VK_ICD_FILENAMES = env.VK_DRIVER_FILES; }
let host;
let app;
let wm;
let stage = 'fixture';
const diagnostics = [];
function start(file, args, label, input = 'ignore') {
  const child = spawn(file, args, { env, stdio: [input, 'pipe', 'pipe'] });
  const chunks = [];
  child.stderr.on('data', data => chunks.push(data));
  child.stdout.on('data', data => chunks.push(data));
  child.on('error', () => {});
  diagnostics.push([label, chunks]);
  return child;
}
function alive(child) {
  check(child?.pid && child.exitCode === null && child.signalCode === null, `${stage}: child exited`);
}
async function until(predicate, message, child, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child) alive(child);
    if (await predicate()) return;
    await delay(100);
  }
  throw new VerificationError(typeof message === 'function' ? message() : message);
}
async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
  try { await exited; } finally { clearTimeout(timer); }
}
function xdo(...args) { return execFileSync('xdotool', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim(); }
function state(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }
// Send the native WM_DELETE_WINDOW path, including state capture. Destroying the
// X window or killing the process would bypass the app's normal close callback.
function closeWindow(window) {
  execFileSync('python3', ['-c', `
import ctypes as c, sys
x=c.CDLL('libX11.so.6')
x.XOpenDisplay.argtypes=[c.c_char_p]; x.XOpenDisplay.restype=c.c_void_p
d=x.XOpenDisplay(None)
assert d
x.XInternAtom.argtypes=[c.c_void_p,c.c_char_p,c.c_int]; x.XInternAtom.restype=c.c_ulong
class Data(c.Union): _fields_=[('b',c.c_char*20),('s',c.c_short*10),('l',c.c_long*5)]
class Message(c.Structure): _fields_=[('type',c.c_int),('serial',c.c_ulong),('send_event',c.c_int),('display',c.c_void_p),('window',c.c_ulong),('message_type',c.c_ulong),('format',c.c_int),('data',Data)]
class Event(c.Union): _fields_=[('message',Message),('pad',c.c_long*24)]
e=Event(); e.message.type=33; e.message.display=d; e.message.window=int(sys.argv[1]); e.message.format=32
e.message.message_type=x.XInternAtom(d,b'WM_PROTOCOLS',0)
e.message.data.l[0]=x.XInternAtom(d,b'WM_DELETE_WINDOW',0)
x.XSendEvent.argtypes=[c.c_void_p,c.c_ulong,c.c_int,c.c_long,c.POINTER(Event)]
x.XFlush.argtypes=[c.c_void_p]; x.XCloseDisplay.argtypes=[c.c_void_p]
assert x.XSendEvent(d,e.message.window,0,0,c.byref(e))
x.XFlush(d); x.XCloseDisplay(d)
`, window], { env, stdio: 'pipe', timeout: 5000 });
}
async function main() {
  check(software, 'software Vulkan driver is required');
  wm = start('openbox', ['--sm-disable'], 'window-manager');
  let origin;
  // The shared VM can miss the fixture's existing startup deadline. Retry only
  // bootstrap, before any app launch or feature assertion, with a fresh store.
  for (let attempt = 1; attempt <= 3; attempt++) {
    origin = undefined;
    host = start(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
      'scripts/next/dev-server.ts', '--shell', '--terminal', '--owned-stdio'], `host-${attempt}`, 'pipe');
    const lines = createInterface({ input: host.stdout });
    lines.on('line', line => { try { origin = JSON.parse(line).origin || origin; } catch { /* private startup diagnostics */ } });
    try {
      await until(() => origin, 'fixture did not publish its HTTP origin', host, 180_000);
      break;
    } catch (error) {
      await stop(host);
      if (attempt === 3) throw error;
    } finally {
      lines.close();
    }
  }
  const get = async path => {
    const response = await fetch(new URL(path, origin), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    check(response.ok, 'production HTTP route must succeed');
    return response.json();
  };
  const inventory = async () => (await get('/api/mobile/terminal-sessions')).sessions;
  const initial = await inventory();
  check(initial.length === 1, 'fixture must publish its pre-existing PTY');
  // Observe an actual read-only attach acknowledgement before opening the app;
  // this observer never creates a session or sends input to the tested shell.
  stage = 'ws-ready';
  const info = await get('/api/panel/ws-info');
  const observer = new WebSocket(`ws://127.0.0.1:${info.wsPort}/ws?token=${encodeURIComponent(info.wsToken)}`);
  observer.on('error', () => {});
  let attached = false;
  observer.on('message', raw => {
    try {
      const frame = JSON.parse(String(raw));
      attached ||= frame.channel === 'terminal' && frame.event === 'attached'
        && frame.data.sessionName === initial[0].name;
    } catch { /* unrelated frame */ }
  });
  try {
    await until(() => observer.readyState === WebSocket.OPEN, 'fixture observer must connect', host);
    observer.send(JSON.stringify({ type: 'terminal-attach', sessionName: initial[0].name, cols: 80, rows: 24, readOnly: true }));
    await until(() => attached, 'production WS server must acknowledge its fixture PTY', host, 120_000);
  } finally {
    observer.terminate();
  }

  const threads = (await get('/api/mobile/orchestrator/threads')).threads;
  const workspace = threads.map(thread => thread.repoPath).find(path => path && path !== initial[0].cwd);
  check(workspace && existsSync(workspace), 'fixture must expose a second workspace without a PTY');
  const sessions = async () => (await inventory()).filter(session => session.cwd === workspace);
  check((await sessions()).length === 0, 'workspace must start with no terminal');
  const expected = `cortex-dash-${createHash('sha256').update(`o8-next:${workspace}:terminal`).digest('hex').slice(0, 32)}`;
  const file = join(root, 'shell.json');
  writeFileSync(file, JSON.stringify({ version: 1, bounds: [0, 0, 1200, 816], selected: workspace,
    workspaces: { [workspace]: { tabs: [{ surface: 'Terminal' }], active: 0, composer: false } } }));
  let observed = 0;
  const selected = () => state(file)?.workspaces?.[workspace]?.terminal_session;
  async function launch(index) {
    stage = `launch-${index}`;
    app = start(resolve(process.argv[2]), ['--enable-next', '--app-shell', '--server', origin, '--shell-state', file], `app-${index}`);
    app.stdout.resume();
    let window;
    await until(() => {
      try { window = xdo('search', '--onlyvisible', '--pid', String(app.pid)).split('\n')[0]; return Boolean(window); } catch { return false; }
    }, 'app shell must open a real X11 window', app);
    alive(wm);
    xdo('windowactivate', '--sync', window);
    xdo('windowfocus', '--sync', window);
    stage = `create-${index}`;
    await until(async () => {
      observed = (await sessions()).length; return observed === 1;
    },
      () => `Terminal surface must create exactly one workspace session (observed ${observed})`, app);
    const [session] = await sessions();
    check(session.name === expected, 'native terminal must use the workspace ownerKey identity');
    await until(() => selected() === session.name, 'app must attach and capture the returned session name', app);
    return { window, name: session.name };
  }
  async function typeProof(window, name, index) {
    stage = `input-${index}`;
    const marker = `o8nexttyped${randomBytes(8).toString('hex')}`;
    const observer = new WebSocket(`ws://127.0.0.1:${info.wsPort}/ws?token=${encodeURIComponent(info.wsToken)}`);
    observer.on('error', () => {});
    let attached = false;
    let output = '';
    observer.on('message', raw => {
      try {
        const frame = JSON.parse(String(raw));
        if (frame.channel !== 'terminal' || frame.data?.sessionName !== name) return;
        if (frame.event === 'attached') attached = true;
        if (frame.event === 'data') output += Buffer.from(frame.data.data, 'base64').toString('utf8');
      } catch { /* unrelated frame */ }
    });
    try {
      await until(() => observer.readyState === WebSocket.OPEN, 'output observer must connect', app);
      // This socket only observes output. All input enters through native X11 keys.
      observer.send(JSON.stringify({ type: 'terminal-attach', sessionName: name, cols: 80, rows: 24, readOnly: true }));
      await until(() => attached, 'returned session must accept an output observer', app);
      xdo('windowfocus', '--sync', window);
      xdo('mousemove', '--window', window, '700', '450');
      xdo('click', '1');
      // Use physical US key presses instead of xdotool type's transient XKB
      // remapping, which can race GPUI's keyboard-map updates on punctuation.
      const keys = [...`echo ${marker}; pwd`].map(key => key === ' ' ? 'space' : key === ';' ? 'semicolon' : key);
      xdo('key', '--clearmodifiers', '--delay', '20', ...keys, 'Return');
      await until(() => {
        const lines = output.replace(/\r/g, '').split('\n');
        return lines.some((line, i) => line === marker && lines[i + 1] === workspace);
      }, 'typed native input must execute in the returned shell and workspace', app);
    } finally {
      if (observer.readyState !== WebSocket.CLOSED) {
        const closed = once(observer, 'close');
        observer.terminate();
        await closed;
      }
    }
  }
  async function quit(window) {
    stage = 'quit';
    const child = app;
    closeWindow(window);
    await until(() => child.exitCode !== null || child.signalCode !== null, 'app must quit through native window close');
    check(child.exitCode === 0, 'app must exit cleanly');
    app = null;
    check((await sessions()).length === 1 && (await sessions())[0].name === expected, 'quit must preserve exactly the owned session');
  }
  const first = await launch(1);
  await typeProof(first.window, first.name, 1);
  stage = 'picker';
  xdo('key', '--clearmodifiers', 'ctrl+alt+o');
  await until(() => state(file) && !selected(), 'Ctrl+Alt+O must leave the terminal picker open', app);
  check((await sessions()).length === 1, 'listing must not create a second session');
  await until(() => {
    if (selected() === first.name) return true;
    xdo('key', '--clearmodifiers', 'Return');
    return false;
  }, 'picker Enter must reattach the listed shell', app);
  await typeProof(first.window, first.name, 'picker');
  await quit(first.window);
  // Retain the real saved workspace/tab state but remove the terminal selection.
  // This proves owner-key adoption on reopen, rather than only saved-name attach.
  const saved = state(file);
  check(saved.selected === workspace && selected() === first.name, 'close must persist the attached terminal selection');
  delete saved.workspaces[workspace].terminal_session;
  writeFileSync(file, JSON.stringify(saved));
  const second = await launch(2);
  check(second.name === first.name, 'reopen must reuse the same session name');
  await typeProof(second.window, second.name, 2);
  await quit(second.window);
  console.log('TERMINAL_OWN_SHELL_PASS sessions=1 reused=true typedLaunches=2 pickerLists=true');
}
try { await main(); }
catch (error) {
  if (process.env.O8_NEXT_OWN_SHELL_DIAGNOSTICS) {
    try {
      execFileSync('import', ['-window', 'root', join(process.env.O8_NEXT_OWN_SHELL_DIAGNOSTICS, `${process.pid}-failure.png`)], { env, timeout: 5000, stdio: 'pipe' });
    } catch { /* optional local pixels must not obscure the failing assertion */ }
  }
  console.error(`TERMINAL_OWN_SHELL_FAIL stage=${stage}: ${error instanceof VerificationError ? error.message : 'fixture operation failed'}`);
  process.exitCode = 1;
} finally {
  await stop(app);
  await stop(host);
  await stop(wm);
  if (process.env.O8_NEXT_OWN_SHELL_DIAGNOSTICS) {
    const destination = process.env.O8_NEXT_OWN_SHELL_DIAGNOSTICS;
    mkdirSync(destination, { recursive: true });
    for (const [name, chunks] of diagnostics) writeFileSync(join(destination, `${process.pid}-${name}.log`), Buffer.concat(chunks));
    for (const file of ['shell.json', 'requests.json']) {
      if (existsSync(join(root, file))) writeFileSync(join(destination, `${process.pid}-${file}`), readFileSync(join(root, file)));
    }
  }
  rmSync(root, { recursive: true, force: true });
}
