import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { createVerifierCoverageFixture } from './helpers/verify-ci-coverage.fixture';

const root = mkdtempSync(path.join(tmpdir(), 'o8-audit-tool-'));
const release = (version = '0.23.0', checksum = 'a'.repeat(64)) => ({
  crate: { max_stable_version: version }, versions: [{ num: version, checksum, yanked: false }],
});
let response: unknown = release();
let status = 200;
let invalidJson = false;
const server = createServer((_request, reply) => {
  reply.writeHead(status, { 'content-type': 'application/json' });
  reply.end(invalidJson ? '{' : JSON.stringify(response));
});
let url = '';
const helper = path.join(root, 'scripts/ci/audit-tool-cache.mjs');
const recipe = path.join(root, 'scripts/ci/install-audit-tool.sh');
const cargoHome = path.join(root, 'cargo');
const binary = path.join(cargoHome, 'bin/cargo-audit');
const receipt = path.join(root, 'calls');
const workflow = () => parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const env = () => ({ ...process.env, PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`,
  CARGO_HOME: cargoHome, AUDIT_TOOL_RECEIPT: receipt, ImageOS: 'ubuntu24', ImageVersion: '20261110.1' });
beforeAll(async () => {
  mkdirSync(path.dirname(helper), { recursive: true });
  mkdirSync(path.join(root, 'bin'), { recursive: true });
  mkdirSync(path.dirname(binary), { recursive: true });
  writeFileSync(path.join(root, 'bin/cargo'), `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); const binary = path.join(process.env.CARGO_HOME, 'bin/cargo-audit');
fs.appendFileSync(process.env.AUDIT_TOOL_RECEIPT, JSON.stringify({args, exists:fs.existsSync(binary)})+'\\n');
if(args[0]==='install') { fs.writeFileSync(binary, args.includes('--version') ? args[args.indexOf('--version')+1] : '0.23.0'); process.exit(0); }
if(args[0]==='audit' && args[1]==='--version') {
  if(!fs.existsSync(binary) || fs.readFileSync(binary,'utf8')==='BROKEN') process.exit(127);
  console.log((process.env.AUDIT_TOOL_PREFIX || 'cargo-audit-audit')+' '+fs.readFileSync(binary,'utf8')); process.exit(0);
}
if(args[0]==='audit') process.exit(13);
process.exit(2);
`, { mode: 0o755 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => {
  response = release(); status = 200; invalidJson = false;
  copyFileSync('scripts/ci/audit-tool-cache.mjs', helper);
  if (existsSync('scripts/ci/install-audit-tool.sh')) copyFileSync('scripts/ci/install-audit-tool.sh', recipe);
  else writeFileSync(recipe, 'cargo install cargo-audit --locked\n');
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});
async function resolve(toolchain = 'rustc fixture', override: Record<string, string> = {}) {
  const output = path.join(root, 'output'); writeFileSync(output, '');
  const child = spawn(process.execPath, [helper, toolchain], {
    env: { ...env(), ...override, GITHUB_OUTPUT: output, AUDIT_TOOL_REGISTRY_URL: url },
  });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise<number | null>(done => child.on('close', done));
  const values = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(line => line.split('=')));
  return { code, stderr, values };
}
function condition(source: string, values: Record<string, string>, hit = 'true') {
  const expression = source.replaceAll('steps.audit-tool-cache', 'steps["audit-tool-cache"]').replaceAll('steps.audit-tool', 'steps["audit-tool"]');
  return new Function('needs', 'steps', `return (${expression});`)(
    { reuse: { outputs: { reuse: 'false' } } }, { 'audit-tool': { outputs: values }, 'audit-tool-cache': { outputs: { 'cache-hit': hit } } },
  );
}
function install(values: Record<string, string>, existing = 'MISSING', prefix = 'cargo-audit-audit', hit = 'true') {
  rmSync(binary, { force: true }); if (existing !== 'MISSING') writeFileSync(binary, existing);
  writeFileSync(receipt, '');
  const step = workflow().jobs.security.steps.find((step: { name?: string }) => step.name === 'Install cargo-audit');
  const result = condition(step.if, values, hit) ? spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
    cwd: root, encoding: 'utf8', env: { ...env(), AUDIT_TOOL_VERSION: values.version ?? '', AUDIT_TOOL_CACHEABLE: values.cacheable ?? '', AUDIT_TOOL_PREFIX: prefix, AUDIT_TOOL_CACHE_HIT: hit },
  }) : { status: 0, stderr: '' };
  const calls = readFileSync(receipt, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { ...result, installs: calls.filter(call => call.args[0] === 'install') };
}
it('source identity', async () => {
  const first = await resolve(); expect(first.code, first.stderr).toBe(0);
  expect(first.values.cacheable).toBe('true'); expect(first.values.source).toBe('a'.repeat(64));
  expect((await resolve('rustc other')).values.toolchain).not.toBe(first.values.toolchain);
  response = release('0.23.0', 'b'.repeat(64)); expect((await resolve()).values.source).toBe('b'.repeat(64));
  response = release('0.24.0'); expect((await resolve()).values.version).toBe('0.24.0');
});
it('restored binary version', async () => {
  const { values } = await resolve();
  for (const prefix of ['cargo-audit', 'cargo-audit-audit']) {
    const valid = install(values, '0.23.0', prefix); expect(valid.status, valid.stderr).toBe(0); expect(valid.installs).toHaveLength(0);
  }
  expect(install(values, '0.23.0', 'cargo-audit', 'false').installs).toHaveLength(1);
  for (const version of ['0.22.0', '0.23.00', 'BROKEN', 'MISSING']) {
    const result = install(values, version); expect(result.status, result.stderr).toBe(0);
    expect(result.installs).toHaveLength(1); expect(result.installs[0].exists).toBe(false);
    expect(result.installs[0].args).toEqual(['install', 'cargo-audit', '--version', '0.23.0', '--locked', '--force']);
    expect(readFileSync(binary, 'utf8')).toBe('0.23.0');
  }
});
it('runner image identity', async () => {
  const first = await resolve(); expect(first.values.image).toMatch(/^[a-f0-9]{64}$/);
  expect((await resolve('rustc fixture', { ImageVersion: 'older' })).values.image).not.toBe(first.values.image);
  expect((await resolve('rustc fixture', { ImageOS: 'other' })).values.image).not.toBe(first.values.image);
  expect((await resolve('rustc fixture', { ImageVersion: '' })).values).toEqual({ cacheable: 'false' });
});
it('registry fallback', async () => {
  const cases = [
    { body: release(), status: 503 }, { body: {}, status: 200 },
    { body: { crate: { max_stable_version: '0.23.0' } }, status: 200 },
    { body: { crate: { max_stable_version: '0.23.0' }, versions: [] }, status: 200 },
    { body: { crate: { max_stable_version: '0.23.0' }, versions: release('0.22.0').versions }, status: 200 },
    { body: { ...release(), versions: [{ num: '0.23.0', checksum: 'a'.repeat(64), yanked: true }] }, status: 200 },
    { body: release('invalid'), status: 200 }, { body: release('0.23.0', 'invalid'), status: 200 },
    { body: release(), status: 200, invalidJson: true },
  ];
  for (const entry of cases) {
    response = entry.body; status = entry.status; invalidJson = entry.invalidJson ?? false;
    const result = await resolve(); expect(result.code, result.stderr).toBe(0); expect(result.values).toEqual({ cacheable: 'false' });
    const cache = workflow().jobs.security.steps.find((step: { id?: string }) => step.id === 'audit-tool-cache');
    expect(condition(cache.if, result.values)).toBe(false);
    const installed = install(result.values); expect(installed.status, installed.stderr).toBe(0);
    expect(installed.installs[0].args).toEqual(['install', 'cargo-audit', '--locked']);
    const audit = workflow().jobs.security.steps.find((step: { name?: string }) => step.name === 'Audit Rust dependencies');
    const blocked = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', audit.run], { cwd: root, encoding: 'utf8', env: { ...env(), AUDIT_IGNORE: '' } });
    expect(blocked.status).toBe(13);
  }
});
it('install recipe hash', async () => {
  const first = await resolve(); expect(first.values.recipe).toMatch(/^[a-f0-9]{64}$/);
  writeFileSync(recipe, readFileSync(recipe, 'utf8').replace('--locked', '--locked --features fixture'));
  expect((await resolve()).values.recipe).not.toBe(first.values.recipe);
});
it('workflow cache boundary', () => {
  const steps = workflow().jobs.security.steps;
  const cache = steps.find((step: { id?: string }) => step.id === 'audit-tool-cache');
  expect(cache.with.path).toBe('~/.cargo/bin/cargo-audit'); expect(cache.with['restore-keys']).toBeUndefined();
  for (const field of ['version', 'source', 'toolchain', 'image', 'recipe']) expect(cache.with.key).toContain(`steps.audit-tool.outputs.${field}`);
  expect(cache.if).toContain("steps.audit-tool.outputs.cacheable == 'true'");
  const install = steps.find((step: { name?: string }) => step.name === 'Install cargo-audit');
  expect(install.if).toBe("needs.reuse.outputs.reuse != 'true'"); expect(install.run).toBe('bash scripts/ci/install-audit-tool.sh');
  expect(install.env.AUDIT_TOOL_CACHE_HIT).toBe('${{ steps.audit-tool-cache.outputs.cache-hit }}');
  for (const name of ['Audit root dependencies', 'Audit Rust dependencies', 'Review dependency changes']) {
    const step = steps.find((step: { name?: string }) => step.name === name);
    expect(step.if).toBe("needs.reuse.outputs.reuse != 'true'"); expect(step['continue-on-error']).toBeUndefined();
  }
});
it('coverage rejection', () => {
  const fixture = createVerifierCoverageFixture(process.cwd(), root); const workflowPath = path.join(fixture, '.github/workflows/ci.yml');
  const run = () => spawnSync(process.execPath, [path.join(fixture, 'scripts/ci/check-verify-ci.mjs')], { encoding: 'utf8' });
  expect(run().status).toBe(0);
  for (const mutation of ['advisories', 'conditional audit', 'source', 'image', 'recipe', 'binary verification']) {
    const value = workflow(); const steps = value.jobs.security.steps;
    if (mutation === 'advisories') steps.find((step: { id?: string }) => step.id === 'audit-tool-cache').with.path = '~/.cargo/advisory-db';
    if (['source', 'image', 'recipe'].includes(mutation)) {
      const cache = steps.find((step: { id?: string }) => step.id === 'audit-tool-cache');
      cache.with.key = cache.with.key.replace(`steps.audit-tool.outputs.${mutation}`, 'missing');
    }
    if (mutation === 'binary verification') steps.find((step: { name?: string }) => step.name === 'Install cargo-audit').run = 'cargo install cargo-audit --locked';
    if (mutation === 'conditional audit') steps.find((step: { name?: string }) => step.name === 'Audit Rust dependencies').if += " && steps.audit-tool-cache.outputs.cache-hit != 'true'";
    writeFileSync(workflowPath, stringify(value)); const result = run(); expect(result.status, mutation).toBe(1); expect(result.stderr).toContain('verify:ci coverage:');
  }
});
