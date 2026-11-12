// External runtime/provisioning stub. Admission, locks, cancellation, commands and settlement stay real.
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const load = Module._load;
const root = process.env.CORTEX_IDE_DATA_DIR;
const calls = [];
const spawns = [];
const accepted = [];
const receipt = () => fs.writeFileSync(path.join(root, 'task-runtime.json'), JSON.stringify({ pid: process.pid, node: process.versions.node, launchCount: spawns.length, calls, spawns, accepted, sessions: [...(globalThis.__o8TaskDispatchFixture?.sessions ?? [])] }));
const { pathToFileURL } = require('node:url');
const stubPath = path.join(__dirname, 'task-dispatch-runtime-stub.cjs');
const stubUrl = pathToFileURL(stubPath).href;
globalThis.__o8TaskDispatchFixture = { root, calls, spawns, accepted, sessions: new Map(), receipt };
if (typeof Module.registerHooks === 'function') {
  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (/\/runtime\/actions(?:\.ts)?$/.test(specifier)) return { url: stubUrl, shortCircuit: true };
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === stubUrl) return { format: 'commonjs', source: fs.readFileSync(stubPath, 'utf8'), shortCircuit: true };
      return nextLoad(url, context);
    },
  });
} else {
  Module.register(pathToFileURL(path.join(__dirname, 'task-dispatch-runtime-loader.mjs')).href);
}
Module._load = function (request, parent, isMain) {
  if (/\/runtimes\/shared\/auth-detect(?:\.ts)?$/.test(request)) {
    return new Proxy(load.call(this, request, parent, isMain), { get: (target, key) => key === 'assertRuntimeDispatchable' ? async () => {} : Reflect.get(target, key) });
  }
  if (/\/lane\/registry(?:\.ts)?$/.test(request)) {
    const actual = load.call(this, request, parent, isMain);
    return new Proxy(actual, { get(target, key) {
      if (key !== 'appendEvent') return Reflect.get(target, key);
      return (...args) => {
        const result = target.appendEvent(...args);
        if (args[1] === 'task_dispatch_accepted') { accepted.push({ laneId: args[0], dispatchId: args[3].dispatchId }); receipt(); }
        return result;
      };
    } });
  }
  if (/\/orchestrator\/capacity-snapshots(?:\.ts)?$/.test(request)) return { capturePacketCapacitySnapshot: async () => {} };
  if (/\/analytics\/server(?:\.ts)?$/.test(request)) return { emitProductEvent: () => {} };
  return load.call(this, request, parent, isMain);
};
