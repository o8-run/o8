// External runtime/provisioning stub. Admission, locks, cancellation, commands and settlement stay real.
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const load = Module._load;
const root = process.env.CORTEX_IDE_DATA_DIR;
const calls = [];
const spawns = [];
const accepted = [];
const receipt = () => fs.writeFileSync(path.join(root, 'task-runtime.json'), JSON.stringify({ pid: process.pid, calls, spawns, accepted }));
globalThis.__o8TaskRuntimeStub = {
    launchRuntimeSurface: async input => {
      calls.push({ laneId: input.existingLaneId, mutationId: input.clientMutationId }); receipt();
      while (fs.existsSync(path.join(root, 'hold-task-launch'))) await delay(10);
      require('../../src/lib/runtimes/shared/owned-session/action-admission').assertOwnedActionAdmission(null);
      spawns.push(input.existingLaneId); receipt();
      return { ok: true, surfaceId: `fixture:${input.existingLaneId}`, note: 'Fixture started' };
    },
    performRuntimeAction: async input => ({ ok: true, surfaceId: input.surfaceId, action: input.action, status: 'completed' }),
    };
Module._load = function (request, parent, isMain) {
  if (/\/runtime\/actions(?:\.ts)?$/.test(request)) return globalThis.__o8TaskRuntimeStub;
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
