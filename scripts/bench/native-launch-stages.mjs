// Extends the pinned measurement harness in a disposable checkout only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchStageIntervals } from './launch-stage-summary.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const [key, value] = arg.replace(/^--/, '').split('=');
  return [key, value ?? true];
}));
const harness = path.resolve(String(args.harness));
const sourceFile = path.join(harness, 'scripts/bench/native-launch.mjs');
const generated = path.join(harness, 'scripts/bench/native-launch-stages.generated.mjs');
const helper = fileURLToPath(new URL('./launch-stage-preload.cjs', import.meta.url));
const summary = new URL('./launch-stage-summary.mjs', import.meta.url).href;
const profile = Boolean(args.profile);
let source = fs.readFileSync(sourceFile, 'utf8');
function replace(before, after) {
  assert.equal(source.split(before).length, 2, 'Pinned measurement anchor changed');
  source = source.replace(before, after);
}
replace("O8_FORCE_BUNDLED_SERVERS: '1', O8_BOOT_TRACE: '1',", `O8_FORCE_BUNDLED_SERVERS: '1', O8_BOOT_TRACE: '1',
    NODE_OPTIONS: ${JSON.stringify('--require=' + JSON.stringify(helper))},
    O8_LAUNCH_CPU_PROFILE: '${profile ? '1' : '0'}',`);
replace('timeOrigin: performance.timeOrigin, pageNow:', `frame: window.__o8LaunchRenderedFrame ?? null,
    clientModules: window.__o8LaunchClientModules ? [...window.__o8LaunchClientModules.values()].sort((a, b) => b.exclusiveMs - a.exclusiveMs).slice(0, 32) : [],
    frameCallbacks: window.__o8LaunchFrameCallbacks ? [...window.__o8LaunchFrameCallbacks.values()].sort((a, b) => b.totalMs - a.totalMs) : [],
    canvasCalls: window.__o8LaunchCanvas ?? {},
    paints: performance.getEntriesByType('paint').map(row => ({ name: row.name, atMs: row.startTime })),
    timeOrigin: performance.timeOrigin, pageNow:`);
replace('type: row.initiatorType, startMs: row.startTime, durationMs: row.duration, path:',
  'type: row.initiatorType, startMs: row.startTime, durationMs: row.duration, decodedBytes: row.decodedBodySize, encodedBytes: row.encodedBodySize, responseStartMs: row.responseStart, responseEndMs: row.responseEnd, path:');
replace('receipt.samples.push({ sample, interactiveComposerMs,', 'receipt.samples.push({ sample, startedEpochMs: epoch, frame: lastProbe.frame, paints: lastProbe.paints, clientModules: lastProbe.clientModules, frameCallbacks: lastProbe.frameCallbacks, canvasCalls: lastProbe.canvasCalls, interactiveComposerMs,');
if (profile) {
  const browserProfile = fs.readFileSync(new URL('./launch-client-profile.js', import.meta.url), 'utf8');
  replace('if (!window.__o8StartupFetchObserved) {', browserProfile + '\n  if (!window.__o8StartupFetchObserved) {');
}
replace('await sleep(30_000);', `receipt.samples.at(-1).serverProfile = await collectLaunchStageProfile(seeded.dataDir, epoch);
        await sleep(1000);`);
source = `import { collectLaunchStageProfile } from ${JSON.stringify(summary)};\n` + source;
fs.writeFileSync(generated, source, { flag: 'wx' });
try {
  const { measureNativeLaunch } = await import(pathToFileURL(generated).href);
  const receipt = await measureNativeLaunch({ app: String(args.app), output: String(args.output),
    sourceSha: String(args.sha), samples: Number(args.samples ?? 3) });
  assert(receipt.teardownVerified, 'The measurement must verify teardown');
  assert(receipt.samples.every(row => row.optionalStartupRequests === 0), 'Apply the startup prefetch patch to both measured copies');
  assert(receipt.samples.every(row => row.serverProfile.some(server => server.role === 'http' && server.listeners.length && server.requests.some(request => request.route === '/dashboard'))), 'Capture the real HTTP listener and dashboard request');
  const identities = new Map();
  if (args.stats) {
    const visit = modules => {
      for (const module of modules || []) {
        if (module.id !== null && module.id !== undefined) identities.set(String(module.id), module.name);
        visit(module.modules);
      }
    };
    visit(JSON.parse(fs.readFileSync(String(args.stats), 'utf8')).modules);
  }
  const result = { ...receipt, schema: 'o8/native-launch-stages/v1', cpuProfiled: profile,
    prefetchPatch: '4874 measurement-only', stageHarnessSha: execFileSync('git', ['-C', fileURLToPath(new URL('../..', import.meta.url)), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    clientModulesMapped: identities.size > 0,
    samples: receipt.samples.map(row => ({ ...row, intervals: launchStageIntervals(row),
      clientModules: row.clientModules.map(module => ({ ...module, owner: identities.get(module.id) ?? null })) })) };
  fs.writeFileSync(path.join(String(args.output), 'stages.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  if (args['check-background-dashboard']) {
    const count = result.samples.reduce((total, sample) => total + sample.serverProfile.flatMap(server => server.requests)
      .filter(row => row.route === '/dashboard' && row.caller === 'background' && row.atMs <= sample.interactiveComposerMs).length, 0);
    console.log(JSON.stringify({ check: 'background-dashboard', count, limit: 0, passed: count === 0 }));
    assert.equal(count, 0, 'Startup must not duplicate the WebView dashboard render');
  }
  if (args.check) assert(result.maxMs < 1000, `Launch budget exceeded: ${result.maxMs} ms >= 1000 ms`);
} finally {
  fs.rmSync(generated, { force: true });
}
