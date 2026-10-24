/** Pinned helper adaptation. Missing or duplicate boundaries stop startup. */
export const VIEWER_BOUNDARIES = {
  native: [
    ['this.handle=new(e6()).SimHID($)', 'this.handle=globalThis.__o8DeviceGate.native($,new(e6()).SimHID($))'],
    ['fM(z,J.serveSimBinPath??"serve-sim")', 'globalThis.__o8DeviceGate.exec(z,()=>fM(z,J.serveSimBinPath??"serve-sim"))'],
    ['J.onUiRequest(z.ui)', 'globalThis.__o8DeviceGate.ui(z.ui,()=>J.onUiRequest(z.ui))'],
    ['function AY($,v){return e6().axTypeKeyboardCharacter($,v)}', 'function AY($,v){return globalThis.__o8DeviceGate.nativeInput($,()=>e6().axTypeKeyboardCharacter($,v))}'],
    ['function TY($,v){return e6().setHardwareKeyboard($,v)}', 'function TY($,v){return globalThis.__o8DeviceGate.nativeInput($,()=>e6().setHardwareKeyboard($,v))}'],
  ],
  hub: [
    ['return withFramePolicy(await routeRequest(gated));', 'return withFramePolicy(await globalThis.__o8DeviceGate.http(gated,()=>routeRequest(gated)));'],
    ['ensureHelperSpawned();', ';'],
    ['[`${EMU_PREFIX}/ws`]: gatedSocket(emuWebSocketHandler)', '[`${EMU_PREFIX}/ws`]: socket=>socket.close(1008,"Device control unavailable")'],
  ],
} as const;

export const VIEWER_LOADER = String.raw`
let targets;
export function initialize(data) { targets = data.targets; }
export async function load(url, context, next) {
  const loaded = await next(url, context);
  const target = targets[url];
  if (!target) return loaded;
  let source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString();
  if (target.part === 'native') {
    const known = new Set(['SimHID', 'SimCapture', 'axDescribe', 'axFrontmost', 'axTypeKeyboardCharacter', 'setHardwareKeyboard']);
    for (const match of source.matchAll(/e6\(\)\)?\.([A-Za-z_][A-Za-z_0-9]*)/g)) {
      if (!known.has(match[1])) throw new Error('Unrecognized native input boundary');
    }
  }
  for (const [before, after] of target.rules) {
    if (source.split(before).length !== 2) throw new Error('Device viewer input boundary does not match the pinned helper.');
    source = source.replace(before, after);
  }
  source += '\nglobalThis.__o8DeviceGate.ready(' + JSON.stringify(target.part) + ');\n';
  return { ...loaded, source };
}
`;

