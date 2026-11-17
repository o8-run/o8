import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Control the TS fallback's checkedAt inputs without excluding response fields.
// Real timers and performance.now remain available for transport measurements.
Date.now = () => 1794873600000;
const { firstDifference, generateRequests, normalize } = require('../../scripts/o8d/parity.ts') as typeof import('../../scripts/o8d/parity');
const { handleNativeHttp } = require('../../src/lib/ws-server/native-http-routes.ts') as typeof import('../../src/lib/ws-server/native-http-routes');
const { O8dBridge } = require('../../src/lib/ws-server/o8d-bridge.ts') as typeof import('../../src/lib/ws-server/o8d-bridge');
const profiles = require('./o8d-settings-parameters.json') as typeof import('./o8d-settings-parameters.json');

const [binary, output] = process.argv.slice(2);
const directory = process.env.CORTEX_IDE_DATA_DIR!;
assert.ok(directory.includes('o8d-settings-parity-'));
assert.equal(process.env.HOME, directory);
const token = 'owned-settings-parity-fixture';
const fixtureBin = join(directory, 'bin');
mkdirSync(fixtureBin);
for (const executable of ['codex', 'claude']) writeFileSync(join(fixtureBin, executable), '#!/bin/sh\nexit 127\n', { mode: 0o700 });
process.env.PATH = fixtureBin + ':/usr/bin:/bin';
for (const name of ['.claude', '.codex']) mkdirSync(join(directory, name), { recursive: true });
writeFileSync(join(directory, 'ws-token'), token, { mode: 0o600 });
writeFileSync(join(directory, 'instance-id'), 'fixture-settings-instance');
writeFileSync(join(directory, 'boot-id'), 'fixture-settings-boot');
writeFileSync(join(directory, 'setup.json'), JSON.stringify({ setupComplete: false, skippedSteps: ['fixture'] }));
writeFileSync(join(directory, 'agent-setup-request.json'), JSON.stringify({ status: 'pending' }));
writeFileSync(join(directory, 'provider-instances.json'), JSON.stringify({ version: 1,
  instances: [{ id: 'fixture-codex', runtime: 'codex', name: 'Fixture', enabled: true }], threads: { 'fixture-thread': 'fixture-codex' } }));
writeFileSync(join(directory, '.claude/settings.json'), JSON.stringify({ fastMode: true }));

