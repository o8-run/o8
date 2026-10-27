import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';

const root = mkdtempSync(path.join(tmpdir(), 'o8-native shards-'));
const runner = path.join(root, 'runner.mjs');
copyFileSync(path.resolve('scripts/ci/native-test-shard.mjs'), runner);
const receipt = path.join(root, 'executed');
const crate = path.join(root, 'native/o8-next');
mkdirSync(path.join(crate, 'src'), { recursive: true });
writeFileSync(path.join(crate, 'Cargo.toml'), '[package]\nname="shard-fixture"\nversion="0.0.0"\nedition="2024"\n[workspace]\n');
writeFileSync(path.join(crate, 'Cargo.lock'), 'version=4\n[[package]]\nname="shard-fixture"\nversion="0.0.0"\n');
const names = ['prefix', 'prefix_longer', ...Array.from({ length: 14 }, (_, i) => `case_${i}`)];
const source = names.map(name => `#[test] fn ${name}() {
  use std::io::Write;
  let mut file = std::fs::OpenOptions::new().create(true).append(true).open(${JSON.stringify(receipt)}).unwrap();
  writeln!(file, "${name}").unwrap();
  assert_ne!(std::env::var("SHARD_FIXTURE_FAIL").unwrap_or_default(), "${name}");
}`).join('\n') + '\n#[test] #[ignore] fn ignored_case() { panic!("must stay ignored"); }\n';
writeFileSync(path.join(crate, 'src/lib.rs'), source);
afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(shard: string, fail = '') {
  return spawnSync(process.execPath, [runner, '--cargo'], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, CARGO_NET_OFFLINE: 'true', CARGO_TARGET_DIR: path.join(root, 'target'),
      O8_NATIVE_TEST_SHARD: shard, SHARD_FIXTURE_FAIL: fail },
  });
}

it.skipIf(process.platform !== 'linux' || process.arch !== 'x64')('runs every real test exactly once across shards, retains ignored cases and propagates assertion failures', () => {
  let output = '';
  for (let index = 1; index <= 4; index++) {
    const result = run(`${index}/4`);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain(`[native-tests] shard=${index}/4`);
    output += result.stdout;
  }
  expect(readFileSync(receipt, 'utf8').trim().split('\n').sort()).toEqual([...names].sort());
  expect(output.match(/ignored_case \.\.\. ignored/g)).toHaveLength(1);
  let failures = 0;
  for (let index = 1; index <= 4; index++) {
    const result = run(`${index}/4`, 'prefix');
    expect([0, 101], result.stderr + result.stdout).toContain(result.status);
    if (result.status === 101) {
      failures++;
      expect(result.stdout).toContain('prefix ... FAILED');
    }
  }
  expect(failures).toBe(1);
  for (const invalid of ['', '0/4', '5/4', '1/0', '1/4/2']) expect(run(invalid).status).not.toBe(0);
}, 60_000);
