/** Private-display capture entry point. Visual differences are informational. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReport } from './report.mjs';
import { CaptureError } from './health.mjs';

const manifest = JSON.parse(readFileSync(new URL('./surfaces.json', import.meta.url), 'utf8'));
export function validateManifest() {
  const shell = readFileSync(new URL('../../native/o8-next/src/shell.rs', import.meta.url), 'utf8');
  const registered = [...shell.matchAll(/^        (\w+): .* = "surfaces\//gm)].map(match => match[1]).sort();
  const mapped = manifest.surfaces.map(row => row.id).sort();
  const missing = registered.filter(id => !mapped.includes(id));
  const stale = mapped.filter(id => !registered.includes(id));
  const duplicate = mapped.filter((id, index) => mapped.indexOf(id) !== index);
  const errors = [missing.length && `Unmapped registered surfaces: ${missing.join(', ')}`,
    stale.length && `Unregistered surface mappings: ${stale.join(', ')}`,
    duplicate.length && `Duplicate surface mappings: ${duplicate.join(', ')}`].filter(Boolean);
  if (errors.length) throw new CaptureError(`${errors.join('; ')}. Update scripts/parity/surfaces.json.`);
}
async function main() {
  const args = process.argv.slice(2);
  const options = { output: resolve('work/next-parity'), binary: resolve('native/o8-next/target/debug/o8-next'),
    browser: process.env.O8_PARITY_BROWSER || '', only: '', nativeTest: '', webHost: resolve('scripts/parity/web-server.ts') };
  let comparison;
  let listing = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--list') listing = true;
    else if (args[i] === '--compare' && args[i + 1]) comparison = args[++i];
    else if (Object.hasOwn(options, args[i].slice(2)) && args[i + 1]) options[args[i].slice(2)] = args[++i];
    else throw new Error('Use --list | --compare FILE | [--output DIR --binary FILE --browser FILE --only SURFACE --nativeTest FILE --webHost FILE]');
  }
  if (options.only && !manifest.surfaces.some(row => row.id === options.only)) throw new CaptureError(`Unknown surface: ${options.only}`);
  if (listing || !comparison) validateManifest();
  if (listing) { console.log(JSON.stringify(manifest)); return; }
  options.output = resolve(options.output);
  options.binary = resolve(options.binary);
  const captures = comparison ? JSON.parse(readFileSync(comparison, 'utf8'))
    : await (await import('./capture.mjs')).capture(manifest, options);
  const report = writeReport(captures, options.output, manifest);
  console.log(`${report.cases.length} captures; ${report.crashes} crashes; visual differences do not gate`);
  if (report.crashes) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error instanceof CaptureError ? error.reason : 'Parity harness failed; inspect the local capture logs.'); process.exitCode = 1;
});
