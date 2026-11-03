import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

// Exact names collected from run 41681385496, including ignored tests and
// auxiliary harnesses. Discovery and execution below use only a Node fixture.
const listing = readFileSync(new URL('./fixtures/native-test-listing.txt', import.meta.url), 'utf8');
const names = listing.trim().split('\n').map(line => line.replace(/: test$/, ''));
const registration = 'shell::pull_requests::registration_tests::pull_requests_single_registration_owns_the_request_adapter';
const sdk = [
  'shell::issues::tests::issues_worker_receives_linked_context_through_stream',
  'shell::issues::tests::issues_view_search_link_clear_and_worker_task',
  'ui::tests::worker_tests::worker_send_steer_queue_promote_remove_and_streaming_latency',
];
const heavy = [registration, ...sdk, ...names.filter(name =>
  name.startsWith('shell::sidebar::tests::settle_tests::')
  || name.startsWith('shell::sidebar::thread_list::races::final_round::'))];
const isTimed = name => sdk.includes(name) || name.startsWith('terminal::tests::production_pty_')
  || name === 'shell::session::image_loaded_shell_tests::native_composer_loaded_shell_images_typing_benchmark';
const directory = mkdtempSync(join(tmpdir(), 'o8-native-shards-'));
const harness = join(directory, 'harness.mjs');
const receipt = join(directory, 'receipt.json');
writeFileSync(harness, `import { writeFileSync } from 'node:fs';
if (process.argv.includes('--list')) process.stdout.write(process.env.FIXTURE_LISTING);
else writeFileSync(process.env.FIXTURE_RECEIPT, JSON.stringify(process.argv.slice(2)));
`);
after(() => rmSync(directory, { recursive: true, force: true }));
const runner = fileURLToPath(new URL('./native-test-shard.mjs', import.meta.url));
function run(shard, phase, fixture = listing) {
  rmSync(receipt, { force: true });
  const result = spawnSync(process.execPath, [runner, process.execPath, harness, `--test-threads=${phase === 'timed' ? 1 : 4}`], {
    encoding: 'utf8', env: { ...process.env, O8_NATIVE_TEST_SHARD: shard, O8_NATIVE_TEST_PHASE: phase,
      FIXTURE_LISTING: fixture, FIXTURE_RECEIPT: receipt },
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  try { return JSON.parse(readFileSync(receipt, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

test('the real runner assigns the listing exactly once across eight nonempty shards and preserves phases', () => {
  const owners = new Map();
  for (let shard = 1; shard <= 8; shard++) {
    let count = 0;
    for (const phase of ['regular', 'timed']) {
      const args = run(`${shard}/8`, phase);
      if (!args) continue;
      assert.deepEqual(args.slice(0, 2), [`--test-threads=${phase === 'timed' ? 1 : 4}`, '--exact']);
      for (const name of args.slice(2)) {
        assert.equal(owners.has(name), false, `duplicate: ${name}`);
        assert.equal(isTimed(name), phase === 'timed', name);
        owners.set(name, shard);
        count++;
      }
    }
    assert.ok(count > 0, `empty shard ${shard}`);
  }
  assert.deepEqual([...owners.keys()].sort(), [...names].sort());
  assert.equal(owners.get(registration), 1);
  // The four largest explicit entries have separate owners. There are more
  // heavy cases than shards; the rest share shards 2–8 evenly, never shard 1.
  assert.equal(new Set([registration, ...sdk].map(name => owners.get(name))).size, 4);
  const heavyCounts = Array(8).fill(0);
  for (const name of heavy) heavyCounts[owners.get(name) - 1]++;
  assert.equal(heavyCounts[0], 1);
  assert.ok(Math.max(...heavyCounts.slice(1)) - Math.min(...heavyCounts.slice(1)) <= 1, heavyCounts.join('/'));
  for (const name of names.filter(name => !heavy.includes(name))) {
    assert.equal(owners.get(name), createHash('sha256').update(name).digest().readUInt32BE(0) % 8 + 1, name);
  }
});

test('empty shards and empty listings never launch libtest with an empty filter', () => {
  const fixture = `${registration}: test\n`;
  assert.equal(run('8/8', 'regular', fixture), null);
  assert.equal(run('1/8', 'timed', fixture), null);
  assert.equal(run('1/8', 'regular', ''), null);
});
