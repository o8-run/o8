/** Private-display capture entry point. Visual differences are informational. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReport } from './report.mjs';

const manifest = JSON.parse(readFileSync(new URL('./surfaces.json', import.meta.url), 'utf8'));
export function validateManifest() {
  const shell = readFileSync(new URL('../../native/o8-next/src/shell.rs', import.meta.url), 'utf8');
  const registered = [...shell.matchAll(/^        (\w+): .* = "surfaces\//gm)].map(match => match[1]).sort();
  const mapped = manifest.surfaces.map(row => row.id).sort();
  if (JSON.stringify(registered) !== JSON.stringify(mapped)) throw new Error('Surface manifest differs from the shell registrations');
}
async function main() {
  validateManifest();
  const args = process.argv.slice(2);
  const options = { output: resolve('work/next-parity'), binary: resolve('native/o8-next/target/debug/o8-next'),
    browser: process.env.O8_PARITY_BROWSER || '', only: '', nativeTest: '', webHost: resolve('scripts/parity/web-server.ts') };
  let comparison;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--list') { console.log(JSON.stringify(manifest)); return; }
    if (args[i] === '--compare' && args[i + 1]) comparison = args[++i];
    else if (Object.hasOwn(options, args[i].slice(2)) && args[i + 1]) options[args[i].slice(2)] = args[++i];
    else throw new Error('Use --list | --compare FILE | [--output DIR --binary FILE --browser FILE --only SURFACE --nativeTest FILE --webHost FILE]');
  }
  options.output = resolve(options.output);
  options.binary = resolve(options.binary);
  const captures = comparison ? JSON.parse(readFileSync(comparison, 'utf8'))
    : await (await import('./capture.mjs')).capture(manifest, options);
  const report = writeReport(captures, options.output, manifest);
  console.log(`${report.cases.length} captures; ${report.crashes} crashes; visual differences do not gate`);
  if (report.crashes) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error('Parity harness failed; inspect the local capture logs.'); process.exitCode = 1;
});
