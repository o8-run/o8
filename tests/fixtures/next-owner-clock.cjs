// Deterministic fixture time for complete cross-process response comparisons.
if (process.env.O8_NEXT_OWNER_FIXTURE !== '1') throw new Error('Fixture opt-in required');
const os = require('node:os');
const { syncBuiltinESMExports } = require('node:module');
const providerRoot = process.env.O8_NEXT_OWNER_PROVIDER_ROOT;
if (!providerRoot) throw new Error('Owned provider fixture root required');
os.homedir = () => providerRoot;
os.hostname = () => 'fixture-device';
syncBuiltinESMExports();
const { AsyncLocalStorage } = require('node:async_hooks');
const Clock = Date;
const instant = Clock.parse('2026-10-01T01:00:00.000Z');
const context = new AsyncLocalStorage();
const requestRandom = new AsyncLocalStorage();
const http = require('node:http');
const createServer = http.createServer;
const requests = new Map();
http.createServer = function (...args) {
  const index = typeof args[0] === 'function' ? 0 : 1;
  const listener = args[index];
  if (typeof listener === 'function') args[index] = function (request, response) {
    const path = `${request.method} ${request.url.split('?')[0]}`;
    const ordinal = (requests.get(path) ?? 0) + 1;
    requests.set(path, ordinal);
    let value = 2166136261;
    for (const char of `${path}:${ordinal}`) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
    return requestRandom.run({ value }, () => listener.call(this, request, response));
  };
  return createServer.apply(this, args);
};
syncBuiltinESMExports();
const scoped = process.env.O8_NEXT_OWNER_FIXTURE_ROLE === 'next';
function fixtureTime() {
  if (scoped) return context.getStore() === true;
  const frames = new Error().stack.split('\n').slice(3);
  const caller = frames.find(frame => !/node-environment-extensions[\\/]date\.|Reflect\.construct/.test(frame)) ?? '';
  return /[\\/]src[\\/](?:lib|app)[\\/]|[\\/]scripts[\\/]next[\\/]/.test(caller);
}

// The pinned Next server loads these route modules through Node. Scope only
// their execution, leaving compiler scheduling and transport deadlines real.
if (scoped) {
  const Module = require('node:module');
  const load = Module._load;
  const wrapped = Symbol('fixture-clock');
  Module._load = function (request, parent, isMain) {
    const exports = load.call(this, request, parent, isMain);
    const route = /[\\/]server[\\/]app[\\/].*[\\/]route\.js$/.test(request) ? exports?.routeModule : null;
    if (route && typeof route.do === 'function' && !route[wrapped]) {
      const execute = route.do;
      route[wrapped] = true;
      route.do = function (handler, ...args) {
        const frozen = function (...input) { return context.run(true, () => handler.apply(this, input)); };
        return execute.call(this, frozen, ...args);
      };
    }
    return exports;
  };
}
global.Date = class extends Clock {
  constructor(...args) { super(...(args.length ? args : [fixtureTime() ? instant : Clock.now()])); }
  static now() { return fixtureTime() ? instant : Clock.now(); }
  static parse(value) { return Clock.parse(value); }
  static UTC(...args) { return Clock.UTC(...args); }
};
// Receipt IDs stay unique within each request and repeat across the two owned
// fixture cohorts. Framework randomness outside the handler remains untouched.
const random = Math.random;
Math.random = function () {
  const state = requestRandom.getStore();
  if (!state || !fixtureTime()) return random();
  state.value = (Math.imul(state.value, 1664525) + 1013904223) >>> 0;
  return state.value / 0x100000000;
};
