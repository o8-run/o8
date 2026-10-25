import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The pinned package layout and native constructor boundary, with fixture hardware. */
export function stageDeviceViewerHelper(directory: string, receipt: string, control: string): void {
  const middleware = join(directory, 'vendor/serve-sim/dist/middleware.js');
  const index = join(directory, 'dist/server/index.mjs');
  mkdirSync(dirname(middleware), { recursive: true }); mkdirSync(dirname(index), { recursive: true });
  writeFileSync(middleware, `
import { appendFileSync, readFileSync } from 'node:fs';
async function record(device, action) {
  const config = JSON.parse(readFileSync(${JSON.stringify(control)}, 'utf8'));
  if (config.manualDelay) await new Promise(resolve => setTimeout(resolve, config.manualDelay));
  appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({ device, action }) + '\\n');
  return { applied: true };
}
const e6 = () => ({ axTypeKeyboardCharacter: device => record(device, 'ax-type'), setHardwareKeyboard: device => record(device, 'hardware-keyboard'), SimHID: class {
  constructor(device) { this.device = device; }
  button() { return record(this.device, 'button'); }
  touch(type) { return record(this.device, 'touch-' + type); }
  key(type) { return record(this.device, 'key-' + type); }
  supportsHingeAngle() { return Promise.resolve(false); }
} });
export class FixtureHid {
  constructor($){this.handle=new(e6()).SimHID($)}
  button() { return this.handle.button(); }
  touch(type) { return this.handle.touch(type); }
}
const fM = request => record(request.params.udid, 'exec');
export async function fixtureExec(z, J = {}) { return fM(z,J.serveSimBinPath??"serve-sim"); }
export async function fixtureUi(z) { const J = { onUiRequest: value => record(value.device, 'ui') }; return J.onUiRequest(z.ui); }
export async function fixtureLifecycle(input) { return record(input.id, 'lifecycle'); }
function AY($,v){return e6().axTypeKeyboardCharacter($,v)}
function TY($,v){return e6().setHardwareKeyboard($,v)}
export const fixtureAxType = device => AY(device, 'A');
export const fixtureHardwareKeyboard = device => TY(device, true);
`);
  const emuMapping = '[`${EMU_PREFIX}/ws`]: gatedSocket(emuWebSocketHandler)';
  writeFileSync(index, `
import { FixtureHid, fixtureExec, fixtureUi, fixtureLifecycle, fixtureAxType, fixtureHardwareKeyboard } from '../../vendor/serve-sim/dist/middleware.js';
export { FixtureHid, fixtureExec, fixtureUi, fixtureAxType, fixtureHardwareKeyboard };
const withFramePolicy = response => response;
async function routeRequest(request) {
  if (new URL(request.url).pathname !== '/api/devices/boot') return null;
  const input = await request.json(); return Response.json(await fixtureLifecycle(input));
}
export default async function handler(request) { const gated = request; return withFramePolicy(await routeRequest(gated)); }
function ensureHelperSpawned() { throw new Error('Unfenced helper launch'); }
export function fixturePreviewRoot() { ensureHelperSpawned(); }
const EMU_PREFIX = '/vendor/serve-emu'; const gatedSocket = handler => handler;
const emuWebSocketHandler = socket => socket.send(JSON.stringify({ applied: true }));
export const webSocketHandlers = { ${emuMapping} };
`);
}
