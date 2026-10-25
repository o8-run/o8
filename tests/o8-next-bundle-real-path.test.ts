import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

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
  const run = (extra = {}) => spawnSync(process.execPath, ['scripts/next/verify-app-bundle.mjs', app], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extra },
  });
  return { root, app, run };
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
  const invocations = readFileSync(calls, 'utf8');
  expect(invocations).toContain('aarch64-apple-darwin'); expect(invocations).toContain('x86_64-apple-darwin');
  expect(invocations).toContain('"--release","--locked"');
  expect(readFileSync(join(root, 'src-tauri/helpers/o8-next-universal-apple-darwin')))
    .toEqual(readFileSync(join(root, 'o8.app/Contents/MacOS/o8-next')));
});
