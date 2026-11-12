// Replace only the provider factory. Load the real module first so its constants
// retain their identity; redirecting that module through an ESM loader creates a cycle.
// The singleton, harness, store claim and HTTP handlers remain real.
const Module = require('node:module');
const { appendFileSync } = require('node:fs');
const { join } = require('node:path');
const original = Module._load;
Module._load = function(request, parent, isMain) {
  const real = original.call(this, request, parent, isMain);
  if (/\/symon\/durable\/managed-provider(?:\.ts)?$/.test(request) || (request === './managed-provider' && /symon[\/]durable[\/]brain/.test(parent?.filename ?? ''))) {
    return { ...real, createSymonManagedProvider: async () => {
      const stub = await import('./symon-brain-native-provider.mjs');
      return stub.createSymonManagedProvider(real.SYMON_MANAGED_MODEL);
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

// Opt-in daemon lifecycle diagnostics for the real-path fixture.
if (process.env.O8_TEST_DAEMON_TRACE === '1') {
  const cp = require('node:child_process');
  const spawn = cp.spawn;
  cp.spawn = function(...args) {
    const child = spawn.apply(this, args);
    if (args[1]?.includes('--app-upstream')) {
      console.error('[daemon] spawn', child.pid);
      child.stderr?.on('data', chunk => process.stderr.write(chunk));
      child.on('exit', (code, signal) => console.error('[daemon] exit', child.pid, code, signal));
    }
    return child;
  };
}
