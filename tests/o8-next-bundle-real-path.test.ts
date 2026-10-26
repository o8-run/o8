import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { macosExecutablePayloadSha256 } from '../scripts/lib/macos-release-artifacts.mjs';
import { afterEach, expect, it } from 'vitest';

const sourceRoot = process.cwd();
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-next-bundle-'))); roots.push(root);
  const app = join(root, 'o8.app'); const bin = join(root, 'bin'); mkdirSync(bin);
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  writeFileSync(join(bin, 'codesign'), `#!/usr/bin/env node
const args = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(join(root, 'calls.jsonl'))}, JSON.stringify(args) + '\\n');
if (process.env.FIXTURE_UNSIGNED === '1' && args.at(-1).endsWith('o8-next')) process.exit(1);
if (args.includes('--display')) console.error('TeamIdentifier=' + (process.env.FIXTURE_WRONG_TEAM === '1' && args.at(-1).endsWith('o8-next') ? 'OTHER' : 'FIXTURE') + '\\nCodeDirectory flags=0x10000(runtime)');
`, { mode: 0o755 });
  const header = Buffer.alloc(112); header.writeUInt32BE(0xcafebabe, 0); header.writeUInt32BE(2, 4);
  for (const [index, cpu] of [0x01000007, 0x0100000c].entries()) {
    const offset = 48 + index * 32; const entry = 8 + index * 20;
    header.writeUInt32BE(cpu, entry); header.writeUInt32BE(offset, entry + 8); header.writeUInt32BE(32, entry + 12);
    header.writeUInt32LE(0xfeedfacf, offset); header.writeUInt32LE(cpu, offset + 4);
  }
  writeFileSync(join(app, 'Contents/MacOS/o8'), header);
  writeFileSync(join(app, 'Contents/MacOS/o8-next'), header); chmodSync(join(app, 'Contents/MacOS/o8-next'), 0o755);
  writeFileSync(join(bin, 'git'), '#!/usr/bin/env node\nconsole.log("a".repeat(40));', { mode: 0o755 });
  const receipt = { schema: 'o8/next-build/v1', commit: 'a'.repeat(40), payloadBytes: { x86_64: 32, arm64: 32 }, payloadSha256: Object.fromEntries(
    (['x86_64', 'arm64'] as const).map(arch => [arch, macosExecutablePayloadSha256(join(app, 'Contents/MacOS/o8-next'), arch)])) };
  mkdirSync(join(root, 'src-tauri/helpers'), { recursive: true });
  mkdirSync(join(app, 'Contents/Resources'));
  for (const path of [join(root, 'src-tauri/helpers/o8-next-build.json'), join(app, 'Contents/Resources/o8-next-build.json')]) {
    writeFileSync(path, JSON.stringify(receipt));
  }
  const run = (extra = {}) => spawnSync(process.execPath, [join(sourceRoot, 'scripts/next/verify-app-bundle.mjs'), app], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extra },
  });
  return { root, app, run, receipt };
}
it('fails the release check when the bundled sidecar is absent', () => {
  const { app, run } = fixture(); rmSync(join(app, 'Contents/MacOS/o8-next'));
  const result = run(); expect(result.status).toBe(1); expect(result.stderr).toContain('o8 next sidecar is missing');
});
it('fails the release check when the sidecar is unsigned or uses another signing team', () => {
  const { run } = fixture();
  for (const extra of [{ FIXTURE_UNSIGNED: '1' }, { FIXTURE_WRONG_TEAM: '1' }]) {
    const result = run(extra); expect(result.status).toBe(1); expect(result.stderr).toContain('o8 next signing coverage');
  }
});
it('checks both architectures, nested signature, hardened runtime and the enclosing app seal', () => {
  const { root, app, run } = fixture(); const result = run(); expect(result.status, result.stderr).toBe(0);
  const calls = readFileSync(join(root, 'calls.jsonl'), 'utf8');
  expect(calls).toContain(JSON.stringify(['--verify', '--strict', '--verbose=2', join(app, 'Contents/MacOS/o8-next')]));
  expect(calls).toContain(JSON.stringify(['--verify', '--deep', '--strict', app]));
  const config = JSON.parse(readFileSync('src-tauri/tauri.macos.conf.json', 'utf8'));
  expect(config.bundle.externalBin).toContain('helpers/o8-next');
});
it('builds and stages both release slices through the prebuild sidecar entry point', () => {
  const { root } = fixture();
  const calls = join(root, 'build-calls.jsonl');
  rmSync(join(root, 'src-tauri/helpers/o8-next-build.json'));
  for (const name of ['cargo', 'lipo']) writeFileSync(join(root, 'bin', name), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'); const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify([${JSON.stringify(name)}, ...args]) + '\\n');
const at = key => args[args.indexOf(key) + 1];
const dest = ${JSON.stringify(name)} === 'cargo' ? path.join(at('--target-dir'), at('--target'), 'release', 'o8-next') : at('-output');
fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(${JSON.stringify(join(root, 'o8.app/Contents/MacOS/o8-next'))}, dest);
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [join(process.cwd(), 'scripts/next/build-sidecar.mjs')], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, O8_TAURI_BUILD_TARGET: 'universal-apple-darwin' },
  });
  expect(result.status, result.stderr).toBe(0);
  const built = JSON.parse(readFileSync(join(root, 'src-tauri/helpers/o8-next-build.json'), 'utf8'));
  expect(built.commit).toBe('a'.repeat(40));
  expect(built.payloadSha256).toEqual(fixtureReceipt(root));
  const invocations = readFileSync(calls, 'utf8');
  expect(invocations).toContain('aarch64-apple-darwin'); expect(invocations).toContain('x86_64-apple-darwin');
  expect(invocations).toContain('"--release","--locked"');
  expect(readFileSync(join(root, 'src-tauri/helpers/o8-next-universal-apple-darwin')))
    .toEqual(readFileSync(join(root, 'o8.app/Contents/MacOS/o8-next')));
});

