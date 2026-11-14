import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);

it.runIf(process.platform === 'linux')('runs the shared launch tests and the real launcher binary fixtures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'o8-launcher-cargo-'));
  const env = { ...process.env, CARGO_TARGET_DIR: join(root, 'target') };
  const options = { env, encoding: 'utf8' as const, timeout: 600_000, maxBuffer: 8 * 1024 * 1024 };
  try {
    const launch = await execute('cargo', ['test', '--locked', '--manifest-path', 'crates/o8-launcher/Cargo.toml', '--', '--test-threads=1'], options);
    expect(launch.stdout).toContain('crashed_parent_orphans_are_cleaned_without_touching_foreign_listener ... ok');
    expect(launch.stdout).toContain('admitted_restart_inspects_and_drains_before_stopping_servers ... ok');
    const core = await execute('cargo', ['test', '--locked', '--no-run', '--message-format=json', '--manifest-path', 'crates/o8-launch-core/Cargo.toml'], options);
    const artifacts = core.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as {
      reason?: string; target?: { name?: string }; profile?: { test?: boolean }; executable?: string;
    });
    const binary = artifacts.find(item => item.reason === 'compiler-artifact' && item.profile?.test && item.target?.name === 'o8_launch_core')?.executable;
    if (!binary) throw new Error('Shared launch test executable was not emitted');
    const home = join(root, 'test-home'); mkdirSync(home);
    const result = await execute(binary, ['--test-threads=1'], { ...options, env: { ...env, HOME: home } });
    expect(result.stdout).toContain('test result: ok.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 900_000);
