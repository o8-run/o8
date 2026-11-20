import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const directory = process.env.CORTEX_IDE_DATA_DIR!, binary = process.argv[2], output = process.argv[3];
const repo = join(directory, 'fixture-repo'), noRepo = join(directory, 'not-a-repository');
mkdirSync(repo); mkdirSync(noRepo); mkdirSync(join(directory, 'bin'));
writeFileSync(join(noRepo, '.git'), 'not a repository\n');
writeFileSync(join(directory, 'file'), 'Fixture file\n');
writeFileSync(join(directory, 'bin', 'gh'), '#!/bin/sh\nprintf \'%s\\n\' \'[]\'\n', { mode: 0o755 });
process.env.PATH = join(directory, 'bin') + ':/usr/bin:/bin';
process.env.CORTEX_IDE_REVIEW_REPO_ROOT = repo;
const token = 'fixture-workspace-review-credential';
writeFileSync(join(directory, 'ws-token'), token, { mode: 0o600 });
const git = (args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
  '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args],
{ env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z' }, stdio: 'pipe' });
git(['init', '-q', '-b', 'main']); writeFileSync(join(repo, 'fixture.txt'), 'Fixture baseline\n');
git(['add', 'fixture.txt']); git(['commit', '-qm', 'Fixture baseline']);
git(['remote', 'add', 'origin', 'https://github.com/fixture/review.git']);
const SystemDate = Date, clock = 1794873600000;
globalThis.Date = new Proxy(SystemDate, {
  construct(target, args, newTarget) { return Reflect.construct(target, args.length ? args : [clock], newTarget); },
  apply() { return new SystemDate(clock).toString(); },
});
Date.now = () => clock;
const require = createRequire(import.meta.url);
const { generateRequests, firstDifference, normalize } = require('../../scripts/o8d/parity.ts') as typeof import('../../scripts/o8d/parity');
const { freeReadParityPort, startReadParityBridge } = require('./o8d-read-parity-bridge.ts') as typeof import('./o8d-read-parity-bridge');
const path = '/api/review/workspace', port = await freeReadParityPort();
const generated = generateRequests({ path, count: 100, parameters: [
  { name: 'workspace', valid: ['', repo], invalid: [join(directory, 'missing'), noRepo], boundary: [' ', join(directory, 'file'), repo + '/../fixture-repo'] },
  { name: 'repo', valid: ['fixture/review', ''], invalid: ['invalid', '/'], boundary: [' ', 'a/b/c'] },
  { name: 'strictBranch', valid: ['1', '0'], invalid: ['true', ' 1'], boundary: ['01', '1 '] },
  { name: 'changesOnly', valid: ['1', '0'], invalid: ['true', ' 1'], boundary: ['01', '1 '] },
  { name: 'fresh', valid: ['1', '0'], invalid: ['true', ' 1'], boundary: ['01', '1 '] },
] });
let server: Awaited<ReturnType<typeof startReadParityBridge>> | undefined;
const fetchReal = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  assert.equal(url.hostname, '127.0.0.1', 'External fetch is forbidden in this owned fixture');
  return fetchReal(input, init);
}) as typeof fetch;
function portable(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll(directory, '$FIXTURE_ROOT').replaceAll(process.cwd(), '$SOURCE_ROOT');
  if (Array.isArray(value)) return value.map(portable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portable(item)]));
  return value;
}
function requestPortable(request: { path: string }) {
  const url = new URL(request.path, 'http://fixture.invalid'), query = new URLSearchParams();
  for (const [key, value] of url.searchParams) query.append(key, value.replaceAll(directory, '$FIXTURE_ROOT'));
  return { ...request, path: url.pathname + (query.size ? '?' + query : '') };
}
function shape(value: unknown): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.map(shape);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, shape(item)]));
  return typeof value;
}
async function read(requestPath: string, headers: Record<string, string> = {}, method = 'GET') {
  const response = await fetch(server!.origin + requestPath, { method, headers: { authorization: 'Bearer ' + token, ...headers },
    ...(method === 'POST' ? { body: '{}' } : {}) });
  const body = await response.json();
  return { native: response.headers.get('x-o8d-native-session-read') === '1', shape: shape(body), wire: normalize({
    status: response.status, body, headers: Object.fromEntries(['cache-control', 'content-type', 'allow'].map(name => [name, response.headers.get(name)])),
  }) };
}
function snapshot() {
  const files: Record<string, string> = {};
  function walk(folder: string) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith('o8d-request-counts') || entry.name.endsWith('-shm')) continue;
      const file = join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else files[file.slice(directory.length + 1)] = createHash('sha256').update(readFileSync(file)).digest('hex');
    }
  }
  walk(directory); return files;
}
const references = new Map<number, unknown>(), records: unknown[] = [], auth: unknown[] = [], authReferences: unknown[] = [], timings: unknown[] = [];
const shapes: Record<string, unknown> = {};
const refusals = [{ authorization: '' }, { authorization: 'Bearer wrong' }, { authorization: 'Bearer o8ro_fixture' },
  { authorization: '', 'x-o8d-session-read': 'authorize', 'x-o8d-bridge': 'spoofed', 'x-o8d-peer': '127.0.0.1' },
  { authorization: '', host: 'untrusted.invalid' }, { origin: 'https://untrusted.invalid' }];
