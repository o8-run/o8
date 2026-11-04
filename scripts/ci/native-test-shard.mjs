#!/usr/bin/env node
// Cargo runner: enumerate the real harness and partition exact test names.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

if (process.argv[2] === '--cargo') {
  const phase = /^--phase=(regular|timed)$/.exec(process.argv[3] ?? '')?.[1];
  if (!phase || process.argv.length !== 4) {
    console.error('[native-tests] usage: --cargo --phase=regular|timed');
    process.exit(2);
  }
  // Regular is the first phase of a fresh job. Harness runners and the timed
  // phase append to this file, including auxiliary Cargo harnesses.
  const shardIndex = /^(\d+)\//.exec(process.env.O8_NATIVE_TEST_SHARD ?? '')?.[1];
  const timingsFile = path.resolve(`test-results/native-timings-${Number(shardIndex)}.json`);
  if (phase === 'regular' && shardIndex) {
    mkdirSync(path.dirname(timingsFile), { recursive: true });
    writeFileSync(timingsFile, '{}\n');
  }
  // Cargo runner environment strings split on whitespace without unquoting.
  // A TOML array preserves checkout paths containing spaces.
  const runner = JSON.stringify([process.execPath, fileURLToPath(import.meta.url)]);
  const result = spawnSync('cargo', ['--config', `target.x86_64-unknown-linux-gnu.runner=${runner}`,
    'test', '--locked', '--manifest-path', 'native/o8-next/Cargo.toml', '--',
    `--test-threads=${phase === 'timed' ? 1 : 4}`], {
    // Cargo runs harnesses from the package directory; retain the job's path.
    stdio: 'inherit', env: { ...process.env, O8_NATIVE_TEST_PHASE: phase, O8_NATIVE_TEST_TIMINGS_PATH: timingsFile },
  });
  if (result.error) console.error('[native-tests] Cargo execution failed:', result.error.message);
  process.exit(result.error || result.signal ? 1 : result.status ?? 1);
}

const [binary, ...args] = process.argv.slice(2);
const shard = /^(\d+)\/(\d+)$/.exec(process.env.O8_NATIVE_TEST_SHARD ?? '');
const index = Number(shard?.[1]);
const count = Number(shard?.[2]);
const phase = process.env.O8_NATIVE_TEST_PHASE;
if (!binary || !shard || index < 1 || index > count || count > 32 || !['regular', 'timed'].includes(phase)) {
  console.error('[native-tests] O8_NATIVE_TEST_SHARD must be INDEX/COUNT, with 1 <= INDEX <= COUNT <= 32');
  process.exit(2);
}
const list = spawnSync(binary, [...args, '--list', '--format=terse'], {
  encoding: 'utf8', maxBuffer: 4 * 1024 ** 2,
});
if (list.error || list.signal || list.status !== 0) {
  console.error('[native-tests] harness discovery failed', list.error?.message ?? list.stderr);
  process.exit(list.status || 1);
}
const names = [];
for (const line of list.stdout.split('\n').filter(Boolean)) {
  const match = /^(.*): (?:test|benchmark)$/.exec(line);
  if (match) names.push(match[1]);
  else if (!/^\d+ tests?, \d+ benchmarks?$/.test(line)) {
    console.error('[native-tests] unsupported harness listing:', line);
    process.exit(2);
  }
}
if (new Set(names).size !== names.length) {
  console.error('[native-tests] duplicate harness test names');
  process.exit(2);
}
// Frame-budget typing has the same isolation requirement as fixed-rate PTY
// probes: sibling scene tests must not consume its measured CPU time.
// The real SDK fixtures also keep their existing first-reply deadlines; cold
// worker starts must not compete with sibling native tests.
const sdk = new Set([
  'shell::issues::tests::issues_worker_receives_linked_context_through_stream',
  'shell::issues::tests::issues_view_search_link_clear_and_worker_task',
  'ui::tests::worker_tests::worker_send_steer_queue_promote_remove_and_streaming_latency',
]);
const timed = name => name.startsWith('terminal::tests::production_pty_')
  || name === 'shell::session::image_loaded_shell_tests::native_composer_loaded_shell_images_typing_benchmark'
  || name === 'files_panel::tests::large_file_one_million_lines_stays_within_bounds'
  || sdk.has(name);
