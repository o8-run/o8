import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

// Exact names collected from run 41681385496, including ignored tests and
// auxiliary harnesses. Discovery and execution below use only a Node fixture.
const listing = readFileSync(new URL('./fixtures/native-test-listing.txt', import.meta.url), 'utf8');
const names = listing.trim().split('\n').map(line => line.replace(/: test$/, ''));
const terminal = 'terminal_own_shell_creates_once_reuses_and_accepts_input';
const registration = 'shell::pull_requests::registration_tests::pull_requests_single_registration_owns_the_request_adapter';
const sdk = [
  'shell::issues::tests::issues_worker_receives_linked_context_through_stream',
  'shell::issues::tests::issues_view_search_link_clear_and_worker_task',
  'ui::tests::worker_tests::worker_send_steer_queue_promote_remove_and_streaming_latency',
];
const isTimed = name => sdk.includes(name) || name.startsWith('terminal::tests::production_pty_')
  || name === 'shell::session::image_loaded_shell_tests::native_composer_loaded_shell_images_typing_benchmark'
  || name === 'files_panel::tests::large_file_one_million_lines_stays_within_bounds';
const directory = mkdtempSync(join(tmpdir(), 'o8-native-shards-'));
const harness = join(directory, 'harness.mjs');
const receipt = join(directory, 'receipt.json');
writeFileSync(harness, `import { appendFileSync } from 'node:fs';
if (process.argv.includes('--list')) process.stdout.write(process.env.FIXTURE_LISTING);
else appendFileSync(process.env.FIXTURE_RECEIPT, JSON.stringify(process.argv.slice(2)) + '\\n');
`);
after(() => rmSync(directory, { recursive: true, force: true }));
const runner = join(directory, 'runner.mjs');
copyFileSync(fileURLToPath(new URL('./native-test-shard.mjs', import.meta.url)), runner);
function run(shard, phase, fixture = listing, weights = {}) {
  writeFileSync(join(directory, 'native-test-weights.json'), JSON.stringify(weights));
  rmSync(receipt, { force: true });
  const result = spawnSync(process.execPath, [runner, process.execPath, harness, `--test-threads=${phase === 'timed' ? 1 : 4}`], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, O8_NATIVE_TEST_SHARD: shard, O8_NATIVE_TEST_PHASE: phase,
      FIXTURE_LISTING: fixture, FIXTURE_RECEIPT: receipt },
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  try { return readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

test('the real runner assigns the listing exactly once across eight nonempty shards and preserves phases', () => {
  const owners = new Map();
  for (let shard = 1; shard <= 8; shard++) {
    let count = 0;
    for (const phase of ['regular', 'timed']) {
      const commands = run(`${shard}/8`, phase);
      if (!commands) continue;
      for (const args of commands) {
        assert.deepEqual(args.slice(0, 2), [`--test-threads=${phase === 'timed' ? 1 : 4}`, '--exact']);
        for (const name of args.slice(2)) {
          assert.equal(owners.has(name), false, `duplicate: ${name}`);
          assert.equal(isTimed(name), phase === 'timed', name);
          owners.set(name, shard);
          count++;
        }
      }
    }
    assert.ok(count > 0, `empty shard ${shard}`);
  }
  assert.deepEqual([...owners.keys()].sort(), [...names].sort());
  assert.equal(owners.get(registration), 1);
  assert.deepEqual([...owners].filter(([, shard]) => shard === 1).map(([name]) => name), names.filter(name => name.startsWith('shell::pull_requests::registration_tests::')).sort());
  assert.equal(owners.get(terminal), 8);
  assert.deepEqual([...owners].filter(([, shard]) => shard === 8).map(([name]) => name), [terminal]);
  const moduleOwners = new Map();
  for (const [name, owner] of owners) {
    const moduleName = name.includes('::') ? name.slice(0, name.lastIndexOf('::')) : name;
    if (moduleOwners.has(moduleName)) assert.equal(owner, moduleOwners.get(moduleName), moduleName);
    moduleOwners.set(moduleName, owner);
  }
});

test('empty shards and empty listings never launch libtest with an empty filter', () => {
  const fixture = `${registration}: test\n`;
  assert.equal(run('8/8', 'regular', fixture), null);
  assert.equal(run('1/8', 'timed', fixture), null);
  assert.equal(run('1/8', 'regular', ''), null);
});

test('weights override test count and discovery order; missing modules use one second per test with lexical ties', () => {
  const fixture = ['a::one', 'a::two', 'a::three', 'b::one', 'b::two', 'c::one', 'd::one'];
  const assign = (names, weights) => {
    const owners = {};
    for (let shard = 1; shard <= 4; shard++) {
      const commands = run(`${shard}/4`, 'regular', names.map(name => `${name}: test`).join('\n'), weights);
      for (const args of commands ?? []) for (const name of args.slice(2)) owners[name] = shard;
    }
    return owners;
  };
  const fallback = assign(fixture, {});
  assert.deepEqual(fallback, { 'a::one': 2, 'a::three': 2, 'a::two': 2, 'd::one': 2, 'b::one': 3, 'b::two': 3, 'c::one': 3 });
  const weighted = assign(fixture, { b: 100 });
  assert.deepEqual(Object.keys(weighted).filter(name => weighted[name] === weighted['b::one']).sort(), ['b::one', 'b::two']);
  assert.deepEqual(assign([...fixture].reverse(), { b: 100 }), weighted);
});
