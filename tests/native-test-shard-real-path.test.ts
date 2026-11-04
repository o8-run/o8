import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';

const root = mkdtempSync(path.join(tmpdir(), 'o8-native shards-'));
const runner = path.join(root, 'runner.mjs');
copyFileSync(path.resolve('scripts/ci/native-test-shard.mjs'), runner);
writeFileSync(path.join(root, 'native-test-weights.json'), JSON.stringify({ heavy: 10_000 }));
const receipt = path.join(root, 'executed');
const crate = path.join(root, 'native/o8-next');
mkdirSync(path.join(crate, 'src'), { recursive: true });
writeFileSync(path.join(crate, 'Cargo.toml'), '[package]\nname="shard-fixture"\nversion="0.0.0"\nedition="2024"\n[workspace]\n');
writeFileSync(path.join(crate, 'Cargo.lock'), 'version=4\n[[package]]\nname="shard-fixture"\nversion="0.0.0"\n');
const names = ['prefix', 'prefix_longer', ...Array.from({ length: 14 }, (_, i) => `case_${i}`)];
const heavy = ['heavy::first', 'heavy::second'];
const registration = 'shell::pull_requests::registration_tests::pull_requests_single_registration_owns_the_request_adapter';
const ownShell = 'terminal_own_shell_creates_once_reuses_and_accepts_input';
const regularTerminal = 'terminal::tests::regular_fixture';
const timed = 'terminal::tests::production_pty_fixture';
const images = 'shell::session::image_loaded_shell_tests::native_composer_loaded_shell_images_typing_benchmark';
const sdk = [
  'shell::issues::tests::issues_worker_receives_linked_context_through_stream',
  'shell::issues::tests::issues_view_search_link_clear_and_worker_task',
  'ui::tests::worker_tests::worker_send_steer_queue_promote_remove_and_streaming_latency',
];
const source = `fn record(name: &str) {
  use std::io::Write;
  let expected = if name.starts_with("terminal::tests::production_pty_") || name == "${images}" || ${JSON.stringify(sdk)}.contains(&name) { "timed" } else { "regular" };
  assert_eq!(std::env::var("O8_NATIVE_TEST_PHASE").unwrap_or_default(), expected);
  let mut file = std::fs::OpenOptions::new().create(true).append(true).open(${JSON.stringify(receipt)}).unwrap();
  file.write_all(format!("{name}\\n").as_bytes()).unwrap();
  assert_ne!(std::env::var("SHARD_FIXTURE_FAIL").unwrap_or_default(), name);
}\n` + names.map(name => `#[test] fn ${name}() { record("${name}"); }`).join('\n') + `
mod heavy {
  #[test] fn first() { crate::record("${heavy[0]}"); }
  #[test] fn second() { crate::record("${heavy[1]}"); }
}
#[test] fn ${ownShell}() { record("${ownShell}"); }
mod terminal { mod tests {
  #[test] fn production_pty_fixture() { crate::record("${timed}"); }
  #[test] fn regular_fixture() { crate::record("${regularTerminal}"); }
} }
mod shell { mod pull_requests { mod registration_tests {
  #[test] fn pull_requests_single_registration_owns_the_request_adapter() { crate::record("${registration}"); }
} } mod session { mod image_loaded_shell_tests {
  #[test] fn native_composer_loaded_shell_images_typing_benchmark() { crate::record("${images}"); }
} } mod issues { mod tests {
  #[test] fn issues_worker_receives_linked_context_through_stream() { crate::record("${sdk[0]}"); }
  #[test] fn issues_view_search_link_clear_and_worker_task() { crate::record("${sdk[1]}"); }
} } }
mod ui { mod tests { mod worker_tests {
  #[test] fn worker_send_steer_queue_promote_remove_and_streaming_latency() { crate::record("${sdk[2]}"); }
} } }
#[test] #[ignore] fn ignored_case() { panic!("must stay ignored"); }\n`;
writeFileSync(path.join(crate, 'src/lib.rs'), source);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const cargoPhases = new Set<string>();
function run(shard: string, fail = '', phase = 'regular') {
  // Exercise Cargo's runner wiring once per phase, then reuse that real
  // compiled harness for the partition/failure matrix instead of rebuilding.
  const throughCargo = !cargoPhases.has(phase);
  cargoPhases.add(phase);
  const args = throughCargo ? ['--cargo', `--phase=${phase}`] : [
    path.join(root, 'target/debug/deps', readdirSync(path.join(root, 'target/debug/deps'))
      .find(name => /^shard_fixture-[a-f0-9]+$/.test(name))!),
    `--test-threads=${phase === 'timed' ? 1 : 4}`,
  ];
  return spawnSync(process.execPath, [runner, ...args], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, CARGO_NET_OFFLINE: 'true', CARGO_TARGET_DIR: path.join(root, 'target'),
      O8_NATIVE_TEST_SHARD: shard, O8_NATIVE_TEST_PHASE: phase, SHARD_FIXTURE_FAIL: fail },
  });
}

