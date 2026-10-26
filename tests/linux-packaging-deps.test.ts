import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// #2055 — a clean Linux install launched straight to the Node pre-flight
// dialog because the deb/rpm bundler config declared no nodejs dependency.
// `bundle.externalBin` stays null on Linux (the Tauri sidecar wants a
// SYSTEM Node), so the packaging config tells the package manager about Node.
//
// It is a soft dependency (`Recommends`), not `Depends`: Debian 13 and
// Ubuntu 24.04 ship Node 20, so a hard `nodejs (>= 22)` made apt refuse the
// install even for users who run Node 22 from nvm, fnm, Volta, asdf or mise.
// The Rust pre-flight (`run_node_preflight` in src-tauri/src/lib.rs) finds
// those installs and shows install instructions when none is usable.
//
// This test reads the real config the build merges (`src-tauri/tauri.linux.conf.json`,
// auto-merged by the Tauri CLI for Linux targets per tauri-utils'
// `BundleConfig.linux` — see `DebConfig.recommends` / `RpmConfig.recommends`).
const CONFIG_PATH = join(__dirname, '..', 'src-tauri', 'tauri.linux.conf.json');

type PackageDeps = { depends?: string[]; recommends?: string[] };

function readLinuxConfig(): {
  bundle?: { linux?: { deb?: PackageDeps; rpm?: PackageDeps } };
} {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

describe.each(['deb', 'rpm'] as const)('Linux %s nodejs dependency (#2055)', (format) => {
  it('recommends nodejs >= 22', () => {
    const deps = readLinuxConfig().bundle?.linux?.[format];
    const nodejsEntry = (deps?.recommends ?? []).find((d) => /^nodejs\b/.test(d));
    expect(nodejsEntry).toBeDefined();
    expect(nodejsEntry).toMatch(/>=\s*22/);
  });

  it('does not hard-depend on nodejs, so stock Debian 13 / Ubuntu 24.04 can install it', () => {
    const deps = readLinuxConfig().bundle?.linux?.[format];
    expect((deps?.depends ?? []).some((d) => /^nodejs\b/.test(d))).toBe(false);
  });
});
