// Replace only the runtime boundary. Routes, credentials and SQLite decisions stay real.
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const original = Module._load;
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = path.join(process.env.CORTEX_IDE_DATA_DIR, 'owned-codex');
const sessions = new Map();
let launches = 0;
let fences = 0;
let claimedAtSteer;
const receipt = () => fs.writeFileSync(path.join(process.env.CORTEX_IDE_DATA_DIR, 'approval-runtime.json'),
  JSON.stringify({ pid: process.pid, launches, fences, claimedAtSteer, sessions: [...sessions.entries()] }));
receipt();
const adapter = {
  resume: async (key, message) => {
    const session = sessions.get(key);
    if (!session || !session.live) return { ok: false, note: 'No live session in this owner' };
    session.messages.push(message); receipt();
    return { ok: true, surfaceId: key, note: 'Continued same owner session' };
  },
};
Module._load = function (request, parent, isMain) {
  if (/\/runtime\/actions(?:\.ts)?$/.test(request)) return {
    launchRuntimeSurface: async () => {
      const surfaceId = `codex-owned:fixture-${++launches}`;
      sessions.set(surfaceId, { live: true, messages: [] }); receipt();
      return { ok: true, surfaceId, note: 'Fixture launched' };
    },
    performRuntimeAction: async input => {
      const directory = path.join(process.env.CORTEX_IDE_OWNED_CODEX_ROOT, input.surfaceId.replace('codex-owned:', ''));
      const file = path.join(directory, 'session.json');
      if (fs.existsSync(file)) {
        const { listApprovalsForContext } = require('../../src/lib/approvals/store');
        claimedAtSteer = listApprovalsForContext({ sessionKey: input.surfaceId })[0]?.status;
        const session = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (fs.existsSync(path.join(directory, 'change-before-steer'))) {
          session.recentRuns[0].id = 'replacement-after-claim';
          fs.writeFileSync(file, JSON.stringify(session));
        }
        fences++; receipt();
        // Model the owned runtime mutation boundary, retaining the real WS fence.
        const { assertOwnedActionFence } = require('../../src/lib/runtimes/shared/owned-session/action-fence');
        await assertOwnedActionFence(input.surfaceId, session);
        if (!sessions.has(input.surfaceId)) sessions.set(input.surfaceId, { live: true, messages: [] });
      }
      return adapter.resume(input.surfaceId, input.message);
    },
  };
  if (/\/runtimes\/registry(?:\.ts)?$/.test(request)) {
    const actual = original.call(this, request, parent, isMain);
    return { ...actual, getRuntime: id => id === 'codex' ? adapter : actual.getRuntime(id) };
  }
  if (/\/agent-control\/service(?:\.ts)?$/.test(request)) return {
    performLegacyRuntimeActionViaAgentControl: async input => {
      const session = sessions.get(input.surfaceId);
      if (!session) return { ok: false, note: 'Unknown owner session' };
      session.live = false; receipt();
      return { ok: true, note: 'Fixture stopped', interrupted: true };
    },
  };
  return original.call(this, request, parent, isMain);
};