it('checks native shard assignment and cache contracts through Node fixtures', () => {
  const fixtures = ['scripts/ci/native-test-shard.test.mjs'];
  if (process.platform === 'linux') fixtures.push('scripts/ci/native-test-cache.test.mjs');
  const result = spawnSync(process.execPath, ['--test', ...fixtures], {
    // Module execution starts one fixture process per group in the full listing.
    encoding: 'utf8', timeout: 120_000,
  });
  expect(result.status, result.stderr + result.stdout).toBe(0);
}, 120_000);

it.skipIf(process.platform !== 'linux' || process.arch !== 'x64')('assigns weighted modules deterministically as a partition and writes timings across both phases', () => {
  const assign = () => {
    const owners: Record<string, number> = {};
    for (let index = 1; index <= 4; index++) {
      rmSync(receipt, { force: true });
      const timingsFile = path.join(root, `test-results/native-timings-${index}.json`);
      rmSync(timingsFile, { force: true });
      const regular = run(`${index}/4`);
      expect(regular.status, regular.stderr + regular.stdout).toBe(0);
      const before = JSON.parse(readFileSync(timingsFile, 'utf8')) as Record<string, number>;
      const timedResult = run(`${index}/4`, '', 'timed');
      expect(timedResult.status, timedResult.stderr + timedResult.stdout).toBe(0);
      const after = JSON.parse(readFileSync(timingsFile, 'utf8')) as Record<string, number>;
      for (const [moduleName, seconds] of Object.entries(before)) expect(after[moduleName]).toBeGreaterThanOrEqual(seconds);
      for (const seconds of Object.values(after)) expect(seconds).toBeGreaterThanOrEqual(0);
      // This module crosses phases; both measurements must survive in one file.
      if ('terminal::tests' in before) expect(after['terminal::tests']).toBeGreaterThan(before['terminal::tests']);
      const executed = readFileSync(receipt, 'utf8').trim().split('\n');
      for (const name of executed) {
        expect(owners, `duplicate execution: ${name}`).not.toHaveProperty(name);
        owners[name] = index;
        const moduleName = name.includes('::') ? name.slice(0, name.lastIndexOf('::')) : name;
        expect(after).toHaveProperty(moduleName);
      }
    }
    expect(Object.keys(owners).sort()).toEqual([...names, ...heavy, registration, ownShell, regularTerminal, timed, images, ...sdk].sort());
    expect(owners[registration]).toBe(1);
    expect(owners[ownShell]).toBe(4);
    expect(Object.keys(owners).filter(name => owners[name] === owners[heavy[0]]).sort()).toEqual(heavy);
    expect(owners[sdk[0]]).toBe(owners[sdk[1]]);
    return owners;
  };
  expect(assign()).toEqual(assign());
}, 60_000);

it.skipIf(process.platform !== 'linux')('derives registration cache keys from the native configuration and dependency segments', () => {
  const result = spawnSync(process.execPath, ['scripts/ci/native-test-cache.mjs', 'key'], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, GITHUB_OUTPUT: '' },
  });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  const outputs = Object.fromEntries([...result.stdout.matchAll(/^\[native-cache\] ([\w-]+)=(.+)$/gm)]
    .map(([, name, value]) => [name, value]));
  const native = outputs.key.match(/^native-tests-v1-([a-f0-9]{64})-([a-f0-9]{64})-[a-f0-9]{64}$/);
  expect(native).not.toBeNull();
  const [, configuration, dependency] = native!;
  expect(outputs['registration-key']).toBe(`native-registration-v1-${configuration}-${dependency}`);
  expect(outputs['registration-restore-key']).toBe(`native-registration-v1-${configuration}-`);
  expect(outputs['registration-key'].startsWith(outputs['registration-restore-key'])).toBe(true);
}, 30_000);

