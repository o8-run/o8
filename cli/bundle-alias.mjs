// Module aliases every CLI bundle needs, shared by cli/esbuild.config.mjs and
// the real-path tests that bundle cli/src/index.ts themselves, so a test-built
// CLI cannot drift from the shipped one.
//
// `server-only` throws outside a React Server Component build. The CLI imports
// a few server modules that carry the marker, so it resolves to an empty stub.

import { fileURLToPath } from 'node:url';

export const cliBundleAlias = Object.freeze({
  'server-only': fileURLToPath(new URL('../scripts/server-only-stub.js', import.meta.url)),
});
