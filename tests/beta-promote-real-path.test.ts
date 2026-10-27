import { createHash } from 'node:crypto';
import { manifestSha256, SMOKE_STEPS } from '../scripts/lib/smoke-receipt.mjs';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
const script = join(process.cwd(), 'scripts/promote.mjs');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-promote-'));
  roots.push(root);
  const artifactHash = createHash('sha256').update('installed-fixture').digest('hex');
  const manifest = { installers: [{ url: 'https://github.com/o8-run/o8/releases/download/v0.1.900/o8.AppImage', sha256: artifactHash }], channel: 'beta', version: '0.1.900', platforms: {
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
 const versioned = path.join(root, a[2] + '-' + name);
 fs.copyFileSync(fs.existsSync(versioned) ? versioned : path.join(root, name), path.join(dest, name));
 if (name === 'latest.json' && process.env.O8_PROMOTE_PAUSE) {
  fs.writeFileSync(path.join(root, 'paused'), '');
  const start = Date.now();
  while (!fs.existsSync(path.join(root, 'resume')) && Date.now() - start < 8000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
 }
}
if (a[1] === 'upload') {
 const source = a.find(v => v.endsWith('/latest.json'));
 fs.copyFileSync(source, path.join(root, 'promoted.json'));
 fs.copyFileSync(source, path.join(root, 'latest.json'));
}
`);
  chmodSync(gh, 0o700);
  const receipt = join(root, 'smoke.json');
  writeFileSync(receipt, JSON.stringify({ schema: 'o8/installed-smoke/v1', status: 'passed', version: manifest.version,
    artifactSha256: artifactHash, manifestSha256: manifestSha256(manifest), providers: { codex: 'fixture', claude: 'fixture', worker: 'fixture' },
    steps: Object.fromEntries(SMOKE_STEPS.map(step => [step, 'passed'])),
  }));
  return { root, manifest, receipt };
}
function run(f: ReturnType<typeof fixture>, version = '0.1.900', extra: string[] = []) {
  return spawnSync(process.execPath, [script, '--version', version, '--repo', 'o8-run/o8', ...(extra.includes('--no-receipt') ? [] : ['--smoke-receipt', f.receipt]), ...extra.filter(arg => arg !== '--no-receipt')], {
    cwd: f.root, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}`, O8_PROMOTE_FIXTURE: f.root, O8_RELEASE_FEED_LOCK: join(f.root, 'promote.lock') },
  });
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('promotes the smoke-verified beta artifacts with explicit stable identity without a build or artifact upload', () => {
  const f = fixture();
  const result = run(f);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(join(f.root, 'promoted.json'), 'utf8'))).toEqual({ ...f.manifest, channel: 'stable' });
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

it('refuses promotion with no installed smoke receipt before a stable write', () => {
  const f = fixture();
  const result = run(f, '0.1.900', ['--no-receipt']);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('smoke');
  expect(existsSync(join(f.root, 'promoted.json'))).toBe(false);
});

