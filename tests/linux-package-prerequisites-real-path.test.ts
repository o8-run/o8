import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  const system = path.join(root, 'system-archives');
  const trusted = 'signed repository package bytes';
  const trustedHash = createHash('sha256').update(trusted).digest('hex');
  const reset = () => { writeFileSync(state, '{"installed":false}'); writeFileSync(calls, ''); rmSync(system, { recursive: true, force: true }); mkdirSync(system); };
  reset();
  const preload = path.join(root, 'filesystem.mjs');
  writeFileSync(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const translate = value => typeof value === 'string' && value.startsWith('/var/cache/apt/archives')
      ? process.env.APT_FIXTURE_ARCHIVES + value.slice('/var/cache/apt/archives'.length) : value;
    for (const name of ['readFileSync','readdirSync','lstatSync','copyFileSync']) {
      const original = fs[name]; fs[name] = (...args) => original(...args.map((value, index) => index < (name === 'copyFileSync' ? 2 : 1) ? translate(value) : value));
    } syncBuiltinESMExports();`);
  const scripts = {
    sudo: `const r = require('node:child_process').spawnSync(process.argv[2], process.argv.slice(3), { stdio: 'inherit', env: process.env }); process.exit(r.status ?? 1);`,
    'dpkg-query': `const state = JSON.parse(require('node:fs').readFileSync(process.env.APT_FIXTURE_STATE)); if (state.installed) console.log('install ok installed'); else process.exit(1);`,
    'dpkg-deb': `process.stdout.write('fixture\\t1\\tall');`,
    'apt-cache': `console.log('Package: fixture\\nVersion: 1\\nArchitecture: all\\nFilename: pool/main/f/fixture/fixture_1_all.deb\\nSHA256: ${trustedHash}\\n');`,
    install: `const fs=require('node:fs'), path=require('node:path'), args=process.argv.slice(2);
      const input=args.at(-2), destination=args.at(-1);
      if (!destination.startsWith('/var/cache/apt/archives/')) process.exit(36);
      fs.copyFileSync(input,path.join(process.env.APT_FIXTURE_ARCHIVES,path.basename(destination)));`,
    rm: `const fs=require('node:fs'),path=require('node:path'); for (const value of process.argv.slice(2).filter(value=>value.startsWith('/var/cache/apt/archives/'))) fs.rmSync(path.join(process.env.APT_FIXTURE_ARCHIVES,path.basename(value)),{force:true});`,
    'apt-get': `const fs = require('node:fs'); const path = require('node:path'); const args = process.argv.slice(2);
      fs.appendFileSync(process.env.APT_FIXTURE_CALLS, JSON.stringify(args) + '\\n');
      if (args.includes('update')) process.exit(0);
      const local = args.find(arg => arg.endsWith('.deb'));
      const directory = args.find(arg => arg.startsWith('Dir::Cache::archives='))?.split('=').slice(1).join('=') ?? process.env.APT_FIXTURE_ARCHIVES;
      const archive=path.join(directory,'fixture_1_all.deb');
      if (args.includes('--download-only')) {
        if (!fs.existsSync(archive)) {
          if (process.env.APT_FIXTURE_PACKAGE_NETWORK === 'false') process.exit(23);
          fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(archive,${JSON.stringify(trusted)});
        }
      } else if (args.includes('install')) {
        const bytes=fs.readFileSync(local ?? archive,'utf8');
        fs.writeFileSync(process.env.APT_FIXTURE_STATE,JSON.stringify({installed:true,bytes}));
      }`,
  };
  for (const [name, body] of Object.entries(scripts)) {
    const file = path.join(bin, name);
    writeFileSync(file, `#!${process.execPath}\n${body}\n`);
    chmodSync(file, 0o700);
  }
  const run = (mode = 'install', extra: Partial<NodeJS.ProcessEnv> = {}, group = 'rust') => {
    writeFileSync(output, '');
    const result = spawnSync(process.execPath, ['--import', preload, path.join(root, 'linux-package-prerequisites.mjs'), mode,
      `--group=${group}`, `--cache=${cache}`], { cwd: root, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ImageOS: 'fixture-linux', ImageVersion: '2026.10.1',
        APT_FIXTURE_STATE: state, APT_FIXTURE_CALLS: calls, APT_FIXTURE_ARCHIVES: system, GITHUB_OUTPUT: output, ...extra } });
    return { ...result, metadata: readFileSync(output, 'utf8'), calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]) };
  };
  return { root, state, cache, calls, reset, run, trusted, trustedHash, system };
}

