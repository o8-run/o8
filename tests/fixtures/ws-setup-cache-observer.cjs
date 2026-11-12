// Observe completion of the real Symon cache invalidator in the WS process.
const Module = require('node:module');
const { appendFileSync } = require('node:fs');
const { join } = require('node:path');
const load = Module._load;
Module._load = function (request, parent, isMain) {
  const result = load.call(this, request, parent, isMain);
  if (/\/mcp\/symon-tools-cache(?:\.ts)?$/.test(request)) {
    return { ...result, registerSymonMcpCacheInvalidator(handler) {
      return result.registerSymonMcpCacheInvalidator(() => {
        handler();
        appendFileSync(join(process.env.HOME, 'cache-invalidations'), 'cleared\n');
      });
    } };
  }
  return result;
};
