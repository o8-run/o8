import { spawnSync } from 'node:child_process';

// The full application needs more than Node's default old-space budget. Match
// the existing tsc cross-check while leaving room on a 16 GiB host.
const HEAP_MIB = 8192;

export function runTypecheckProcess(modulePath, args, cwd = process.cwd()) {
  console.log(`[typecheck] heap limit: ${HEAP_MIB} MiB`);
  const result = spawnSync(process.execPath, [
    `--max-old-space-size=${HEAP_MIB}`, modulePath, ...args,
  ], {
    cwd,
    encoding: 'utf8',
    stdio: ['inherit', 'inherit', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  // V8 writes its fatal allocation report to stderr before aborting. Hold that
  // stream until exit so a heap failure has one actionable diagnostic.
  if (/FATAL ERROR:.*(?:heap|allocation)|JavaScript heap out of memory/i.test(result.stderr ?? '')) {
    console.error(`[typecheck] heap exhausted at ${HEAP_MIB} MiB; type check failed.`);
    return 1;
  }
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    console.error(`[typecheck] could not start checker: ${result.error.code ?? 'unknown error'}`);
    return 1;
  }
  if (result.signal) {
    console.error(`[typecheck] checker terminated by ${result.signal}.`);
    return 1;
  }
  return result.status ?? 1;
}
