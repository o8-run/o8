// Exercise long-lived fixture output after the real Workers events response.
const { Server } = require('node:http');
const emit = Server.prototype.emit;
let written = false;
Server.prototype.emit = function (event, ...args) {
  if (event === 'request' && args[0].url?.startsWith('/api/orchestrator/lane-events') && !written) {
    written = true;
    args[1].once('finish', () => {
      process.stdout.write('fixture stdout\n'.repeat(80_000));
      process.stderr.write('fixture stderr\n'.repeat(80_000));
    });
  }
  return emit.call(this, event, ...args);
};