it.each(['version', 'artifactSha256', 'manifestSha256', 'status', 'step', 'providers'])('rejects a smoke receipt with a mismatched %s before stable writes', field => {
  const f = fixture();
  const receipt = JSON.parse(readFileSync(f.receipt, 'utf8'));
  if (field === 'step') receipt.steps['worker-dispatch'] = 'failed';
  else if (field === 'providers') receipt.providers.codex = 'unknown';
  else receipt[field] = 'mismatch';
  writeFileSync(f.receipt, JSON.stringify(receipt));
  const result = run(f);
  expect(result.status).toBe(1);
  expect(existsSync(join(f.root, 'promoted.json'))).toBe(false);
});
it('requires a passing receipt for every installer in a multi-artifact beta manifest', () => {
  const f = fixture();
  const secondHash = createHash('sha256').update('second-installer').digest('hex');
  f.manifest.installers.push({ url: 'https://github.com/o8-run/o8/releases/download/v0.1.900/second.dmg', sha256: secondHash });
  writeFileSync(join(f.root, 'beta.json'), JSON.stringify(f.manifest));
  const first = JSON.parse(readFileSync(f.receipt, 'utf8'));
  first.manifestSha256 = manifestSha256(f.manifest);
  writeFileSync(f.receipt, JSON.stringify(first));
  expect(run(f).status).toBe(1);
  expect(existsSync(join(f.root, 'promoted.json'))).toBe(false);
  const second = join(f.root, 'second-smoke.json');
  writeFileSync(second, JSON.stringify({ ...first, artifactSha256: secondHash }));
  const result = run(f, '0.1.900', ['--smoke-receipt', second]);
  expect(result.status, result.stderr).toBe(0);
});
it('refuses a candidate missing any stable platform before writing', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'latest.json'), JSON.stringify({ version: '0.1.800', platforms: {
    'darwin-aarch64': { url: 'https://example.invalid/old', signature: 'old' },
    ...f.manifest.platforms,
  } }));
  const result = run(f);
  expect(result.status, result.stderr).toBe(1);
  expect(existsSync(join(f.root, 'promoted.json'))).toBe(false);
});
it('carries all signed candidate platforms into stable unchanged', () => {
  const f = fixture();
  const manifest = { ...f.manifest, platforms: { ...f.manifest.platforms,
    'darwin-x86_64': { url: new URL('o8.app.tar.gz', f.manifest.platforms['linux-x86_64'].url).href, signature: 'darwin-fixture' },
  } };
  writeFileSync(join(f.root, 'beta.json'), JSON.stringify(manifest));
  const receipt = JSON.parse(readFileSync(f.receipt, 'utf8'));
  receipt.manifestSha256 = manifestSha256(manifest);
  writeFileSync(f.receipt, JSON.stringify(receipt));
  writeFileSync(join(f.root, 'latest.json'), JSON.stringify({ ...manifest, version: '0.1.800' }));
  const result = run(f);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(join(f.root, 'promoted.json'), 'utf8')).platforms).toEqual(manifest.platforms);
});
it('serializes overlapping commands and refuses a later downgrade', async () => {
  const f = fixture();
  const newer = JSON.parse(JSON.stringify(f.manifest).replaceAll('0.1.900', '0.1.901'));
  writeFileSync(join(f.root, 'v0.1.901-beta.json'), JSON.stringify(newer));
  const newerReceipt = join(f.root, 'newer-smoke.json');
  writeFileSync(newerReceipt, JSON.stringify({ ...JSON.parse(readFileSync(f.receipt, 'utf8')),
    version: newer.version, manifestSha256: manifestSha256(newer) }));
  const child = spawn(process.execPath, [script, '--version', '0.1.900', '--repo', 'o8-run/o8', '--smoke-receipt', f.receipt], {
    cwd: f.root, stdio: 'pipe', env: { ...process.env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}`,
      O8_PROMOTE_FIXTURE: f.root, O8_RELEASE_FEED_LOCK: join(f.root, 'promote.lock'), O8_PROMOTE_PAUSE: '1' },
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const completed = new Promise<number | null>(resolve => child.on('close', resolve));
  try {
    const deadline = Date.now() + 8000;
    while (!existsSync(join(f.root, 'paused')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(existsSync(join(f.root, 'paused')), errors).toBe(true);
    const overlap = run(f, '0.1.901', ['--smoke-receipt', newerReceipt]);
    writeFileSync(join(f.root, 'resume'), '');
    expect(await completed, errors).toBe(0);
    expect(overlap.status, overlap.stderr).toBe(1);
    expect(run(f, '0.1.901', ['--smoke-receipt', newerReceipt]).status).toBe(0);
    expect(run(f, '0.1.900').status).toBe(1);
    expect(JSON.parse(readFileSync(join(f.root, 'latest.json'), 'utf8')).version).toBe('0.1.901');
  } finally {
    writeFileSync(join(f.root, 'resume'), '');
    await completed;
  }
}, 20_000);

it('uses the same publication lock as beta and Linux writers before reading manifests', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'promote.lock'), 'another publisher owns this lock');
  const result = run(f);
  expect(result.status).toBe(1);
  expect(existsSync(join(f.root, 'calls.jsonl'))).toBe(false);
  expect(existsSync(join(f.root, 'promoted.json'))).toBe(false);
  expect(readFileSync(join(f.root, 'promote.lock'), 'utf8')).toBe('another publisher owns this lock');
});
it('repeats promotion with stable identity and unchanged artifact bytes', () => {
  const f = fixture();
  expect(run(f).status).toBe(0);
  expect(run(f).status).toBe(0);
  expect(JSON.parse(readFileSync(join(f.root, 'latest.json'), 'utf8'))).toEqual({ ...f.manifest, channel: 'stable' });
});
