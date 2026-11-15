require('./ws-parity-task-dispatch.cjs');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const root = process.env.CORTEX_IDE_DATA_DIR;
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = path.join(root, 'owned-codex');
const delivered = [];
const calls = [];
const save = () => fs.writeFileSync(path.join(root, 'steer-runtime.json'), JSON.stringify({ pid: process.pid, delivered, calls }));
async function accept(input, fallback = false) {
  const guard = require('../../src/lib/runtimes/shared/owned-session/action-admission');
  let session;
  try { session = JSON.parse(fs.readFileSync(path.join(root, 'owned-codex', input.surfaceId.split(':')[1], 'session.json'), 'utf8')); }
  catch { session = { surfaceId: input.surfaceId, recentRuns: [{ id: 'run-original', outcome: 'finished' }] }; }
  calls.push({ surfaceId: input.surfaceId, fallback }); save();
  if (!fallback && fs.existsSync(path.join(root, 'steer-busy'))) return { ok: false, reason: 'surface_not_ready', note: 'This worker is still finishing its current turn.' };
  guard.assertOwnedActionAdmission(session);
  while (fs.existsSync(path.join(root, 'hold-steer'))) await delay(10);
  if (!fallback && fs.existsSync(path.join(root, 'steer-fallback'))) return { ok: false, note: 'Surface not found' };
  const runId = `prepared-${delivered.length + 1}`;
  guard.assertOwnedActionAdmission({ ...session, activeRun: { id: runId } }, runId);
  delivered.push({ surfaceId: input.surfaceId, message: input.message, runId, fallback }); save();
  return { ok: true, status: 'completed', sessionKey: input.surfaceId, runId, note: 'Fixture accepted' };
}
globalThis.__o8TaskDispatchRuntime.performRuntimeAction = input => accept(input);
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (/\/codex\/owned(?:\.ts)?$/.test(request)) {
    const actual = load.call(this, request, parent, isMain);
    return new Proxy(actual, { get(target, key) {
      if (key === 'continueOwnedCodexSession') return (surfaceId, message) => accept({ surfaceId, message }, true);
      if (key === 'getOwnedCodexTelemetrySources') return async () => null;
      return Reflect.get(target, key);
    } });
  }
  if (/\/orchestrator\/headless-loop(?:\.ts)?$/.test(request)) return { runHeadlessSprintTick: async () => ({ launched: 0, active: 0, currentWave: 0, totalWaves: 0 }) };
  return load.call(this, request, parent, isMain);
};
