// Replace only runtime boundaries. Routes, credentials and SQLite decisions stay real.
const Module = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const original = Module._load;
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = path.join(process.env.CORTEX_IDE_DATA_DIR, 'owned-codex');
const stubPath = path.join(__dirname, 'ws-parity-approval-runtime-actions.cjs');
const stub = require(stubPath);

// Node 22's synchronous hooks cannot chain with tsx's asynchronous loader
// (ERR_METHOD_NOT_IMPLEMENTED: resolveSync). Register an ESM resolver as well
// as the require boundary, both pointing at the same named CommonJS exports.
Module.register(pathToFileURL(path.join(__dirname, 'ws-parity-approval-runtime-loader.mjs')).href);
Module._load = function (request, parent, isMain) {
  if (/\/runtime\/actions(?:\.ts)?$/.test(request)) return stub;
  if (/\/runtimes\/registry(?:\.ts)?$/.test(request)) {
    const actual = original.call(this, request, parent, isMain);
    return { ...actual, getRuntime: id => id === 'codex' ? { resume: stub.resume } : actual.getRuntime(id) };
  }
  if (/\/agent-control\/service(?:\.ts)?$/.test(request)) return {
    performLegacyRuntimeActionViaAgentControl: stub.interrupt,
  };
  return original.call(this, request, parent, isMain);
};
