import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Control the TS fallback's checkedAt inputs without excluding response fields.
// Real timers and performance.now remain available for transport measurements.
Date.now = () => 1794873600000;
const { firstDifference, generateRequests, normalize } = require('../../scripts/o8d/parity.ts') as typeof import('../../scripts/o8d/parity');
const { freeReadParityPort, startReadParityBridge } = require('./o8d-read-parity-bridge.ts') as typeof import('./o8d-read-parity-bridge');
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

const port = await freeReadParityPort();
let server: Awaited<ReturnType<typeof startReadParityBridge>> | undefined;
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  assert.ok(url.startsWith('http://127.0.0.1:'), 'External fixture network disabled');
  return originalFetch(input, init);
};
async function read(path: string, headers: Record<string, string> = {}, method = 'GET') {
  const response = await fetch(server!.origin + path, { method,
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
const records: unknown[] = [], summary: unknown[] = [], auth: unknown[] = [], timings: unknown[] = [];
const references = new Map<string, Awaited<ReturnType<typeof read>>>();
const authReferences = new Map<string, Awaited<ReturnType<typeof read>>>();
const groups = Object.entries(profiles).map(([route, parameters]) => {
  const generated = generateRequests({ path: route, parameters, count: 100 });
  if (route === '/api/panel/operator-defaults') {
    const project = parameters.find(parameter => parameter.name === 'project')!;
    generated.push(...generateRequests({ path: route, parameters: [project], count: 100 }).map(request => {
      const url = new URL(request.path, 'http://fixture.invalid'); url.searchParams.set('include', 'native');
      return { ...request, caseIndex: request.caseIndex + 100, kind: 'legacy-' + request.kind, path: url.pathname + url.search };
    }));
  }
  return { route, generated };
});
function prepare(route: string, index: number) {
  if (route !== '/api/panel/operator-defaults') return;
  const mode = index % 5;
  if (index >= 100) {
    rmSync(join(directory, 'settings.toml'), { force: true });
    writeFileSync(join(directory, 'operator-defaults.json'), JSON.stringify({ presentationQuietMode: mode % 2 === 0,
      ...(mode === 4 ? { parallelCap: 2 } : {}) }));
  } else {
    writeFileSync(join(directory, 'settings.toml'), '[presentation]\nquiet_mode = true\n');
    writeFileSync(join(directory, 'operator-defaults.json'), '{}');
  }
}
const releaseReceipt = process.env.O8D_SETTINGS_RELEASE_RECEIPT;
if (releaseReceipt) {
  const receipt = JSON.parse(readFileSync(releaseReceipt, 'utf8'));
  assert.equal(receipt.profile, 'release');
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), receipt.binarySha256);
}
let mutationPointer: string | null = null;
try {
  for (const enabled of [false, true]) {
    server = await startReadParityBridge(binary, port, enabled, true);
    if (!enabled) {
      // TS initializes its owned stores before the saved-read comparison.
      await read('/api/panel/operator-defaults?include=native');
      await read('/api/panel/operator-defaults');
    }
    for (const { route, generated } of groups) {
      let native = 0;
      for (const request of generated) {
        prepare(route, request.caseIndex);
        const before = snapshot();
        const actual = await read(request.path);
        const key = route + ':' + request.caseIndex;
        if (!enabled) { assert.equal(actual.native, false); references.set(key, actual); continue; }
        assert.deepEqual(snapshot(), before, `Native read changed durable files: ${request.path}`);
        const expected = references.get(key)!;
        const pointer = firstDifference(expected.wire, actual.wire);
        assert.equal(pointer, null, JSON.stringify({ seed: request.seed, caseIndex: request.caseIndex, path: request.path, pointer }));
        if (route === '/api/v2/keys') {
          const wire = actual.wire as { body: { providers: Array<{ configured: boolean; maskedKey: unknown }> } };
          for (const provider of wire.body.providers) { assert.equal(provider.configured, false); assert.equal(provider.maskedKey, null); }
        }
        if (route === '/api/setup/config') assert.equal(actual.native, false, 'Unchecked saved setup fields must remain TypeScript-owned');
        if (actual.native) native++;
        if (route === '/api/panel/operator-defaults' && request.caseIndex >= 100) {
          assert.equal(actual.native, request.caseIndex % 5 !== 4, `Native route was not reached: ${request.path}`);
        }
        records.push({ request, expected: portable(expected.wire), native: actual.native });
      }
      if (enabled) {
        if (route === '/api/setup/config') assert.equal(native, 0);
        else assert.ok(native > 0, `Native route was not reached: ${route}`);
        const result = { route, attempted: generated.length, native, fallback: generated.length - native, differences: 0 };
        summary.push(result); console.log(JSON.stringify(result));
      }
      const cases = [
        { headers: { authorization: '' } }, { headers: { authorization: 'Bearer wrong' } },
        { headers: { authorization: 'Bearer o8ro_fixture' } },
        { headers: { authorization: '', 'x-o8d-session-read': 'authorize', 'x-o8d-bridge': 'spoofed', 'x-o8d-peer': '127.0.0.1' } },
        { headers: { authorization: '', host: 'untrusted.invalid' } },
        { headers: { origin: 'https://untrusted.invalid' }, method: 'POST' },
      ];
      for (const [index, refusal] of cases.entries()) {
        const actual = await read(route, refusal.headers, refusal.method);
        const key = route + ':' + index;
        assert.equal(actual.native, false);
        if (!enabled) authReferences.set(key, actual);
        else {
          const expected = authReferences.get(key)!;
          assert.equal(firstDifference(expected.wire, actual.wire), null, `Refusal differs: ${route}`);
          auth.push({ route, method: refusal.method ?? 'GET', expected: expected.wire });
        }
      }
    }
    if (releaseReceipt) for (const route of Object.keys(profiles)) {
      rmSync(join(directory, 'settings.toml'), { force: true });
      writeFileSync(join(directory, 'operator-defaults.json'), '{}');
      const path = route === '/api/panel/operator-defaults' ? route + '?include=native' : route;
      for (let index = 0; index < 10; index++) await read(path);
      const samples = [];
      for (let index = 0; index < 100; index++) {
        const start = performance.now(); const result = await read(path); samples.push(performance.now() - start);
        assert.equal(result.native, enabled, `Latency reader not reached: ${path}`);
      }
      const sorted = [...samples].sort((a, b) => a - b);
      timings.push({ path, native: enabled, p50Ms: sorted[49], p95Ms: sorted[94], samplesMs: samples });
    }
    if (!enabled) assert.deepEqual(server.probes, [], 'Reference child attempted native admission');
    else {
      const response = await read('/api/setup/config'); assert.equal(response.native, false);
      const mutated = structuredClone(response.wire) as { body: { setupComplete: boolean } };
      mutated.body.setupComplete = !mutated.body.setupComplete;
      mutationPointer = firstDifference(response.wire, mutated);
      assert.ok(mutationPointer?.startsWith('$/body/setupComplete'));
    }
    await server.stop(); server = undefined;
  }
  // Prove why setup/config is excluded, without logging synthetic credential bytes.
  const probeValue = 'owned-fixture-private-credential-value';
  const setupPath = join(directory, 'setup.json'), originalSetup = readFileSync(setupPath, 'utf8');
  const credentialGuard = { setupReaderCopiesUnknownValues: false, setupProductProxied: false, keysExposeOnlyMetadata: false, ambientKeysDefer: false };
  try {
    writeFileSync(setupPath, JSON.stringify({ setupComplete: false, skippedSteps: [], cortex: { apiKey: probeValue } }));
    for (const product of [false, true]) {
      server = await startReadParityBridge(binary, port, true, product);
      const actual = await read('/api/setup/config');
      assert.equal(actual.native, !product);
      assert.equal(JSON.stringify(actual.wire).includes(probeValue), true);
      if (product) credentialGuard.setupProductProxied = true;
      else credentialGuard.setupReaderCopiesUnknownValues = true;
      await server.stop(); server = undefined;
    }
    writeFileSync(setupPath, originalSetup);
    server = await startReadParityBridge(binary, port, true, true);
    const keys = await read('/api/v2/keys'); assert.equal(keys.native, true);
    const providers = (keys.wire as { body: { providers: Array<Record<string, unknown>> } }).body.providers;
    assert.ok(providers.every(provider => provider.configured === false && provider.maskedKey === null));
    assert.equal(JSON.stringify(keys.wire).includes(probeValue), false);
    credentialGuard.keysExposeOnlyMetadata = true;
    process.env.OPENAI_API_KEY = probeValue;
    const configured = await read('/api/v2/keys'); assert.equal(configured.native, false);
    assert.equal(JSON.stringify(configured.wire).includes(probeValue), false);
    credentialGuard.ambientKeysDefer = true;
  } finally {
    delete process.env.OPENAI_API_KEY; writeFileSync(setupPath, originalSetup);
    await server?.stop(); server = undefined;
  }
  writeFileSync(output, JSON.stringify({ seed: groups[0].generated[0].seed, records, summary, auth, timings, credentialGuard,
    separateChildLaunchFlags: [false, true], referenceAdmissionProbes: 0, mutationPointer }, null, 2) + '\n');
} finally { await server?.stop(); }
process.exit(0);
