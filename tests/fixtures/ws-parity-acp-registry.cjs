// Replace only the public catalog network boundary; GET and auth stay real.
const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, options) {
  if (String(input) === 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json') {
    return Promise.resolve(Response.json({ agents: [{
      id: 'fixture-agent', name: 'Fixture agent', version: '1.0.0',
      distribution: { npx: { package: 'fixture-agent@1.0.0', args: [] } },
    }] }));
  }
  return originalFetch(input, options);
};

// The detection socket test exercises credential reads, not host-installed CLI versions.
// Keep these external probes below the production ten-second route deadline under CI load.
const childProcess = require('node:child_process');
const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function (command, args, options) {
  if (Array.isArray(args) && args.length === 1 && args[0] === '--version') {
    return options?.encoding ? 'fixture 1.0.0\n' : Buffer.from('fixture 1.0.0\n');
  }
  return originalExecFileSync.call(this, command, args, options);
};
require('node:module').syncBuiltinESMExports();