// The own-shell test needs the ordinary app without GPUI's dev-only
// test-support feature. Its nested build cannot reuse Cargo's test binary.
// Reserve shard 1 for registration and the last shard for that build.
const terminal = 'terminal_own_shell_creates_once_reuses_and_accepts_input';
const registration = 'shell::pull_requests::registration_tests::pull_requests_single_registration_owns_the_request_adapter';
const terminalShard = count >= 3 ? count - 1 : 0;
const shared = Array.from({ length: Math.max(1, count - (count >= 3 ? 2 : 1)) },
  (_, index) => count === 1 ? 0 : index + 1);
// A module is everything before the test name's last `::`. A root-level test
// without `::` is its own group, keyed by its full name. Keep the group intact
// for assignment, even when execution splits its tests across the two phases.
const moduleFor = name => name.includes('::') ? name.slice(0, name.lastIndexOf('::')) : name;
const groups = new Map();
for (const name of names) {
  const moduleName = moduleFor(name);
  if (!groups.has(moduleName)) groups.set(moduleName, []);
  groups.get(moduleName).push(name);
}
// Whole wall seconds; an unmeasured module costs one second per test.
const weights = JSON.parse(readFileSync(new URL('./native-test-weights.json', import.meta.url), 'utf8'));
const weightFor = moduleName => Object.hasOwn(weights, moduleName) ? weights[moduleName] : groups.get(moduleName).length;
const compareNames = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const modules = [...groups.keys()].sort((a, b) => weightFor(b) - weightFor(a) || compareNames(a, b));
const totals = Array(count).fill(0);
const assignment = new Map();
// Pins participate in totals when small shard counts share their buckets.
for (const [moduleName, owner] of [[moduleFor(registration), 0], [terminal, terminalShard]]) {
  if (groups.has(moduleName)) {
    assignment.set(moduleName, owner);
    totals[owner] += weightFor(moduleName);
  }
}
// Longest-processing-time greedy: the heaviest remaining module goes to the
// least loaded eligible shard. Equal weights use module name; equal totals
// use shard index. Every runner computes this full, phase-independent map.
for (const moduleName of modules) {
  if (assignment.has(moduleName)) continue;
  const owner = shared.reduce((best, shard) => totals[shard] < totals[best] ? shard : best);
  assignment.set(moduleName, owner);
  totals[owner] += weightFor(moduleName);
}
const selected = modules.filter(moduleName => assignment.get(moduleName) === index - 1)
  .map(moduleName => [moduleName, groups.get(moduleName).filter(name => (timed(name) ? 'timed' : 'regular') === phase).sort(compareNames)])
  .filter(([, tests]) => tests.length);
console.log(`[native-tests] shard=${index}/${count} phase=${phase} selected=${selected.reduce((sum, [, tests]) => sum + tests.length, 0)} total=${names.length}`);
const timingsFile = process.env.O8_NATIVE_TEST_TIMINGS_PATH ?? `test-results/native-timings-${index}.json`;
let timings = {};
try { timings = JSON.parse(readFileSync(timingsFile, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
mkdirSync(path.dirname(timingsFile), { recursive: true });
writeFileSync(timingsFile, `${JSON.stringify(timings, null, 2)}\n`);
// An empty filter runs everything in libtest; never launch an empty group.
// Keep going after assertion failures so other groups still run and report.
for (const [moduleName, tests] of selected) {
  const start = performance.now();
  const result = spawnSync(binary, [...args, '--exact', ...tests], { stdio: 'inherit' });
  const seconds = (performance.now() - start) / 1000;
  timings[moduleName] = (timings[moduleName] ?? 0) + seconds;
  writeFileSync(timingsFile, `${JSON.stringify(timings, null, 2)}\n`);
  console.log(`[native-tests] module=${moduleName} wall=${seconds.toFixed(3)} s`);
  if (result.error) console.error('[native-tests] harness execution failed:', result.error.message);
  const status = result.error || result.signal ? 1 : result.status ?? 1;
  if (status) process.exitCode ||= status;
}
