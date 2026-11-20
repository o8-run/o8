import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Checked-in assets keep WS packaging independent of Next and runtime disk paths.
const root = fileURLToPath(new URL('../', import.meta.url));
const output = await build({
  absWorkingDir: root,
  entryPoints: ['src/lib/broadcast/static/entry.tsx'],
  bundle: true,
  write: false,
  minify: true,
  platform: 'browser',
  format: 'iife',
  target: ['es2020'],
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'inline',
  metafile: true,
});
if (Object.keys(output.metafile.inputs).some(path => path.startsWith('src/app/') || path.includes('node_modules/next/'))) {
  throw new Error('Standalone broadcast must not depend on Next or src/app');
}
const css = ':root{--font-sans-system:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Segoe UI",Roboto,"Helvetica Neue",Arial,system-ui,sans-serif;--font-mono-system:"SF Mono",Menlo,Consolas,monospace}html{font-family:var(--font-sans-system)}body{margin:0}*{scrollbar-width:none}*::-webkit-scrollbar{display:none}button,input,select{font:inherit}';
const contents = JSON.stringify({ javascript: output.outputFiles[0].text, css }) + '\n';
const path = new URL('../src/lib/broadcast/static/assets.json', import.meta.url);
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== contents) throw new Error('Broadcast assets are stale; run node scripts/build-broadcast-page.mjs');
} else {
  writeFileSync(path, contents);
}
console.log(`Broadcast assets: ${Buffer.byteLength(contents)} bytes${process.argv.includes('--check') ? ' (verified)' : ''}`);