export const VIEWER_BOOTSTRAP = String.raw`
import { register } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpath } from 'node:fs/promises';
const config = JSON.parse(process.argv[2]);
process.argv.splice(2, 1);
const context = new AsyncLocalStorage();
const pending = new Map(); const devices = new Map(); let sequence = 0;
function request(type, body) {
  if (!process.connected) return Promise.reject(new Error('Device authority unavailable'));
  const requestId = String(++sequence);
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    process.send({ type, requestId, ...body });
  });
}
process.on('message', message => {
  if (message?.type !== 'o8-device-result') return;
  const item = pending.get(message.requestId); if (!item) return;
  pending.delete(message.requestId);
  message.ok ? item.resolve(message) : item.reject(new Error('Device controller changed'));
});
process.on('disconnect', () => process.exit(1));
async function run(device, work) {
  if (typeof device !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(device)) throw new Error('Choose a device controller');
  const inherited = context.getStore();
  if (inherited?.device === device && !inherited.closed) {
    const task = Promise.resolve().then(work); inherited.tasks.push(task); return task;
  }
  let state = devices.get(device);
  if (!state) { state = { tail: Promise.resolve(), lease: null, holds: new Set() }; devices.set(device, state); }
  const result = state.tail.then(async () => {
    if (!state.lease) state.lease = (await request('o8-device-begin', { deviceId: device })).lease;
    const scope = { device, state, tasks: [], closed: false }; let failed = false;
    try {
      const value = await context.run(scope, work);
      for (let index = 0; index < scope.tasks.length; index++) await scope.tasks[index];
      return value;
    } catch (error) { failed = true; state.holds.clear(); throw error; }
    finally {
      scope.closed = true;
      if (!state.holds.size) {
        const lease = state.lease; state.lease = null;
        await request('o8-device-complete', { lease, failed });
      }
    }
  });
  state.tail = result.catch(() => {}); return result;
}
let handleId = 0;
function native(device, handle) {
  const id = ++handleId;
  const read = new Set(['supportsHingeAngle', 'supportsPhysicalOrientation', 'hingeState', 'setScreen']);
  return new Proxy(handle, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    if (read.has(key)) return value.bind(target);
    return (...args) => run(device, async () => {
      const result = await value.apply(target, args);
      const state = context.getStore().state;
      let hold; let begin; let end;
      if (key === 'touch' || key === 'multiTouch') { hold = id + ':' + key; begin = args[0] === 'begin'; end = args[0] === 'end'; }
      if (key === 'key') { hold = id + ':key:' + args[1]; begin = args[0] === 'down'; end = args[0] === 'up'; }
      if (key === 'buttonHid') { hold = id + ':button:' + args[0] + ':' + args[1]; begin = args[2] === 'down'; end = args[2] === 'up'; }
      if (hold && begin) state.holds.add(hold);
      if (hold && end) state.holds.delete(hold);
      return result;
    });
  } });
}
const ready = new Set();
function deviceOf(...inputs) {
  const values = inputs.flatMap(input => ['device', 'udid', 'id'].map(key => input?.[key])).filter(value => value !== undefined && value !== null);
  if (!values.length) return undefined;
  if (values.some(value => typeof value !== 'string' || value !== values[0] || !/^[A-Za-z0-9_-]{1,256}$/.test(value))) throw new Error('Conflicting device targets');
  return values[0];
}
globalThis.__o8DeviceGate = {
  native, nativeInput: run,
  ready(part) { ready.add(part); if (ready.size === 2) process.send({ type: 'o8-device-ready' }); },
  async exec(input, work) {
    const device = deviceOf(input?.params);
    if (!device || input.params.udid !== device) throw new Error('Choose an explicit simulator');
    if (['appearance.get', 'screenshot.capture'].includes(input.action)) return work();
    if (!['appearance.set', 'location.set', 'location.clear', 'home.springboard', 'permissions.set', 'permissions.resetAll', 'app.install', 'media.add'].includes(input.action)) throw new Error('This viewer command is not admitted by the device authority');
    return run(device, work);
  },
  async ui(input, work) { return input?.option === undefined ? work() : run(deviceOf(input), work); },
  async http(request, work) {
    const url = new URL(request.url); const path = url.pathname;
    if (path.includes('/devtools') || path.startsWith('/vendor/serve-emu')) return Response.json({ error: 'Device control unavailable' }, { status: 403 });
    const read = request.method === 'GET' || request.method === 'HEAD';
    // Startup health must work before a controller can acquire the device.
    if (read && path === '/readyz') return work();
    const root = ['/', '/index.html', '/api/devices', '/api/new-device-options', '/vendor/serve-sim', '/vendor/serve-sim/', '/vendor/serve-sim/grid', '/vendor/serve-sim/grid/'].includes(path);
    const asset = /\.(?:js|css|svg|png|jpg|woff2?)$/.test(path);
    const grid = /^\/vendor\/serve-sim\/grid\/api\/(?:catalog|status(?:\/events)?|memory|devicekit-chrome|device-placeholder-asset|devicekit-model)$/.test(path);
    const preview = /^\/vendor\/serve-sim\/helper\/(?:[A-Za-z0-9_-]+\/)?(?:health|config|ax|foreground|stream\.mjpeg|stream\.avcc|webrtc(?:\/stats)?)$/.test(path);
    const video = /^\/vendor\/serve-sim\/helper\/(?:[A-Za-z0-9_-]+\/)?(?:panel\/[^/]+\/)?webrtc(?:\/close)?$/.test(path);
    if (read && (root || asset || grid || preview) || video && request.method === 'POST') return work();
    try {
      const input = request.method === 'GET' || request.method === 'HEAD' ? null : await request.clone().json().catch(() => null);
      if (input?.platform === 'android') throw new Error('iOS device control only');
      const pathDevice = /^\/vendor\/serve-sim\/helper\/([A-Za-z0-9_-]+)\//.exec(path)?.[1];
      const device = deviceOf(input, { device: url.searchParams.get('device'), udid: url.searchParams.get('udid'), id: url.searchParams.get('id') }, { device: pathDevice });
      return await run(device, work);
    } catch { return Response.json({ error: 'Device controller changed. Refresh Devices.' }, { status: 409 }); }
  },
};
process.argv[1] = await realpath(process.argv[1]);
const entry = pathToFileURL(process.argv[1]);
const targets = {
  [pathToFileURL(await realpath(resolve(dirname(process.argv[1]), 'index.mjs'))).href]: { part: 'hub', rules: config.boundaries.hub },
  [pathToFileURL(await realpath(resolve(dirname(process.argv[1]), '../../vendor/serve-sim/dist/middleware.js'))).href]: { part: 'native', rules: config.boundaries.native },
};
register('data:text/javascript,' + encodeURIComponent(config.loader), { parentURL: entry.href, data: { targets } });
await import(entry.href);
`;
