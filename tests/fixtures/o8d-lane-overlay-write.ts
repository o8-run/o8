// Test-only invocation of the canonical Node lane-event writer. Delivery stays
// with Node; this fixture records an immediate steer without calling a runtime.
async function main() {
  const { recordLaneEvent } = await import('../../src/lib/lane/events');
  const { closeDb } = await import('../../src/lib/db');
  try { recordLaneEvent(process.argv[2], 'steered_packet', 'user', { message: 'Fresh Node steer', source: 'Operator', deliveryState: 'immediate' }); }
  finally { closeDb(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
export {};
