import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Linux packages shipped without `o8-pi-write`, so every approved Pi write
// failed with "Pi write helper is missing from this build" and confined
// commands had no supervisor (the helper is the Linux command supervisor too,
// #3350). The shell finds the helper beside its own executable
// (`pi_write_helper` in src-tauri/src/lib.rs), which is where Tauri installs
// an externalBin: /usr/bin/o8-pi-write in the deb/rpm and the AppImage.
const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Linux Pi write helper packaging', () => {
  it('bundles o8-pi-write as a Linux sidecar', () => {
    const config = JSON.parse(read('src-tauri/tauri.linux.conf.json'));
    expect(config.bundle.externalBin).toContain('helpers/o8-pi-write');
  });

  it('builds the helper for Linux gnu targets instead of skipping', () => {
    const script = read('scripts/build-pi-write.mjs');
    expect(script).toContain("process.platform !== 'darwin' && process.platform !== 'linux'");
    expect(script).toMatch(/LINUX_TRIPLES = \['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu'\]/);
  });

  it('stages the helper before tauri-build validates externalBin', () => {
    const build = read('src-tauri/build.rs');
    const stage = build.indexOf('stage_linux_pi_write();');
    expect(stage).toBeGreaterThan(-1);
    expect(stage).toBeLessThan(build.search(/^  tauri_build::build\(\)$/m));
    // An existing staged binary (fresh from tauri:prebuild) is never replaced.
    expect(build).toMatch(/if staged\.exists\(\) \{\s*return;\s*\}/);
  });

  it('treats the Linux helper copies as release build outputs', () => {
    const artifacts = read('scripts/lib/release-artifacts.mjs');
    for (const triple of ['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu']) {
      expect(artifacts).toContain(`'src-tauri/helpers/o8-pi-write-${triple}'`);
    }
  });

  const host = process.arch === 'x64' ? 'x86_64-unknown-linux-gnu' : 'aarch64-unknown-linux-gnu';
  const staged = join(root, 'src-tauri', 'helpers', `o8-pi-write-${host}`);
  it.runIf(process.platform === 'linux' && existsSync(staged))('stages a runnable Linux ELF helper', () => {
    expect(readFileSync(staged).subarray(0, 4).toString('latin1')).toBe('\x7fELF');
    // The supervisor refuses an unknown subcommand with a usage error, which
    // proves the binary runs on this host without performing any write.
    let failure: { status?: number | null } | undefined;
    try {
      execFileSync(staged, ['--o8-test-unknown-subcommand'], { stdio: 'pipe' });
    } catch (error) {
      failure = error as { status?: number | null };
    }
    expect(failure?.status).not.toBe(127);
  });
});
