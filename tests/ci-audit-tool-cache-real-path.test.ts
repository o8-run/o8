import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { createVerifierCoverageFixture } from './helpers/verify-ci-coverage.fixture';

const root = mkdtempSync(path.join(tmpdir(), 'o8-audit-tool-'));
let response: unknown = { crate: { max_stable_version: '0.23.0' } };
let status = 200;
const server = createServer((_request, reply) => {
  reply.writeHead(status, { 'content-type': 'application/json' });
  reply.end(JSON.stringify(response));
});
let url = '';
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});
async function resolve(toolchain = 'rustc 1.fixture\nhost: fixture-target') {
  const output = path.join(root, 'output');
  writeFileSync(output, '');
  const child = spawn(process.execPath, ['scripts/ci/audit-tool-cache.mjs', toolchain], {
    env: { ...process.env, GITHUB_OUTPUT: output, AUDIT_TOOL_REGISTRY_URL: url },
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise<number | null>(done => child.on('close', done));
  return { code, stderr, output: readFileSync(output, 'utf8') };
}
it('resolves current stable versions on every invocation and binds identity to the toolchain', async () => {
  const first = await resolve();
  expect(first.code, first.stderr).toBe(0);
  expect(first.output).toMatch(/^version=0\.23\.0\ntoolchain=[a-f0-9]{64}\n$/);
  expect((await resolve('rustc other')).output).not.toBe(first.output);
  response = { crate: { max_stable_version: '0.24.0' } };
  expect((await resolve()).output).toContain('version=0.24.0\n');
});
it('fails closed on registry failure or malformed version without publishing outputs', async () => {
  for (const version of ['0.24.0\ncache=unsafe', '', null, '0.25.0-preview.1']) {
    response = { crate: { max_stable_version: version } };
    const result = await resolve();
    expect(result.code).not.toBe(0);
    expect(result.output).toBe('');
  }
  status = 503;
  expect((await resolve()).code).not.toBe(0);
  status = 200;
});
it('caches only the audit executable and still runs every advisory and dependency check', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const steps = workflow.jobs.security.steps;
  const cache = steps.find((step: { id?: string }) => step.id === 'audit-tool-cache');
  expect(cache.with.path).toBe('~/.cargo/bin/cargo-audit');
  expect(cache.with['restore-keys']).toBeUndefined();
  expect(cache.with.key).toContain('${{ steps.audit-tool.outputs.version }}');
  expect(cache.with.key).toContain('${{ steps.audit-tool.outputs.toolchain }}');
  expect(cache.with.key).toContain('${{ runner.arch }}');
  const install = steps.find((step: { name?: string }) => step.name === 'Install cargo-audit');
  expect(install.if).toBe("needs.reuse.outputs.reuse != 'true' && steps.audit-tool-cache.outputs.cache-hit != 'true'");
  expect(install.run).toContain('--version "$AUDIT_TOOL_VERSION" --locked');
  for (const name of ['Audit root dependencies', 'Audit Rust dependencies', 'Review dependency changes']) {
    const step = steps.find((step: { name?: string }) => step.name === name);
    expect(step.if).toBe("needs.reuse.outputs.reuse != 'true'");
    expect(step['continue-on-error']).toBeUndefined();
  }
});

it('keeps local verification complete and rejects caching advisories or stale tool identities', () => {
  const fixture = createVerifierCoverageFixture(process.cwd(), root);
  const workflowPath = path.join(fixture, '.github/workflows/ci.yml');
  const run = () => spawnSync(process.execPath, [path.join(fixture, 'scripts/ci/check-verify-ci.mjs')], { encoding: 'utf8' });
  expect(run().status).toBe(0);
  for (const mutation of ['advisories', 'stale identity', 'conditional audit']) {
    const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
    const steps = workflow.jobs.security.steps;
    if (mutation === 'advisories') steps.find((step: { id?: string }) => step.id === 'audit-tool-cache').with.path = '~/.cargo/advisory-db';
    if (mutation === 'stale identity') steps.find((step: { id?: string }) => step.id === 'audit-tool').run = 'echo version=0.1';
    if (mutation === 'conditional audit') steps.find((step: { name?: string }) => step.name === 'Audit Rust dependencies').if += " && steps.audit-tool-cache.outputs.cache-hit != 'true'";
    writeFileSync(workflowPath, stringify(workflow));
    const result = run();
    expect(result.status, mutation).toBe(1);
    expect(result.stderr).toContain('verify:ci coverage:');
  }
});