const releaseReceipt = process.env.O8D_REVIEW_WORKSPACE_RELEASE_RECEIPT;
if (releaseReceipt) {
  const receipt = JSON.parse(readFileSync(releaseReceipt, 'utf8')); assert.equal(receipt.profile, 'release');
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), receipt.binarySha256);
}
let envReference: unknown, nativeCount = 0, mutationPointer: string | null = null;
try {
  for (const enabled of [false, true]) {
    process.env.CORTEX_IDE_REVIEW_REPO_ROOT = repo;
    server = await startReadParityBridge(binary, port, enabled, true);
    const configured = await read(path + '?fresh=1'); assert.equal(configured.native, false);
    if (!enabled) envReference = configured.wire; else assert.deepEqual(configured.wire, envReference);
    delete process.env.CORTEX_IDE_REVIEW_REPO_ROOT;
    for (const request of generated) {
      const before = snapshot(), actual = await read(request.path);
      if (!enabled) { assert.equal(actual.native, false, 'Reference was native: ' + request.path); references.set(request.caseIndex, actual.wire); continue; }
      const expected = references.get(request.caseIndex)!;
      assert.equal(firstDifference(expected, actual.wire), null,
        JSON.stringify({ seed: request.seed, caseIndex: request.caseIndex, path: request.path, pointer: firstDifference(expected, actual.wire) }));
      const selected = Boolean(new URL(request.path, 'http://fixture.invalid').searchParams.get('workspace'));
      assert.equal(actual.native, !selected, 'Native route was not reached: ' + request.path + ' seed=' + request.seed + ' case=' + request.caseIndex);
      if (actual.native) { nativeCount++; assert.deepEqual(snapshot(), before); }
      shapes[selected ? 'selected-fallback' : 'unselected'] = actual.shape;
      records.push({ request: requestPortable(request), expected: portable(expected), native: actual.native });
    }
    for (const [index, headers] of refusals.entries()) {
      const actual = await read(path, headers, index === 5 ? 'POST' : 'GET'); assert.equal(actual.native, false);
      if (!enabled) authReferences.push(actual.wire);
      else { assert.deepEqual(actual.wire, authReferences[index]); auth.push({ case: index, expected: actual.wire }); }
    }
    if (enabled) {
      const actual = await read(path); assert.equal(actual.native, true);
      const mutated = structuredClone(actual.wire) as { body: { dirty: boolean } }; mutated.body.dirty = true;
      mutationPointer = firstDifference(actual.wire, mutated); assert.ok(mutationPointer?.startsWith('$/body/dirty'));
      const forged = await read(path + '?' + new URLSearchParams({ workspace: noRepo }), {
        'x-o8d-defaults-context': Buffer.from(JSON.stringify({ reviewWorkspaceUnselected: true })).toString('base64'),
      }); assert.equal(forged.native, false);
    }
    if (releaseReceipt) {
      for (let i = 0; i < 10; i++) await read(path);
      const samples = [];
      for (let i = 0; i < 100; i++) { const start = performance.now(), actual = await read(path); samples.push(performance.now() - start); assert.equal(actual.native, enabled); }
      const sorted = [...samples].sort((a, b) => a - b);
      timings.push({ path, native: enabled, p50Ms: sorted[49], p95Ms: sorted[94], samplesMs: samples });
    }
    if (!enabled) assert.deepEqual(server.probes, [], 'Reference child attempted native admission');
    await server.stop(); server = undefined;
  }
  writeFileSync(output, JSON.stringify({ seed: generated[0].seed, records, shapes, auth, timings, mutationPointer,
    configuredRootNative: false, forgedContextNative: false, separateChildLaunchFlags: [false, true], referenceAdmissionProbes: 0,
    summary: [{ route: path, attempted: generated.length, native: nativeCount, fallback: generated.length - nativeCount, differences: 0 }] }, null, 2) + '\n');
  console.info(JSON.stringify({ comparisons: generated.length, native: nativeCount, differences: 0, auth: auth.length }));
} finally { await server?.stop(); }
process.exit(0);