const reserve = createServer();
await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = (reserve.address() as { port: number }).port;
await new Promise<void>(resolve => reserve.close(() => resolve()));
Object.assign(process.env, { O8_NEXT_O8D: '1', O8_WS_O8D: '1', O8D_NATIVE_SESSION_READS: '1',
  O8D_BINARY: binary, O8_API_PORT: String(port), O8_WS_PORT: String(port), PORT: String(port) });
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  assert.ok(url.startsWith('http://127.0.0.1:'), 'External fixture network disabled');
  return originalFetch(input, init);
};
const privateServer = createServer(async (req, res) => {
  try {
    if (!await handleNativeHttp(req, res, port, bridge.bridged(req), bridge.clientAddress(req))) res.writeHead(404).end();
  } catch { res.writeHead(500).end(); }
});
const bridge = new O8dBridge(privateServer, port, 'settings-parity-epoch', '127.0.0.1');
async function read(path: string, headers: Record<string, string> = {}, method = 'GET') {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method,
    signal: AbortSignal.timeout(20_000), headers: { authorization: `Bearer ${token}`, ...headers },
    ...(method === 'POST' ? { body: '{}' } : {}) });
  return { native: response.headers.get('x-o8d-native-session-read') === '1', wire: normalize({
    status: response.status, headers: Object.fromEntries(['content-type', 'cache-control', 'allow']
      .map(name => [name, response.headers.get(name)])), body: await response.json() }) };
}
function portable(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll(directory, '$FIXTURE_ROOT');
  if (Array.isArray(value)) return value.map(portable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portable(item)]));
  return value;
}
function snapshot() {
  const files: Record<string, string> = {};
  function walk(folder: string) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === 'o8d-request-counts.jsonl' || entry.name.endsWith('-shm')) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[path.slice(directory.length + 1)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  }
  walk(directory);
  return files;
}
const records: unknown[] = [];
const summary: Array<{ route: string; attempted: number; native: number; fallback: number; differences: number }> = [];
const auth: unknown[] = [];
const timings: unknown[] = [];
try {
  await bridge.start();
  assert.equal(bridge.status.transport, 'o8d');
  // Initialize the actual TS-owned schema and migration stores before read-only comparisons.
  process.env.O8D_NATIVE_SESSION_READS = '0';
  await read('/api/panel/operator-defaults?include=native');
  for (const [route, parameters] of Object.entries(profiles)) {
    const generated = generateRequests({ path: route, parameters, count: 100 });
    if (route === '/api/panel/operator-defaults') {
      const project = parameters.find(parameter => parameter.name === 'project')!;
      generated.push(...generateRequests({ path: route, parameters: [project], count: 100 }).map(request => {
        const url = new URL(request.path, 'http://fixture.invalid');
        url.searchParams.set('include', 'native');
        return { ...request, caseIndex: request.caseIndex + 100, kind: 'legacy-' + request.kind, path: url.pathname + url.search };
      }));
    }
    let native = 0;
    for (const request of generated) {
      // The operator group deliberately includes unsupported legacy ownership.
      // Other parameter domains come directly from each handler's accepted inputs.
      const operator = route === '/api/panel/operator-defaults';
      const mode = request.caseIndex % 5;
      const path = request.path;
      if (operator && request.caseIndex >= 100) {
        rmSync(join(directory, 'settings.toml'), { force: true });
        writeFileSync(join(directory, 'operator-defaults.json'), JSON.stringify({
          presentationQuietMode: mode % 2 === 0, ...(mode === 4 ? { parallelCap: 2 } : {}),
        }));
      }
      if (operator && request.caseIndex < 100) {
        writeFileSync(join(directory, 'settings.toml'), '[presentation]\nquiet_mode = true\n');
        writeFileSync(join(directory, 'operator-defaults.json'), '{}');
      }
      process.env.O8D_NATIVE_SESSION_READS = '0';
      const expected = await read(path);
      const before = snapshot();
      process.env.O8D_NATIVE_SESSION_READS = '1';
      const actual = await read(path);
      assert.deepEqual(snapshot(), before, `Native read changed durable files: ${path}`);
      const pointer = firstDifference(expected.wire, actual.wire);
      assert.equal(pointer, null, JSON.stringify({ seed: request.seed, caseIndex: request.caseIndex, path, pointer }));
      if (route === '/api/v2/keys') {
        const wire = actual.wire as { body: { providers: Array<{ configured: boolean; maskedKey: unknown }> } };
        for (const provider of wire.body.providers) {
          assert.equal(provider.configured, false);
          assert.equal(provider.maskedKey, null);
        }
      }
      if (actual.native) native++;
      if (operator && request.caseIndex >= 100) assert.equal(actual.native, mode !== 4, `Native route was not reached: ${path}`);
      records.push({ request: { ...request, path }, expected: portable(expected.wire), native: actual.native });
    }
    assert.ok(native > 0, `Native route was not reached: ${route}`);
    const result = { route, attempted: generated.length, native, fallback: generated.length - native, differences: 0 };
    summary.push(result);
    console.log(JSON.stringify(result));
    for (const headers of [{ authorization: '' }, { authorization: 'Bearer wrong' },
      { authorization: 'Bearer o8ro_fixture' },
      { authorization: '', 'x-o8d-session-read': 'authorize', 'x-o8d-bridge': 'spoofed', 'x-o8d-peer': '127.0.0.1' },
      { authorization: '', host: 'untrusted.invalid' }]) {
      process.env.O8D_NATIVE_SESSION_READS = '0'; const expected = await read(route, headers);
      process.env.O8D_NATIVE_SESSION_READS = '1'; const actual = await read(route, headers);
      assert.equal(firstDifference(expected.wire, actual.wire), null, `Refusal differs: ${route}`);
      assert.equal(actual.native, false);
      auth.push({ route, expected: expected.wire });
    }
    process.env.O8D_NATIVE_SESSION_READS = '0';
    const refused = await read(route, { origin: 'https://untrusted.invalid' }, 'POST');
    process.env.O8D_NATIVE_SESSION_READS = '1';
    const refusedNative = await read(route, { origin: 'https://untrusted.invalid' }, 'POST');
    assert.equal(firstDifference(refused.wire, refusedNative.wire), null);
    assert.equal(refusedNative.native, false);
    auth.push({ route, method: 'POST', expected: refused.wire });
  }
  const releaseReceipt = process.env.O8D_SETTINGS_RELEASE_RECEIPT;
  if (releaseReceipt) {
    const receipt = JSON.parse(readFileSync(releaseReceipt, 'utf8'));
    assert.equal(receipt.profile, 'release');
    assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), receipt.binarySha256);
    for (const route of Object.keys(profiles)) {
      rmSync(join(directory, 'settings.toml'), { force: true });
      writeFileSync(join(directory, 'operator-defaults.json'), '{}');
      const path = route === '/api/panel/operator-defaults' ? route + '?include=native' : route;
      for (const enabled of [false, true]) {
        process.env.O8D_NATIVE_SESSION_READS = enabled ? '1' : '0';
        for (let index = 0; index < 10; index++) await read(path);
        const samples = [];
        for (let index = 0; index < 100; index++) {
          const start = performance.now();
          const result = await read(path);
          samples.push(performance.now() - start);
          assert.equal(result.native, enabled, `Latency reader not reached: ${path}`);
        }
        const sorted = [...samples].sort((a, b) => a - b);
        timings.push({ path, native: enabled, p50Ms: sorted[49], p95Ms: sorted[94], samplesMs: samples });
      }
    }
  }
  // Mutate an actual native response, then require a useful mismatch pointer.
  process.env.O8D_NATIVE_SESSION_READS = '1';
  const response = await read('/api/setup/config');
  assert.equal(response.native, true);
  const mutated = structuredClone(response.wire) as { body: { setupComplete: boolean } };
  mutated.body.setupComplete = !mutated.body.setupComplete;
  const mutationPointer = firstDifference(response.wire, mutated);
  assert.ok(mutationPointer?.startsWith('$/body/setupComplete'));
  writeFileSync(output, JSON.stringify({ seed: generatedSeed(), records, summary, auth, timings, mutationPointer }, null, 2) + '\n');
} finally {
  bridge.stop();
  privateServer.closeAllConnections();
  await new Promise<void>(resolve => privateServer.close(() => resolve()));
}
function generatedSeed() { return generateRequests({ path: '/', parameters: [], count: 1 })[0].seed; }
process.exit(0);
