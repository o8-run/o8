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
