#!/usr/bin/env node
// Inventory: root lockfile native install scripts plus platform bindings used
// by Next builds, ESLint's resolver, Vitest/Vite, CSS transforms and WebSocket tests.
// Do not catch load failures: optional accelerators are required in this cache.
const lock = require('../../package-lock.json');
const modules = ['better-sqlite3', 'node-pty', 'bufferutil', 'utf-8-validate',
  'sharp', 'unrs-resolver', 'lightningcss'];
for (const name of modules) {
  if (!lock.packages[`node_modules/${name}`]) throw new Error(`Native inventory missing from lockfile: ${name}`);
  const loaded = require(name);
  if (name === 'better-sqlite3') loaded(':memory:').close();
  console.log(`[native-load] ${name}: PASS`);
}
// These wrappers defer binding loading until called.
require('esbuild').transformSync('let x = 1');
// Rolldown is ESM; importing it loads its platform binding.
const rolldown = import('rolldown');
Promise.all([rolldown, require('next/dist/build/swc').loadBindings()]).then(() => {
  console.log('[native-load] esbuild, rolldown, next/swc: PASS');
}).catch(error => { console.error(error); process.exitCode = 1; });
