import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
const script = join(process.cwd(), 'scripts/promote.mjs');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-promote-'));
  roots.push(root);
  const manifest = { channel: 'beta', version: '0.1.900', platforms: {
    'linux-x86_64': { url: 'https://github.com/o8-run/o8/releases/download/v0.1.900/o8.AppImage', signature: 'signed-fixture' },
  } };
  writeFileSync(join(root, 'beta.json'), JSON.stringify(manifest));
  writeFileSync(join(root, 'latest.json'), JSON.stringify({ version: '0.1.800', platforms: {} }));
  mkdirSync(join(root, 'bin'));
  const gh = join(root, 'bin/gh');
  writeFileSync(gh, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const a = process.argv.slice(2), root = process.env.O8_PROMOTE_FIXTURE;
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(a) + '\\n');
if (a[1] === 'view') process.stdout.write('v0.1.800');
if (a[1] === 'download') {
 const name = a[a.indexOf('--pattern') + 1], dest = a[a.indexOf('--dir') + 1];
 fs.copyFileSync(path.join(root, name), path.join(dest, name));
}
if (a[1] === 'upload') {
 const source = a.find(v => v.endsWith('/latest.json'));
 fs.copyFileSync(source, path.join(root, 'promoted.json'));
}
`);
  chmodSync(gh, 0o700);
  return { root, manifest };
}
function run(f: ReturnType<typeof fixture>, version = '0.1.900', extra: string[] = []) {
  return spawnSync(process.execPath, [script, '--version', version, '--repo', 'o8-run/o8', ...extra], {
    cwd: f.root, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}`, O8_PROMOTE_FIXTURE: f.root },
  });
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('promotes exactly the beta manifest without a build or artifact upload', () => {
  const f = fixture();
  const result = run(f);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(join(f.root, 'promoted.json'), 'utf8'))).toEqual(f.manifest);
  const calls: string[][] = readFileSync(join(f.root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(calls.filter(a => a[1] === 'upload')).toHaveLength(1);
  expect(calls.find(a => a[1] === 'upload')).toContain('v0.1.800');
  expect(calls.some(a => ['create', 'edit'].includes(a[1]))).toBe(false);
});
it.each(['0.1.901', '0.1.700'])('refuses mismatched candidate %s before writing stable', version => {
  const f = fixture();
  const result = run(f, version);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/beta|version/);
  expect(existsSync(join(f.root, 'promoted.json'))).toBe(false);
});
