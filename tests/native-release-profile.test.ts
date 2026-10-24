import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { expect, it } from 'vitest';

it.runIf(process.platform === 'darwin')('keeps matching crash symbols outside stripped universal release executables', () => {
  const manifest = readFileSync('src-tauri/Cargo.toml', 'utf8');
  const profile = (parse(manifest).profile as Record<string, Record<string, unknown>>).release;
  expect(profile).toMatchObject({ strip: 'symbols', 'codegen-units': 1, debug: 1, 'split-debuginfo': 'packed' });
  expect(['thin', 'fat']).toContain(profile.lto);
  expect(profile.panic).not.toBe('abort');
  const root = mkdtempSync(join(tmpdir(), 'o8-release-symbols-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/main.rs'), '#[inline(never)]\nfn crash_symbol_marker(value: u64) -> u64 { std::hint::black_box(value) }\nfn main() { std::hint::black_box(crash_symbol_marker(42)); }\n');
    const release = manifest.match(/\[profile\.release\][\s\S]*?(?=\n\[|$)/)?.[0];
    writeFileSync(join(root, 'Cargo.toml'), `[package]\nname = "symbol-fixture"\nversion = "0.0.0"\nedition = "2021"\n${release}\n`);
    const slices: string[] = [];
    const uuids: string[] = [];
    for (const triple of ['aarch64-apple-darwin', 'x86_64-apple-darwin']) {
      execFileSync('cargo', ['build', '--release', '--offline', '--target', triple, '--target-dir', join(root, 'target')], {
        cwd: root, stdio: 'pipe',
      });
      const binary = join(root, 'target', triple, 'release', 'symbol-fixture');
      const uuid = execFileSync('dwarfdump', ['--uuid', binary], { encoding: 'utf8' }).split(' ')[1];
      uuids.push(uuid);
      const dsym = `${binary}.dSYM`;
      expect(execFileSync('dwarfdump', ['--uuid', dsym], { encoding: 'utf8' })).toContain(uuid);
      expect(execFileSync('dwarfdump', ['--name=crash_symbol_marker', dsym], { encoding: 'utf8' })).toContain('crash_symbol_marker');
      expect(execFileSync('nm', [binary], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).not.toContain('crash_symbol_marker');
      const dwarfDirectory = join(dsym, 'Contents/Resources/DWARF');
      const [dwarfName] = readdirSync(dwarfDirectory);
      if (!dwarfName) throw new Error('Missing retained DWARF artifact');
      const dwarf = join(dwarfDirectory, dwarfName);
      const symbols = execFileSync('nm', [dwarf], { encoding: 'utf8' });
      const address = symbols.split('\n').find(line => line.includes('crash_symbol_marker'))?.trim().split(/\s+/)[0];
      expect(address).toMatch(/^[a-f0-9]+$/i);
      const architecture = triple.startsWith('aarch64') ? 'arm64' : 'x86_64';
      expect(execFileSync('atos', ['-o', dwarf, '-arch', architecture, `0x${address}`], { encoding: 'utf8' }))
        .toContain('crash_symbol_marker');
      slices.push(binary);
    }
    const universal = join(root, 'o8');
    execFileSync('lipo', ['-create', ...slices, '-output', universal]);
    const universalUuids = execFileSync('dwarfdump', ['--uuid', universal], { encoding: 'utf8' });
    expect(universalUuids.trim().split('\n')).toHaveLength(2);
    for (const uuid of uuids) expect(universalUuids).toContain(uuid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