it.skipIf(process.platform !== 'linux')('backdates only unchanged sources and safe directories on a prefix cache hit, and every source on an exact hit', () => {
  const directory = mkdtempSync(path.join(root, 'cache-checkout-'));
  const files = {
    'native/o8-next/Cargo.toml': '[package]\nname="cache-fixture"\n',
    'native/o8-next/Cargo.lock': 'version=4\n',
    'native/o8-next/src/main.rs': 'const SPEC: &str = include_str!("../../../docs/spec.md");',
    'native/o8-next/vendor/gpui/src/lib.rs': 'fn unchanged() {}',
    'native/o8-next/vendor/taffy/src/lib.rs': 'fn unchanged() {}',
    'native/o8-next/tests/deleted.rs': 'fn removed() {}',
    'docs/spec.md': 'embedded fixture',
    '.cargo/config.toml': '[build]\n',
  };
  const write = (file: string, content: string) => {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), content);
  };
  for (const [file, content] of Object.entries(files)) write(file, content);
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  };
  git('init', '-q');
  git('add', '.');
  const target = path.join(directory, 'native/o8-next/target');
  const runCache = (mode: string, hit = '') => {
    const result = spawnSync(process.execPath, [path.resolve('scripts/ci/native-test-cache.mjs'), mode], {
      cwd: directory, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, CARGO_TARGET_DIR: target, CARGO_HOME: path.join(directory, 'cargo'),
        GITHUB_OUTPUT: '', O8_NATIVE_CACHE_HIT: hit || undefined },
    });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    return result.stdout;
  };
  write('native/o8-next/target/debug/incremental/disposable', 'unused');
  const initialKey = runCache('key');
  runCache('measure');
  expect(existsSync(path.join(target, 'debug/incremental'))).toBe(false);
  expect(runCache('key')).toBe(initialKey);
  const changed = 'native/o8-next/src/main.rs';
  const added = 'native/o8-next/vendor/taffy/src/new.rs';
  const removed = 'native/o8-next/tests/deleted.rs';
  write(changed, `${files[changed]}\nfn changed() {}`);
  write(added, 'fn added() {}');
  git('add', added);
  rmSync(path.join(directory, removed));
  const present = [...Object.keys(files).filter(file => file !== removed), added];
  const safeDirectories = ['native/o8-next/vendor/gpui', 'native/o8-next/vendor/gpui/src'];
  const changedDirectories = ['native/o8-next', 'native/o8-next/src', 'native/o8-next/vendor',
    'native/o8-next/vendor/taffy', 'native/o8-next/vendor/taffy/src'];
  const directories = [...safeDirectories, ...changedDirectories];
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const stamp = Date.parse('2000-01-01T00:00:00Z');
  for (const file of [...present, ...directories]) utimesSync(path.join(directory, file), now, now);
  const restored = runCache('restore');
  for (const file of present) {
    expect(statSync(path.join(directory, file)).mtimeMs, file).toBe(file === changed || file === added ? now.getTime() : stamp);
  }
  for (const dir of directories) {
    expect(statSync(path.join(directory, dir)).mtimeMs, dir).toBe(changedDirectories.includes(dir) ? now.getTime() : stamp);
  }
  expect(restored).toContain('backdated=6 changed=1 new=1 missing=1');
  const manifest = JSON.parse(readFileSync(path.join(target, '.o8-native-sources.json'), 'utf8'));
  expect(manifest.sources).toEqual(Object.fromEntries(Object.entries(files)
    .map(([file, content]) => [file, createHash('sha256').update(content).digest('hex')])));
  expect(initialKey).toContain(`native-tests-v1-${manifest.configuration}-${manifest.lockfile}-`);
  for (const field of ['configuration', 'lockfile']) {
    writeFileSync(path.join(target, '.o8-native-sources.json'), JSON.stringify({ ...manifest, [field]: 'mismatch' }));
    for (const file of [...present, ...directories]) utimesSync(path.join(directory, file), now, now);
    expect(runCache('restore', 'false')).toContain('configuration or lockfile mismatch');
    for (const file of [...present, ...directories]) {
      expect(statSync(path.join(directory, file)).mtimeMs, file).toBe(now.getTime());
    }
  }
  // Restore the deleted input so the exact-hit case matches a complete checkout.
  write(removed, files[removed]);
  for (const file of [...present, removed, ...directories]) utimesSync(path.join(directory, file), now, now);
  expect(runCache('restore', 'true')).toContain('exact hit');
  for (const file of [...present, removed, ...directories]) {
    expect(statSync(path.join(directory, file)).mtimeMs, file).toBe(stamp);
  }
}, 30_000);

it.skipIf(process.platform !== 'linux' || process.arch !== 'x64')('runs every real test exactly once across shards, retains ignored cases and propagates assertion failures', () => {
  rmSync(receipt, { force: true });
  let output = '';
  for (let index = 1; index <= 4; index++) {
    for (const phase of ['regular', 'timed']) {
      const result = run(`${index}/4`, '', phase);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toContain(`[native-tests] shard=${index}/4 phase=${phase}`);
      output += result.stdout;
    }
  }
  expect(readFileSync(receipt, 'utf8').trim().split('\n').sort()).toEqual([...names, ...heavy, registration, ownShell, regularTerminal, timed, images, ...sdk].sort());
  expect(output.match(/ignored_case \.\.\. ignored/g)).toHaveLength(1);
  for (const fault of ['prefix', timed, images]) {
    let failures = 0;
    for (let index = 1; index <= 4; index++) {
      for (const phase of ['regular', 'timed']) {
        const result = run(`${index}/4`, fault, phase);
        expect([0, 101], result.stderr + result.stdout).toContain(result.status);
        if (result.status === 101) {
          failures++;
          expect(result.stdout).toContain(`${fault} ... FAILED`);
        }
      }
    }
    expect(failures).toBe(1);
  }
  for (const invalid of ['', '0/4', '5/4', '1/0', '1/4/2', '1/33']) expect(run(invalid).status).not.toBe(0);
  expect(run('1/4', '', 'unknown').status).not.toBe(0);
}, 60_000);
