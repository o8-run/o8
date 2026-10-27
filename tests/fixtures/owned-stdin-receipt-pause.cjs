// Widen the real relay write window without changing its receipt implementation.
const fs = require('node:fs');
const path = require('node:path');
const writeSync = fs.writeSync;
const writeFileSync = fs.writeFileSync;
function pauseReceipt(fd, data) {
  if (typeof fd !== 'number' || typeof data !== 'string' || !data.startsWith('{"stagedBytes":')) return false;
  writeSync(fd, data.slice(0, 1));
  writeFileSync(path.join(process.env.O8_STDIN_FIXTURE_ROOT, 'delivery-write-started'), 'paused');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  // Let the reader inspect the paused write even if the test host is busy.
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(path.join(process.env.O8_STDIN_FIXTURE_ROOT, 'delivery-write-release')) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  writeSync(fd, data.slice(1));
  return true;
}
fs.writeSync = function(fd, data, ...args) {
  return pauseReceipt(fd, data) ? Buffer.byteLength(data) : writeSync(fd, data, ...args);
};
fs.writeFileSync = function(fd, data, ...args) {
  if (!pauseReceipt(fd, data)) return writeFileSync(fd, data, ...args);
};