it.each(['hash', 'commit', 'build-commit', 'missing-receipt'] as const)('refuses a correctly signed sidecar with stale %s through the verifier CLI', kind => {
  const { root, app, run, receipt } = fixture();
  const packaged = join(app, 'Contents/Resources/o8-next-build.json');
  if (kind === 'hash') {
    const binary = join(app, 'Contents/MacOS/o8-next');
    const bytes = readFileSync(binary); bytes[bytes.length - 1] ^= 1; writeFileSync(binary, bytes);
  } else if (kind === 'missing-receipt') rmSync(packaged);
  else {
    receipt.commit = 'b'.repeat(40);
    writeFileSync(packaged, JSON.stringify(receipt));
    if (kind === 'build-commit') writeFileSync(join(root, 'src-tauri/helpers/o8-next-build.json'), JSON.stringify(receipt));
  }
  const result = run();
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stderr).toMatch(/o8 next.*current build/);
});

function fixtureReceipt(root: string) {
  return Object.fromEntries((['x86_64', 'arm64'] as const).map(arch => [arch,
    macosExecutablePayloadSha256(join(root, 'src-tauri/helpers/o8-next-universal-apple-darwin'), arch)]));
}

it.each([0, 8])('accepts a first signature that adds a load command and %s alignment bytes through the verifier CLI', padding => {
  const { root, app, run, receipt } = fixture();
  const thin = (cpu: number) => {
    const bytes = Buffer.alloc(80 - padding);
    bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(cpu, 4);
    bytes.fill(0x23, 48);
    return bytes;
  };
  const fat = (slices: Buffer[]) => {
    const bytes = Buffer.alloc(48 + slices.reduce((sum, slice) => sum + slice.length, 0));
    bytes.writeUInt32BE(0xcafebabe, 0); bytes.writeUInt32BE(2, 4);
    let offset = 48;
    slices.forEach((slice, index) => {
      const entry = 8 + index * 20;
      bytes.writeUInt32BE(slice.readUInt32LE(4), entry);
      bytes.writeUInt32BE(offset, entry + 8); bytes.writeUInt32BE(slice.length, entry + 12);
      slice.copy(bytes, offset); offset += slice.length;
    });
    return bytes;
  };
  const originals = [thin(0x01000007), thin(0x0100000c)];
  const binary = join(app, 'Contents/MacOS/o8-next');
  writeFileSync(binary, fat(originals));
  receipt.payloadSha256 = Object.fromEntries((['x86_64', 'arm64'] as const).map(arch => [arch,
    macosExecutablePayloadSha256(binary, arch)]));
  const build = { ...receipt, payloadBytes: { x86_64: originals[0].length, arm64: originals[1].length } };
  for (const path of [join(root, 'src-tauri/helpers/o8-next-build.json'), join(app, 'Contents/Resources/o8-next-build.json')]) {
    writeFileSync(path, JSON.stringify(build));
  }
  // Model only the signature's load command, aligned blob and header changes.
  // No signing tool, signing identity or credential is used.
  const signed = originals.map(original => {
    const bytes = Buffer.alloc(112); original.copy(bytes);
    bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(16, 20);
    bytes.writeUInt32LE(0x1d, 32); bytes.writeUInt32LE(16, 36);
    bytes.writeUInt32LE(80, 40); bytes.writeUInt32LE(32, 44);
    bytes.fill(0x42, 80);
    return bytes;
  });
  writeFileSync(binary, fat(signed));
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  signed[0][64] ^= 1;
  writeFileSync(binary, fat(signed));
  const changed = run();
  expect(changed.status).toBe(1);
  expect(changed.stderr).toContain('content hash does not match the current build');
  if (padding) {
    signed[0][64] ^= 1;
    signed[0][originals[0].length] = 1;
    writeFileSync(binary, fat(signed));
    const alignment = run();
    expect(alignment.status).toBe(1);
    expect(alignment.stderr).toContain('payload length does not match the current build');
  }
});
