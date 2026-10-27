import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'yaml';

const source = process.cwd();
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const linuxIt = it.skipIf(process.platform !== 'linux');

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'o8-linux-packages-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  for (const file of ['linux-package-prerequisites.mjs', 'linux-package-prerequisites.json']) {
    const original = path.join(source, 'scripts/ci', file);
    if (existsSync(original)) copyFileSync(original, path.join(root, file));
  }
  const state = path.join(root, 'state.json');
  const calls = path.join(root, 'calls.jsonl');
  const cache = path.join(root, 'cache');
  const output = path.join(root, 'output');
  const reset = () => { writeFileSync(state, '{"installed":false}'); writeFileSync(calls, ''); };
  reset();
  const scripts = {
    sudo: `const r = require('node:child_process').spawnSync(process.argv[2], process.argv.slice(3), { stdio: 'inherit', env: process.env }); process.exit(r.status ?? 1);`,
    'dpkg-query': `const state = JSON.parse(require('node:fs').readFileSync(process.env.APT_FIXTURE_STATE)); if (state.installed) console.log('install ok installed'); else process.exit(1);`,
    'apt-get': `const fs = require('node:fs'); const path = require('node:path'); const args = process.argv.slice(2);
      fs.appendFileSync(process.env.APT_FIXTURE_CALLS, JSON.stringify(args) + '\\n');
      const online = args.includes('update') || args.includes('--download-only');
      if (online && process.env.APT_FIXTURE_OFFLINE === 'true') process.exit(23);
      if (args.includes('--download-only')) {
        const destination = args.find(arg => arg.startsWith('Dir::Cache::archives=')).split('=').slice(1).join('=');
        fs.mkdirSync(destination, { recursive: true }); fs.writeFileSync(path.join(destination, 'fixture_1_all.deb'), 'verified fixture archive');
      } else if (args.includes('install')) {
        if (!args.includes('--no-download') || !args.some(arg => arg.endsWith('.deb'))) process.exit(35);
        fs.writeFileSync(process.env.APT_FIXTURE_STATE, '{"installed":true}');
      }`,
  };
  for (const [name, body] of Object.entries(scripts)) {
    const file = path.join(bin, name);
    writeFileSync(file, `#!${process.execPath}\n${body}\n`);
    chmodSync(file, 0o700);
  }
  const run = (mode = 'install', extra: Partial<NodeJS.ProcessEnv> = {}) => {
    writeFileSync(output, '');
    const result = spawnSync(process.execPath, [path.join(root, 'linux-package-prerequisites.mjs'), mode,
      '--group=rust', `--cache=${cache}`], { cwd: root, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ImageOS: 'fixture-linux', ImageVersion: '2026.10.1',
        APT_FIXTURE_STATE: state, APT_FIXTURE_CALLS: calls, GITHUB_OUTPUT: output, ...extra } });
    return { ...result, metadata: readFileSync(output, 'utf8'), calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]) };
  };
  return { root, state, cache, calls, reset, run };
}

linuxIt('downloads a complete miss and installs a fresh image from cached archives without network', () => {
  const f = fixture();
  const miss = f.run();
  expect(miss.status, miss.stderr + miss.stdout).toBe(0);
  expect(miss.metadata).toContain('source=download');
  expect(miss.calls.some(args => args.includes('update'))).toBe(true);
  expect(miss.calls.some(args => args.includes('--download-only'))).toBe(true);
  f.reset();
  const hit = f.run('install', { APT_FIXTURE_OFFLINE: 'true' });
  expect(hit.status, hit.stderr + hit.stdout).toBe(0);
  expect(hit.metadata).toContain('source=cache');
  expect(hit.calls).toHaveLength(1);
  expect(hit.calls[0]).toEqual(expect.arrayContaining(['install', '--no-download']));
  expect(hit.calls[0]).toContain(`Dir::Cache::archives=${f.cache}`);
  expect(hit.calls[0].some(arg => arg.endsWith('.deb'))).toBe(true);
});

linuxIt('skips every network and install command when the image already has the requested packages', () => {
  const f = fixture();
  writeFileSync(f.state, '{"installed":true}');
  const result = f.run('install', { APT_FIXTURE_OFFLINE: 'true' });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(result.calls).toEqual([]);
  expect(result.metadata).toContain('source=installed');
});

linuxIt('rejects a corrupted archive and refreshes the cache through the ordinary miss path', () => {
  const f = fixture();
  expect(f.run().status).toBe(0);
  writeFileSync(path.join(f.cache, 'fixture_1_all.deb'), 'corrupted archive');
  f.reset();
  const result = f.run();
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(result.metadata).toContain('source=download');
  expect(result.calls.some(args => args.includes('--download-only'))).toBe(true);
});

linuxIt('keys package caches on package definitions, installer version and the runner image', () => {
  const f = fixture();
  const first = f.run('key');
  expect(first.status, first.stderr + first.stdout).toBe(0);
  const image = f.run('key', { ImageVersion: '2026.10.2' });
  expect(image.metadata).not.toBe(first.metadata);
  const file = path.join(f.root, 'linux-package-prerequisites.json');
  const groups = JSON.parse(readFileSync(file, 'utf8'));
  groups.rust.push('fixture-new-package');
  writeFileSync(file, JSON.stringify(groups));
  const packages = f.run('key');
  expect(packages.metadata).not.toBe(first.metadata);
  expect(packages.calls).toEqual([]);
});

it('pins archive cache actions and saves only the reviewed main-branch cache', () => {
  const file = path.join(source, '.github/actions/linux-package-prerequisites/action.yml');
  expect(existsSync(file), 'the real prerequisite action must own the archive cache').toBe(true);
  const action = parse(readFileSync(file, 'utf8'));
  const restore = action.runs.steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/cache/restore@'));
  const save = action.runs.steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/cache/save@'));
  expect(restore.uses).toMatch(/@[0-9a-f]{40}$/);
  expect(save.uses).toMatch(/@[0-9a-f]{40}$/);
  expect(save.if).toContain("github.ref == 'refs/heads/main'");
  expect(save.with.key).toBe(restore.with.key);
  const archivePaths = '${{ steps.identity.outputs.path }}/*.deb\n${{ steps.identity.outputs.path }}/manifest.json\n';
  expect(restore.with.path).toBe(archivePaths);
  expect(save.with.path).toBe(archivePaths);
  const workflow = parse(readFileSync(path.join(source, '.github/workflows/ci.yml'), 'utf8'));
  const rust = workflow.jobs['rust-check-linux'].steps.find((step: { uses?: string }) => step.uses === './.github/actions/linux-package-prerequisites');
  expect(rust.with).toEqual({ group: 'rust' });
  expect(rust.if).toBe("steps.native.outputs.changed == 'true'");
});
