// Replace only model access. The singleton, harness, store claim and HTTP handlers are real.
const Module = require('node:module');
const { appendFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
// The async resolver chains with tsx; synchronous hooks cannot do so.
Module.register(pathToFileURL(join(__dirname, 'symon-brain-native-loader.mjs')).href);
const original = Module._load;
Module._load = function(request, parent, isMain) {
  const real = original.call(this, request, parent, isMain);
  if (/\/symon\/durable\/managed-provider(?:\.ts)?$/.test(request) || (request === './managed-provider' && /symon[\/]durable[\/]brain/.test(parent?.filename ?? ''))) {
    return { ...real, createSymonManagedProvider: async () => {
      const stub = await import('./symon-brain-native-provider.mjs');
      return stub.createSymonManagedProvider();
    } };
  }
  if (/\/cortex\/owner-process(?:\.ts)?$/.test(request)) {
    return { ...real, markNativeCortexReader: () => {
      appendFileSync(join(process.env.CORTEX_IDE_DATA_DIR, 'cortex-owner-marked'), 'marked\n');
      real.markNativeCortexReader();
    } };
  }
  return real;
};
if (process.env.O8_SYMON_FIXTURE_DEFAULT === '1') delete process.env.O8_NEXT_O8D;
