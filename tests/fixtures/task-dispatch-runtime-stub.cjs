// Explicit CommonJS exports are visible to both require() and ESM import().
const { setTimeout: delay } = require('node:timers/promises');
const fs = require('node:fs');
const path = require('node:path');
exports.launchRuntimeSurface = async input => {
  const fixture = globalThis.__o8TaskDispatchFixture;
  fixture.calls.push({ laneId: input.existingLaneId, mutationId: input.clientMutationId });
  fixture.receipt();
  while (fs.existsSync(path.join(fixture.root, 'hold-task-launch'))) await delay(10);
  require('../../src/lib/runtimes/shared/owned-session/action-admission').assertOwnedActionAdmission(null);
  const surfaceId = `fixture:${input.existingLaneId}`;
  fixture.spawns.push(input.existingLaneId);
  fixture.sessions.set(surfaceId, { laneId: input.existingLaneId, live: true });
  fixture.receipt();
  return { ok: true, surfaceId, note: 'Fixture started' };
};
exports.performRuntimeAction = async input => ({ ok: true, surfaceId: input.surfaceId, action: input.action, status: 'completed' });