linuxIt('refreshes the signed index on a miss and a hit while reusing authenticated package payloads', () => {
  const f = fixture(); const miss=f.run();
  expect(miss.status,miss.stderr+miss.stdout).toBe(0);
  expect(miss.metadata).toContain('source=download');
  f.reset(); const hit=f.run('install',{APT_FIXTURE_PACKAGE_NETWORK:'false'});
  expect(hit.status,hit.stderr+hit.stdout).toBe(0);
  expect(hit.metadata).toContain('source=cache');
  expect(hit.calls[0]).toContain('update');
  const installs=hit.calls.filter(args=>args.includes('install'));
  expect(installs.length).toBeGreaterThan(0);
  expect(installs.every(args=>!args.includes('--no-download') && !args.some(value=>value.endsWith('.deb') || value.startsWith('Dir::Etc::') || value.startsWith('Dir::State::')))).toBe(true);
  expect(JSON.parse(readFileSync(f.state,'utf8')).bytes).toBe(f.trusted);
});

linuxIt('refreshes APT authentication even when the requested packages are already installed', () => {
  const f=fixture();writeFileSync(f.state,'{"installed":true}');
  const result=f.run();expect(result.status,result.stderr+result.stdout).toBe(0);
  expect(result.calls[0]).toContain('update');
  expect(result.calls.some(args=>args.includes('install'))).toBe(true);
});

linuxIt.each(['rust','resources'])('rejects a tampered archive and matching manifest hash for %s', group => {
  const f=fixture(); const key=f.run('key',{},group).stdout.trim(); mkdirSync(f.cache);
  const tampered=f.trusted.slice(0,-1)+'!';
  writeFileSync(path.join(f.cache,'fixture_1_all.deb'),tampered);
  writeFileSync(path.join(f.cache,'manifest.json'),JSON.stringify({key,archives:[{file:'fixture_1_all.deb',sha256:createHash('sha256').update(tampered).digest('hex')}]}));
  const result=f.run('install',{},group);
  expect(result.status,result.stderr+result.stdout).toBe(0);
  expect(JSON.parse(readFileSync(f.state,'utf8')).bytes).toBe(f.trusted);
  expect(result.stdout).toContain('signed index');
  expect(result.metadata).toContain('source=download');
});

linuxIt('unlinks a tampered system-cache symlink without following or modifying its target', () => {
  const f=fixture(); const target=path.join(f.root,'tampered.deb');
  const tampered=f.trusted.slice(0,-1)+'!'; writeFileSync(target,tampered);
  symlinkSync(target,path.join(f.system,'fixture_1_all.deb'));
  const result=f.run();
  expect(result.status,result.stderr+result.stdout).toBe(0);
  expect(JSON.parse(readFileSync(f.state,'utf8')).bytes).toBe(f.trusted);
  expect(readFileSync(target,'utf8')).toBe(tampered);
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
  expect(restore.with['restore-keys']).toBe('${{ steps.identity.outputs.key }}-');
  expect(save.with.key).toBe('${{ steps.identity.outputs.key }}-${{ steps.install.outputs.revision }}');
  const archivePaths = '${{ steps.identity.outputs.path }}/*.deb\n${{ steps.identity.outputs.path }}/manifest.json\n';
  expect(restore.with.path).toBe(archivePaths);
  expect(save.with.path).toBe(archivePaths);
  const workflow = parse(readFileSync(path.join(source, '.github/workflows/ci.yml'), 'utf8'));
  const rust = workflow.jobs['rust-check-linux'].steps.find((step: { uses?: string }) => step.uses === './.github/actions/linux-package-prerequisites');
  expect(rust.with).toEqual({ group: 'rust' });
  expect(rust.if).toBe("steps.native.outputs.changed == 'true'");
});
