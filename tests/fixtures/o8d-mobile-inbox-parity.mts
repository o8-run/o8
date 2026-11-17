import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const SystemDate = Date;
let clock = 1794873600000;
globalThis.Date = new Proxy(SystemDate, {
  construct(target, args, newTarget) { return Reflect.construct(target, args.length ? args : [clock], newTarget); },
  apply() { return new SystemDate(clock).toString(); },
});
Date.now = () => clock;
const directory = process.env.CORTEX_IDE_DATA_DIR!;
const binary = process.argv[2], output = process.argv[3];
const token = 'fixture-mobile-inbox-credential';
mkdirSync(join(directory, 'chat-history'), { recursive: true });
mkdirSync(join(directory, 'fixture-bin'), { recursive: true });
mkdirSync(join(directory, 'no-repository'), { recursive: true });
for (const command of ['gh', 'codex', 'claude', 'tmux', 'lsof', 'ps', 'pi', 'opencode']) {
  writeFileSync(join(directory, 'fixture-bin', command), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
}
process.env.PATH = join(directory, 'fixture-bin') + ':/usr/bin:/bin';
process.env.CORTEX_IDE_REVIEW_REPO_ROOT = join(directory, 'no-repository');
writeFileSync(join(directory, 'ws-token'), token, { mode: 0o600 });
const { firstDifference, generateRequests, normalize } = require('../../scripts/o8d/parity.ts') as typeof import('../../scripts/o8d/parity');
const { freeReadParityPort, startReadParityBridge } = require('./o8d-read-parity-bridge.ts') as typeof import('./o8d-read-parity-bridge');
const { getSqlite, closeDb } = require('../../src/lib/db/index.ts') as typeof import('../../src/lib/db');
getSqlite();
const { invalidateInboxCache } = require('../../src/lib/mobile/inbox.ts') as typeof import('../../src/lib/mobile/inbox');
const { invalidateRuntimeInventoryCache } = require('../../src/lib/runtime/inventory.ts') as typeof import('../../src/lib/runtime/inventory');
const path = '/api/mobile/inbox';
const generated = generateRequests({ path, count: 100, parameters: [
  { name: 'fresh', valid: ['1', '0'], invalid: ['true', ' 1'], boundary: ['01', '1 ', '-1'] },
  { name: 'limit', valid: ['1', '2', '100'], invalid: ['NaN', '-1', '0'], boundary: ['1suffix', '1e9', '9007199254740993', '999999999999999999999999999999999999999999'] },
  { name: 'workspaceReview', valid: ['0', '1'], invalid: ['false', ' 0'], boundary: ['00', '0 ', '\n'] },
] });
const port = await freeReadParityPort();
const references = new Map<number, { wire: unknown; shape: unknown }>();
const authReferences: unknown[] = [], records: unknown[] = [], auth: unknown[] = [], timings: unknown[] = [];
const shapes: Record<string, unknown> = {};
let server: Awaited<ReturnType<typeof startReadParityBridge>> | undefined;
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  assert.equal(url.hostname, '127.0.0.1', 'External service access is forbidden in this owned fixture');
  return realFetch(input, init);
}) as typeof fetch;
function portable(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll(directory, '$FIXTURE_ROOT').replaceAll(process.cwd(), '$SOURCE_ROOT');
  if (Array.isArray(value)) return value.map(portable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portable(item)]));
  return value;
}
function shape(value: unknown): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length ? [shape(value[0])] : [];
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, shape(item)]));
  return typeof value;
}
async function read(requestPath: string, headers: Record<string, string> = {}, method = 'GET') {
  const response = await fetch(server!.origin + requestPath, { method, headers: { authorization: 'Bearer ' + token, ...headers },
    ...(method === 'POST' ? { body: '{}' } : {}) });
  const body = await response.json();
  if (response.status === 200) assert.match(response.headers.get('server-timing') ?? '', /^total;dur=\d+(\.\d+)?$/);
  return { native: response.headers.get('x-o8d-native-session-read') === '1', shape: shape(body), wire: normalize({
    status: response.status, body, headers: Object.fromEntries(['cache-control', 'content-type', 'access-control-allow-origin', 'allow'].map(name => [name, response.headers.get(name)])),
  }) };
}
function snapshot() {
  const files: Record<string, string> = {};
  function walk(folder: string) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith('o8d-request-counts') || entry.name.endsWith('-shm') || entry.name === 'fixture-bin') continue;
      const file = join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else files[file.slice(directory.length + 1)] = createHash('sha256').update(readFileSync(file)).digest('hex');
    }
  }
  walk(directory); return files;
}
async function prepare(nonempty: boolean) {
  const file = join(directory, 'chat-history', 'thoughts-mobile-fixture.json');
  if (nonempty) {
    writeFileSync(file, JSON.stringify({ title: 'Fixture conversation', backend: 'claude', model: 'fixture-model', savedAt: new Date(clock).toISOString(),
      messages: [{ role: 'user', content: 'Fixture nonempty inbox' }] }));
    utimesSync(file, clock / 1000, clock / 1000);
  } else rmSync(file, { force: true });
  invalidateInboxCache();
  for (const query of ['?fresh=1&workspaceReview=0', '?fresh=1']) assert.equal((await read(path + query)).native, false);
}
const refusals = [
  { authorization: '' }, { authorization: 'Bearer wrong' }, { authorization: 'Bearer o8ro_fixture' },
  { authorization: '', 'x-o8d-session-read': 'authorize', 'x-o8d-bridge': 'spoofed', 'x-o8d-peer': '127.0.0.1' },
  { authorization: '', host: 'untrusted.invalid' }, { origin: 'https://untrusted.invalid' },
];
const releaseReceipt = process.env.O8D_MOBILE_INBOX_RELEASE_RECEIPT;
if (releaseReceipt) {
  const receipt = JSON.parse(readFileSync(releaseReceipt, 'utf8'));
  assert.equal(receipt.profile, 'release');
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), receipt.binarySha256);
}
let nativeCount = 0, mutationPointer: string | null = null;
const boundaries: unknown[] = [];
try {
  for (const enabled of [false, true]) {
    invalidateInboxCache(); invalidateRuntimeInventoryCache();
    server = await startReadParityBridge(binary, port, enabled);
    const cold = await read(path + '?workspaceReview=0');
    assert.equal(cold.native, false, 'An absent cache must execute the original handler');
    let previous: boolean | undefined;
    for (const request of generated) {
      const nonempty = request.caseIndex % 5 === 4;
      if (previous !== nonempty) await prepare(nonempty);
      previous = nonempty;
      const before = snapshot(), actual = await read(request.path);
      if (!enabled) {
        assert.equal(actual.native, false, 'Reference request was native: ' + request.path);
        references.set(request.caseIndex, actual); continue;
      }
      const expected = references.get(request.caseIndex)!;
      assert.equal(firstDifference(expected.wire, actual.wire), null,
        JSON.stringify({ seed: request.seed, caseIndex: request.caseIndex, path: request.path, pointer: firstDifference(expected.wire, actual.wire) }));
      const expectedNative = !nonempty && new URL(request.path, 'http://fixture.invalid').searchParams.get('fresh') !== '1';
      assert.equal(actual.native, expectedNative, 'Native route was not reached: ' + request.path + ' seed=' + request.seed + ' case=' + request.caseIndex);
      if (actual.native) { nativeCount++; assert.deepEqual(snapshot(), before, 'Native read changed durable state'); }
      shapes[nonempty ? 'nonempty-fallback' : 'idle'] = actual.shape;
      records.push({ request, fixture: nonempty ? 'chat' : 'idle', expected: portable(expected.wire), native: actual.native });
    }
    for (const [index, headers] of refusals.entries()) {
      const actual = await read(path, headers, index === 5 ? 'POST' : 'GET');
      if (!enabled) { assert.equal(actual.native, false); authReferences.push(actual.wire); }
      else { assert.deepEqual(actual.wire, authReferences[index]); assert.equal(actual.native, false); auth.push({ case: index, expected: actual.wire }); }
    }
    await prepare(false);
    if (enabled) {
      const actual = await read(path); assert.equal(actual.native, true);
      const mutated = structuredClone(actual.wire) as { body: { summary: { alerts: number } } };
      mutated.body.summary.alerts++;
      mutationPointer = firstDifference(actual.wire, mutated); assert.ok(mutationPointer?.startsWith('$/body/summary/alerts'));
      for (const kind of ['expired', 'cross-process-invalidation', 'local-invalidation', 'fresh', 'nonempty']) {
        await prepare(false);
        if (kind === 'expired') clock += 8001;
        if (kind === 'cross-process-invalidation') writeFileSync(join(directory, 'snapshot-inbox.generation'), 'fixture-external-generation');
        if (kind === 'local-invalidation') invalidateInboxCache();
        if (kind === 'nonempty') await prepare(true);
        const result = await read(path + (kind === 'fresh' ? '?fresh=1' : ''));
        assert.equal(result.native, false, 'Owner boundary must fall back: ' + kind); boundaries.push({ kind, native: result.native });
      }
      clock = 1794873600000;
    }
    await prepare(false);
    if (releaseReceipt) {
      for (let i = 0; i < 10; i++) await read(path);
      const samples = [];
      for (let i = 0; i < 100; i++) {
        const start = performance.now(), actual = await read(path); samples.push(performance.now() - start);
        assert.equal(actual.native, enabled);
      }
      const sorted = [...samples].sort((a, b) => a - b);
      timings.push({ path, native: enabled, p50Ms: sorted[49], p95Ms: sorted[94], samplesMs: samples });
    }
    if (!enabled) assert.deepEqual(server.probes, [], 'Reference child attempted native admission');
    await server.stop(); server = undefined;
  }
  writeFileSync(output, JSON.stringify({ seed: generated[0].seed, records, shapes, auth, boundaries, mutationPointer, timings,
    summary: [{ route: path, attempted: generated.length, native: nativeCount, fallback: generated.length - nativeCount, differences: 0 }],
    separateChildLaunchFlags: [false, true], referenceAdmissionProbes: 0 }, null, 2) + '\n');
  console.info(JSON.stringify({ comparisons: generated.length, native: nativeCount, differences: 0, auth: auth.length }));
} finally { await server?.stop(); closeDb(); }
process.exit(0);
