#!/usr/bin/env node
// Cargo runner: enumerate the real harness and partition exact test names.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

if (process.argv[2] === '--cargo') {
  const phase = /^--phase=(regular|timed)$/.exec(process.argv[3] ?? '')?.[1];
  if (!phase || process.argv.length !== 4) {
    console.error('[native-tests] usage: --cargo --phase=regular|timed');
    process.exit(2);
  }
  // Cargo runner environment strings split on whitespace without unquoting.
  // A TOML array preserves checkout paths containing spaces.
  const runner = JSON.stringify([process.execPath, fileURLToPath(import.meta.url)]);
  const result = spawnSync('cargo', ['--config', `target.x86_64-unknown-linux-gnu.runner=${runner}`,
    'test', '--locked', '--manifest-path', 'native/o8-next/Cargo.toml', '--',
    `--test-threads=${phase === 'timed' ? 1 : 4}`], {
    stdio: 'inherit', env: { ...process.env, O8_NATIVE_TEST_PHASE: phase },
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
const timed = name => name.startsWith('terminal::tests::production_pty_')
  || name === 'shell::session::image_loaded_shell_tests::native_composer_loaded_shell_images_typing_benchmark';
const selected = names.filter(name =>
  createHash('sha256').update(name).digest().readUInt32BE(0) % count === index - 1
  && (timed(name) ? 'timed' : 'regular') === phase);
console.log(`[native-tests] shard=${index}/${count} phase=${phase} selected=${selected.length} total=${names.length}`);
// An empty filter runs everything in libtest; do not launch an empty shard.
if (selected.length) {
  const result = spawnSync(binary, [...args, '--exact', ...selected], { stdio: 'inherit' });
  if (result.error) console.error('[native-tests] harness execution failed:', result.error.message);
  process.exitCode = result.error || result.signal ? 1 : result.status ?? 1;
}
